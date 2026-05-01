import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import {
  actualizarComboConDetalle,
  actualizarEstadoCombo,
  agregarDetalleCombo,
  crearComboConDetalle,
  desactivarDetalleCombo,
  esEnteroPositivo,
  esErrorConflictoConstraint,
  existeComboPorId,
  existeUsuario,
  getSafeServerErrorMessage,
  isRowActive,
  listarCombosAdmin,
  listarRecetasParaCombos,
  normalizarDetalleCombo,
  normalizarPayloadCombo,
  obtenerComboPorId,
  shouldIncludeInactive,
  validarCampoCombo,
  validarEstructuraPayloadCombo,
  validarReglasNegocioYFks
} from './admin_combos_helpers.js';

const router = express.Router();
const MENU_VIEW_PERMISSIONS = ['MENU_VER'];
const MENU_MUTATION_PERMISSIONS = ['MENU_VER'];

const parseComboId = (value) => {
  const parsed = Number(value);
  return esEnteroPositivo(parsed) ? parsed : null;
};

// Seguridad: el actor se resuelve siempre desde el token autenticado.
const resolveActorUserId = (req) => {
  const parsed = Number(req?.user?.id_usuario);
  return esEnteroPositivo(parsed) ? parsed : null;
};

// GET: listar combos admin.
router.get('/', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const baseDatos = await listarCombosAdmin();
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    return res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener combos admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: catalogo de recetas activas para armar detalle de combo.
router.get('/catalogos/recetas', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const recetas = await listarRecetasParaCombos();
    return res.status(200).json(recetas);
  } catch (err) {
    console.error('Error al obtener catalogo de recetas para combos:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: obtener combo por id.
router.get('/:id_combo', checkPermission(MENU_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo invalido.' });
    }

    const combo = await obtenerComboPorId(idCombo, {
      includeInactiveDetail: shouldIncludeInactive(req.query)
    });
    if (!combo) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    return res.status(200).json(combo);
  } catch (err) {
    console.error('Error al obtener combo por id admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// POST: crear combo.
router.post('/', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };

    const payloadValidation = validarEstructuraPayloadCombo(payloadConActor);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const detalleNormalizacion = normalizarDetalleCombo(payloadConActor?.detalle);
    if (!detalleNormalizacion.ok) {
      return res.status(400).json({ error: true, message: detalleNormalizacion.message });
    }
    if (!detalleNormalizacion.provided || detalleNormalizacion.data.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'detalle es obligatorio y debe incluir al menos una receta.'
      });
    }

    const normalizacion = await normalizarPayloadCombo(payloadConActor);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;
    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados, detalleNormalizacion.data);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    await client.query('BEGIN');
    const idCombo = await crearComboConDetalle(client, datosNormalizados, detalleNormalizacion.data);
    await client.query('COMMIT');

    const comboCreado = await obtenerComboPorId(idCombo, { includeInactiveDetail: true });
    return res.status(201).json({
      error: false,
      message: 'Combo creado exitosamente.',
      data: comboCreado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear combo admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo crear el combo por un conflicto de datos.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// PUT: actualizar combo completo por id.
router.put('/:id_combo', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo invalido.' });
    }

    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };

    const payloadValidation = validarEstructuraPayloadCombo(payloadConActor);
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const detalleNormalizacion = normalizarDetalleCombo(payloadConActor?.detalle);
    if (!detalleNormalizacion.ok) {
      return res.status(400).json({ error: true, message: detalleNormalizacion.message });
    }

    const normalizacion = await normalizarPayloadCombo(payloadConActor);
    if (!normalizacion.ok) {
      return res.status(400).json({ error: true, message: normalizacion.message });
    }

    const datosNormalizados = normalizacion.datos;
    const reglasValidation = await validarReglasNegocioYFks(datosNormalizados, detalleNormalizacion.data);
    if (!reglasValidation.ok) {
      return res.status(reglasValidation.status).json({ error: true, message: reglasValidation.message });
    }

    await client.query('BEGIN');
    await actualizarComboConDetalle(client, idCombo, datosNormalizados, detalleNormalizacion.data, {
      replaceDetalle: detalleNormalizacion.provided
    });
    await client.query('COMMIT');

    const comboActualizado = await obtenerComboPorId(idCombo, { includeInactiveDetail: true });
    return res.status(200).json({
      error: false,
      message: 'Combo actualizado correctamente.',
      data: comboActualizado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar combo admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo actualizar el combo por un conflicto de datos.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// PATCH: actualizar solo estado por id; id_usuario se toma de req.user.
router.patch('/:id_combo/estado', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo invalido.' });
    }

    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    // Compatibilidad: si el cliente envia id_usuario se ignora silenciosamente.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };

    const payloadValidation = validarEstructuraPayloadCombo(payloadConActor, { soloEstadoUsuario: true });
    if (!payloadValidation.ok) {
      return res.status(400).json({ error: true, message: payloadValidation.message });
    }

    const estadoValidation = validarCampoCombo('estado', payloadConActor.estado);
    if (!estadoValidation.valido) {
      return res.status(400).json({ error: true, message: estadoValidation.message });
    }

    const usuarioValidation = validarCampoCombo('id_usuario', actorUserId);
    if (!usuarioValidation.valido) {
      return res.status(400).json({ error: true, message: usuarioValidation.message });
    }

    const usuarioExiste = await existeUsuario(usuarioValidation.valor);
    if (!usuarioExiste) {
      return res.status(400).json({ error: true, message: 'id_usuario no existe en usuarios.' });
    }

    await client.query('BEGIN');
    await actualizarEstadoCombo(client, idCombo, estadoValidation.valor, usuarioValidation.valor);
    await client.query('COMMIT');

    return res.status(200).json({ error: false, message: 'Estado de combo actualizado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar estado de combo admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo actualizar el estado del combo por un conflicto de datos.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// POST: agregar receta al detalle del combo.
router.post('/:id_combo/detalle', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo invalido.' });
    }

    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    const detalleNormalizacion = normalizarDetalleCombo([req.body || {}]);
    if (!detalleNormalizacion.ok) {
      return res.status(400).json({ error: true, message: detalleNormalizacion.message });
    }

    const item = detalleNormalizacion.data[0];
    const recetaExisteResult = await pool.query('SELECT 1 FROM recetas WHERE id_receta = $1 LIMIT 1', [item.id_receta]);
    if (recetaExisteResult.rowCount === 0) {
      return res.status(400).json({ error: true, message: `id_receta no existe: ${item.id_receta}` });
    }

    await client.query('BEGIN');
    const detalleCreado = await agregarDetalleCombo(client, idCombo, item);
    await client.query('COMMIT');

    return res.status(201).json({
      error: false,
      message: 'Receta agregada al combo correctamente.',
      data: detalleCreado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al agregar detalle de combo admin:', err.message);

    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo agregar la receta porque ya existe activa en el combo.'
      });
    }

    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// DELETE logico: quitar receta del combo (desactiva detalle).
router.delete('/:id_combo/detalle/:id_detalle_combo', checkPermission(MENU_MUTATION_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idCombo = parseComboId(req.params.id_combo);
    const idDetalleCombo = parseComboId(req.params.id_detalle_combo);

    if (!idCombo || !idDetalleCombo) {
      return res.status(400).json({ error: true, message: 'id_combo o id_detalle_combo invalido.' });
    }

    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    await client.query('BEGIN');
    const detalleActualizado = await desactivarDetalleCombo(client, idCombo, idDetalleCombo);
    if (!detalleActualizado) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Detalle de combo no encontrado o ya inactivo.' });
    }
    await client.query('COMMIT');

    return res.status(200).json({
      error: false,
      message: 'Detalle de combo desactivado correctamente.',
      data: detalleActualizado
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al desactivar detalle de combo admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

export default router;
