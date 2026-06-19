import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { buildAbsolutePublicUrl } from '../utils/uploads.js';
import {
  actualizarComboConDetalle,
  actualizarEstadoCombo,
  agregarDetalleCombo,
  attachComboAlmacenes,
  crearComboConDetalle,
  desactivarDetalleCombo,
  esEnteroPositivo,
  esErrorConflictoConstraint,
  existeComboPorId,
  existeRecetaPorId,
  existeUsuario,
  getSafeServerErrorMessage,
  isRowActive,
  listComboAssignments,
  listarCombosAdmin,
  listarRecetasParaCombos,
  normalizarDetalleCombo,
  normalizePositiveIdList,
  normalizarPayloadCombo,
  obtenerComboPorId,
  replaceComboAlmacenes,
  shouldIncludeInactive,
  validarCampoCombo,
  validarEstructuraPayloadCombo,
  validarReglasNegocioYFks,
  validateComboAlmacenes
} from './admin_combos_helpers.js';
import {
  autoPublishNewCombo,
  moveComboPublicationToMenu
} from '../services/menuAutoPublicationService.js';

const router = express.Router();
const MENU_COMBOS_VIEW_PERMISSIONS = ['MENU_COMBOS_VER', 'MENU_VER'];
const MENU_COMBOS_CREATE_PERMISSIONS = ['MENU_COMBOS_CREAR', 'MENU_VER'];
const MENU_COMBOS_EDIT_PERMISSIONS = ['MENU_COMBOS_EDITAR', 'MENU_VER'];
const MENU_COMBOS_STATE_PERMISSIONS = ['MENU_COMBOS_ESTADO_CAMBIAR', 'MENU_VER'];
const MENU_COMBOS_DETAIL_EDIT_PERMISSIONS = ['MENU_COMBOS_DETALLE_EDITAR', 'MENU_COMBOS_EDITAR', 'MENU_VER'];

const parseComboId = (value) => {
  const parsed = Number(value);
  return esEnteroPositivo(parsed) ? parsed : null;
};

// Seguridad: el actor se resuelve siempre desde el token autenticado.
const resolveActorUserId = (req) => {
  const parsed = Number(req?.user?.id_usuario);
  return esEnteroPositivo(parsed) ? parsed : null;
};

const withResolvedComboImageUrl = (req, combo) => ({
  ...combo,
  url_imagen_publica: buildAbsolutePublicUrl(req, combo?.url_imagen_publica || null)
});

// GET: listar combos admin.
router.get('/', checkPermission(MENU_COMBOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const baseDatos = await listarCombosAdmin();
    const hydrated = await attachComboAlmacenes(pool, Array.isArray(baseDatos) ? baseDatos : []);
    const datosNormalizados = hydrated.map((combo) => withResolvedComboImageUrl(req, combo));
    const datos = shouldIncludeInactive(req.query) ? datosNormalizados : datosNormalizados.filter(isRowActive);
    return res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener combos admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// GET: catalogo de recetas activas para armar detalle de combo.
router.get('/catalogos/recetas', checkPermission(MENU_COMBOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const recetas = await listarRecetasParaCombos();
    return res.status(200).json(recetas);
  } catch (err) {
    console.error('Error al obtener catalogo de recetas para combos:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

router.get('/catalogos/almacenes', checkPermission(MENU_COMBOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          a.id_almacen,
          COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacén #', a.id_almacen::text)) AS nombre_almacen,
          a.id_sucursal,
          s.nombre_sucursal,
          COALESCE(a.estado, true) AS estado
        FROM public.almacenes a
        INNER JOIN public.sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE COALESCE(a.estado, true) = true
          AND COALESCE(s.estado, true) = true
        ORDER BY s.nombre_sucursal ASC, COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacén #', a.id_almacen::text)) ASC, a.id_almacen ASC
      `
    );
    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('Error al listar almacenes para combos:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar los almacenes.' });
  }
});

router.get('/:id_combo/asignaciones', checkPermission(MENU_COMBOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo inválido.' });
    }
    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }
    const asignaciones = await listComboAssignments(pool, idCombo);
    return res.status(200).json({ id_combo: idCombo, asignaciones });
  } catch (err) {
    console.error('Error al obtener asignaciones de combo:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron cargar las asignaciones del combo.' });
  }
});

router.put('/:id_combo/asignaciones', checkPermission(MENU_COMBOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idCombo = parseComboId(req.params.id_combo);
    if (!idCombo) {
      return res.status(400).json({ error: true, message: 'id_combo inválido.' });
    }
    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    const idAlmacenes = normalizePositiveIdList(req.body?.id_almacenes);
    const validation = await validateComboAlmacenes(client, idAlmacenes);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: true, code: validation.code, message: validation.message });
    }

    await client.query('BEGIN');
    await replaceComboAlmacenes(client, idCombo, idAlmacenes);
    const comboBase = await obtenerComboPorId(idCombo, { includeInactiveDetail: true });
    const [combo] = await attachComboAlmacenes(client, [comboBase]);
    await client.query('COMMIT');

    return res.status(200).json({
      error: false,
      message: 'Sucursales del combo actualizadas correctamente.',
      id_combo: idCombo,
      id_almacenes: idAlmacenes,
      data: withResolvedComboImageUrl(req, combo)
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al reemplazar asignaciones de combo:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudieron actualizar las sucursales del combo.' });
  } finally {
    client.release();
  }
});

router.post('/:id_combo/asignaciones', checkPermission(MENU_COMBOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idCombo = parseComboId(req.params.id_combo);
    const idAlmacen = Number(req.body?.id_almacen);
    if (!idCombo || !esEnteroPositivo(idAlmacen)) {
      return res.status(400).json({ error: true, message: 'id_combo o id_almacen inválido.' });
    }
    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    const validation = await validateComboAlmacenes(client, [idAlmacen]);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: true, code: validation.code, message: validation.message });
    }

    const currentAssignments = (await listComboAssignments(client, idCombo)).filter((row) => row.estado === true);
    const newBranchId = Number(validation.rows[0]?.id_sucursal || 0);
    const sameBranchActive = currentAssignments.find((row) => Number(row.id_sucursal) === newBranchId && Number(row.id_almacen) !== idAlmacen);
    if (sameBranchActive) {
      return res.status(409).json({
        error: true,
        code: 'COMBO_BRANCH_ASSIGNMENT_CONFLICT',
        message: 'Ya existe otro almacén activo para esa sucursal en este combo.'
      });
    }
    const sameAssignment = currentAssignments.find((row) => Number(row.id_almacen) === idAlmacen);
    if (sameAssignment) {
      return res.status(409).json({
        error: true,
        code: 'COMBO_ASSIGNMENT_ALREADY_ACTIVE',
        message: 'El combo ya está asignado a ese almacén.'
      });
    }

    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO public.menu_combo_almacenes (id_combo, id_almacen, estado, fecha_actualizacion)
        VALUES ($1, $2, true, NOW())
        ON CONFLICT (id_combo, id_almacen)
        DO UPDATE SET estado = true, fecha_actualizacion = NOW()
      `,
      [idCombo, idAlmacen]
    );
    await client.query('COMMIT');

    return res.status(201).json({
      error: false,
      message: 'Asignación del combo creada correctamente.',
      id_combo: idCombo,
      id_almacen: idAlmacen
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear asignación de combo:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo crear la asignación del combo.' });
  } finally {
    client.release();
  }
});

router.patch('/:id_combo/asignaciones/:id_almacen/inactivar', checkPermission(MENU_COMBOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idCombo = parseComboId(req.params.id_combo);
    const idAlmacen = Number(req.params.id_almacen);
    if (!idCombo || !esEnteroPositivo(idAlmacen)) {
      return res.status(400).json({ error: true, message: 'id_combo o id_almacen inválido.' });
    }
    const comboExiste = await existeComboPorId(idCombo);
    if (!comboExiste) {
      return res.status(404).json({ error: true, message: 'Combo no encontrado.' });
    }

    const assignmentResult = await client.query(
      `
        SELECT id_combo, id_almacen, COALESCE(estado, true) AS estado
        FROM public.menu_combo_almacenes
        WHERE id_combo = $1
          AND id_almacen = $2
        LIMIT 1
      `,
      [idCombo, idAlmacen]
    );
    if (!assignmentResult.rowCount) {
      return res.status(404).json({ error: true, message: 'La asignación del combo no existe para ese almacén.' });
    }

    await client.query('BEGIN');
    await client.query(
      `
        UPDATE public.menu_combo_almacenes
        SET estado = false,
            fecha_actualizacion = NOW()
        WHERE id_combo = $1
          AND id_almacen = $2
      `,
      [idCombo, idAlmacen]
    );
    await client.query('COMMIT');

    return res.status(200).json({
      error: false,
      message: assignmentResult.rows[0].estado === true
        ? 'Asignación del combo inactivada correctamente.'
        : 'La asignación del combo ya estaba inactiva.',
      id_combo: idCombo,
      id_almacen: idAlmacen
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al inactivar asignación de combo:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo inactivar la asignación del combo.' });
  } finally {
    client.release();
  }
});

// GET: obtener combo por id.
router.get('/:id_combo', checkPermission(MENU_COMBOS_VIEW_PERMISSIONS), async (req, res) => {
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
    const [hydrated] = await attachComboAlmacenes(pool, [combo]);
    const asignaciones = await listComboAssignments(pool, idCombo);
    return res.status(200).json({
      ...withResolvedComboImageUrl(req, hydrated),
      asignaciones
    });
  } catch (err) {
    console.error('Error al obtener combo por id admin:', err.message);
    return res.status(500).json({ error: true, message: getSafeServerErrorMessage(err) });
  }
});

// POST: crear combo.
router.post('/', checkPermission(MENU_COMBOS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const actorUserId = resolveActorUserId(req);
    if (!actorUserId) {
      return res.status(401).json({ error: true, message: 'Sesion invalida. Vuelve a iniciar sesion.' });
    }

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    const idAlmacenes = normalizePositiveIdList(payloadConActor.id_almacenes);
    delete payloadConActor.id_almacenes;

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
    const almacenesValidation = await validateComboAlmacenes(client, idAlmacenes);
    if (!almacenesValidation.ok) {
      return res.status(almacenesValidation.status).json({
        error: true,
        code: almacenesValidation.code,
        message: almacenesValidation.message
      });
    }

    await client.query('BEGIN');
    const idCombo = await crearComboConDetalle(client, datosNormalizados, detalleNormalizacion.data);
    await replaceComboAlmacenes(client, idCombo, idAlmacenes);
    await autoPublishNewCombo({
      client,
      idMenu: datosNormalizados.id_menu,
      idCombo,
      estadoItem: datosNormalizados.estado ?? true
    });
    await client.query('COMMIT');

    const comboCreado = await obtenerComboPorId(idCombo, { includeInactiveDetail: true });
    const [comboHydrated] = await attachComboAlmacenes(pool, [comboCreado]);
    return res.status(201).json({
      error: false,
      message: 'Combo creado exitosamente.',
      data: withResolvedComboImageUrl(req, comboHydrated)
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
router.put('/:id_combo', checkPermission(MENU_COMBOS_EDIT_PERMISSIONS), async (req, res) => {
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

    const comboActualResult = await client.query(
      `
        SELECT id_menu
        FROM combos
        WHERE id_combo = $1
        LIMIT 1
      `,
      [idCombo]
    );
    const previousMenuId = Number(comboActualResult.rows?.[0]?.id_menu || 0) || null;

    // Transicion segura: id_usuario del cliente se ignora y se fuerza desde req.user.
    const payloadConActor = { ...(req.body || {}), id_usuario: actorUserId };
    const idAlmacenes = normalizePositiveIdList(payloadConActor.id_almacenes);
    delete payloadConActor.id_almacenes;

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
    const almacenesValidation = await validateComboAlmacenes(client, idAlmacenes);
    if (!almacenesValidation.ok) {
      return res.status(almacenesValidation.status).json({
        error: true,
        code: almacenesValidation.code,
        message: almacenesValidation.message
      });
    }

    await client.query('BEGIN');
    await actualizarComboConDetalle(client, idCombo, datosNormalizados, detalleNormalizacion.data, {
      replaceDetalle: detalleNormalizacion.provided
    });
    await replaceComboAlmacenes(client, idCombo, idAlmacenes);
    await moveComboPublicationToMenu({
      client,
      idCombo,
      fromMenuId: previousMenuId,
      toMenuId: datosNormalizados.id_menu
    });
    await client.query('COMMIT');

    const comboActualizado = await obtenerComboPorId(idCombo, { includeInactiveDetail: true });
    const [comboHydrated] = await attachComboAlmacenes(pool, [comboActualizado]);
    return res.status(200).json({
      error: false,
      message: 'Combo actualizado correctamente.',
      data: withResolvedComboImageUrl(req, comboHydrated)
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
router.patch('/:id_combo/estado', checkPermission(MENU_COMBOS_STATE_PERMISSIONS), async (req, res) => {
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
router.post('/:id_combo/detalle', checkPermission(MENU_COMBOS_DETAIL_EDIT_PERMISSIONS), async (req, res) => {
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
    const recetaExiste = await existeRecetaPorId(item.id_receta);
    if (!recetaExiste) {
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
router.delete('/:id_combo/detalle/:id_detalle_combo', checkPermission(MENU_COMBOS_DETAIL_EDIT_PERMISSIONS), async (req, res) => {
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
