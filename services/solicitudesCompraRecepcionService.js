import crypto from 'crypto';
import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import { supabase } from './supabaseClient.js';
import {
  getWarehouseAssignmentDetails,
  resolveCatalogoMaestroEntity
} from './catalogoMaestroAsignacionesService.js';
import {
  SolicitudesCompraError,
  parsePositiveIntStrict,
  parseQuantity,
  resolveOperativeWarehouseId
} from './solicitudesCompraService.js';
import { multiplyApprovedQuantityToBase } from './solicitudesCompraRevisionService.js';
import { SUPABASE_ADMIN_BUCKET, detectFileMimeTypeFromBuffer } from '../utils/uploads.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_FACTURA_EVIDENCES = 10;
const MAX_LINES = 100;
const MAX_OBSERVATION_LENGTH = 1000;
const SIGNED_URL_SECONDS = 300;
const ALLOWED_MIMES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
});
const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'ADMINISTRADOR']);
const OPERATIVE_ROLES = new Set(['CAJERO', 'COCINA', 'COCINERO', 'COCINERA', 'JEFA_COCINA', 'JEFE_COCINA']);
const RECEIPT_FIELDS = new Set(['observacion_recepcion', 'factura', 'detalles']);
const UPLOAD_FIELDS = new Set(['factura']);
const INVOICE_FIELDS = new Set(['nombre_original', 'mime_type', 'data_url']);
const DETAIL_FIELDS = new Set(['id_solicitud_detalle', 'cantidad_recibida']);
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const fail = (status, code, message) => { throw new SolicitudesCompraError(status, code, message); };
const normalizeRole = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';

const ensurePlainObject = (value, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'VALIDATION_ERROR', message);
};

const rejectUnexpectedFields = (value, allowed, context) => {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(400, 'VALIDATION_ERROR', `${context} contiene campos no permitidos: ${unexpected.join(', ')}.`);
};

const normalizeObservation = (value) => {
  if (!hasValue(value)) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length > MAX_OBSERVATION_LENGTH) {
    fail(400, 'VALIDATION_ERROR', `observacion_recepcion no puede exceder ${MAX_OBSERVATION_LENGTH} caracteres.`);
  }
  return normalized || null;
};

export const normalizeInvoiceName = (value) => {
  const raw = String(value ?? '').trim().split(/[\\/]/).pop() || 'factura';
  const normalized = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return normalized || 'factura';
};

const decodeInvoice = (invoice) => {
  ensurePlainObject(invoice, 'factura es obligatoria y debe ser un objeto.');
  rejectUnexpectedFields(invoice, INVOICE_FIELDS, 'factura');
  const declaredMime = String(invoice.mime_type ?? '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIMES, declaredMime)) {
    fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'La factura debe ser una imagen JPEG, PNG o WEBP.');
  }
  const raw = String(invoice.data_url ?? '').trim();
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(raw);
  if (!match || match[1].toLowerCase() !== declaredMime || !BASE64_REGEX.test(match[2]) || match[2].length % 4 !== 0) {
    fail(400, 'VALIDATION_ERROR', 'data_url de factura no es valido o no coincide con mime_type.');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    fail(400, 'VALIDATION_ERROR', 'La factura esta vacia o contiene base64 invalido.');
  }
  if (buffer.length > MAX_FILE_BYTES) fail(413, 'FILE_TOO_LARGE', 'La factura no puede exceder 6 MB.');
  const detectedMime = detectFileMimeTypeFromBuffer(buffer);
  if (detectedMime !== declaredMime) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'El contenido de la factura no coincide con el MIME declarado.');
  return {
    buffer,
    mimeType: declaredMime,
    extension: ALLOWED_MIMES[declaredMime],
    originalName: normalizeInvoiceName(invoice.nombre_original)
  };
};

const validatePayload = (body) => {
  ensurePlainObject(body, 'El payload debe ser un objeto.');
  rejectUnexpectedFields(body, RECEIPT_FIELDS, 'El payload');
  const invoice = body.factura === undefined || body.factura === null ? null : decodeInvoice(body.factura);
  if (!Array.isArray(body.detalles) || !body.detalles.length) {
    fail(400, 'VALIDATION_ERROR', 'detalles debe contener todas las lineas aprobadas.');
  }
  if (body.detalles.length > MAX_LINES) fail(400, 'VALIDATION_ERROR', `No se permiten mas de ${MAX_LINES} lineas.`);
  const seen = new Set();
  const details = body.detalles.map((detail) => {
    ensurePlainObject(detail, 'Cada detalle debe ser un objeto.');
    rejectUnexpectedFields(detail, DETAIL_FIELDS, 'El detalle');
    const id = parsePositiveIntStrict(detail.id_solicitud_detalle);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_solicitud_detalle debe ser un entero positivo.');
    if (seen.has(id)) fail(400, 'VALIDATION_ERROR', 'No se permiten IDs de detalle duplicados.');
    if (!hasValue(detail.cantidad_recibida)) fail(400, 'VALIDATION_ERROR', 'cantidad_recibida es obligatoria.');
    seen.add(id);
    return { id_solicitud_detalle: id, rawQuantity: detail.cantidad_recibida };
  });
  return { invoice, details, observation: normalizeObservation(body.observacion_recepcion) };
};

const validateUploadPayload = (body) => {
  ensurePlainObject(body, 'El payload debe ser un objeto.');
  rejectUnexpectedFields(body, UPLOAD_FIELDS, 'El payload');
  return decodeInvoice(body.factura);
};

const assertAccess = async (req, queryRunner, dependencies) => {
  const rawAccess = await dependencies.readAccess(req, queryRunner);
  const scope = await dependencies.resolveScope(req, queryRunner);
  if (!rawAccess?.idUsuario) fail(401, 'UNAUTHORIZED', 'No autorizado.');
  const roles = new Set(Array.from(rawAccess.roles || []).map(normalizeRole));
  const isSuperAdmin = Boolean(rawAccess.isSuperAdmin) || roles.has('SUPER_ADMIN');
  const isAdmin = isSuperAdmin || Array.from(roles).some((role) => ADMIN_ROLES.has(role));
  const isOperative = !isAdmin && Array.from(roles).some((role) => OPERATIVE_ROLES.has(role));
  if (!isAdmin && !isOperative) fail(403, 'FORBIDDEN', 'El rol del usuario no puede recibir solicitudes de compra.');
  const userSucursalId = Number(scope?.userSucursalId || 0) || null;
  if (isOperative && !userSucursalId) fail(403, 'FORBIDDEN', 'El usuario no tiene una sucursal operativa asignada.');
  const operativeWarehouseId = isOperative ? await dependencies.resolveOperativeWarehouse(queryRunner, userSucursalId) : null;
  const allowedSucursalIds = new Set((scope?.allowedSucursalIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (userSucursalId) allowedSucursalIds.add(userSucursalId);
  return { idUsuario: Number(rawAccess.idUsuario), isAdmin, isSuperAdmin, isOperative, userSucursalId, operativeWarehouseId, allowedSucursalIds };
};

const assertBranchAccess = (header, access) => {
  if (!header) fail(404, 'NOT_FOUND', 'Solicitud de compra no encontrada.');
  if (access.isOperative && (Number(header.id_sucursal) !== access.userSucursalId || Number(header.id_almacen) !== access.operativeWarehouseId)) {
    fail(403, 'FORBIDDEN', 'No tiene acceso a esta solicitud de compra.');
  }
};

const assertHeader = (header, access) => {
  assertBranchAccess(header, access);
  if (String(header.estado || '').toUpperCase() !== 'APROBADA') {
    fail(409, 'INVALID_STATE', 'La solicitud debe estar en estado APROBADA.');
  }
  if (header.inventario_aplicado === true || header.fecha_inventario_aplicado) {
    fail(409, 'CONFLICT', 'La solicitud ya tiene inventario aplicado.');
  }
};

const parseStoredPositive = (value) => parseQuantity(String(value ?? ''), { integerOnly: false });

const parseReceivedQuantity = (value, type) => {
  if (type !== 'PRODUCTO') return parseQuantity(value);
  const text = String(value ?? '').trim();
  const integerEquivalent = /^(?:[1-9]\d*)(?:\.0{1,6})?$/.exec(text);
  return integerEquivalent ? parseQuantity(text.split('.')[0], { integerOnly: true }) : null;
};

const normalizeDetails = (submitted, stored) => {
  if (!stored.length) fail(409, 'CONFLICT', 'La solicitud no contiene lineas aprobadas.');
  if (stored.length !== submitted.length) fail(400, 'VALIDATION_ERROR', 'El payload debe contener exactamente todas las lineas de la solicitud.');
  const storedById = new Map(stored.map((row) => [Number(row.id_solicitud_detalle), row]));
  if (submitted.some((line) => !storedById.has(line.id_solicitud_detalle))) {
    fail(400, 'VALIDATION_ERROR', 'El payload contiene una linea que no pertenece a la solicitud.');
  }
  let hasDifference = false;
  const normalized = submitted.map((line) => {
    const row = storedById.get(line.id_solicitud_detalle);
    const type = String(row.tipo_item || '').trim().toUpperCase();
    if (!['PRODUCTO', 'INSUMO'].includes(type)) fail(409, 'CONFLICT', 'La solicitud contiene un tipo de item no valido.');
    const approved = parseStoredPositive(row.cantidad_aprobada);
    const approvedBase = parseStoredPositive(row.cantidad_base_aprobada);
    if (!approved || !approvedBase || !parsePositiveIntStrict(row.id_proveedor)) {
      fail(409, 'CONFLICT', 'Todas las lineas deben conservar cantidad aprobada, cantidad base y proveedor validos.');
    }
    const received = parseReceivedQuantity(line.rawQuantity, type);
    if (!received) fail(400, 'VALIDATION_ERROR', type === 'PRODUCTO'
      ? 'La cantidad recibida de un producto debe ser un entero positivo.'
      : 'La cantidad recibida de un insumo debe ser positiva y tener hasta 6 decimales.');
    if (received.scaled !== approved.scaled) hasDifference = true;
    const factor = type === 'PRODUCTO' ? '1' : String(row.factor_conversion_snapshot ?? '').trim();
    return {
      id: line.id_solicitud_detalle,
      type,
      masterId: parsePositiveIntStrict(type === 'PRODUCTO' ? row.id_producto : row.id_insumo),
      received: received.decimal,
      receivedBase: type === 'PRODUCTO' ? received.decimal : multiplyApprovedQuantityToBase(received.decimal, factor),
      idProducto: type === 'PRODUCTO' ? Number(row.id_producto) : null,
      idInsumo: type === 'INSUMO' ? Number(row.id_insumo) : null
    };
  });
  return { normalized, hasDifference };
};

const storageAdapter = {
  async upload(path, buffer, mimeType) {
    const { error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).upload(path, buffer, {
      contentType: mimeType, cacheControl: '3600', upsert: false
    });
    if (error) throw error;
  },
  async remove(path) {
    const { error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).remove([path]);
    if (error) throw error;
  },
  async createSignedUrl(path, seconds) {
    const { data, error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).createSignedUrl(path, seconds);
    if (error || !data?.signedUrl) throw error || new Error('Signed URL unavailable');
    return data.signedUrl;
  }
};

const mapError = (error) => {
  if (error instanceof SolicitudesCompraError) return error;
  if (['23502', '23503', '23514', '22P02', '22003'].includes(error?.code)) {
    return new SolicitudesCompraError(400, 'VALIDATION_ERROR', 'Los datos de recepcion no son validos.');
  }
  if (error?.code === '23505') return new SolicitudesCompraError(409, 'CONFLICT', 'La recepcion entra en conflicto con datos existentes.');
  return new SolicitudesCompraError(500, 'INTERNAL_ERROR', 'No se pudo completar la recepcion solicitada.');
};

const loadHeader = async (runner, requestId, { lock = false } = {}) => (await runner.query(
  `SELECT id_solicitud_compra, id_sucursal, id_almacen, estado, inventario_aplicado, fecha_inventario_aplicado
   FROM public.solicitudes_compra WHERE id_solicitud_compra = $1${lock ? ' FOR UPDATE' : ''}`,
  [requestId]
)).rows?.[0];

const loadDetails = async (runner, requestId, { lock = false } = {}) => (await runner.query(
  `SELECT id_solicitud_detalle, tipo_item, id_producto, id_insumo, factor_conversion_snapshot,
          cantidad_aprobada, cantidad_base_aprobada, id_proveedor
   FROM public.solicitudes_compra_detalle WHERE id_solicitud_compra = $1
   ORDER BY id_solicitud_detalle${lock ? ' FOR UPDATE' : ''}`,
  [requestId]
)).rows || [];

const countInvoiceEvidence = async (runner, requestId) => {
  const result = await runner.query(
    `SELECT COUNT(*)::int AS total
     FROM public.solicitudes_compra_evidencias
     WHERE id_solicitud_compra = $1 AND tipo_evidencia = 'FACTURA'`,
    [requestId]
  );
  return Number(result.rows?.[0]?.total || 0);
};

const safeRollback = async (client) => { try { await client.query('ROLLBACK'); } catch { /* AM: conserva error principal. */ } };

export const createSolicitudesCompraRecepcionService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveScope: overrides.resolveScope || resolveRequestUserSucursalScope,
    resolveMaster: overrides.resolveMaster || resolveCatalogoMaestroEntity,
    getAssignment: overrides.getAssignment || getWarehouseAssignmentDetails,
    storage: overrides.storage || storageAdapter,
    now: overrides.now || (() => Date.now()),
    uuid: overrides.uuid || (() => crypto.randomUUID()),
    resolveOperativeWarehouse: overrides.resolveOperativeWarehouse || resolveOperativeWarehouseId
  };

  const cleanupUploadedPaths = async (paths) => {
    for (const path of paths) {
      try { await dependencies.storage.remove(path); } catch (cleanupError) {
        console.warn('[solicitudes_compra] compensacion de factura pendiente', { code: cleanupError?.code || null });
      }
    }
  };

  const persistInvoiceEvidence = async ({ client, requestId, access, invoice, uploadedPaths }) => {
    const currentCount = await countInvoiceEvidence(client, requestId);
    if (currentCount >= MAX_FACTURA_EVIDENCES) {
      fail(409, 'FACTURA_EVIDENCE_LIMIT', 'La solicitud admite un maximo de 10 imagenes de factura.');
    }

    const objectPath = `solicitudes-compra/${requestId}/factura-${dependencies.now()}-${dependencies.uuid()}.${invoice.extension}`;
    try {
      await dependencies.storage.upload(objectPath, invoice.buffer, invoice.mimeType);
      uploadedPaths.push(objectPath);
    } catch {
      fail(502, 'STORAGE_ERROR', 'No se pudo guardar la factura privada.');
    }

    const storedPath = `${SUPABASE_ADMIN_BUCKET}/${objectPath}`;
    const fileResult = await client.query(
      `INSERT INTO public.archivos (nombre_original, url_publica, tipo_archivo, tamano_bytes, id_usuario, estado)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id_archivo`,
      [invoice.originalName, storedPath, invoice.mimeType, invoice.buffer.length, access.idUsuario]
    );
    const fileId = Number(fileResult.rows?.[0]?.id_archivo);
    if (!fileId) fail(500, 'INTERNAL_ERROR', 'No se pudo registrar la factura.');
    const evidenceResult = await client.query(
      `INSERT INTO public.solicitudes_compra_evidencias
        (id_solicitud_compra, id_archivo, tipo_evidencia, id_usuario_registro)
       VALUES ($1, $2, 'FACTURA', $3)
       RETURNING id_evidencia`,
      [requestId, fileId, access.idUsuario]
    );
    const evidenceId = Number(evidenceResult.rows?.[0]?.id_evidencia);
    if (!evidenceId) fail(500, 'INTERNAL_ERROR', 'No se pudo vincular la factura a la solicitud.');
    return {
      id_evidencia: evidenceId,
      id_archivo: fileId,
      nombre_original: invoice.originalName,
      tipo_archivo: invoice.mimeType,
      tamano_bytes: invoice.buffer.length
    };
  };

  const receive = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const payload = validatePayload(req.body);

    const access = await assertAccess(req, dependencies.db, dependencies);
    const preHeader = await loadHeader(dependencies.db, requestId);
    assertHeader(preHeader, access);
    const preDetails = normalizeDetails(payload.details, await loadDetails(dependencies.db, requestId));
    if (preDetails.hasDifference && !payload.observation) {
      fail(400, 'VALIDATION_ERROR', 'observacion_recepcion es obligatoria cuando existen diferencias.');
    }

    let client;
    let transactionStarted = false;
    const uploadedPaths = [];
    try {
      client = await dependencies.db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const txAccess = await assertAccess(req, client, dependencies);
      const header = await loadHeader(client, requestId, { lock: true });
      assertHeader(header, txAccess);
      const details = normalizeDetails(payload.details, await loadDetails(client, requestId, { lock: true }));
      if (details.hasDifference && !payload.observation) {
        fail(400, 'VALIDATION_ERROR', 'observacion_recepcion es obligatoria cuando existen diferencias.');
      }

      for (const detail of details.normalized) {
        if (!detail.masterId) fail(409, 'CONFLICT', 'La linea no conserva un item maestro valido.');
        const entityType = detail.type.toLowerCase();
        const resolved = await dependencies.resolveMaster(entityType, detail.masterId, client);
        if (!resolved.ok || !resolved.master?.estado_global) fail(409, 'CONFLICT', `El ${entityType} maestro ya no esta activo.`);
        const assignment = await dependencies.getAssignment(entityType, Number(resolved.masterId), Number(header.id_almacen), client);
        if (!assignment?.activo) fail(409, 'CONFLICT', `El ${entityType} no tiene asignacion activa en el almacen.`);
      }

      const legacyEvidence = payload.invoice
        ? await persistInvoiceEvidence({ client, requestId, access: txAccess, invoice: payload.invoice, uploadedPaths })
        : null;
      const evidenceCount = await countInvoiceEvidence(client, requestId);
      if (evidenceCount < 1) {
        fail(409, 'FACTURA_REQUIRED', 'Debes cargar al menos una imagen de factura antes de confirmar la recepcion.');
      }

      for (const detail of details.normalized) {
        const update = await client.query(
          `UPDATE public.solicitudes_compra_detalle
           SET cantidad_recibida = $3::numeric, cantidad_base_recibida = $4::numeric, fecha_actualizacion = NOW()
           WHERE id_solicitud_detalle = $1 AND id_solicitud_compra = $2`,
          [detail.id, requestId, detail.received, detail.receivedBase]
        );
        if (update.rowCount !== 1) fail(409, 'CONFLICT', 'Una linea cambio durante la recepcion.');
        await client.query(
          `INSERT INTO public.movimientos_inventario
            (tipo, cantidad, id_almacen, id_producto, id_insumo, ref_origen, id_ref, descripcion)
           VALUES ('ENTRADA', $1::numeric, $2, $3, $4, 'SOLICITUD_COMPRA', $5, $6)`,
          [detail.receivedBase, Number(header.id_almacen), detail.idProducto, detail.idInsumo, requestId,
            `Recepcion de solicitud de compra #${requestId}`]
        );
      }

      const headerResult = await client.query(
        `UPDATE public.solicitudes_compra
         SET estado = 'RECIBIDA', id_usuario_recepcion = $2, fecha_recepcion = NOW(),
             observacion_recepcion = $3, inventario_aplicado = true, fecha_inventario_aplicado = NOW()
         WHERE id_solicitud_compra = $1 AND estado = 'APROBADA' AND inventario_aplicado = false
         RETURNING id_solicitud_compra, estado, id_usuario_recepcion, fecha_recepcion, inventario_aplicado`,
        [requestId, txAccess.idUsuario, payload.observation]
      );
      if (headerResult.rowCount !== 1) fail(409, 'INVALID_STATE', 'La solicitud cambio durante la recepcion.');
      await client.query('COMMIT');
      transactionStarted = false;
      const received = headerResult.rows[0];
      return {
        ok: true,
        mensaje: 'Solicitud recibida e inventario actualizado correctamente.',
        solicitud: {
          id_solicitud_compra: Number(received.id_solicitud_compra), estado: received.estado,
          id_usuario_recepcion: Number(received.id_usuario_recepcion), fecha_recepcion: received.fecha_recepcion,
          inventario_aplicado: received.inventario_aplicado, total_lineas: details.normalized.length,
          total_movimientos: details.normalized.length
        },
        ...(legacyEvidence ? { evidencia: legacyEvidence } : {})
      };
    } catch (error) {
      if (transactionStarted && client) await safeRollback(client);
      await cleanupUploadedPaths(uploadedPaths);
      throw mapError(error);
    } finally {
      client?.release();
    }
  };

  const uploadInvoiceEvidence = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const invoice = validateUploadPayload(req.body);
    let client;
    let transactionStarted = false;
    const uploadedPaths = [];
    try {
      client = await dependencies.db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await assertAccess(req, client, dependencies);
      const header = await loadHeader(client, requestId, { lock: true });
      assertHeader(header, access);
      const evidence = await persistInvoiceEvidence({ client, requestId, access, invoice, uploadedPaths });
      await client.query('COMMIT');
      transactionStarted = false;
      return { ok: true, evidencia: evidence };
    } catch (error) {
      if (transactionStarted && client) await safeRollback(client);
      await cleanupUploadedPaths(uploadedPaths);
      throw mapError(error);
    } finally {
      client?.release();
    }
  };

  const deleteInvoiceEvidence = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    const evidenceId = parsePositiveIntStrict(req.params?.id_evidencia);
    if (!requestId || !evidenceId) fail(400, 'VALIDATION_ERROR', 'Los identificadores de solicitud y evidencia deben ser enteros positivos.');
    let client;
    let transactionStarted = false;
    let objectPath = null;
    try {
      client = await dependencies.db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await assertAccess(req, client, dependencies);
      const header = await loadHeader(client, requestId, { lock: true });
      assertHeader(header, access);
      const evidenceResult = await client.query(
        `SELECT e.id_evidencia, e.id_archivo, e.tipo_evidencia, a.url_publica
         FROM public.solicitudes_compra_evidencias e
         INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo
         WHERE e.id_solicitud_compra = $1 AND e.id_evidencia = $2
         FOR UPDATE`,
        [requestId, evidenceId]
      );
      const evidence = evidenceResult.rows?.[0];
      if (!evidence) fail(404, 'NOT_FOUND', 'La evidencia no pertenece a esta solicitud o ya no existe.');
      if (String(evidence.tipo_evidencia || '').toUpperCase() !== 'FACTURA') {
        fail(409, 'INVALID_EVIDENCE_TYPE', 'Solo se pueden quitar evidencias de factura desde este flujo.');
      }
      const prefix = `${SUPABASE_ADMIN_BUCKET}/`;
      if (!String(evidence.url_publica || '').startsWith(prefix)) {
        fail(409, 'INVALID_EVIDENCE_PATH', 'La evidencia no conserva una ruta privada valida.');
      }
      objectPath = String(evidence.url_publica).slice(prefix.length);
      const unlink = await client.query(
        `DELETE FROM public.solicitudes_compra_evidencias
         WHERE id_solicitud_compra = $1 AND id_evidencia = $2 AND tipo_evidencia = 'FACTURA'`,
        [requestId, evidenceId]
      );
      if (unlink.rowCount !== 1) fail(409, 'CONFLICT', 'La evidencia cambio durante la eliminacion.');
      await client.query('UPDATE public.archivos SET estado = false WHERE id_archivo = $1', [Number(evidence.id_archivo)]);
      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted && client) await safeRollback(client);
      throw mapError(error);
    } finally {
      client?.release();
    }

    let storageCleanupPending = false;
    try { await dependencies.storage.remove(objectPath); } catch (cleanupError) {
      storageCleanupPending = true;
      console.warn('[solicitudes_compra] limpieza fisica de evidencia pendiente', { code: cleanupError?.code || null });
    }
    return { ok: true, id_evidencia: evidenceId, storage_cleanup_pending: storageCleanupPending };
  };

  const listEvidence = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const access = await assertAccess(req, dependencies.db, dependencies);
    const header = await loadHeader(dependencies.db, requestId);
    assertBranchAccess(header, access);
    const result = await dependencies.db.query(
      `SELECT e.id_evidencia, e.tipo_evidencia, e.fecha_registro, e.id_usuario_registro,
              a.nombre_original, a.url_publica, a.tipo_archivo, a.tamano_bytes,
              u.nombre_usuario AS usuario_nombre
       FROM public.solicitudes_compra_evidencias e
       INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo AND COALESCE(a.estado, true) = true
       INNER JOIN public.usuarios u ON u.id_usuario = e.id_usuario_registro
       WHERE e.id_solicitud_compra = $1 ORDER BY e.fecha_registro, e.id_evidencia`,
      [requestId]
    );
    const evidences = [];
    for (const row of result.rows || []) {
      const prefix = `${SUPABASE_ADMIN_BUCKET}/`;
      if (!String(row.url_publica || '').startsWith(prefix)) fail(409, 'CONFLICT', 'La evidencia no conserva una ruta privada valida.');
      let signedUrl;
      try { signedUrl = await dependencies.storage.createSignedUrl(String(row.url_publica).slice(prefix.length), SIGNED_URL_SECONDS); }
      catch { fail(502, 'STORAGE_ERROR', 'No se pudo generar el acceso temporal a la evidencia.'); }
      evidences.push({
        id_evidencia: Number(row.id_evidencia), tipo_evidencia: row.tipo_evidencia,
        nombre_original: row.nombre_original, tipo_archivo: row.tipo_archivo,
        tamano_bytes: Number(row.tamano_bytes), fecha_registro: row.fecha_registro,
        usuario_registro: { id_usuario: Number(row.id_usuario_registro), nombre: row.usuario_nombre },
        url_firmada: signedUrl, expira_en_segundos: SIGNED_URL_SECONDS
      });
    }
    return { ok: true, evidencias: evidences };
  };

  return { receive, uploadInvoiceEvidence, deleteInvoiceEvidence, listEvidence };
};

export const solicitudesCompraRecepcionService = createSolicitudesCompraRecepcionService();
