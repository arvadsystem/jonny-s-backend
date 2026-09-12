import crypto from 'crypto';
import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import { supabase } from './supabaseClient.js';
import {
  getWarehouseAssignmentDetails,
  resolveCatalogoMaestroEntity,
  validateWarehouseAssignmentsBatch
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
const RECEIPT_FIELDS = new Set(['observacion_recepcion', 'factura', 'detalles', 'reception_request_id']);
const UPLOAD_FIELDS = new Set(['factura', 'upload_request_id']);
const INVOICE_FIELDS = new Set(['nombre_original', 'mime_type', 'data_url']);
const DETAIL_FIELDS = new Set(['id_solicitud_detalle', 'cantidad_recibida']);
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

const normalizeUuid = (value, field) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_REGEX.test(normalized)) fail(400, 'VALIDATION_ERROR', `${field} debe ser un UUID valido.`);
  return normalized;
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalQuantity = (value) => {
  const text = String(value ?? '').trim();
  const [whole, fraction = ''] = text.split('.');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole;
};

export const buildReceptionFingerprint = ({ requestId, observation, details }) => sha256(JSON.stringify({
  id_solicitud_compra: Number(requestId),
  observacion_recepcion: observation,
  detalles: details.map((detail) => ({
    id_solicitud_detalle: Number(detail.id_solicitud_detalle),
    cantidad_recibida: canonicalQuantity(detail.rawQuantity)
  })).sort((left, right) => left.id_solicitud_detalle - right.id_solicitud_detalle)
}));

export const buildUploadFingerprint = ({ requestId, invoice }) => sha256(JSON.stringify({
  id_solicitud_compra: Number(requestId),
  nombre: invoice.originalName.toLowerCase(),
  mime: invoice.mimeType,
  contenido_sha256: sha256(invoice.buffer)
}));

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
  return {
    invoice,
    details,
    observation: normalizeObservation(body.observacion_recepcion),
    receptionRequestId: normalizeUuid(body.reception_request_id, 'reception_request_id')
  };
};

const validateUploadPayload = (body) => {
  ensurePlainObject(body, 'El payload debe ser un objeto.');
  rejectUnexpectedFields(body, UPLOAD_FIELDS, 'El payload');
  const invoice = decodeInvoice(body.factura);
  return { invoice, uploadRequestId: normalizeUuid(body.upload_request_id, 'upload_request_id') };
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

export const parseReceivedQuantity = (value, type) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (type !== 'PRODUCTO') {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) return null;
    return parseQuantity(text) || (canonicalQuantity(text) === '0' ? { decimal: '0', scaled: 0n } : null);
  }
  const integerEquivalent = /^(?:0|[1-9]\d*)(?:\.0{1,6})?$/.exec(text);
  if (!integerEquivalent) return null;
  const integer = text.split('.')[0];
  return parseQuantity(integer, { integerOnly: true }) || (integer === '0' ? { decimal: '0', scaled: 0n } : null);
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
      ? 'La cantidad recibida de un producto debe ser cero o un entero positivo.'
      : 'La cantidad recibida de un insumo debe ser no negativa y tener hasta 6 decimales.');
    if (received.scaled !== approved.scaled) hasDifference = true;
    const factor = type === 'PRODUCTO' ? '1' : String(row.factor_conversion_snapshot ?? '').trim();
    return {
      id: line.id_solicitud_detalle,
      type,
      masterId: parsePositiveIntStrict(type === 'PRODUCTO' ? row.id_producto : row.id_insumo),
      received: received.decimal,
      receivedBase: received.scaled === 0n ? '0' : (type === 'PRODUCTO' ? received.decimal : multiplyApprovedQuantityToBase(received.decimal, factor)),
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
  `SELECT id_solicitud_compra, id_sucursal, id_almacen, estado, inventario_aplicado, fecha_inventario_aplicado,
          id_usuario_recepcion, fecha_recepcion, reception_request_id, reception_request_fingerprint
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

const loadReceptionResult = async (runner, requestId) => {
  const result = await runner.query(
    `SELECT sc.id_solicitud_compra, sc.estado, sc.id_usuario_recepcion, sc.fecha_recepcion, sc.inventario_aplicado,
            COUNT(DISTINCT d.id_solicitud_detalle)::int AS total_lineas,
            COUNT(DISTINCT mi.id_movimiento)::int AS total_movimientos
     FROM public.solicitudes_compra sc
     LEFT JOIN public.solicitudes_compra_detalle d ON d.id_solicitud_compra = sc.id_solicitud_compra
     LEFT JOIN public.movimientos_inventario mi ON mi.ref_origen = 'SOLICITUD_COMPRA' AND mi.id_ref = sc.id_solicitud_compra
     WHERE sc.id_solicitud_compra = $1
     GROUP BY sc.id_solicitud_compra`, [requestId]
  );
  return result.rows?.[0] || null;
};

const formatReceptionResult = (row, replay = false) => ({
  ok: true,
  mensaje: 'Solicitud recibida e inventario actualizado correctamente.',
  replay,
  solicitud: {
    id_solicitud_compra: Number(row.id_solicitud_compra), estado: row.estado,
    id_usuario_recepcion: Number(row.id_usuario_recepcion), fecha_recepcion: row.fecha_recepcion,
    inventario_aplicado: row.inventario_aplicado,
    total_lineas: Number(row.total_lineas), total_movimientos: Number(row.total_movimientos)
  }
});

export const createSolicitudesCompraRecepcionService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveScope: overrides.resolveScope || resolveRequestUserSucursalScope,
    resolveMaster: overrides.resolveMaster || resolveCatalogoMaestroEntity,
    getAssignment: overrides.getAssignment || getWarehouseAssignmentDetails,
    validateAssignmentsBatch: overrides.validateAssignmentsBatch || validateWarehouseAssignmentsBatch,
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

  const findUpload = async (runner, uploadRequestId) => (await runner.query(
    `SELECT e.id_evidencia, e.id_archivo, e.upload_request_fingerprint,
            a.nombre_original, a.tipo_archivo, a.tamano_bytes, a.url_publica
     FROM public.solicitudes_compra_evidencias e
     INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo
     WHERE e.upload_request_id = $1::uuid`, [uploadRequestId]
  )).rows?.[0] || null;

  const formatEvidence = (row) => ({
    id_evidencia: Number(row.id_evidencia), id_archivo: Number(row.id_archivo),
    nombre_original: row.nombre_original, tipo_archivo: row.tipo_archivo,
    tamano_bytes: Number(row.tamano_bytes)
  });

  const persistInvoiceEvidence = async ({ client, requestId, access, invoice, uploadedPaths, uploadRequestId = null }) => {
    const fingerprint = uploadRequestId ? buildUploadFingerprint({ requestId, invoice }) : null;
    if (uploadRequestId) {
      const existing = await findUpload(client, uploadRequestId);
      if (existing) {
        if (existing.upload_request_fingerprint !== fingerprint) {
          fail(409, 'IDEMPOTENCY_CONFLICT', 'upload_request_id ya fue utilizado con otro archivo.');
        }
        return { evidence: formatEvidence(existing), replay: true };
      }
    }
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
        (id_solicitud_compra, id_archivo, tipo_evidencia, id_usuario_registro, upload_request_id, upload_request_fingerprint)
       VALUES ($1, $2, 'FACTURA', $3, $4::uuid, $5)
       RETURNING id_evidencia`,
      [requestId, fileId, access.idUsuario, uploadRequestId, fingerprint]
    );
    const evidenceId = Number(evidenceResult.rows?.[0]?.id_evidencia);
    if (!evidenceId) fail(500, 'INTERNAL_ERROR', 'No se pudo vincular la factura a la solicitud.');
    return { evidence: {
      id_evidencia: evidenceId,
      id_archivo: fileId,
      nombre_original: invoice.originalName,
      tipo_archivo: invoice.mimeType,
      tamano_bytes: invoice.buffer.length
    }, replay: false };
  };

  const receive = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const payload = validatePayload(req.body);
    const fingerprint = buildReceptionFingerprint({ requestId, observation: payload.observation, details: payload.details });
    const startedAt = dependencies.now();
    const metrics = { request_id: payload.receptionRequestId, id_solicitud_compra: requestId };

    const accessStarted = dependencies.now();
    const access = await assertAccess(req, dependencies.db, dependencies);
    metrics.access_ms = dependencies.now() - accessStarted;
    const prevalidationStarted = dependencies.now();
    const preHeader = await loadHeader(dependencies.db, requestId);
    assertBranchAccess(preHeader, access);
    if (String(preHeader.reception_request_id || '').toLowerCase() === payload.receptionRequestId) {
      if (preHeader.reception_request_fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'reception_request_id ya fue utilizado con otro payload.');
      if (String(preHeader.estado).toUpperCase() === 'RECIBIDA' && preHeader.inventario_aplicado === true) {
        const replay = formatReceptionResult(await loadReceptionResult(dependencies.db, requestId), true);
        console.info('[solicitudes_compra.recepcion]', { ...metrics, total_ms: dependencies.now() - startedAt, replay: true });
        return replay;
      }
    }
    assertHeader(preHeader, access);
    const preDetails = normalizeDetails(payload.details, await loadDetails(dependencies.db, requestId));
    if (preDetails.hasDifference && !payload.observation) {
      fail(400, 'VALIDATION_ERROR', 'observacion_recepcion es obligatoria cuando existen diferencias.');
    }
    metrics.prevalidation_ms = dependencies.now() - prevalidationStarted;

    let client;
    let transactionStarted = false;
    const uploadedPaths = [];
    try {
      client = await dependencies.db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const txAccess = await assertAccess(req, client, dependencies);
      const lockStarted = dependencies.now();
      const header = await loadHeader(client, requestId, { lock: true });
      metrics.lock_wait_ms = dependencies.now() - lockStarted;
      assertBranchAccess(header, txAccess);
      if (String(header.reception_request_id || '').toLowerCase() === payload.receptionRequestId) {
        if (header.reception_request_fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'reception_request_id ya fue utilizado con otro payload.');
        if (String(header.estado).toUpperCase() === 'RECIBIDA' && header.inventario_aplicado === true) {
          const replayRow = await loadReceptionResult(client, requestId);
          await client.query('COMMIT'); transactionStarted = false;
          console.info('[solicitudes_compra.recepcion]', { ...metrics, total_ms: dependencies.now() - startedAt, replay: true });
          return formatReceptionResult(replayRow, true);
        }
      }
      assertHeader(header, txAccess);
      const validationStarted = dependencies.now();
      const details = normalizeDetails(payload.details, await loadDetails(client, requestId, { lock: true }));
      if (details.hasDifference && !payload.observation) {
        fail(400, 'VALIDATION_ERROR', 'observacion_recepcion es obligatoria cuando existen diferencias.');
      }
      metrics.validation_ms = dependencies.now() - validationStarted;
      metrics.total_lines = details.normalized.length;
      metrics.positive_lines = details.normalized.filter((detail) => detail.receivedBase !== '0').length;
      metrics.zero_lines = details.normalized.length - metrics.positive_lines;

      const inventoryValidationStarted = dependencies.now();
      if (details.normalized.some((detail) => !detail.masterId)) fail(409, 'CONFLICT', 'La linea no conserva un item maestro valido.');
      const validations = await dependencies.validateAssignmentsBatch(details.normalized, Number(header.id_almacen), client);
      if (validations.length !== details.normalized.length || validations.some((row) => !row.existe || !row.activo || !row.asignado)) {
        fail(409, 'CONFLICT', 'Uno o mas items ya no estan activos o no tienen asignacion activa en el almacen.');
      }
      metrics.inventory_validation_ms = dependencies.now() - inventoryValidationStarted;

      const legacyEvidence = payload.invoice
        ? (await persistInvoiceEvidence({ client, requestId, access: txAccess, invoice: payload.invoice, uploadedPaths })).evidence
        : null;
      const evidenceCount = await countInvoiceEvidence(client, requestId);
      if (evidenceCount < 1) {
        fail(409, 'FACTURA_REQUIRED', 'Debes cargar al menos una imagen de factura antes de confirmar la recepcion.');
      }

      const ids = details.normalized.map((detail) => detail.id);
      const receivedQuantities = details.normalized.map((detail) => detail.received);
      const receivedBase = details.normalized.map((detail) => detail.receivedBase);
      const detailsUpdateStarted = dependencies.now();
      const update = await client.query(
        `UPDATE public.solicitudes_compra_detalle d
         SET cantidad_recibida = v.cantidad_recibida, cantidad_base_recibida = v.cantidad_base_recibida,
             fecha_actualizacion = NOW()
         FROM UNNEST($1::int[], $2::numeric[], $3::numeric[]) AS v(id, cantidad_recibida, cantidad_base_recibida)
         WHERE d.id_solicitud_detalle = v.id AND d.id_solicitud_compra = $4`, [ids, receivedQuantities, receivedBase, requestId]
      );
      if (update.rowCount !== details.normalized.length) fail(409, 'CONFLICT', 'Una linea cambio durante la recepcion.');
      metrics.details_update_ms = dependencies.now() - detailsUpdateStarted;

      const positive = details.normalized.filter((detail) => detail.receivedBase !== '0');
      const movementsStarted = dependencies.now();
      if (positive.length) {
        await client.query(
          `INSERT INTO public.movimientos_inventario
            (tipo, cantidad, id_almacen, id_producto, id_insumo, ref_origen, id_ref, descripcion)
           SELECT 'ENTRADA', v.cantidad, $1, v.id_producto, v.id_insumo, 'SOLICITUD_COMPRA', $2, $3
           FROM UNNEST($4::numeric[], $5::int[], $6::int[]) AS v(cantidad, id_producto, id_insumo)`,
          [Number(header.id_almacen), requestId, `Recepcion de solicitud de compra #${requestId}`,
            positive.map((detail) => detail.receivedBase), positive.map((detail) => detail.idProducto), positive.map((detail) => detail.idInsumo)]
        );
      }
      metrics.movements_ms = dependencies.now() - movementsStarted;

      const headerResult = await client.query(
        `UPDATE public.solicitudes_compra
         SET estado = 'RECIBIDA', id_usuario_recepcion = $2, fecha_recepcion = NOW(),
             observacion_recepcion = $3, inventario_aplicado = true, fecha_inventario_aplicado = NOW(),
             reception_request_id = $4::uuid, reception_request_fingerprint = $5
         WHERE id_solicitud_compra = $1 AND estado = 'APROBADA' AND inventario_aplicado = false
         RETURNING id_solicitud_compra, estado, id_usuario_recepcion, fecha_recepcion, inventario_aplicado`,
        [requestId, txAccess.idUsuario, payload.observation, payload.receptionRequestId, fingerprint]
      );
      if (headerResult.rowCount !== 1) fail(409, 'INVALID_STATE', 'La solicitud cambio durante la recepcion.');
      const commitStarted = dependencies.now();
      await client.query('COMMIT');
      metrics.commit_ms = dependencies.now() - commitStarted;
      transactionStarted = false;
      const received = headerResult.rows[0];
      const response = {
        ...formatReceptionResult({
          id_solicitud_compra: Number(received.id_solicitud_compra), estado: received.estado,
          id_usuario_recepcion: Number(received.id_usuario_recepcion), fecha_recepcion: received.fecha_recepcion,
          inventario_aplicado: received.inventario_aplicado, total_lineas: details.normalized.length,
          total_movimientos: positive.length
        }),
        ...(legacyEvidence ? { evidencia: legacyEvidence } : {})
      };
      console.info('[solicitudes_compra.recepcion]', { ...metrics, total_ms: dependencies.now() - startedAt, replay: false });
      return response;
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
    const { invoice, uploadRequestId } = validateUploadPayload(req.body);
    let client;
    let transactionStarted = false;
    const uploadedPaths = [];
    try {
      client = await dependencies.db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const access = await assertAccess(req, client, dependencies);
      const header = await loadHeader(client, requestId, { lock: true });
      assertBranchAccess(header, access);
      const fingerprint = buildUploadFingerprint({ requestId, invoice });
      const existing = await findUpload(client, uploadRequestId);
      if (existing) {
        if (existing.upload_request_fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'upload_request_id ya fue utilizado con otro archivo.');
        await client.query('COMMIT'); transactionStarted = false;
        return { ok: true, replay: true, evidencia: formatEvidence(existing) };
      }
      assertHeader(header, access);
      const persisted = await persistInvoiceEvidence({ client, requestId, access, invoice, uploadedPaths, uploadRequestId });
      await client.query('COMMIT');
      transactionStarted = false;
      return { ok: true, replay: persisted.replay, evidencia: persisted.evidence };
    } catch (error) {
      if (transactionStarted && client) await safeRollback(client);
      await cleanupUploadedPaths(uploadedPaths);
      throw mapError(error);
    } finally {
      client?.release();
    }
  };

  const reconcileReception = async (req) => {
    const receptionRequestId = normalizeUuid(req.params?.reception_request_id, 'reception_request_id');
    const access = await assertAccess(req, dependencies.db, dependencies);
    const header = (await dependencies.db.query(
      `SELECT id_solicitud_compra, id_sucursal, id_almacen, estado, inventario_aplicado, fecha_recepcion
       FROM public.solicitudes_compra WHERE reception_request_id = $1::uuid`, [receptionRequestId]
    )).rows?.[0];
    if (!header) fail(404, 'NOT_CONFIRMED', 'La recepcion todavia no ha sido confirmada.');
    assertBranchAccess(header, access);
    if (String(header.estado).toUpperCase() !== 'RECIBIDA' || header.inventario_aplicado !== true) {
      fail(404, 'NOT_CONFIRMED', 'La recepcion todavia no ha sido confirmada.');
    }
    const result = await loadReceptionResult(dependencies.db, Number(header.id_solicitud_compra));
    return { ok: true, confirmed: true, solicitud: formatReceptionResult(result, true).solicitud };
  };

  const reconcileInvoiceUpload = async (req) => {
    const requestId = parsePositiveIntStrict(req.params?.id_solicitud_compra);
    const uploadRequestId = normalizeUuid(req.params?.upload_request_id, 'upload_request_id');
    if (!requestId) fail(400, 'VALIDATION_ERROR', 'id_solicitud_compra debe ser un entero positivo.');
    const access = await assertAccess(req, dependencies.db, dependencies);
    const header = await loadHeader(dependencies.db, requestId);
    assertBranchAccess(header, access);
    const existing = await findUpload(dependencies.db, uploadRequestId);
    if (!existing || Number((await dependencies.db.query(
      'SELECT id_solicitud_compra FROM public.solicitudes_compra_evidencias WHERE id_evidencia = $1',
      [Number(existing.id_evidencia)]
    )).rows?.[0]?.id_solicitud_compra) !== requestId) {
      fail(404, 'NOT_CONFIRMED', 'La evidencia todavia no ha sido confirmada.');
    }
    return { ok: true, confirmed: true, evidencia: formatEvidence(existing) };
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

  return { receive, reconcileReception, uploadInvoiceEvidence, reconcileInvoiceUpload, deleteInvoiceEvidence, listEvidence };
};

export const solicitudesCompraRecepcionService = createSolicitudesCompraRecepcionService();
