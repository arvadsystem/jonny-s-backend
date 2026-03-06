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

const TABLA_RECETAS = 'recetas';
const COLUMNAS_RECETAS =
  'id_receta, nombre_receta, descripcion, fecha_modificacion, id_menu, id_nivel_picante, fecha_creacion, id_usuario, estado, id_tipo_departamento, precio';

// GET: listar recetas.
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT function_select($1, $2) as resultado', [TABLA_RECETAS, COLUMNAS_RECETAS]);
    const baseDatos = result.rows?.[0]?.resultado || [];
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

    await pool.query('CALL pa_insert($1, $2)', ['recetas', datosInsert]);
    return res.status(201).json({ error: false, message: 'Receta creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear receta admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo crear la receta por un conflicto de datos.'
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
