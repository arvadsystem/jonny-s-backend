import pool from '../config/db-connection.js';

export const PRINT_DOCUMENT_TYPES = new Set(['factura', 'comanda', 'caja']);
const MAX_PAYLOAD_BYTES = 256 * 1024;

export const validatePrintPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'El payload de impresion debe ser un objeto.' };
  }
  let serialized;
  try { serialized = JSON.stringify(payload); } catch { return { ok: false, message: 'Payload no serializable.' }; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    return { ok: false, message: 'El payload de impresion excede 256 KB.' };
  }
  if (Number(payload.schema_version) !== 1 || !PRINT_DOCUMENT_TYPES.has(String(payload.tipo_documento || '').toLowerCase())) {
    return { ok: false, message: 'Payload de impresion no soportado.' };
  }
  if (!payload.documento || typeof payload.documento !== 'object' || Array.isArray(payload.documento)) {
    return { ok: false, message: 'El documento de impresion es obligatorio.' };
  }
  return { ok: true, value: payload };
};

export const enqueuePrintJob = async ({
  idSucursal, tipoDocumento, payload, idempotencyKey, idFactura = null,
  idPedido = null, idUsuario = null, esReimpresion = false, db = pool
}) => {
  const normalizedType = String(tipoDocumento || '').trim().toLowerCase();
  const validation = validatePrintPayload(payload);
  if (!validation.ok) throw Object.assign(new Error(validation.message), { code: 'PRINT_PAYLOAD_INVALID', status: 400 });
  if (!PRINT_DOCUMENT_TYPES.has(normalizedType) || normalizedType !== String(payload.tipo_documento).toLowerCase()) {
    throw Object.assign(new Error('Tipo de documento invalido.'), { code: 'PRINT_TYPE_INVALID', status: 400 });
  }
  const key = String(idempotencyKey || '').trim();
  if (key.length < 8 || key.length > 160) {
    throw Object.assign(new Error('Idempotency-Key es obligatorio.'), { code: 'PRINT_IDEMPOTENCY_INVALID', status: 400 });
  }
  const result = await db.query(
    `INSERT INTO public.trabajos_impresion
       (id_sucursal, tipo_documento, payload, idempotency_key, id_factura, id_pedido,
        id_usuario_solicitante, es_reimpresion)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
     ON CONFLICT (id_sucursal, idempotency_key, tipo_documento)
     DO UPDATE SET fecha_actualizacion = public.trabajos_impresion.fecha_actualizacion
     RETURNING id_trabajo, id_sucursal, tipo_documento, estado, fecha_creacion`,
    [idSucursal, normalizedType, JSON.stringify(payload), key, idFactura, idPedido, idUsuario, esReimpresion]
  );
  return result.rows[0];
};

export const claimPrintJobs = async ({ agentId, limit = 1, leaseSeconds = 90, db = pool }) => {
  const result = await db.query(
    'SELECT * FROM public.reclamar_trabajos_impresion($1::uuid, $2::integer, $3::integer)',
    [agentId, Math.min(Math.max(Number(limit) || 1, 1), 10), Math.min(Math.max(Number(leaseSeconds) || 90, 30), 600)]
  );
  return result.rows;
};

export const transitionPrintJob = async ({ agent, jobId, action, errorMessage = null, leaseSeconds = 90, db = pool }) => {
  const transitions = {
    printing: { from: ['asignado'], to: 'imprimiendo', final: false },
    complete: { from: ['asignado', 'imprimiendo'], to: 'impreso', final: true },
    fail: { from: ['asignado', 'imprimiendo'], to: 'fallido', final: true },
    renew: { from: ['asignado', 'imprimiendo'], to: null, final: false }
  };
  const rule = transitions[action];
  if (!rule) throw Object.assign(new Error('Accion invalida.'), { status: 400 });
  const sanitizedError = String(errorMessage || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000) || null;
  const result = await db.query(
    `UPDATE public.trabajos_impresion
     SET estado = CASE
           WHEN $9 = 'fail' AND intentos < max_intentos THEN 'pendiente'
           ELSE COALESCE($5, estado)
         END,
         disponible_at = CASE
           WHEN $9 = 'fail' AND intentos < max_intentos
             THEN now() + make_interval(secs => LEAST(60, power(2, LEAST(intentos, 5))::integer))
           ELSE disponible_at
         END,
         lease_expires_at = CASE WHEN $6 OR $9 = 'fail' THEN NULL ELSE now() + make_interval(secs => $7) END,
         finalizado_at = CASE
           WHEN $9 = 'complete' OR ($9 = 'fail' AND intentos >= max_intentos) THEN now()
           ELSE finalizado_at
         END,
         error_sanitizado = CASE WHEN $5 = 'fallido' THEN $8 ELSE NULL END,
         fecha_actualizacion = now()
     WHERE id_trabajo = $1 AND id_sucursal = $2 AND id_agente_tomado = $3
       AND estado = ANY($4::varchar[]) AND lease_expires_at > now()
     RETURNING id_trabajo, estado, finalizado_at, lease_expires_at`,
    [jobId, agent.id_sucursal, agent.id_agente, rule.from, rule.to, rule.final,
      Math.min(Math.max(Number(leaseSeconds) || 90, 30), 600), sanitizedError, action]
  );
  if (!result.rows[0]) throw Object.assign(new Error('Trabajo no encontrado, lease vencido o estado incompatible.'), { status: 409, code: 'PRINT_JOB_STATE_CONFLICT' });
  await db.query(
    `INSERT INTO public.trabajos_impresion_eventos
       (id_trabajo,id_sucursal,id_agente,evento,estado_nuevo,detalle)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [jobId, agent.id_sucursal, agent.id_agente, action, result.rows[0].estado,
      JSON.stringify(sanitizedError ? { error: sanitizedError } : {})]
  );
  return result.rows[0];
};
