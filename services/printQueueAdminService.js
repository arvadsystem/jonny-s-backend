import pool from '../config/db-connection.js';

const RESOLVABLE_STATES = new Set(['asignado', 'imprimiendo', 'confirmacion_pendiente']);

const adminError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

export const sanitizePrintResolutionReason = (value) => {
  const reason = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 500);
  if (reason.length < 8) throw adminError('PRINT_RESOLUTION_REASON_REQUIRED', 'El motivo debe contener al menos 8 caracteres.');
  return reason;
};

export const listAmbiguousPrintJobs = async ({ idSucursal, db = pool }) => {
  const result = await db.query(
    `SELECT id_trabajo,id_sucursal,tipo_documento,estado,intentos,max_intentos,
            id_agente_tomado,lease_expires_at,fecha_creacion,fecha_actualizacion
     FROM public.trabajos_impresion
     WHERE id_sucursal=$1
       AND (
         estado='confirmacion_pendiente'
         OR (estado IN ('asignado','imprimiendo') AND lease_expires_at <= now())
       )
     ORDER BY fecha_actualizacion,id_trabajo
     LIMIT 100`,
    [idSucursal]
  );
  return result.rows;
};

export const getPrintJobEvents = async ({ idSucursal, jobId, db = pool }) => {
  const result = await db.query(
    `SELECT e.id_evento,e.evento,e.estado_anterior,e.estado_nuevo,e.id_agente,
            e.id_usuario,e.detalle,e.fecha_creacion
     FROM public.trabajos_impresion_eventos e
     INNER JOIN public.trabajos_impresion t ON t.id_trabajo=e.id_trabajo
     WHERE e.id_trabajo=$1 AND t.id_sucursal=$2
     ORDER BY e.fecha_creacion,e.id_evento`,
    [jobId, idSucursal]
  );
  return result.rows;
};

export const resolvePrintJobAdministratively = async ({
  idSucursal, jobId, userId, resolution, reason, db = pool
}) => {
  if (!['printed', 'not_printed'].includes(resolution)) {
    throw adminError('PRINT_RESOLUTION_INVALID', 'Resolucion de impresion invalida.');
  }
  const sanitizedReason = sanitizePrintResolutionReason(reason);
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const shouldRelease = client !== db && typeof client.release === 'function';
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id_trabajo,id_sucursal,estado,intentos,max_intentos,id_agente_tomado,
              (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
       FROM public.trabajos_impresion
       WHERE id_trabajo=$1 AND id_sucursal=$2
       FOR UPDATE`,
      [jobId, idSucursal]
    );
    const current = currentResult.rows[0];
    const isExpiredOrPastBarrier = current?.estado === 'confirmacion_pendiente' || current?.lease_active === false;
    if (!current || !RESOLVABLE_STATES.has(current.estado) || !isExpiredOrPastBarrier) {
      throw adminError('PRINT_RESOLUTION_STATE_CONFLICT', 'El trabajo no esta ambiguo ni huerfano.', 409);
    }

    const nextState = resolution === 'printed' ? 'impreso' : 'pendiente';
    const updateResult = await client.query(
      `UPDATE public.trabajos_impresion
       SET estado=$3,
           disponible_at=CASE WHEN $4 THEN now() ELSE disponible_at END,
           intentos=CASE WHEN $4 THEN LEAST(intentos,19) ELSE intentos END,
           lease_at=NULL,
           lease_expires_at=NULL,
           id_agente_tomado=CASE WHEN $4 THEN NULL ELSE id_agente_tomado END,
           max_intentos=CASE WHEN $4 THEN LEAST(20,GREATEST(max_intentos,intentos + 1)) ELSE max_intentos END,
           finalizado_at=CASE WHEN $4 THEN NULL ELSE now() END,
           error_sanitizado=NULL,
           fecha_actualizacion=now()
       WHERE id_trabajo=$1 AND id_sucursal=$2
       RETURNING id_trabajo,id_sucursal,estado,intentos,max_intentos,finalizado_at,fecha_actualizacion`,
      [jobId, idSucursal, nextState, resolution === 'not_printed']
    );
    const updated = updateResult.rows[0];
    const event = resolution === 'printed' ? 'manual_mark_printed' : 'manual_requeue_not_printed';
    await client.query(
      `INSERT INTO public.trabajos_impresion_eventos
         (id_trabajo,id_sucursal,id_agente,id_usuario,evento,estado_anterior,estado_nuevo,detalle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [jobId, idSucursal, current.id_agente_tomado, userId, event, current.estado, nextState,
        JSON.stringify({ reason: sanitizedReason, resolution, previous_attempts: current.intentos, previous_max_attempts: current.max_intentos })]
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
