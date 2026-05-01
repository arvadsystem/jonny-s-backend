import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
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
const MENU_VIEW_PERMISSIONS = ['MENU_VER'];
const MENU_MUTATION_PERMISSIONS = ['MENU_VER'];

// Seguridad: el actor se resuelve siempre desde el token autenticado.
const resolveActorUserId = (req) => {
  const parsed = Number(req?.user?.id_usuario);
  return esEnteroPositivo(parsed) ? parsed : null;
};

const toSafeFileBaseName = (value) => {
  const sanitized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'receta';
};

const getDriveFileIdFromUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '';

  try {
    const parsed = new URL(safeUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    const isDrive =
      host.includes('drive.google.com') ||
      host.includes('drive.usercontent.google.com') ||
      host.includes('lh3.googleusercontent.com');

    if (!isDrive) return '';

    const path = String(parsed.pathname || '');
    const fromPath =
      path.match(/\/file\/d\/([^/?#]+)/i)?.[1] ||
      path.match(/\/d\/([^/?#]+)/i)?.[1] ||
      '';
    const fromQuery = String(parsed.searchParams.get('id') || '').trim();
    return String(fromPath || fromQuery).trim();
  } catch {
    return '';
  }
};

const getDriveResourceKeyFromUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return '';

  try {
    const parsed = new URL(safeUrl);
    return String(parsed.searchParams.get('resourcekey') || '').trim();
  } catch {
    return '';
  }
};

const normalizeDriveImageUrl = (rawUrl) => {
  const safeUrl = String(rawUrl || '').trim();
  if (!safeUrl) return safeUrl;

  const fileId = getDriveFileIdFromUrl(safeUrl);
  if (!fileId) return safeUrl;

  const resourceKey = getDriveResourceKeyFromUrl(safeUrl);
  const resourceKeySuffix = resourceKey
    ? `&resourcekey=${encodeURIComponent(resourceKey)}`
    : '';

  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1200${resourceKeySuffix}`;
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
          id_unidad_medida
        ) VALUES ($1, $2, $3, true, $4)
      `,
      [idReceta, item.id_insumo, item.cant, item.id_unidad_medida]
    );
  }
};

const registrarArchivoDesdeUrlPublica = async ({ nombreReceta, urlPublica, idUsuario }) => {
  const insertResult = await pool.query(
    `
      INSERT INTO archivos (
        nombre_original,
        url_publica,
        tipo_archivo,
        tamano_bytes,
        estado,
        id_usuario
      ) VALUES ($1, $2, $3, $4, true, $5)
      RETURNING id_archivo
    `,
    [
      `${toSafeFileBaseName(nombreReceta)}-url`,
      normalizeDriveImageUrl(urlPublica),
      'image/url',
      null,
      idUsuario
    ]
  );

  return Number(insertResult.rows?.[0]?.id_archivo || 0);
};

// GET: listar recetas.
router.get('/', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
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
    const baseDatos = result.rows || [];
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);

    return res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener recetas admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: catalogo de insumos activos para armar detalle de receta.
router.get('/catalogos/insumos', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          i.id_insumo,
          i.nombre_insumo,
          i.id_unidad_medida,
          um.nombre AS unidad_nombre,
          um.simbolo AS unidad_simbolo,
          i.cantidad,
          i.stock_minimo
        FROM insumos i
        LEFT JOIN unidades_medida um
          ON um.id_unidad_medida = i.id_unidad_medida
        WHERE COALESCE(i.estado, true) = true
        ORDER BY i.nombre_insumo ASC, i.id_insumo ASC
      `
    );

    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al obtener catalogo de insumos para recetas:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: detalle de insumos de una receta.
router.get('/:id_receta/detalle', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const recetaExiste = await existeRecetaPorId(idReceta);
    if (!recetaExiste) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
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
    console.error('Error al obtener detalle de receta admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// PUT: reemplazar detalle de insumos de una receta.
router.put('/:id_receta/detalle', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
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

    await client.query('BEGIN');
    await reemplazarDetalleReceta(client, idReceta, normalized.detalle);
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
router.get('/:id_receta', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idReceta = Number(req.params.id_receta);
    if (!esEnteroPositivo(idReceta)) {
      return res.status(400).json({ error: true, message: 'id_receta invalido.' });
    }

    const receta = await obtenerRecetaPorId(idReceta);
    if (!receta) {
      return res.status(404).json({ error: true, message: 'Receta no encontrada.' });
    }

    return res.status(200).json(receta);
  } catch (err) {
    console.error('Error al obtener receta por id admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// POST: crear receta.
router.post('/', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const detalleValidation = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!detalleValidation.ok) {
      return res.status(400).json({ error: true, message: detalleValidation.message });
    }

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleValidation.detalle);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    delete payloadConActor.detalle_receta;
    delete payloadConActor.detalle;

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
      const idArchivoGenerado = await registrarArchivoDesdeUrlPublica({
        nombreReceta: datosNormalizados.nombre_receta,
        urlPublica: urlImagenPublica,
        idUsuario: actorUserId
      });

      if (!esEnteroPositivo(idArchivoGenerado)) {
        return res.status(500).json({ error: true, message: 'No se pudo registrar la imagen en archivos.' });
      }

      datosNormalizados.id_archivo = idArchivoGenerado;
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

    await reemplazarDetalleReceta(client, idRecetaCreada, detalleValidation.detalle);
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
router.put('/:id_receta', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
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

    const detalleValidation = normalizeDetalleRecetaPayload(req.body?.detalle_receta || req.body?.detalle || []);
    if (!detalleValidation.ok) {
      return res.status(400).json({ error: true, message: detalleValidation.message });
    }

    const fkDetalleValidation = await validarDetalleRecetaFks(client, detalleValidation.detalle);
    if (!fkDetalleValidation.ok) {
      return res.status(fkDetalleValidation.status).json({ error: true, message: fkDetalleValidation.message });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    delete payloadConActor.detalle_receta;
    delete payloadConActor.detalle;

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
      const idArchivoGenerado = await registrarArchivoDesdeUrlPublica({
        nombreReceta: datosNormalizados.nombre_receta,
        urlPublica: urlImagenPublica,
        idUsuario: actorUserId
      });

      if (!esEnteroPositivo(idArchivoGenerado)) {
        return res.status(500).json({ error: true, message: 'No se pudo registrar la imagen en archivos.' });
      }

      datosNormalizados.id_archivo = idArchivoGenerado;
    }
    delete datosNormalizados.url_imagen_publica;

    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    await client.query('BEGIN');

    for (const campo of Object.keys(datosNormalizados)) {
      await actualizarCampoReceta(client, idReceta, campo, datosNormalizados[campo]);
    }

    await reemplazarDetalleReceta(client, idReceta, detalleValidation.detalle);

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
router.patch('/:id_receta/estado', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
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
