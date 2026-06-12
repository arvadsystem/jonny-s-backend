import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { buildAbsolutePublicUrl } from '../utils/uploads.js';
import {
  actualizarCampoReceta,
  esEnteroPositivo,
  esErrorConflictoConstraint,
  existeRecetaPorId,
  existeUsuario,
  getSafeServerErrorMessage,
  isRowActive,
  normalizarPayloadReceta,
  obtenerRecetaPorId,
  shouldIncludeInactive,
  validarCampoReceta,
  validarEstructuraPayloadReceta,
  validarReglasNegocioYFks
} from './admin_recetas_helpers.js';
import {
  autoPublishNewRecipe,
  moveRecipePublicationToMenu
} from '../services/menuAutoPublicationService.js';
import {
  isCatalogoMaestroReadsEnabled,
  isCatalogoMaestroViewMissingError,
  logCatalogoMaestroViewMissing,
  sendCatalogoMaestroViewMissingResponse
} from '../services/catalogoMaestroReadService.js';
import {
  fetchCatalogoInsumosMaestros,
  fetchDetalleRecetaInsumosMaestros,
  getRecetaInsumosMaestrosErrorResponse,
  isRecetaInsumosMaestrosControlledError,
  normalizeDetalleRecetaInsumosMaestros
} from '../services/recetaInsumosMaestrosService.js';

const router = express.Router();
const RECETAS_PERF_LOGS_ENABLED = String(process.env.RECETAS_PERF_LOGS || '').trim().toLowerCase() === 'true';

const createRecetasPerfTracker = (endpoint, ingredientCount) => {
  const startedAt = process.hrtime.bigint();
  let validationsMs = null;
  let writeStartedAt = null;
  let writeMs = 0;
  let success = false;
  const elapsedMs = (from) => Number(process.hrtime.bigint() - from) / 1e6;

  return {
    validationsDone() {
      if (validationsMs === null) validationsMs = elapsedMs(startedAt);
    },
    writeStarted() {
      this.validationsDone();
      writeStartedAt = process.hrtime.bigint();
    },
    writeDone() {
      if (writeStartedAt) writeMs = elapsedMs(writeStartedAt);
    },
    succeeded() {
      success = true;
    },
    finish() {
      if (!RECETAS_PERF_LOGS_ENABLED) return;
      const finalWriteMs = writeStartedAt && writeMs === 0 ? elapsedMs(writeStartedAt) : writeMs;
      console.info(JSON.stringify({
        event: 'recetas_write_perf',
        endpoint,
        total_ms: Number(elapsedMs(startedAt).toFixed(2)),
        validations_ms: Number((validationsMs ?? elapsedMs(startedAt)).toFixed(2)),
        escritura_ms: Number(finalWriteMs.toFixed(2)),
        ingredient_count: ingredientCount,
        result: success ? 'success' : 'error'
      }));
    }
  };
};
// AM: transicion segura a permisos granulares sin romper el acceso actual mientras se alinea BD/roles.
const MENU_RECETAS_VIEW_PERMISSIONS = ['MENU_RECETAS_VER', 'MENU_VER'];
const MENU_RECETAS_CREATE_PERMISSIONS = ['MENU_RECETAS_CREAR', 'MENU_VER'];
const MENU_RECETAS_EDIT_PERMISSIONS = ['MENU_RECETAS_EDITAR', 'MENU_VER'];
const MENU_RECETAS_STATE_PERMISSIONS = ['MENU_RECETAS_ESTADO_CAMBIAR', 'MENU_VER'];
const RECETAS_IMAGE_CONTRACT_MESSAGE =
  'Las imagenes de recetas deben subirse primero mediante POST /archivos y luego enviar id_archivo.';
const LEGACY_RECIPE_IMAGE_FIELDS = [
  'imagen_data_url',
  'imagen_base64',
  'data_url',
  'base64',
  'imagenDataUrl',
  'imagenBase64',
  'dataUrl'
];

// Seguridad: el actor se resuelve siempre desde el token autenticado.
const resolveActorUserId = (req) => {
  const parsed = Number(req?.user?.id_usuario);
  return esEnteroPositivo(parsed) ? parsed : null;
};

const hasValue = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const hasLegacyEmbeddedImagePayload = (payload) =>
  LEGACY_RECIPE_IMAGE_FIELDS.some((field) => hasValue(payload?.[field]));

const rejectLegacyEmbeddedImagePayload = (payload) => {
  if (!hasLegacyEmbeddedImagePayload(payload)) return null;
  return {
    status: 400,
    body: {
      error: true,
      message: RECETAS_IMAGE_CONTRACT_MESSAGE
    }
  };
};

const shouldUseCatalogoMaestroInsumos = () => isCatalogoMaestroReadsEnabled();

const sendRecetaInsumosMaestrosError = (res, err, context) => {
  if (isCatalogoMaestroViewMissingError(err)) {
    logCatalogoMaestroViewMissing(context, err);
    return sendCatalogoMaestroViewMissingResponse(res);
  }

  if (isRecetaInsumosMaestrosControlledError(err)) {
    const response = getRecetaInsumosMaestrosErrorResponse(err);
    if (response.body?.code === 'CATALOGO_MAESTRO_VIEW_MISSING') {
      console.error(`${context}: CATALOGO_MAESTRO_VIEW_MISSING`, err.cause?.message || err.message);
    }
    return res.status(response.status).json(response.body);
  }

  return null;
};

const normalizeDetalleForCurrentMode = async (client, detalle) => {
  if (!shouldUseCatalogoMaestroInsumos()) return detalle;
  return normalizeDetalleRecetaInsumosMaestros(client, detalle);
};

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const normalizeDetalleRecetaPayload = (detalle) => {
  if (!Array.isArray(detalle)) {
    return { ok: false, message: 'detalle_receta debe ser una lista de insumos.' };
  }

  const normalized = [];
  const seenInsumos = new Set();

  for (const [index, item] of detalle.entries()) {
    const idInsumo = Number(item?.id_insumo);
    const idUnidadMedida = Number(item?.id_unidad_medida);
    const cantidad = parsePositiveNumber(item?.cant ?? item?.cantidad);

    if (!esEnteroPositivo(idInsumo)) {
      return { ok: false, message: `Insumo invalido en linea ${index + 1}.` };
    }
    if (!esEnteroPositivo(idUnidadMedida)) {
      return { ok: false, message: `Unidad de medida invalida en linea ${index + 1}.` };
    }
    if (cantidad === null) {
      return { ok: false, message: `Cantidad invalida en linea ${index + 1}.` };
    }
    if (seenInsumos.has(idInsumo)) {
      return { ok: false, message: 'No repitas el mismo insumo en el detalle de receta.' };
    }

    seenInsumos.add(idInsumo);
    normalized.push({
      id_insumo: idInsumo,
      id_unidad_medida: idUnidadMedida,
      cant: cantidad
    });
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'Agrega al menos un insumo al detalle de receta.' };
  }

  return { ok: true, detalle: normalized };
};

const validarDetalleRecetaFks = async (client, detalle) => {
  const insumosIds = detalle.map((item) => item.id_insumo);
  const unidadesIds = detalle.map((item) => item.id_unidad_medida);

  const insumosResult = await client.query(
    `
      SELECT id_insumo, COALESCE(estado, true) AS estado
      FROM insumos
      WHERE id_insumo = ANY($1::int[])
    `,
    [insumosIds]
  );
  const insumosMap = new Map(insumosResult.rows.map((row) => [Number(row.id_insumo), Boolean(row.estado)]));

  for (const idInsumo of insumosIds) {
    if (!insumosMap.has(idInsumo)) {
      return { ok: false, status: 400, message: `El insumo ${idInsumo} no existe.` };
    }
    if (!insumosMap.get(idInsumo)) {
      return { ok: false, status: 409, message: `El insumo ${idInsumo} esta inactivo.` };
    }
  }

  const unidadesResult = await client.query(
    `
      SELECT id_unidad_medida
      FROM unidades_medida
      WHERE id_unidad_medida = ANY($1::int[])
    `,
    [unidadesIds]
  );
  const unidadesSet = new Set(unidadesResult.rows.map((row) => Number(row.id_unidad_medida)));

  for (const idUnidad of unidadesIds) {
    if (!unidadesSet.has(idUnidad)) {
      return { ok: false, status: 400, message: `La unidad de medida ${idUnidad} no existe.` };
    }
  }

  return { ok: true };
};

const buildUnidadConflictoMessage = (nombreInsumo, idInsumo) => {
  const safeName = String(nombreInsumo || '').trim();
  if (safeName) {
    return `El insumo "${safeName}" ya tiene una unidad definida diferente. Actualiza el detalle con la unidad correcta.`;
  }
  return `El insumo ${idInsumo} ya tiene una unidad definida diferente. Actualiza el detalle con la unidad correcta.`;
};

const sincronizarUnidadesInsumosDesdeDetalle = async (client, detalle) => {
  const insumosIds = [...new Set(detalle.map((item) => item.id_insumo))];
  const snapshotResult = await client.query(
    `
      SELECT id_insumo, nombre_insumo, id_unidad_medida
      FROM insumos
      WHERE id_insumo = ANY($1::int[])
    `,
    [insumosIds]
  );
  const snapshotMap = new Map(
    snapshotResult.rows.map((row) => [
      Number(row.id_insumo),
      {
        nombre_insumo: String(row?.nombre_insumo || '').trim(),
        id_unidad_medida:
          row?.id_unidad_medida === null || row?.id_unidad_medida === undefined
            ? null
            : Number(row.id_unidad_medida)
      }
    ])
  );

  for (const item of detalle) {
    const current = snapshotMap.get(item.id_insumo);
    if (!current) {
      return { ok: false, status: 400, message: `El insumo ${item.id_insumo} no existe.` };
    }

    if (esEnteroPositivo(current.id_unidad_medida)) {
      if (current.id_unidad_medida !== item.id_unidad_medida) {
        return {
          ok: false,
          status: 409,
          message: buildUnidadConflictoMessage(current.nombre_insumo, item.id_insumo)
        };
      }
      continue;
    }

    const updateResult = await client.query(
      `
        UPDATE insumos
        SET id_unidad_medida = $1
        WHERE id_insumo = $2
          AND id_unidad_medida IS NULL
      `,
      [item.id_unidad_medida, item.id_insumo]
    );

    if (updateResult.rowCount === 1) {
      snapshotMap.set(item.id_insumo, {
        ...current,
        id_unidad_medida: item.id_unidad_medida
      });
      continue;
    }

    const refreshedResult = await client.query(
      `
        SELECT nombre_insumo, id_unidad_medida
        FROM insumos
        WHERE id_insumo = $1
        LIMIT 1
      `,
      [item.id_insumo]
    );
    const refreshed = refreshedResult.rows?.[0] || null;
    const refreshedUnidadId =
      refreshed?.id_unidad_medida === null || refreshed?.id_unidad_medida === undefined
        ? null
        : Number(refreshed.id_unidad_medida);

    if (esEnteroPositivo(refreshedUnidadId) && refreshedUnidadId === item.id_unidad_medida) {
      snapshotMap.set(item.id_insumo, {
        nombre_insumo: String(refreshed?.nombre_insumo || current.nombre_insumo || '').trim(),
        id_unidad_medida: refreshedUnidadId
      });
      continue;
    }

    return {
      ok: false,
      status: 409,
      message: buildUnidadConflictoMessage(
        refreshed?.nombre_insumo || current.nombre_insumo,
        item.id_insumo
      )
    };
  }

  return { ok: true };
};

const reemplazarDetalleReceta = async (client, idReceta, detalle, { desactivarAnterior = true } = {}) => {
  if (desactivarAnterior) {
    await client.query('UPDATE detalle_recetas SET estado = false WHERE id_receta = $1', [idReceta]);
  }

  if (detalle.length > 0) {
    await client.query(
      `
        INSERT INTO detalle_recetas (
          id_receta,
          id_insumo,
          cant,
          estado,
          id_unidad_medida
        )
        SELECT
          $1,
          item.id_insumo,
          item.cant,
          true,
          item.id_unidad_medida
        FROM jsonb_to_recordset($2::jsonb) AS item(
          id_insumo integer,
          cant numeric,
          id_unidad_medida integer
        )
      `,
      [idReceta, JSON.stringify(detalle)]
    );
  }
};

// GET: listar recetas.
router.get('/', checkPermission(MENU_RECETAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          r.id_receta,
          r.nombre_receta,
          r.descripcion,
          r.fecha_modificacion,
          r.id_menu,
          r.id_nivel_picante,
          r.id_archivo,
          r.fecha_creacion,
          r.id_usuario,
          r.estado,
          r.id_tipo_departamento,
          r.precio,
          a.url_publica AS url_imagen_publica,
          COALESCE(dr_count.total_detalle, 0)::int AS total_detalle
        FROM recetas r
        LEFT JOIN archivos a
          ON a.id_archivo = r.id_archivo
         AND (a.estado = true OR a.estado IS NULL)
        LEFT JOIN (
          SELECT id_receta, COUNT(*)::int AS total_detalle
          FROM detalle_recetas
          WHERE COALESCE(estado, true) = true
          GROUP BY id_receta
        ) dr_count
          ON dr_count.id_receta = r.id_receta
        ORDER BY r.id_receta DESC
      `
    );
    const baseDatos = (result.rows || []).map((row) => ({
      ...row,
      url_imagen_publica: buildAbsolutePublicUrl(req, row?.url_imagen_publica || null)
    }));
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);

    return res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener recetas admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: catalogo de insumos activos para armar detalle de receta.
router.get('/catalogos/insumos', checkPermission(MENU_RECETAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    if (shouldUseCatalogoMaestroInsumos()) {
      const rows = await fetchCatalogoInsumosMaestros(pool);
      return res.status(200).json(rows);
    }

    const result = await pool.query(
      `
        SELECT
          i.id_insumo,
          i.nombre_insumo,
          i.id_categoria_insumo,
          ci.nombre_categoria,
          i.id_almacen,
          a.nombre AS nombre_almacen,
          i.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_abreviatura,
          um.simbolo AS unidad_simbolo,
          i.cantidad,
          i.stock_minimo
        FROM insumos i
        LEFT JOIN categorias_insumos ci
          ON ci.id_categoria_insumo = i.id_categoria_insumo
        LEFT JOIN almacenes a
          ON a.id_almacen = i.id_almacen
        LEFT JOIN unidades_medida um
          ON um.id_unidad_medida = i.id_unidad_medida
        WHERE COALESCE(i.estado, true) = true
        ORDER BY ci.nombre_categoria ASC NULLS LAST, i.nombre_insumo ASC, a.nombre ASC NULLS LAST, i.id_insumo ASC
      `
    );

    return res.status(200).json(result.rows || []);
  } catch (err) {
    const handled = sendRecetaInsumosMaestrosError(res, err, 'GET /admin/recetas/catalogos/insumos');
    if (handled) return handled;
    console.error('Error al obtener catalogo de insumos para recetas:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: detalle de insumos de una receta.
router.get('/:id_receta/detalle', checkPermission(MENU_RECETAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const recetaExiste = await existeRecetaPorId(idReceta);
    if (!recetaExiste) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    if (shouldUseCatalogoMaestroInsumos()) {
      const detalle = await fetchDetalleRecetaInsumosMaestros(pool, idReceta);
      return res.status(200).json(detalle);
    }

    const result = await pool.query(
      `
        SELECT
          dr.id_detalle,
          dr.id_receta,
          dr.id_insumo,
          i.nombre_insumo,
          dr.cant,
          dr.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_simbolo,
          dr.estado
        FROM detalle_recetas dr
        INNER JOIN insumos i
          ON i.id_insumo = dr.id_insumo
        LEFT JOIN unidades_medida um
          ON um.id_unidad_medida = dr.id_unidad_medida
        WHERE dr.id_receta = $1
          AND COALESCE(dr.estado, true) = true
        ORDER BY i.nombre_insumo ASC, dr.id_detalle ASC
      `,
      [idReceta]
    );

    return res.status(200).json(result.rows || []);
  } catch (err) {
    const handled = sendRecetaInsumosMaestrosError(res, err, 'GET /admin/recetas/:id_receta/detalle');
    if (handled) return handled;
    console.error('Error al obtener detalle de receta admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: contexto completo de edicion para reducir roundtrips del modal (receta + detalle + catalogo insumos).
router.get('/:id_receta/contexto-edicion', checkPermission(MENU_RECETAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const receta = await obtenerRecetaPorId(idReceta);
    if (!receta) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    if (shouldUseCatalogoMaestroInsumos()) {
      const [detalle, insumosCatalogo] = await Promise.all([
        fetchDetalleRecetaInsumosMaestros(pool, idReceta),
        fetchCatalogoInsumosMaestros(pool)
      ]);

      return res.status(200).json({
        receta: {
          ...receta,
          url_imagen_publica: buildAbsolutePublicUrl(req, receta?.url_imagen_publica || null)
        },
        detalle_receta: detalle,
        catalogos: {
          insumos: insumosCatalogo
        }
      });
    }

    const [detalleResult, insumosCatalogResult] = await Promise.all([
      pool.query(
        `
          SELECT
            dr.id_detalle,
            dr.id_receta,
            dr.id_insumo,
            i.nombre_insumo,
            dr.cant,
            dr.id_unidad_medida,
            um.nombre AS unidad_nombre,
            um.simbolo AS unidad_simbolo,
            dr.estado
          FROM detalle_recetas dr
          INNER JOIN insumos i
            ON i.id_insumo = dr.id_insumo
          LEFT JOIN unidades_medida um
            ON um.id_unidad_medida = dr.id_unidad_medida
          WHERE dr.id_receta = $1
            AND COALESCE(dr.estado, true) = true
          ORDER BY i.nombre_insumo ASC, dr.id_detalle ASC
        `,
        [idReceta]
      ),
      pool.query(
        `
          SELECT
            i.id_insumo,
            i.nombre_insumo,
            i.id_categoria_insumo,
            ci.nombre_categoria,
            i.id_almacen,
            a.nombre AS nombre_almacen,
            i.id_unidad_medida,
            um.nombre AS unidad_nombre,
            um.simbolo AS unidad_abreviatura,
            um.simbolo AS unidad_simbolo,
            i.cantidad,
            i.stock_minimo
          FROM insumos i
          LEFT JOIN categorias_insumos ci
            ON ci.id_categoria_insumo = i.id_categoria_insumo
          LEFT JOIN almacenes a
            ON a.id_almacen = i.id_almacen
          LEFT JOIN unidades_medida um
            ON um.id_unidad_medida = i.id_unidad_medida
          WHERE COALESCE(i.estado, true) = true
          ORDER BY ci.nombre_categoria ASC NULLS LAST, i.nombre_insumo ASC, a.nombre ASC NULLS LAST, i.id_insumo ASC
        `
      )
    ]);

    return res.status(200).json({
      receta: {
        ...receta,
        url_imagen_publica: buildAbsolutePublicUrl(req, receta?.url_imagen_publica || null)
      },
      detalle_receta: detalleResult.rows || [],
      catalogos: {
        insumos: insumosCatalogResult.rows || []
      }
    });
  } catch (err) {
    const handled = sendRecetaInsumosMaestrosError(res, err, 'GET /admin/recetas/:id_receta/contexto-edicion');
    if (handled) return handled;
    console.error('Error al obtener contexto de edicion de receta admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// PUT: reemplazar detalle de insumos de una receta.
router.put('/:id_receta/detalle', checkPermission(MENU_RECETAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const recetaExiste = await existeRecetaPorId(idReceta);
    if (!recetaExiste) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    const normalized = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!normalized.ok) {
      return res.status(400).json({ error: true, message: normalized.message });
    }

    const detalleNormalizado = await normalizeDetalleForCurrentMode(client, normalized.detalle);

    const fkValidation = await validarDetalleRecetaFks(client, detalleNormalizado);
    if (!fkValidation.ok) {
      return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });
    }

    await client.query('BEGIN');
    await reemplazarDetalleReceta(client, idReceta, detalleNormalizado);
    await client.query(
      `
        UPDATE recetas
        SET fecha_modificacion = timezone('America/Tegucigalpa', now())
        WHERE id_receta = $1
      `,
      [idReceta]
    );
    await client.query('COMMIT');

    return res.status(200).json({ error: false, message: 'Detalle de receta actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    const handled = sendRecetaInsumosMaestrosError(res, err, 'PUT /admin/recetas/:id_receta/detalle');
    if (handled) return handled;
    console.error('Error al actualizar detalle de receta admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// GET: obtener receta por id.
router.get('/:id_receta', checkPermission(MENU_RECETAS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const receta = await obtenerRecetaPorId(idReceta);
    if (!receta) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    return res.status(200).json({
      ...receta,
      url_imagen_publica: buildAbsolutePublicUrl(req, receta?.url_imagen_publica || null)
    });
  } catch (err) {
    console.error('Error al obtener receta por id admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// POST: crear receta.
router.post('/', checkPermission(MENU_RECETAS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  const perf = createRecetasPerfTracker(
    'POST /admin/recetas',
    Array.isArray(req.body?.detalle_receta || req.body?.detalle)
      ? (req.body.detalle_receta || req.body.detalle).length
      : 0
  );

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const legacyImageError = rejectLegacyEmbeddedImagePayload(req.body || {});
    if (legacyImageError) {
      return res.status(legacyImageError.status).json(legacyImageError.body);
    }

    const detalleValidation = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!detalleValidation.ok) {
      return res.status(400).json({ error: true, message: detalleValidation.message });
    }

    const detalleNormalizado = await normalizeDetalleForCurrentMode(client, detalleValidation.detalle);

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleNormalizado);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }

    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    delete payloadConActor.detalle_receta;
    delete payloadConActor.detalle;
    delete payloadConActor.imagen_data_url;
    delete payloadConActor.imagenDataUrl;
    delete payloadConActor.imagen_base64;
    delete payloadConActor.imagenBase64;
    delete payloadConActor.data_url;
    delete payloadConActor.dataUrl;
    delete payloadConActor.base64;
    delete payloadConActor.mime_type;
    delete payloadConActor.mimeType;
    delete payloadConActor.tipo_archivo;
    delete payloadConActor.nombre_original;
    delete payloadConActor.nombreOriginal;

    const payloadValidation = validarEstructuraPayloadReceta(payloadConActor);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const normalizacion = normalizarPayloadReceta(payloadConActor);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;

    const urlImagenPublica = String(datosNormalizados.url_imagen_publica || '').trim();
    if (urlImagenPublica) {
      return res.status(400).json({
        error: true,
        message: RECETAS_IMAGE_CONTRACT_MESSAGE
      });
    }
    delete datosNormalizados.url_imagen_publica;

    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados, client);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    const nowIso = new Date().toISOString();
    perf.writeStarted();
    await client.query('BEGIN');
    if (!shouldUseCatalogoMaestroInsumos()) {
      const unidadSyncValidation = await sincronizarUnidadesInsumosDesdeDetalle(client, detalleNormalizado);
      if (!unidadSyncValidation.ok) {
        await client.query('ROLLBACK');
        return res.status(unidadSyncValidation.status).json({ error: true, message: unidadSyncValidation.message });
      }
    }

    const createdResult = await client.query(
      `
        INSERT INTO recetas (
          nombre_receta,
          descripcion,
          id_menu,
          id_nivel_picante,
          id_archivo,
          fecha_creacion,
          fecha_modificacion,
          id_usuario,
          estado,
          id_tipo_departamento,
          precio
        ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10)
        RETURNING id_receta
      `,
      [
        datosNormalizados.nombre_receta,
        datosNormalizados.descripcion,
        datosNormalizados.id_menu,
        datosNormalizados.id_nivel_picante,
        datosNormalizados.id_archivo ?? null,
        nowIso,
        datosNormalizados.id_usuario,
        datosNormalizados.estado,
        datosNormalizados.id_tipo_departamento,
        datosNormalizados.precio
      ]
    );
    const idRecetaCreada = Number(createdResult.rows?.[0]?.id_receta || 0) || null;
    if (!esEnteroPositivo(idRecetaCreada)) {
      throw new Error('No se pudo resolver la receta creada para guardar su detalle.');
    }

    await reemplazarDetalleReceta(client, idRecetaCreada, detalleNormalizado, { desactivarAnterior: false });
    await autoPublishNewRecipe({
      client,
      idMenu: datosNormalizados.id_menu,
      idReceta: idRecetaCreada,
      estadoItem: datosNormalizados.estado ?? true
    });
    await client.query('COMMIT');
    perf.writeDone();
    perf.succeeded();

    return res.status(201).json({
      error: false,
      message: 'Receta creada exitosamente.',
      id_receta: idRecetaCreada
    });
  } catch (err) {
    await client.query('ROLLBACK');
    const handled = sendRecetaInsumosMaestrosError(res, err, 'POST /admin/recetas');
    if (handled) return handled;
    console.error('Error al crear receta admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      if (err?.code === '23505' && err?.constraint === 'uq_recetas_menu_nombre_activo') {
        return res.status(409).json({
          error: true,
          message: 'Ya existe una receta activa con ese nombre en este menu. Cambia el nombre o inactiva la receta anterior.'
        });
      }

      if (err?.code === '23502' && err?.column === 'id_nivel_picante') {
        return res.status(400).json({
          error: true,
          message: 'id_nivel_picante es obligatorio.'
        });
      }

      if (err?.constraint === 'recetas_departamento_valido') {
        return res.status(409).json({
          error: true,
          message: 'El id_tipo_departamento corresponde a productos y no puede asignarse a recetas.'
        });
      }

      return res.status(409).json({
        error: true,
        message: getSafeServerErrorMessage(err, 'No se pudo crear la receta por un conflicto de datos.')
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    perf.finish();
    client.release();
  }
});

// PUT: actualizar receta completa por id.
router.put('/:id_receta', checkPermission(MENU_RECETAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  const perf = createRecetasPerfTracker(
    'PUT /admin/recetas/:id_receta',
    Array.isArray(req.body?.detalle_receta || req.body?.detalle)
      ? (req.body.detalle_receta || req.body.detalle).length
      : 0
  );

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const legacyImageError = rejectLegacyEmbeddedImagePayload(req.body || {});
    if (legacyImageError) {
      return res.status(legacyImageError.status).json(legacyImageError.body);
    }

    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const recetaActualResult = await client.query(
      `
        SELECT id_menu
        FROM recetas
        WHERE id_receta = $1
        LIMIT 1
      `,
      [idReceta]
    );
    if (recetaActualResult.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }
    const previousMenuId = Number(recetaActualResult.rows[0].id_menu || 0) || null;

    const detalleValidation = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!detalleValidation.ok) {
      return res.status(400).json({ error: true, message: detalleValidation.message });
    }

    const detalleNormalizado = await normalizeDetalleForCurrentMode(client, detalleValidation.detalle);

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleNormalizado);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }

    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    delete payloadConActor.detalle_receta;
    delete payloadConActor.detalle;
    delete payloadConActor.imagen_data_url;
    delete payloadConActor.imagenDataUrl;
    delete payloadConActor.imagen_base64;
    delete payloadConActor.imagenBase64;
    delete payloadConActor.data_url;
    delete payloadConActor.dataUrl;
    delete payloadConActor.base64;
    delete payloadConActor.mime_type;
    delete payloadConActor.mimeType;
    delete payloadConActor.tipo_archivo;
    delete payloadConActor.nombre_original;
    delete payloadConActor.nombreOriginal;

    const payloadValidation = validarEstructuraPayloadReceta(payloadConActor);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const normalizacion = normalizarPayloadReceta(payloadConActor);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;

    const urlImagenPublica = String(datosNormalizados.url_imagen_publica || '').trim();
    if (urlImagenPublica) {
      return res.status(400).json({
        error: true,
        message: RECETAS_IMAGE_CONTRACT_MESSAGE
      });
    }
    delete datosNormalizados.url_imagen_publica;

    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados, client);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    perf.writeStarted();
    await client.query('BEGIN');
    if (!shouldUseCatalogoMaestroInsumos()) {
      const unidadSyncValidation = await sincronizarUnidadesInsumosDesdeDetalle(client, detalleNormalizado);
      if (!unidadSyncValidation.ok) {
        await client.query('ROLLBACK');
        return res.status(unidadSyncValidation.status).json({ error: true, message: unidadSyncValidation.message });
      }
    }

    await client.query(
      `
        UPDATE recetas
        SET
          nombre_receta = $2,
          descripcion = $3,
          id_menu = $4,
          id_nivel_picante = $5,
          id_archivo = CASE WHEN $11 THEN $6 ELSE id_archivo END,
          id_usuario = $7,
          estado = $8,
          id_tipo_departamento = $9,
          precio = $10,
          fecha_modificacion = timezone('America/Tegucigalpa', now())
        WHERE id_receta = $1
        RETURNING id_receta
      `,
      [
        idReceta,
        datosNormalizados.nombre_receta,
        datosNormalizados.descripcion,
        datosNormalizados.id_menu,
        datosNormalizados.id_nivel_picante,
        datosNormalizados.id_archivo ?? null,
        datosNormalizados.id_usuario,
        datosNormalizados.estado,
        datosNormalizados.id_tipo_departamento,
        datosNormalizados.precio,
        Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo')
      ]
    );

    await reemplazarDetalleReceta(client, idReceta, detalleNormalizado);
    await moveRecipePublicationToMenu({
      client,
      idReceta,
      fromMenuId: previousMenuId,
      toMenuId: datosNormalizados.id_menu
    });

    await client.query('COMMIT');
    perf.writeDone();
    perf.succeeded();
    return res.status(200).json({ error: false, message: 'Receta actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    const handled = sendRecetaInsumosMaestrosError(res, err, 'PUT /admin/recetas/:id_receta');
    if (handled) return handled;
    console.error('Error al actualizar receta admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      if (err?.code === '23505' && err?.constraint === 'uq_recetas_menu_nombre_activo') {
        return res.status(409).json({
          error: true,
          message: 'Ya existe una receta activa con ese nombre en este menu. Cambia el nombre o inactiva la receta anterior.'
        });
      }

      return res.status(409).json({
        error: true,
        message: 'No se pudo actualizar la receta por un conflicto de datos.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    perf.finish();
    client.release();
  }
});

// PATCH: actualizar solo estado por id; id_usuario se toma de req.user.
router.patch('/:id_receta/estado', checkPermission(MENU_RECETAS_STATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const recetaExiste = await existeRecetaPorId(idReceta);
    if (!recetaExiste) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };

    const payloadValidation = validarEstructuraPayloadReceta(payloadConActor, { soloEstadoUsuario: true });
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const estadoValidation = validarCampoReceta('estado', payloadConActor.estado);
    if (!estadoValidation.valido) {
      return res.status(400).json({ error: true, message: estadoValidation.message });
    }

    const usuarioValidation = validarCampoReceta('id_usuario', actorUserId);
    if (!usuarioValidation.valido) {
      return res.status(400).json({ error: true, message: usuarioValidation.message });
    }

    const usuarioExiste = await existeUsuario(usuarioValidation.valor);
    if (!usuarioExiste) {
      return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
    }

    await client.query('BEGIN');

    await actualizarCampoReceta(client, idReceta, 'estado', estadoValidation.valor);
    await actualizarCampoReceta(client, idReceta, 'id_usuario', usuarioValidation.valor);

    await client.query(
      `
        UPDATE recetas
        SET fecha_modificacion = timezone('America/Tegucigalpa', now())
        WHERE id_receta = $1
      `,
      [idReceta]
    );

    await client.query('COMMIT');
    return res.status(200).json({ error: false, message: 'Estado de receta actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar estado de receta admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo actualizar el estado de la receta por un conflicto de datos.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

export default router;
