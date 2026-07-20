import pool from '../config/db-connection.js';
import { validateCanonicalPrintPayload } from './printJobDocumentService.js';

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
  const schemaVersion = Number(payload.schema_version);
  if (!PRINT_DOCUMENT_TYPES.has(String(payload.tipo_documento || '').toLowerCase())) {
    return { ok: false, message: 'Payload de impresion no soportado.' };
  }
  if (schemaVersion === 1) {
    if (!payload.documento || typeof payload.documento !== 'object' || Array.isArray(payload.documento)) {
      return { ok: false, message: 'El documento de impresion es obligatorio.' };
    }
    return { ok: true, value: payload };
  }
  if (schemaVersion === 2 || schemaVersion === 3) return validateCanonicalPrintPayload(payload);
  return { ok: false, message: 'Payload de impresion no soportado.' };
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

export const claimPrintJobs = async ({ agentId, leaseSeconds = 90, db = pool }) => {
  const result = await db.query(
    'SELECT * FROM public.reclamar_trabajos_impresion($1::uuid, $2::integer, $3::integer)',
    [agentId, 1, Math.min(Math.max(Number(leaseSeconds) || 90, 30), 600)]
  );
  return result.rows;
};

export const getPrintJobStatusForAgent = async ({ agent, jobId, db = pool }) => {
  const result = await db.query(
    `SELECT id_trabajo,estado,finalizado_at,fecha_actualizacion,
            (id_agente_tomado=$3) AS assigned_to_agent,
            (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
     FROM public.trabajos_impresion
     WHERE id_trabajo=$1 AND id_sucursal=$2`,
    [jobId, agent.id_sucursal, agent.id_agente]
  );
  return result.rows[0] || null;
};

export const transitionPrintJob = async ({ agent, jobId, action, errorMessage = null, leaseSeconds = 90, db = pool }) => {
  const transitions = {
    printing: { from: ['asignado'], to: 'imprimiendo', event: 'printing' },
    confirmationPending: { from: ['imprimiendo'], to: 'confirmacion_pendiente', event: 'confirmacion_pendiente' },
    complete: { from: ['confirmacion_pendiente'], to: 'impreso', event: 'complete' },
    fail: { from: ['imprimiendo'], to: 'fallido', event: 'fail' },
    renew: { from: ['asignado', 'imprimiendo'], to: null, event: 'renew' }
  };
  const rule = transitions[action];
  if (!rule) throw Object.assign(new Error('Accion invalida.'), { status: 400 });
  const sanitizedError = String(errorMessage || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000) || null;
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const shouldRelease = client !== db && typeof client.release === 'function';

  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id_trabajo, estado, intentos, max_intentos,
              (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_activo
       FROM public.trabajos_impresion
       WHERE id_trabajo=$1 AND id_sucursal=$2 AND id_agente_tomado=$3
       FOR UPDATE`,
      [jobId, agent.id_sucursal, agent.id_agente]
    );
    const current = currentResult.rows[0];
    const canFinishWithoutLease = current?.estado === 'confirmacion_pendiente' && action === 'complete';
    if (!current || !rule.from.includes(current.estado) || (!canFinishWithoutLease && !current.lease_activo)) {
      throw Object.assign(new Error('Trabajo no encontrado, lease vencido o estado incompatible.'), {
        status: 409,
        code: 'PRINT_JOB_STATE_CONFLICT'
      });
    }

    const retryableFailure = action === 'fail' && Number(current.intentos) < Number(current.max_intentos);
    const nextState = retryableFailure ? 'pendiente' : (rule.to || current.estado);
    const clearLease = ['confirmationPending', 'complete', 'fail'].includes(action);
    const finalState = action === 'complete' || (action === 'fail' && !retryableFailure);
    const boundedLeaseSeconds = Math.min(Math.max(Number(leaseSeconds) || 90, 30), 600);
    const updateResult = await client.query(
      `UPDATE public.trabajos_impresion
       SET estado=$4,
           disponible_at=CASE WHEN $5 THEN now() + make_interval(secs => LEAST(60, power(2, LEAST(intentos,5))::integer)) ELSE disponible_at END,
           lease_expires_at=CASE WHEN $6 THEN NULL ELSE now() + make_interval(secs => $7) END,
           finalizado_at=CASE WHEN $8 THEN now() ELSE finalizado_at END,
           error_sanitizado=CASE WHEN $9::text IS NOT NULL THEN $9 ELSE NULL END,
           fecha_actualizacion=now()
       WHERE id_trabajo=$1 AND id_sucursal=$2 AND id_agente_tomado=$3
       RETURNING id_trabajo, estado, finalizado_at, lease_expires_at`,
      [jobId, agent.id_sucursal, agent.id_agente, nextState, retryableFailure, clearLease,
        boundedLeaseSeconds, finalState, action === 'fail' ? sanitizedError : null]
    );
    const updated = updateResult.rows[0];

    await client.query(
      `INSERT INTO public.trabajos_impresion_eventos
         (id_trabajo,id_sucursal,id_agente,evento,estado_anterior,estado_nuevo,detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [jobId, agent.id_sucursal, agent.id_agente, rule.event, current.estado, updated.estado,
        JSON.stringify(sanitizedError ? { error: sanitizedError } : {})]
    );
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
};
