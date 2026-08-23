import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import { getWarehouseAssignmentDetails, resolveCatalogoMaestroEntity } from './catalogoMaestroAsignacionesService.js';
import { loadInsumoSnapshot, parsePositiveIntStrict, parseQuantity, SolicitudesCompraError } from './solicitudesCompraService.js';
import { multiplyApprovedQuantityToBase } from './solicitudesCompraRevisionService.js';

const ADMIN_ROLES = new Set(['ADMINISTRADOR', 'SUPER_ADMIN']);
const LINE_FIELDS = new Set(['tipo_item', 'id_item', 'id_presentacion_insumo', 'cantidad', 'id_proveedor']);
const fail = (status, code, message) => { throw new SolicitudesCompraError(status, code, message); };
const normalizeRole = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';
const mapError = (error) => {
  if (error instanceof SolicitudesCompraError) return error;
  if (['23502', '23503', '23514', '22P02', '22003'].includes(error?.code)) return new SolicitudesCompraError(400, 'VALIDATION_ERROR', 'Los datos de formalizacion no son validos.');
  if (error?.code === '23505') return new SolicitudesCompraError(409, 'CONFLICT', 'La formalizacion entra en conflicto con datos existentes.');
  return new SolicitudesCompraError(500, 'INTERNAL_ERROR', 'No se pudo formalizar la compra.');
};

const validatePayload = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'detalles')) fail(400, 'VALIDATION_ERROR', 'El payload solo admite detalles.');
  if (!Array.isArray(body.detalles) || body.detalles.length < 1 || body.detalles.length > 100) fail(400, 'VALIDATION_ERROR', 'detalles debe contener entre 1 y 100 lineas.');
  return body.detalles.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(400, 'VALIDATION_ERROR', 'Cada detalle debe ser un objeto.');
    const unexpected = Object.keys(raw).filter((key) => !LINE_FIELDS.has(key));
    if (unexpected.length) fail(400, 'VALIDATION_ERROR', `El detalle contiene campos no permitidos: ${unexpected.join(', ')}.`);
    const type = String(raw.tipo_item ?? '').trim().toLowerCase();
    const itemId = parsePositiveIntStrict(raw.id_item);
    const providerId = parsePositiveIntStrict(raw.id_proveedor);
    const presentationId = hasValue(raw.id_presentacion_insumo) ? parsePositiveIntStrict(raw.id_presentacion_insumo) : null;
    if (!['producto', 'insumo'].includes(type)) fail(400, 'VALIDATION_ERROR', 'tipo_item debe ser producto o insumo.');
    if (!itemId || !providerId) fail(400, 'VALIDATION_ERROR', 'id_item e id_proveedor deben ser enteros positivos.');
    if (hasValue(raw.id_presentacion_insumo) && !presentationId) fail(400, 'VALIDATION_ERROR', 'id_presentacion_insumo debe ser un entero positivo.');
    if (type === 'producto' && presentationId) fail(400, 'VALIDATION_ERROR', 'Los productos no aceptan presentacion de insumo.');
    const quantity = parseQuantity(raw.cantidad, { integerOnly: type === 'producto' });
    if (!quantity) fail(400, 'VALIDATION_ERROR', type === 'producto' ? 'La cantidad de producto debe ser un entero positivo.' : 'La cantidad de insumo debe ser positiva y tener hasta 6 decimales.');
    return { type, itemId, providerId, presentationId, quantity: quantity.decimal };
  });
};

const assertAdmin = async (req, queryRunner, readAccess) => {
  const access = await readAccess(req, queryRunner);
  if (!access?.idUsuario) fail(401, 'UNAUTHORIZED', 'No autorizado.');
  const roles = new Set(Array.from(access.roles || []).map(normalizeRole));
  if (access.isSuperAdmin) roles.add('SUPER_ADMIN');
  if (![...roles].some((role) => ADMIN_ROLES.has(role))) fail(403, 'FORBIDDEN', 'No tienes permiso para formalizar esta captura.');
  return { idUsuario: Number(access.idUsuario), roles };
};

export const createCapturasCompraRapidaFormalizacionService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveMaster: overrides.resolveMaster || resolveCatalogoMaestroEntity,
    getAssignment: overrides.getAssignment || getWarehouseAssignmentDetails,
    loadSnapshot: overrides.loadSnapshot || loadInsumoSnapshot
  };

  const listProviders = async (req) => {
    await assertAdmin(req, dependencies.db, dependencies.readAccess);
    const result = await dependencies.db.query(`SELECT id_proveedor, nombre_proveedor FROM public.proveedores WHERE COALESCE(estado, true) = true ORDER BY LOWER(nombre_proveedor), id_proveedor LIMIT 100`);
    return { ok: true, proveedores: (result.rows || []).map((row) => ({ id_proveedor: Number(row.id_proveedor), nombre_proveedor: row.nombre_proveedor })) };
  };

  const formalize = async (req) => {
    const captureId = parsePositiveIntStrict(req.params?.id_captura);
    if (!captureId) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    const rawLines = validatePayload(req.body);
    const client = await dependencies.db.connect();
    let started = false;
    try {
      await client.query('BEGIN'); started = true;
      const captureResult = await client.query(
        `SELECT id_captura_compra_rapida, id_sucursal, id_almacen, id_usuario_registro, estado, fecha_envio, id_solicitud_compra
         FROM public.capturas_compra_rapida WHERE id_captura_compra_rapida = $1 FOR UPDATE`, [captureId]
      );
      const capture = captureResult.rows?.[0];
      if (!capture) fail(404, 'NOT_FOUND', 'Captura rapida no encontrada.');
      if (String(capture.estado).toUpperCase() !== 'PENDIENTE' || capture.id_solicitud_compra !== null || !capture.fecha_envio) fail(409, 'INVALID_STATE', 'La captura cambio y ya no puede formalizarse.');
      const access = await assertAdmin(req, client, dependencies.readAccess);
      const warehouseResult = await client.query(`SELECT id_almacen, id_sucursal FROM public.almacenes WHERE id_almacen = $1 AND COALESCE(estado, true) = true LIMIT 1`, [capture.id_almacen]);
      const warehouse = warehouseResult.rows?.[0];
      if (!warehouse || Number(warehouse.id_sucursal) !== Number(capture.id_sucursal)) fail(409, 'CONFLICT', 'El almacen de la captura ya no esta disponible en su sucursal.');
      const evidenceResult = await client.query(
        `SELECT e.id_archivo, e.id_usuario_registro FROM public.capturas_compra_rapida_evidencias e
         INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo
         WHERE e.id_captura_compra_rapida = $1 AND e.tipo_evidencia = 'FACTURA' AND a.estado = true
         ORDER BY e.id_captura_evidencia FOR UPDATE OF e`, [captureId]
      );
      if (!evidenceResult.rows?.length) fail(409, 'FACTURA_REQUIRED', 'Debes contar con al menos una factura activa para formalizar la compra.');

      const providerIds = [...new Set(rawLines.map((line) => line.providerId))];
      const providers = await client.query(`SELECT id_proveedor FROM public.proveedores WHERE id_proveedor = ANY($1::int[]) AND COALESCE(estado, true) = true`, [providerIds]);
      if ((providers.rows || []).length !== providerIds.length) fail(400, 'VALIDATION_ERROR', 'Todos los proveedores deben existir y estar activos.');

      const normalized = [];
      const unique = new Set();
      for (const raw of rawLines) {
        const resolved = await dependencies.resolveMaster(raw.type, raw.itemId, client);
        if (!resolved.ok) fail(resolved.status || 400, resolved.status === 404 ? 'NOT_FOUND' : 'CONFLICT', resolved.message);
        if (!resolved.master?.estado_global) fail(409, 'CONFLICT', `El ${raw.type} maestro esta inactivo.`);
        const masterId = Number(resolved.masterId);
        const assignment = await dependencies.getAssignment(raw.type, masterId, Number(capture.id_almacen), client);
        if (!assignment?.activo || Number(assignment.id_sucursal) !== Number(capture.id_sucursal)) fail(409, 'CONFLICT', `El ${raw.type} no tiene una asignacion activa en el almacen de la captura.`);
        const snapshot = raw.type === 'producto'
          ? { id_presentacion_insumo: null, id_unidad_base: null, nombre_presentacion_snapshot: 'Unidad', factor_conversion_snapshot: '1' }
          : await dependencies.loadSnapshot(masterId, raw.presentationId, client);
        const key = `${raw.type}:${masterId}:${snapshot.id_presentacion_insumo ?? 'base'}`;
        if (unique.has(key)) fail(400, 'VALIDATION_ERROR', 'No se permiten lineas duplicadas del mismo articulo y presentacion.');
        unique.add(key);
        normalized.push({ ...raw, masterId, ...snapshot, baseQuantity: multiplyApprovedQuantityToBase(raw.quantity, snapshot.factor_conversion_snapshot) });
      }

      const headerResult = await client.query(
        `INSERT INTO public.solicitudes_compra
          (id_sucursal, id_almacen, id_usuario_solicitante, estado, observacion_solicitud, comentario_revision,
           id_usuario_revisor, fecha_revision, id_usuario_recepcion, fecha_recepcion, observacion_recepcion,
           inventario_aplicado, fecha_inventario_aplicado)
         VALUES ($1, $2, $3, 'RECIBIDA', NULL, NULL, $4, NOW(), $3, $5, NULL, true, NOW())
         RETURNING id_solicitud_compra`,
        [capture.id_sucursal, capture.id_almacen, capture.id_usuario_registro, access.idUsuario, capture.fecha_envio]
      );
      const requestId = Number(headerResult.rows?.[0]?.id_solicitud_compra);
      if (!requestId) fail(500, 'INTERNAL_ERROR', 'No se pudo crear la orden de compra.');
      for (const line of normalized) {
        await client.query(
          `INSERT INTO public.solicitudes_compra_detalle
            (id_solicitud_compra, tipo_item, id_producto, id_insumo, id_presentacion_insumo, id_unidad_base,
             nombre_presentacion_snapshot, factor_conversion_snapshot, id_proveedor,
             cantidad_solicitada, cantidad_base_solicitada, cantidad_aprobada, cantidad_base_aprobada,
             cantidad_recibida, cantidad_base_recibida, origen_linea)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10::numeric, $11::numeric, $10::numeric, $11::numeric, $10::numeric, $11::numeric, 'CAPTURA_RAPIDA')`,
          [requestId, line.type.toUpperCase(), line.type === 'producto' ? line.masterId : null, line.type === 'insumo' ? line.masterId : null,
            line.id_presentacion_insumo, line.id_unidad_base, line.nombre_presentacion_snapshot, line.factor_conversion_snapshot,
            line.providerId, line.quantity, line.baseQuantity]
        );
      }
      for (const evidence of evidenceResult.rows) {
        await client.query(
          `INSERT INTO public.solicitudes_compra_evidencias (id_solicitud_compra, id_archivo, tipo_evidencia, id_usuario_registro)
           VALUES ($1, $2, 'FACTURA', $3)`, [requestId, evidence.id_archivo, evidence.id_usuario_registro || capture.id_usuario_registro]
        );
      }
      for (const line of normalized) {
        await client.query(
          `INSERT INTO public.movimientos_inventario (tipo, cantidad, id_almacen, id_producto, id_insumo, ref_origen, id_ref, descripcion)
           VALUES ('ENTRADA', $1::numeric, $2, $3, $4, 'SOLICITUD_COMPRA', $5, $6)`,
          [line.baseQuantity, capture.id_almacen, line.type === 'producto' ? line.masterId : null, line.type === 'insumo' ? line.masterId : null,
            requestId, `Recepcion de solicitud de compra #${requestId} desde captura rapida #${captureId}`]
        );
      }
      const update = await client.query(
        `UPDATE public.capturas_compra_rapida SET estado = 'FORMALIZADA', id_usuario_gestion = $2, fecha_gestion = NOW(),
           motivo_rechazo = NULL, id_solicitud_compra = $3
         WHERE id_captura_compra_rapida = $1 AND estado = 'PENDIENTE' AND id_solicitud_compra IS NULL
         RETURNING id_captura_compra_rapida, estado, id_solicitud_compra, fecha_gestion, id_usuario_gestion`,
        [captureId, access.idUsuario, requestId]
      );
      if (update.rowCount !== 1) fail(409, 'INVALID_STATE', 'La captura cambio y ya no puede formalizarse.');
      await client.query('COMMIT'); started = false;
      return { ok: true, mensaje: 'Compra formalizada e inventario actualizado correctamente.', captura: update.rows[0], solicitud: { id_solicitud_compra: requestId, estado: 'RECIBIDA', inventario_aplicado: true, total_lineas: normalized.length, total_movimientos: normalized.length, total_evidencias: evidenceResult.rows.length } };
    } catch (error) {
      if (started) { try { await client.query('ROLLBACK'); } catch { /* AM: conserva el error original. */ } }
      throw mapError(error);
    } finally { client.release(); }
  };

  return { listProviders, formalize };
};

export const capturasCompraRapidaFormalizacionService = createCapturasCompraRapidaFormalizacionService();
