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

const router = express.Router();
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

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const roundDecimal = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

const hasPositiveInteger = (value) => esEnteroPositivo(Number(value));

const formatDetalleLine = (index, insumoLabel = '') => {
  const suffix = String(insumoLabel || '').trim();
  return suffix ? `linea ${index + 1} (${suffix})` : `linea ${index + 1}`;
};

const normalizeDetalleRecetaPayload = (detalle) => {
  if (!Array.isArray(detalle)) {
    return { ok: false, message: 'detalle_receta debe ser una lista de insumos.' };
  }

  const normalized = [];
  const seenInsumos = new Set();

  for (const [index, item] of detalle.entries()) {
    const idInsumo = Number(item?.id_insumo);
    const idPresentacionInsumo = Number(item?.id_presentacion_insumo);
    const usePresentacion = esEnteroPositivo(idPresentacionInsumo);

    if (!esEnteroPositivo(idInsumo)) {
      return { ok: false, message: `Insumo invalido en linea ${index + 1}.` };
    }
    if (seenInsumos.has(idInsumo)) {
      return { ok: false, message: 'No repitas el mismo insumo en el detalle de receta.' };
    }

    if (usePresentacion) {
      const cantidadPresentacion = parsePositiveNumber(item?.cantidad_presentacion);
      if (cantidadPresentacion === null) {
        return { ok: false, message: `Cantidad de presentacion invalida en linea ${index + 1}.` };
      }

      seenInsumos.add(idInsumo);
      normalized.push({
        row_index: index,
        id_insumo: idInsumo,
        modo_unidad: 'presentacion',
        id_presentacion_insumo: idPresentacionInsumo,
        cantidad_presentacion: roundDecimal(cantidadPresentacion, 4)
      });
      continue;
    }

    const idUnidadMedida = Number(item?.id_unidad_medida);
    const cantidad = parsePositiveNumber(item?.cant ?? item?.cantidad);
    if (!esEnteroPositivo(idUnidadMedida)) {
      return { ok: false, message: `Unidad de medida invalida en linea ${index + 1}.` };
    }
    if (cantidad === null) {
      return { ok: false, message: `Cantidad invalida en linea ${index + 1}.` };
    }

    seenInsumos.add(idInsumo);
    normalized.push({
      row_index: index,
      id_insumo: idInsumo,
      modo_unidad: 'base',
      id_unidad_medida: idUnidadMedida,
      cant: roundDecimal(cantidad, 2),
      id_presentacion_insumo: null,
      cantidad_presentacion: null,
      id_unidad_presentacion: null,
      factor_conversion_usado: null
    });
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'Agrega al menos un insumo al detalle de receta.' };
  }

  return { ok: true, detalle: normalized };
};

const validarDetalleRecetaFks = async (client, detalle) => {
  const insumosIds = detalle.map((item) => item.id_insumo);
  const unidadesIds = detalle
    .filter((item) => item.modo_unidad === 'base')
    .map((item) => item.id_unidad_medida);
  const presentacionesIds = detalle
    .filter((item) => item.modo_unidad === 'presentacion')
    .map((item) => item.id_presentacion_insumo);

  const insumosResult = await client.query(
    `
      SELECT id_insumo, nombre_insumo, id_unidad_medida, COALESCE(estado, true) AS estado
      FROM insumos
      WHERE id_insumo = ANY($1::int[])
    `,
    [insumosIds]
  );
  const insumosMap = new Map(
    insumosResult.rows.map((row) => [
      Number(row.id_insumo),
      {
        nombre_insumo: String(row?.nombre_insumo || '').trim(),
        id_unidad_medida:
          row?.id_unidad_medida === null || row?.id_unidad_medida === undefined
            ? null
            : Number(row.id_unidad_medida),
        estado: Boolean(row.estado)
      }
    ])
  );

  for (const idInsumo of insumosIds) {
    if (!insumosMap.has(idInsumo)) {
      return { ok: false, status: 400, message: `El insumo ${idInsumo} no existe.` };
    }
    if (!insumosMap.get(idInsumo).estado) {
      return { ok: false, status: 409, message: `El insumo ${idInsumo} esta inactivo.` };
    }
  }

  const unidadesResult = unidadesIds.length > 0
    ? await client.query(
      `
        SELECT id_unidad_medida
        FROM unidades_medida
        WHERE id_unidad_medida = ANY($1::int[])
      `,
      [unidadesIds]
    )
    : { rows: [] };
  const unidadesSet = new Set(unidadesResult.rows.map((row) => Number(row.id_unidad_medida)));

  for (const idUnidad of unidadesIds) {
    if (!unidadesSet.has(idUnidad)) {
      return { ok: false, status: 400, message: `La unidad de medida ${idUnidad} no existe.` };
    }
  }

  const presentacionesResult = presentacionesIds.length > 0
    ? await client.query(
      `
        SELECT
          ip.id_presentacion,
          ip.id_insumo,
          ip.nombre_presentacion,
          ip.cantidad_presentacion,
          ip.id_unidad_presentacion,
          up.nombre AS unidad_presentacion_nombre,
          up.simbolo AS unidad_presentacion_simbolo,
          ip.cantidad_base,
          ip.id_unidad_base,
          ub.nombre AS unidad_base_nombre,
          ub.simbolo AS unidad_base_simbolo,
          COALESCE(ip.uso_receta, false) AS uso_receta,
          COALESCE(ip.es_predeterminada_receta, false) AS es_predeterminada_receta,
          COALESCE(ip.estado, true) AS estado
        FROM insumo_presentaciones ip
        LEFT JOIN unidades_medida up
          ON up.id_unidad_medida = ip.id_unidad_presentacion
        LEFT JOIN unidades_medida ub
          ON ub.id_unidad_medida = ip.id_unidad_base
        WHERE ip.id_presentacion = ANY($1::bigint[])
      `,
      [presentacionesIds]
    )
    : { rows: [] };
  const presentacionesMap = new Map(
    presentacionesResult.rows.map((row) => [Number(row.id_presentacion), row])
  );

  const resolved = [];
  for (const item of detalle) {
    const insumo = insumosMap.get(item.id_insumo);
    const lineLabel = formatDetalleLine(item.row_index, insumo?.nombre_insumo || `insumo ${item.id_insumo}`);

    if (item.modo_unidad === 'base') {
      resolved.push(item);
      continue;
    }

    if (!hasPositiveInteger(insumo?.id_unidad_medida)) {
      return { ok: false, status: 409, message: `El insumo de la ${lineLabel} no tiene unidad base definida.` };
    }

    const presentacion = presentacionesMap.get(item.id_presentacion_insumo);
    if (!presentacion) {
      return { ok: false, status: 400, message: `La presentacion de la ${lineLabel} no existe.` };
    }

    if (Number(presentacion.id_insumo) !== item.id_insumo) {
      return { ok: false, status: 409, message: `La presentacion de la ${lineLabel} pertenece a otro insumo.` };
    }
    if (!Boolean(presentacion.estado)) {
      return { ok: false, status: 409, message: `La presentacion de la ${lineLabel} esta inactiva. Elige una presentacion activa o la unidad base.` };
    }
    if (!Boolean(presentacion.uso_receta)) {
      return { ok: false, status: 409, message: `La presentacion de la ${lineLabel} no esta habilitada para recetas.` };
    }
    if (Number(presentacion.id_unidad_base) !== Number(insumo.id_unidad_medida)) {
      return { ok: false, status: 409, message: `La unidad base de la presentacion en la ${lineLabel} no coincide con la del insumo.` };
    }
    if (!hasPositiveInteger(presentacion.id_unidad_presentacion)) {
      return { ok: false, status: 409, message: `La presentacion de la ${lineLabel} no tiene unidad de presentacion valida.` };
    }

    const cantidadConfig = parsePositiveNumber(presentacion.cantidad_presentacion);
    const cantidadBase = parsePositiveNumber(presentacion.cantidad_base);
    if (cantidadConfig === null || cantidadBase === null) {
      return { ok: false, status: 409, message: `La presentacion de la ${lineLabel} tiene una conversion invalida.` };
    }

    const factorConversion = roundDecimal(cantidadBase / cantidadConfig, 6);
    const cantidadCanonica = roundDecimal(item.cantidad_presentacion * factorConversion, 2);
    if (cantidadCanonica <= 0) {
      return {
        ok: false,
        status: 400,
        message: `La conversion de la ${lineLabel} redondea a 0.00. Ingresa una cantidad mayor.`
      };
    }

    resolved.push({
      ...item,
      id_unidad_medida: Number(insumo.id_unidad_medida),
      cant: cantidadCanonica,
      id_unidad_presentacion: Number(presentacion.id_unidad_presentacion),
      factor_conversion_usado: factorConversion
    });
  }

  return { ok: true, detalle: resolved };
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

const reemplazarDetalleReceta = async (client, idReceta, detalle) => {
  await client.query('UPDATE detalle_recetas SET estado = false WHERE id_receta = $1', [idReceta]);

  for (const item of detalle) {
    await client.query(
      `
        INSERT INTO detalle_recetas (
          id_receta,
          id_insumo,
          cant,
          estado,
          id_unidad_medida,
          cantidad_presentacion,
          id_unidad_presentacion,
          id_presentacion_insumo,
          factor_conversion_usado
        ) VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)
      `,
      [
        idReceta,
        item.id_insumo,
        item.cant,
        item.id_unidad_medida,
        item.cantidad_presentacion,
        item.id_unidad_presentacion,
        item.id_presentacion_insumo,
        item.factor_conversion_usado
      ]
    );
  }
};

const buildDetalleRecetaSelect = () => `
  SELECT
    dr.id_detalle,
    dr.id_receta,
    dr.id_insumo,
    i.nombre_insumo,
    dr.cant,
    dr.id_unidad_medida,
    um.nombre AS unidad_nombre,
    um.simbolo AS unidad_simbolo,
    dr.id_presentacion_insumo,
    dr.cantidad_presentacion,
    dr.id_unidad_presentacion,
    dr.factor_conversion_usado,
    ip.nombre_presentacion,
    up.nombre AS unidad_presentacion_nombre,
    up.simbolo AS unidad_presentacion_simbolo,
    COALESCE(ip.estado, true) AS presentacion_estado,
    COALESCE(ip.uso_receta, false) AS presentacion_uso_receta,
    dr.estado
  FROM detalle_recetas dr
  INNER JOIN insumos i
    ON i.id_insumo = dr.id_insumo
  LEFT JOIN unidades_medida um
    ON um.id_unidad_medida = dr.id_unidad_medida
  LEFT JOIN insumo_presentaciones ip
    ON ip.id_presentacion = dr.id_presentacion_insumo
  LEFT JOIN unidades_medida up
    ON up.id_unidad_medida = dr.id_unidad_presentacion
  WHERE dr.id_receta = $1
    AND COALESCE(dr.estado, true) = true
  ORDER BY i.nombre_insumo ASC, dr.id_detalle ASC
`;

const obtenerCatalogoInsumosRecetas = async (queryable = pool) => {
  const result = await queryable.query(
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
  const insumos = result.rows || [];
  const ids = insumos.map((row) => Number(row.id_insumo)).filter(esEnteroPositivo);
  if (ids.length === 0) return insumos;

  const presentacionesResult = await queryable.query(
    `
      SELECT
        ip.id_presentacion,
        ip.id_insumo,
        ip.nombre_presentacion,
        ip.cantidad_presentacion,
        ip.id_unidad_presentacion,
        up.nombre AS unidad_presentacion_nombre,
        up.simbolo AS unidad_presentacion_simbolo,
        ip.cantidad_base,
        ip.id_unidad_base,
        ub.nombre AS unidad_base_nombre,
        ub.simbolo AS unidad_base_simbolo,
        COALESCE(ip.es_predeterminada_receta, false) AS es_predeterminada_receta
      FROM insumo_presentaciones ip
      LEFT JOIN unidades_medida up
        ON up.id_unidad_medida = ip.id_unidad_presentacion
      LEFT JOIN unidades_medida ub
        ON ub.id_unidad_medida = ip.id_unidad_base
      WHERE ip.id_insumo = ANY($1::int[])
        AND COALESCE(ip.estado, true) = true
        AND COALESCE(ip.uso_receta, false) = true
      ORDER BY ip.es_predeterminada_receta DESC, ip.nombre_presentacion ASC, ip.id_presentacion ASC
    `,
    [ids]
  );
  const presentacionesByInsumo = new Map();
  for (const presentacion of presentacionesResult.rows || []) {
    const key = Number(presentacion.id_insumo);
    if (!presentacionesByInsumo.has(key)) presentacionesByInsumo.set(key, []);
    presentacionesByInsumo.get(key).push(presentacion);
  }

  return insumos.map((insumo) => ({
    ...insumo,
    presentaciones_receta: presentacionesByInsumo.get(Number(insumo.id_insumo)) || []
  }));
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
    const insumos = await obtenerCatalogoInsumosRecetas(pool);
    return res.status(200).json(insumos);
  } catch (err) {
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

    const result = await pool.query(buildDetalleRecetaSelect(), [idReceta]);

    return res.status(200).json(result.rows || []);
  } catch (err) {
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

    const [detalleResult, insumosCatalog] = await Promise.all([
      pool.query(buildDetalleRecetaSelect(), [idReceta]),
      obtenerCatalogoInsumosRecetas(pool)
    ]);

    return res.status(200).json({
      receta: {
        ...receta,
        url_imagen_publica: buildAbsolutePublicUrl(req, receta?.url_imagen_publica || null)
      },
      detalle_receta: detalleResult.rows || [],
      catalogos: {
        insumos: insumosCatalog || []
      }
    });
  } catch (err) {
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

    const fkValidation = await validarDetalleRecetaFks(client, normalized.detalle);
    if (!fkValidation.ok) {
      return res.status(fkValidation.status).json({ error: true, message: fkValidation.message });
    }
    const detalleResuelto = fkValidation.detalle;

    await client.query('BEGIN');
    const unidadSyncValidation = await sincronizarUnidadesInsumosDesdeDetalle(client, detalleResuelto);
    if (!unidadSyncValidation.ok) {
      await client.query('ROLLBACK');
      return res.status(unidadSyncValidation.status).json({ error: true, message: unidadSyncValidation.message });
    }

    await reemplazarDetalleReceta(client, idReceta, detalleResuelto);
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

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleValidation.detalle);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }
    const detalleResuelto = fkDetalleValidation.detalle;

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

    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    // Fechas de auditoria desde backend.
    const nowIso = new Date().toISOString();
    const datosInsert = {
      ...datosNormalizados,
      fecha_creacion: nowIso,
      fecha_modificacion: nowIso
    };

    // `pa_insert` usa json_each_text y omite valores NULL; por eso se excluyen
    // campos nulos para evitar desajuste entre columnas y valores.
    const datosInsertSinNull = Object.fromEntries(
      Object.entries(datosInsert).filter(([, valor]) => valor !== null)
    );

    await client.query('BEGIN');
    const unidadSyncValidation = await sincronizarUnidadesInsumosDesdeDetalle(client, detalleResuelto);
    if (!unidadSyncValidation.ok) {
      await client.query('ROLLBACK');
      return res.status(unidadSyncValidation.status).json({ error: true, message: unidadSyncValidation.message });
    }

    await client.query('CALL pa_insert($1, $2)', ['recetas', datosInsertSinNull]);

    const createdResult = await client.query(
      `
        SELECT id_receta
        FROM recetas
        WHERE nombre_receta = $1
          AND id_menu = $2
          AND COALESCE(estado, true) = $3
        ORDER BY id_receta DESC
        LIMIT 1
      `,
      [datosInsertSinNull.nombre_receta, datosInsertSinNull.id_menu, datosInsertSinNull.estado]
    );
    const idRecetaCreada = Number(createdResult.rows?.[0]?.id_receta || 0) || null;
    if (!esEnteroPositivo(idRecetaCreada)) {
      throw new Error('No se pudo resolver la receta creada para guardar su detalle.');
    }

    await reemplazarDetalleReceta(client, idRecetaCreada, detalleResuelto);
    await client.query('COMMIT');

    return res.status(201).json({
      error: false,
      message: 'Receta creada exitosamente.',
      id_receta: idRecetaCreada
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear receta admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      if (err?.code === '23505' && err?.constraint === 'uq_recetas_menu_nombre_activo') {
        return res.status(409).json({
          error: true,
          message: 'Ya existe una receta activa con ese nombre en este menu. Cambia el nombre o inactiva la receta anterior.'
        });
      }

      // Mapeo explicito de conflictos conocidos para evitar mensajes genericos.
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
    client.release();
  }
});

// PUT: actualizar receta completa por id.
router.put('/:id_receta', checkPermission(MENU_RECETAS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

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

    const recetaExiste = await existeRecetaPorId(idReceta);
    if (!recetaExiste) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    const detalleValidation = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!detalleValidation.ok) {
      return res.status(400).json({ error: true, message: detalleValidation.message });
    }

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleValidation.detalle);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }
    const detalleResuelto = fkDetalleValidation.detalle;

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

    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    await client.query('BEGIN');
    const unidadSyncValidation = await sincronizarUnidadesInsumosDesdeDetalle(client, detalleResuelto);
    if (!unidadSyncValidation.ok) {
      await client.query('ROLLBACK');
      return res.status(unidadSyncValidation.status).json({ error: true, message: unidadSyncValidation.message });
    }

    for (const campo of Object.keys(datosNormalizados)) {
      await actualizarCampoReceta(client, idReceta, campo, datosNormalizados[campo]);
    }

    await reemplazarDetalleReceta(client, idReceta, detalleResuelto);

    // Se actualiza fecha_modificacion en cada PUT.
    await client.query(
      `
        UPDATE recetas
        SET fecha_modificacion = timezone('America/Tegucigalpa', now())
        WHERE id_receta = $1
      `,
      [idReceta]
    );

    await client.query('COMMIT');
    return res.status(200).json({ error: false, message: 'Receta actualizada correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
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

    // Compatibilidad: si el cliente envia id_usuario se ignora silenciosamente.
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

    // Requisito de negocio: PATCH estado tambien refresca fecha_modificacion.
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
