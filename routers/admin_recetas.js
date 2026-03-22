import express from 'express';
import pool from '../config/db-connection.js';
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
router.get('/', async (req, res) => {
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
          a.url_publica AS url_imagen_publica
        FROM recetas r
        LEFT JOIN archivos a
          ON a.id_archivo = r.id_archivo
         AND (a.estado = true OR a.estado IS NULL)
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

// GET: obtener receta por id.
router.get('/:id_receta', async (req, res) => {
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
router.post('/', async (req, res) => {
  try {
    const payloadValidation = validarEstructuraPayloadReceta(req.body);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const normalizacion = normalizarPayloadReceta(req.body);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;

    const urlImagenPublica = String(datosNormalizados.url_imagen_publica || '').trim();
    if (urlImagenPublica) {
      const idArchivoGenerado = await registrarArchivoDesdeUrlPublica({
        nombreReceta: datosNormalizados.nombre_receta,
        urlPublica: urlImagenPublica,
        idUsuario: datosNormalizados.id_usuario
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

    await pool.query('CALL pa_insert($1, $2)', ['recetas', datosInsertSinNull]);
    return res.status(201).json({ error: false, message: 'Receta creada exitosamente.' });
  } catch (err) {
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
  }
});

// PUT: actualizar receta completa por id.
router.put('/:id_receta', async (req, res) => {
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

    const payloadValidation = validarEstructuraPayloadReceta(req.body);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const normalizacion = normalizarPayloadReceta(req.body);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;

    const urlImagenPublica = String(datosNormalizados.url_imagen_publica || '').trim();
    if (urlImagenPublica) {
      const idArchivoGenerado = await registrarArchivoDesdeUrlPublica({
        nombreReceta: datosNormalizados.nombre_receta,
        urlPublica: urlImagenPublica,
        idUsuario: datosNormalizados.id_usuario
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

// PATCH: actualizar solo estado e id_usuario por id.
router.patch('/:id_receta/estado', async (req, res) => {
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

    const payloadValidation = validarEstructuraPayloadReceta(req.body, { soloEstadoUsuario: true });
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const estadoValidation = validarCampoReceta('estado', req.body.estado);
    if (!estadoValidation.valido) {
      return res.status(400).json({ error: true, message: estadoValidation.message });
    }

    const usuarioValidation = validarCampoReceta('id_usuario', req.body.id_usuario);
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
