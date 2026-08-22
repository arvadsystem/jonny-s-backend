import crypto from 'crypto';
import pool from '../config/db-connection.js';
import { readRequestAccess } from '../middleware/checkPermission.js';
import { supabase } from './supabaseClient.js';
import { SolicitudesCompraError, parsePositiveIntStrict, resolveOperativeWarehouseId } from './solicitudesCompraService.js';
import { normalizeInvoiceName } from './solicitudesCompraRecepcionService.js';
import { SUPABASE_ADMIN_BUCKET, detectFileMimeTypeFromBuffer } from '../utils/uploads.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const MAX_FILE_BYTES = 6 * 1024 * 1024;
const MAX_EVIDENCES = 10;
const SIGNED_URL_SECONDS = 300;
const OPERATIVE_ROLES = new Set(['CAJERO', 'COCINA', 'COCINERO', 'COCINERA', 'JEFA_COCINA', 'JEFE_COCINA']);
const FORBIDDEN_CREATE_ROLES = new Set(['ADMIN', 'ROOT', 'ADMINISTRADOR', 'SUPER_ADMIN']);
const ALLOWED_MIMES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const INVOICE_FIELDS = new Set(['nombre_original', 'mime_type', 'data_url']);
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;
const CAPTURE_STATES = new Set(['BORRADOR', 'PENDIENTE', 'FORMALIZADA', 'RECHAZADA']);

const fail = (status, code, message) => { throw new SolicitudesCompraError(status, code, message); };
const normalizeRole = (value) => String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase();
const ensurePlainObject = (value, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'VALIDATION_ERROR', message);
};
const rejectUnexpectedFields = (value, allowed, context) => {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(400, 'VALIDATION_ERROR', `${context} contiene campos no permitidos: ${unexpected.join(', ')}.`);
};
const normalizeSearch = (value) => {
  const search = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (search.length > 120) fail(400, 'VALIDATION_ERROR', 'La busqueda no puede exceder 120 caracteres.');
  return search;
};
const normalizeRejectReason = (value) => {
  const reason = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!reason || reason.length > 1000) fail(400, 'VALIDATION_ERROR', 'El motivo del rechazo es obligatorio y no puede exceder 1000 caracteres.');
  return reason;
};

export const decodeQuickCaptureInvoice = (invoice) => {
  ensurePlainObject(invoice, 'factura es obligatoria y debe ser un objeto.');
  rejectUnexpectedFields(invoice, INVOICE_FIELDS, 'factura');
  const declaredMime = String(invoice.mime_type ?? '').trim().toLowerCase();
  if (!Object.hasOwn(ALLOWED_MIMES, declaredMime)) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'La factura debe ser una imagen JPEG, PNG o WEBP.');
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(invoice.data_url ?? '').trim());
  if (!match || match[1].toLowerCase() !== declaredMime || !BASE64_REGEX.test(match[2]) || match[2].length % 4 !== 0) {
    fail(400, 'VALIDATION_ERROR', 'data_url de factura no es valido o no coincide con mime_type.');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) fail(400, 'VALIDATION_ERROR', 'La factura esta vacia o contiene base64 invalido.');
  if (buffer.length > MAX_FILE_BYTES) fail(413, 'FILE_TOO_LARGE', 'La factura no puede exceder 6 MB.');
  if (detectFileMimeTypeFromBuffer(buffer) !== declaredMime) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'El contenido no coincide con el MIME declarado.');
  return { buffer, mimeType: declaredMime, extension: ALLOWED_MIMES[declaredMime], originalName: normalizeInvoiceName(invoice.nombre_original) };
};

const storageAdapter = {
  async upload(path, buffer, mimeType) {
    const { error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).upload(path, buffer, { contentType: mimeType, cacheControl: '3600', upsert: false });
    if (error) throw error;
  },
  async remove(path) {
    const { error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).remove([path]);
    if (error) throw error;
  },
  async signedUrl(path) {
    const { data, error } = await supabase.storage.from(SUPABASE_ADMIN_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error || !data?.signedUrl) throw error || new Error('Signed URL unavailable');
    return data.signedUrl;
  }
};

const mapError = (error) => {
  if (error instanceof SolicitudesCompraError) return error;
  if (['23502', '23503', '23514', '22P02', '22003'].includes(error?.code)) return new SolicitudesCompraError(400, 'VALIDATION_ERROR', 'Los datos de la captura no son validos.');
  if (error?.code === '23505') return new SolicitudesCompraError(409, 'CONFLICT', 'La captura entra en conflicto con datos existentes.');
  return new SolicitudesCompraError(500, 'INTERNAL_ERROR', 'No se pudo completar la operacion de captura rapida.');
};
const rollback = async (client) => { try { await client.query('ROLLBACK'); } catch { /* AM: conserva error principal. */ } };
const objectPathFromStored = (stored) => {
  const prefix = `${SUPABASE_ADMIN_BUCKET}/`;
  return String(stored || '').startsWith(prefix) ? String(stored).slice(prefix.length) : null;
};

const readAccess = async (req, runner, dependencies, { mutation = false } = {}) => {
  const raw = await dependencies.readAccess(req, runner);
  if (!raw?.idUsuario) fail(401, 'UNAUTHORIZED', 'No autorizado.');
  const roles = new Set(Array.from(raw.roles || []).map(normalizeRole));
  const hasForbiddenCreateRole = Array.from(roles).some((role) => FORBIDDEN_CREATE_ROLES.has(role));
  const isOperative = !hasForbiddenCreateRole && Array.from(roles).some((role) => OPERATIVE_ROLES.has(role));
  const isAdministrative = Boolean(raw.isSuperAdmin) || roles.has('SUPER_ADMIN') || roles.has('ADMINISTRADOR');
  if (mutation && !isOperative) fail(403, 'FORBIDDEN', 'El rol del usuario no puede operar capturas rapidas.');
  if (!mutation && !isOperative && !isAdministrative) fail(403, 'FORBIDDEN', 'El rol del usuario no puede consultar capturas rapidas.');
  return { idUsuario: Number(raw.idUsuario), roles, isOperative, isAdministrative };
};

const loadLocked = async (client, id) => (await client.query(
  `SELECT id_captura_compra_rapida, id_sucursal, id_almacen, id_usuario_registro, estado,
          fecha_creacion, fecha_envio, id_solicitud_compra
   FROM public.capturas_compra_rapida
   WHERE id_captura_compra_rapida = $1
   FOR UPDATE`, [id]
)).rows?.[0];
const assertOwnerDraft = (row, access) => {
  if (!row || Number(row.id_usuario_registro) !== access.idUsuario) fail(404, 'NOT_FOUND', 'Captura rapida no encontrada.');
  if (String(row.estado).toUpperCase() !== 'BORRADOR') fail(409, 'INVALID_STATE', 'La captura ya no se encuentra en BORRADOR.');
};

export const createCapturasCompraRapidaService = (overrides = {}) => {
  const dependencies = {
    db: overrides.db || pool,
    readAccess: overrides.readAccess || readRequestAccess,
    resolveScope: overrides.resolveScope || resolveRequestUserSucursalScope,
    resolveWarehouse: overrides.resolveWarehouse || resolveOperativeWarehouseId,
    storage: overrides.storage || storageAdapter,
    now: overrides.now || (() => Date.now()),
    uuid: overrides.uuid || (() => crypto.randomUUID())
  };

  const cleanup = async (paths) => {
    for (const path of paths.filter(Boolean)) {
      try { await dependencies.storage.remove(path); } catch (error) {
        console.warn('[capturas_compra_rapida] limpieza Storage pendiente', { code: error?.code || null });
      }
    }
  };

  const create = async (req) => {
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, new Set(), 'El payload');
    const access = await readAccess(req, dependencies.db, dependencies, { mutation: true });
    const scope = await dependencies.resolveScope(req, dependencies.db);
    const branchId = Number(scope?.userSucursalId || 0);
    if (!Number.isInteger(branchId) || branchId <= 0) fail(403, 'FORBIDDEN', 'El usuario no tiene sucursal operativa asignada.');
    const warehouseId = await dependencies.resolveWarehouse(dependencies.db, branchId);
    const result = await dependencies.db.query(
      `INSERT INTO public.capturas_compra_rapida
        (id_sucursal, id_almacen, id_usuario_registro, estado)
       VALUES ($1, $2, $3, 'BORRADOR')
       RETURNING id_captura_compra_rapida, id_sucursal, id_almacen, id_usuario_registro, estado, fecha_creacion`,
      [branchId, warehouseId, access.idUsuario]
    );
    return { ok: true, captura: result.rows[0] };
  };

  const uploadInvoice = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_captura);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, new Set(['factura']), 'El payload');
    const invoice = decodeQuickCaptureInvoice(req.body.factura);
    const client = await dependencies.db.connect();
    let started = false;
    let uploadedPath = null;
    try {
      await client.query('BEGIN'); started = true;
      const access = await readAccess(req, client, dependencies, { mutation: true });
      const capture = await loadLocked(client, id);
      assertOwnerDraft(capture, access);
      const count = await client.query(`SELECT COUNT(*)::int AS total FROM public.capturas_compra_rapida_evidencias WHERE id_captura_compra_rapida = $1`, [id]);
      if (Number(count.rows?.[0]?.total || 0) >= MAX_EVIDENCES) fail(409, 'FACTURA_EVIDENCE_LIMIT', 'La captura admite un maximo de 10 imagenes.');
      uploadedPath = `solicitudes_compra/capturas-rapidas/${id}/factura-${dependencies.now()}-${dependencies.uuid()}.${invoice.extension}`;
      try { await dependencies.storage.upload(uploadedPath, invoice.buffer, invoice.mimeType); } catch { fail(502, 'STORAGE_ERROR', 'No se pudo guardar la factura privada.'); }
      const file = await client.query(
        `INSERT INTO public.archivos (nombre_original, url_publica, tipo_archivo, tamano_bytes, id_usuario, estado)
         VALUES ($1, $2, $3, $4, $5, true) RETURNING id_archivo`,
        [invoice.originalName, `${SUPABASE_ADMIN_BUCKET}/${uploadedPath}`, invoice.mimeType, invoice.buffer.length, access.idUsuario]
      );
      const evidence = await client.query(
        `INSERT INTO public.capturas_compra_rapida_evidencias
          (id_captura_compra_rapida, id_archivo, tipo_evidencia, id_usuario_registro)
         VALUES ($1, $2, 'FACTURA', $3)
         RETURNING id_captura_evidencia, fecha_registro`,
        [id, Number(file.rows?.[0]?.id_archivo), access.idUsuario]
      );
      await client.query('COMMIT'); started = false;
      return { ok: true, evidencia: { id_evidencia: Number(evidence.rows[0].id_captura_evidencia), nombre_original: invoice.originalName, mime_type: invoice.mimeType, fecha_registro: evidence.rows[0].fecha_registro } };
    } catch (error) {
      if (started) await rollback(client);
      if (uploadedPath) await cleanup([uploadedPath]);
      throw mapError(error);
    } finally { client.release(); }
  };

  const deleteEvidence = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_captura);
    const evidenceId = parsePositiveIntStrict(req.params?.id_evidencia);
    if (!id || !evidenceId) fail(400, 'VALIDATION_ERROR', 'Los identificadores deben ser enteros positivos.');
    const client = await dependencies.db.connect(); let started = false; let path = null;
    try {
      await client.query('BEGIN'); started = true;
      const access = await readAccess(req, client, dependencies, { mutation: true });
      assertOwnerDraft(await loadLocked(client, id), access);
      const evidence = await client.query(
        `SELECT e.id_captura_evidencia, e.id_archivo, a.url_publica
         FROM public.capturas_compra_rapida_evidencias e
         INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo
         WHERE e.id_captura_compra_rapida = $1 AND e.id_captura_evidencia = $2 FOR UPDATE`, [id, evidenceId]
      );
      if (!evidence.rows?.[0]) fail(404, 'NOT_FOUND', 'Evidencia no encontrada.');
      path = objectPathFromStored(evidence.rows[0].url_publica);
      await client.query(`DELETE FROM public.capturas_compra_rapida_evidencias WHERE id_captura_evidencia = $1`, [evidenceId]);
      await client.query(`UPDATE public.archivos SET estado = false WHERE id_archivo = $1`, [evidence.rows[0].id_archivo]);
      await client.query('COMMIT'); started = false;
      await cleanup([path]);
      return { ok: true, mensaje: 'Factura eliminada correctamente.' };
    } catch (error) { if (started) await rollback(client); throw mapError(error); } finally { client.release(); }
  };

  const discard = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_captura);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    const client = await dependencies.db.connect(); let started = false; const paths = [];
    try {
      await client.query('BEGIN'); started = true;
      const access = await readAccess(req, client, dependencies, { mutation: true });
      assertOwnerDraft(await loadLocked(client, id), access);
      const files = await client.query(
        `SELECT e.id_archivo, a.url_publica FROM public.capturas_compra_rapida_evidencias e
         INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo WHERE e.id_captura_compra_rapida = $1 FOR UPDATE`, [id]
      );
      for (const row of files.rows || []) paths.push(objectPathFromStored(row.url_publica));
      const fileIds = (files.rows || []).map((row) => Number(row.id_archivo));
      if (fileIds.length) await client.query(`UPDATE public.archivos SET estado = false WHERE id_archivo = ANY($1::int[])`, [fileIds]);
      await client.query(`DELETE FROM public.capturas_compra_rapida WHERE id_captura_compra_rapida = $1`, [id]);
      await client.query('COMMIT'); started = false;
      await cleanup(paths);
      return { ok: true, mensaje: 'Borrador descartado correctamente.' };
    } catch (error) { if (started) await rollback(client); throw mapError(error); } finally { client.release(); }
  };

  const send = async (req) => {
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, new Set(), 'El payload');
    const id = parsePositiveIntStrict(req.params?.id_captura);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    const client = await dependencies.db.connect(); let started = false;
    try {
      await client.query('BEGIN'); started = true;
      const access = await readAccess(req, client, dependencies, { mutation: true });
      assertOwnerDraft(await loadLocked(client, id), access);
      const count = await client.query(`SELECT COUNT(*)::int AS total FROM public.capturas_compra_rapida_evidencias WHERE id_captura_compra_rapida = $1 AND tipo_evidencia = 'FACTURA'`, [id]);
      if (Number(count.rows?.[0]?.total || 0) < 1) fail(409, 'FACTURA_REQUIRED', 'Debes guardar al menos una factura antes de enviar.');
      const result = await client.query(
        `UPDATE public.capturas_compra_rapida SET estado = 'PENDIENTE', fecha_envio = NOW()
         WHERE id_captura_compra_rapida = $1 AND id_usuario_registro = $2 AND estado = 'BORRADOR'
         RETURNING id_captura_compra_rapida, estado, fecha_envio`, [id, access.idUsuario]
      );
      if (result.rowCount !== 1) fail(409, 'INVALID_STATE', 'La captura cambio y ya no puede enviarse.');
      await client.query('COMMIT'); started = false;
      return { ok: true, captura: result.rows[0] };
    } catch (error) { if (started) await rollback(client); throw mapError(error); } finally { client.release(); }
  };

  const list = async (req) => {
    const access = await readAccess(req, dependencies.db, dependencies);
    const page = parsePositiveIntStrict(req.query?.page) || 1;
    const limit = Math.min(parsePositiveIntStrict(req.query?.limit) || 10, 100);
    const state = String(req.query?.estado ?? '').trim().toUpperCase();
    if (state && !CAPTURE_STATES.has(state)) fail(400, 'VALIDATION_ERROR', 'estado no es valido.');
    const search = normalizeSearch(req.query?.buscar);
    const params = [];
    const conditions = [];
    if (access.isOperative) conditions.push(`c.id_usuario_registro = $${params.push(access.idUsuario)}`);
    if (state) conditions.push(`c.estado = $${params.push(state)}`);
    if (search) {
      const ref = `$${params.push(search)}`;
      const numeric = /^\d+$/.test(search) ? Number(search) : null;
      conditions.push(`(
        ${numeric ? `c.id_captura_compra_rapida = $${params.push(numeric)} OR` : ''}
        u.nombre_usuario ILIKE '%' || ${ref} || '%'
        OR COALESCE(p.nombre, '') ILIKE '%' || ${ref} || '%'
        OR COALESCE(p.apellido, '') ILIKE '%' || ${ref} || '%'
        OR s.nombre_sucursal ILIKE '%' || ${ref} || '%'
        OR a.nombre ILIKE '%' || ${ref} || '%'
      )`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit, (page - 1) * limit);
    const result = await dependencies.db.query(
      `SELECT c.id_captura_compra_rapida, c.estado, c.id_sucursal, c.id_almacen, c.fecha_creacion, c.fecha_envio,
              c.fecha_gestion, c.id_solicitud_compra, c.motivo_rechazo,
              JSON_BUILD_OBJECT('id', s.id_sucursal, 'nombre', s.nombre_sucursal) AS sucursal,
              JSON_BUILD_OBJECT('id', a.id_almacen, 'nombre', a.nombre) AS almacen,
              JSON_BUILD_OBJECT('id_usuario', u.id_usuario, 'nombre', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), ''), u.nombre_usuario), 'nombre_usuario', u.nombre_usuario) AS registrador,
              CASE WHEN ug.id_usuario IS NULL THEN NULL ELSE JSON_BUILD_OBJECT('id_usuario', ug.id_usuario, 'nombre', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pg.nombre, pg.apellido)), ''), ug.nombre_usuario), 'nombre_usuario', ug.nombre_usuario) END AS gestor,
              COUNT(e.id_captura_evidencia)::int AS cantidad_evidencias,
              COUNT(*) OVER()::int AS total_count
       FROM public.capturas_compra_rapida c
       INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
       INNER JOIN public.almacenes a ON a.id_almacen = c.id_almacen
       INNER JOIN public.usuarios u ON u.id_usuario = c.id_usuario_registro
       LEFT JOIN public.empleados er ON er.id_empleado = u.id_empleado
       LEFT JOIN public.personas p ON p.id_persona = er.id_persona
       LEFT JOIN public.usuarios ug ON ug.id_usuario = c.id_usuario_gestion
       LEFT JOIN public.empleados eg ON eg.id_empleado = ug.id_empleado
       LEFT JOIN public.personas pg ON pg.id_persona = eg.id_persona
       LEFT JOIN public.capturas_compra_rapida_evidencias e ON e.id_captura_compra_rapida = c.id_captura_compra_rapida
       ${where}
       GROUP BY c.id_captura_compra_rapida, s.id_sucursal, s.nombre_sucursal, a.id_almacen, a.nombre,
                u.id_usuario, p.nombre, p.apellido, ug.id_usuario, pg.nombre, pg.apellido
       ORDER BY CASE c.estado WHEN 'PENDIENTE' THEN 1 WHEN 'BORRADOR' THEN 2 WHEN 'RECHAZADA' THEN 3 ELSE 4 END,
                COALESCE(c.fecha_envio, c.fecha_creacion) DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const total = Number(result.rows?.[0]?.total_count || 0);
    return { ok: true, capturas: (result.rows || []).map(({ total_count, ...row }) => row), pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } };
  };

  const detail = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_captura);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    const access = await readAccess(req, dependencies.db, dependencies);
    const params = [id];
    const ownerWhere = access.isOperative ? ` AND c.id_usuario_registro = $${params.push(access.idUsuario)}` : '';
    const result = await dependencies.db.query(
      `SELECT c.id_captura_compra_rapida, c.estado, c.id_sucursal, c.id_almacen, c.fecha_creacion, c.fecha_envio,
              c.fecha_gestion, c.id_solicitud_compra, c.observacion, c.motivo_rechazo,
              JSON_BUILD_OBJECT('id', s.id_sucursal, 'nombre', s.nombre_sucursal) AS sucursal,
              JSON_BUILD_OBJECT('id', a.id_almacen, 'nombre', a.nombre) AS almacen,
              JSON_BUILD_OBJECT('id_usuario', u.id_usuario, 'nombre', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', p.nombre, p.apellido)), ''), u.nombre_usuario), 'nombre_usuario', u.nombre_usuario) AS registrador,
              CASE WHEN ug.id_usuario IS NULL THEN NULL ELSE JSON_BUILD_OBJECT('id_usuario', ug.id_usuario, 'nombre', COALESCE(NULLIF(TRIM(CONCAT_WS(' ', pg.nombre, pg.apellido)), ''), ug.nombre_usuario), 'nombre_usuario', ug.nombre_usuario) END AS gestor,
              (SELECT COUNT(*)::int FROM public.capturas_compra_rapida_evidencias e WHERE e.id_captura_compra_rapida = c.id_captura_compra_rapida) AS cantidad_evidencias
       FROM public.capturas_compra_rapida c
       INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
       INNER JOIN public.almacenes a ON a.id_almacen = c.id_almacen
       INNER JOIN public.usuarios u ON u.id_usuario = c.id_usuario_registro
       LEFT JOIN public.empleados er ON er.id_empleado = u.id_empleado
       LEFT JOIN public.personas p ON p.id_persona = er.id_persona
       LEFT JOIN public.usuarios ug ON ug.id_usuario = c.id_usuario_gestion
       LEFT JOIN public.empleados eg ON eg.id_empleado = ug.id_empleado
       LEFT JOIN public.personas pg ON pg.id_persona = eg.id_persona
       WHERE c.id_captura_compra_rapida = $1${ownerWhere}`, params
    );
    if (!result.rows?.[0]) fail(404, 'NOT_FOUND', 'Captura rapida no encontrada.');
    const capture = result.rows[0];
    const canManage = access.isAdministrative && capture.estado === 'PENDIENTE' && capture.id_solicitud_compra === null;
    capture.acciones = {
      puede_rechazar: canManage,
      puede_formalizar: canManage && Number(capture.cantidad_evidencias || 0) >= 1
    };
    return { ok: true, captura: capture };
  };

  const reject = async (req) => {
    const id = parsePositiveIntStrict(req.params?.id_captura);
    if (!id) fail(400, 'VALIDATION_ERROR', 'id_captura debe ser un entero positivo.');
    ensurePlainObject(req.body, 'El payload debe ser un objeto.');
    rejectUnexpectedFields(req.body, new Set(['motivo_rechazo']), 'El payload');
    const reason = normalizeRejectReason(req.body.motivo_rechazo);
    const client = await dependencies.db.connect(); let started = false;
    try {
      await client.query('BEGIN'); started = true;
      const access = await readAccess(req, client, dependencies);
      if (!access.isAdministrative) fail(403, 'FORBIDDEN', 'El rol del usuario no puede gestionar capturas rapidas.');
      const capture = await loadLocked(client, id);
      if (!capture) fail(404, 'NOT_FOUND', 'Captura rapida no encontrada.');
      if (capture.estado !== 'PENDIENTE' || capture.id_solicitud_compra !== null) fail(409, 'INVALID_STATE', 'La captura cambio y ya no puede rechazarse.');
      const result = await client.query(
        `UPDATE public.capturas_compra_rapida
         SET estado = 'RECHAZADA', id_usuario_gestion = $2, fecha_gestion = NOW(), motivo_rechazo = $3
         WHERE id_captura_compra_rapida = $1 AND estado = 'PENDIENTE' AND id_solicitud_compra IS NULL
         RETURNING id_captura_compra_rapida, estado, fecha_envio, fecha_gestion, motivo_rechazo, id_usuario_gestion`,
        [id, access.idUsuario, reason]
      );
      if (result.rowCount !== 1) fail(409, 'INVALID_STATE', 'La captura cambio y ya no puede rechazarse.');
      await client.query('COMMIT'); started = false;
      return { ok: true, captura: result.rows[0] };
    } catch (error) { if (started) await rollback(client); throw mapError(error); } finally { client.release(); }
  };

  const listEvidence = async (req) => {
    const detailResult = await detail(req);
    const id = Number(detailResult.captura.id_captura_compra_rapida);
    const result = await dependencies.db.query(
      `SELECT e.id_captura_evidencia, e.fecha_registro, a.nombre_original, a.tipo_archivo, a.url_publica
       FROM public.capturas_compra_rapida_evidencias e INNER JOIN public.archivos a ON a.id_archivo = e.id_archivo
       WHERE e.id_captura_compra_rapida = $1 AND e.tipo_evidencia = 'FACTURA' AND a.estado = true
       ORDER BY e.fecha_registro, e.id_captura_evidencia`, [id]
    );
    const evidencias = [];
    for (const row of result.rows || []) {
      const path = objectPathFromStored(row.url_publica);
      let signedUrl;
      try { signedUrl = await dependencies.storage.signedUrl(path); } catch { fail(502, 'STORAGE_ERROR', 'No se pudo generar acceso temporal a la factura.'); }
      evidencias.push({ id_evidencia: Number(row.id_captura_evidencia), nombre_original: row.nombre_original, mime_type: row.tipo_archivo, fecha_registro: row.fecha_registro, url_firmada: signedUrl });
    }
    return { ok: true, evidencias };
  };

  return { create, uploadInvoice, deleteEvidence, discard, send, list, detail, listEvidence, reject };
};

export const capturasCompraRapidaService = createCapturasCompraRapidaService();
