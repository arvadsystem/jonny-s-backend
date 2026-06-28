import pool from '../config/db-connection.js';
import { enviarCorreo } from '../utils/emailService.js';
import { buildCajaCierrePdfBuffer, buildCajaCierrePdfFilename } from '../utils/cajaCierreReportePdf.js';
import { resolveCajaCloseEmailRecipient } from './cajaCloseNotificationService.js';

export const CAJA_CLOSE_EMAIL_FALLBACK_TO = 'gersonmz@jonnyshn.com';
export const CAJA_CLOSE_EMAIL_OUTBOX_TABLE = 'public.cajas_cierres_notificaciones_email';
export const CAJA_CLOSE_EMAIL_OUTBOX_STATES = Object.freeze({
  PENDIENTE: 'PENDIENTE',
  PROCESANDO: 'PROCESANDO',
  ENVIADO: 'ENVIADO',
  REINTENTO: 'REINTENTO',
  FALLIDO: 'FALLIDO'
});

const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_LOCK_MS = 120000;

const parsePositiveInt = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const normalizeCloseId = (value) => {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) ? text : null;
};

const clampErrorMessage = (error) =>
  String(error?.message || error || 'Error enviando correo de cierre de caja.').slice(0, 2000);

const resolveBackoffSeconds = (attempts) => {
  const boundedAttempts = Math.min(Math.max(Number(attempts || 1), 1), MAX_ATTEMPTS);
  return Math.min(60 * (2 ** (boundedAttempts - 1)), 3600);
};

export const buildCajaCloseEmailSubject = ({ payload = {} } = {}) => {
  const cajaLabel = payload.session?.nombre_caja || payload.session?.codigo_caja || `Caja ${payload.session?.id_caja || ''}`.trim();
  const sucursalLabel = payload.session?.nombre_sucursal || `Sucursal ${payload.session?.id_sucursal || ''}`.trim();
  const subjectPrefix = payload.requiresAudit
    ? 'Cierre de caja pendiente de revision'
    : 'Cierre de caja registrado';
  return `${subjectPrefix} - ${cajaLabel || 'Caja'} - ${sucursalLabel || 'Sucursal'}`;
};

export const buildCajaCloseEmailHtml = ({ payload = {}, pdfAttached = false } = {}) => {
  const money = (value) => Number(value || 0).toFixed(2);
  const session = payload.session || {};
  return `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;color:#111827;">
  <h2 style="margin:0 0 12px;">Cierre de caja registrado</h2>
  <p>Se registro un cierre de caja en JONNY'S SmartOrder.</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #eaecf0;">
    <tr><td><strong>Cierre</strong></td><td>${payload.idCierreCaja || 'N/A'}</td></tr>
    <tr><td><strong>Caja</strong></td><td>${session.nombre_caja || session.codigo_caja || 'N/A'}</td></tr>
    <tr><td><strong>Sucursal</strong></td><td>${session.nombre_sucursal || session.id_sucursal || 'N/A'}</td></tr>
    <tr><td><strong>Total teorico</strong></td><td>L ${money(payload.montoTeorico)}</td></tr>
    <tr><td><strong>Total declarado</strong></td><td>L ${money(payload.montoDeclaradoCierre)}</td></tr>
    <tr><td><strong>Diferencia</strong></td><td>L ${money(payload.diferencia)}</td></tr>
    <tr><td><strong>Revision</strong></td><td>${payload.requiresAudit ? 'Requiere revision' : 'Sin inconsistencias pendientes'}</td></tr>
  </table>
  <p>${pdfAttached ? 'Se adjunta el reporte PDF del cierre.' : 'No fue posible adjuntar el PDF automaticamente.'}</p>
</body>
</html>`;
};

export const resolveCajaCloseOutboxRecipient = (fallback = CAJA_CLOSE_EMAIL_FALLBACK_TO) =>
  resolveCajaCloseEmailRecipient(fallback);

export const createCajaCloseEmailNotification = async (client, {
  idCierreCaja,
  emailDestino = null
} = {}) => {
  const closeId = normalizeCloseId(idCierreCaja);
  if (!closeId) return null;
  const recipient = resolveCajaCloseOutboxRecipient(emailDestino || CAJA_CLOSE_EMAIL_FALLBACK_TO);
  const result = await client.query(
    `
      INSERT INTO public.cajas_cierres_notificaciones_email (
        id_cierre_caja, estado, intentos, proximo_intento, email_destino, fecha_creacion, fecha_actualizacion
      )
      VALUES ($1, 'PENDIENTE', 0, NOW(), $2, NOW(), NOW())
      ON CONFLICT (id_cierre_caja)
      DO UPDATE SET
        email_destino = COALESCE(public.cajas_cierres_notificaciones_email.email_destino, EXCLUDED.email_destino),
        fecha_actualizacion = NOW()
      RETURNING *
    `,
    [closeId, recipient]
  );
  return result.rows?.[0] || null;
};

export const fetchCajaCloseEmailNotificationByCloseId = async (queryRunner, idCierreCaja) => {
  const closeId = normalizeCloseId(idCierreCaja);
  if (!closeId) return null;
  const result = await queryRunner.query(
    `
      SELECT *
      FROM public.cajas_cierres_notificaciones_email
      WHERE id_cierre_caja = $1
      LIMIT 1
    `,
    [closeId]
  );
  return result.rows?.[0] || null;
};

export const reactivateFailedCajaCloseEmailNotification = async (client, idCierreCaja) => {
  const closeId = normalizeCloseId(idCierreCaja);
  if (!closeId) return null;
  const result = await client.query(
    `
      UPDATE public.cajas_cierres_notificaciones_email
      SET estado = 'REINTENTO',
          intentos = 0,
          proximo_intento = NOW(),
          bloqueado_hasta = NULL,
          ultimo_error = NULL,
          fecha_actualizacion = NOW()
      WHERE id_cierre_caja = $1
        AND estado = 'FALLIDO'
      RETURNING *
    `,
    [closeId]
  );
  return result.rows?.[0] || fetchCajaCloseEmailNotificationByCloseId(client, closeId);
};

export const claimCajaCloseEmailNotifications = async ({
  queryRunner,
  batchSize = DEFAULT_BATCH_SIZE,
  lockMs = DEFAULT_LOCK_MS
} = {}) => {
  const limit = parsePositiveInt(batchSize, DEFAULT_BATCH_SIZE, 1, 20);
  const lockIntervalMs = parsePositiveInt(lockMs, DEFAULT_LOCK_MS, 1000, 600000);
  const result = await queryRunner.query(
    `
      WITH candidates AS (
        SELECT id_notificacion
        FROM public.cajas_cierres_notificaciones_email
        WHERE (
            estado IN ('PENDIENTE', 'REINTENTO')
            AND (proximo_intento IS NULL OR proximo_intento <= NOW())
          )
          OR (
            estado = 'PROCESANDO'
            AND bloqueado_hasta IS NOT NULL
            AND bloqueado_hasta <= NOW()
          )
        ORDER BY COALESCE(proximo_intento, fecha_creacion), id_notificacion
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.cajas_cierres_notificaciones_email n
      SET estado = 'PROCESANDO',
          bloqueado_hasta = NOW() + ($2::text)::interval,
          fecha_actualizacion = NOW()
      FROM candidates
      WHERE n.id_notificacion = candidates.id_notificacion
      RETURNING n.*
    `,
    [limit, `${lockIntervalMs} milliseconds`]
  );
  return result.rows || [];
};

export const loadCajaCloseEmailPayload = async (queryRunner, idCierreCaja) => {
  const closeId = normalizeCloseId(idCierreCaja);
  if (!closeId) return null;
  const result = await queryRunner.query(
    `
      SELECT
        cc.*,
        cs.id_sesion_caja,
        cs.id_usuario_responsable AS sesion_id_usuario_responsable,
        c.id_caja,
        c.codigo_caja,
        c.nombre_caja,
        s.id_sucursal,
        s.nombre_sucursal,
        resolucion.codigo AS resolucion_codigo,
        resolucion.nombre AS resolucion_nombre
      FROM public.cajas_cierres cc
      INNER JOIN public.cajas_sesiones cs ON cs.id_sesion_caja = cc.id_sesion_caja
      INNER JOIN public.cajas c ON c.id_caja = cc.id_caja
      INNER JOIN public.sucursales s ON s.id_sucursal = cc.id_sucursal
      LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion
        ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
      WHERE cc.id_cierre_caja = $1
      LIMIT 1
    `,
    [closeId]
  );
  const row = result.rows?.[0] || null;
  if (!row) return null;
  return {
    idCierreCaja: String(row.id_cierre_caja),
    idSesionCaja: String(row.id_sesion_caja),
    session: {
      id_sesion_caja: row.id_sesion_caja,
      id_caja: row.id_caja,
      id_sucursal: row.id_sucursal,
      id_usuario_responsable: row.id_usuario_responsable || row.sesion_id_usuario_responsable,
      codigo_caja: row.codigo_caja,
      nombre_caja: row.nombre_caja,
      nombre_sucursal: row.nombre_sucursal
    },
    idUsuarioCierre: row.id_usuario_cierre,
    fechaCierre: row.fecha_cierre,
    montoTeorico: Number(row.monto_teorico_cierre || 0),
    montoDeclaradoCierre: Number(row.monto_declarado_cierre || 0),
    diferencia: Number(row.diferencia || 0),
    idResolucionFinal: row.id_resolucion_cierre_caja,
    resolutionCode: row.resolucion_codigo,
    requiresAudit: String(row.resolucion_codigo || '').trim().toUpperCase() === 'PENDIENTE_REVISION'
      || Math.abs(Number(row.diferencia || 0)) > 0,
    montoApertura: Number(row.monto_apertura || 0),
    ventasEfectivoNetas: Number(row.monto_ventas_efectivo || 0),
    ventasNoEfectivoNetas: Number(row.monto_ventas_no_efectivo || 0),
    ingresosManuales: Number(row.monto_ingresos_manuales || 0),
    egresosManuales: Number(row.monto_egresos_manuales || 0),
    payrollSync: { synced: true, reason: 'NOT_REQUIRED' },
    arqueos: []
  };
};

export const sendCajaCloseEmailFromOutbox = async (notification, {
  queryRunner = pool,
  sendEmail = enviarCorreo,
  buildPdf = buildCajaCierrePdfBuffer,
  buildPdfFilename = buildCajaCierrePdfFilename
} = {}) => {
  const payload = await loadCajaCloseEmailPayload(queryRunner, notification.id_cierre_caja);
  if (!payload) {
    const error = new Error('No se encontro el cierre asociado a la notificacion.');
    error.code = 'CAJA_CLOSE_EMAIL_PAYLOAD_NOT_FOUND';
    throw error;
  }
  const recipient = resolveCajaCloseOutboxRecipient(notification.email_destino || CAJA_CLOSE_EMAIL_FALLBACK_TO);
  if (!recipient) {
    throw new Error('CAJA_CLOSE_EMAIL_TO no está configurado y no existe destinatario fallback.');
  }

  const attachments = [];
  try {
    const pdfBuffer = await buildPdf(payload);
    attachments.push({
      filename: buildPdfFilename(payload.idCierreCaja),
      content: pdfBuffer,
      contentType: 'application/pdf'
    });
  } catch (pdfError) {
    console.warn('[caja_close_email_outbox] No se pudo generar PDF:', pdfError?.message || pdfError);
  }

  const result = await sendEmail(
    recipient,
    buildCajaCloseEmailSubject({ payload }),
    buildCajaCloseEmailHtml({ payload, pdfAttached: attachments.length > 0 }),
    {
      id_usuario: payload.session?.id_usuario_responsable,
      tipo_correo: 'caja_cierre',
      fromKey: 'ADMON',
      attachments
    }
  );

  return {
    messageId: result?.messageId || result?.message_id || null,
    recipient
  };
};

export const markCajaCloseEmailNotificationSent = async (queryRunner, notification, {
  messageId = null,
  emailDestino = null
} = {}) => {
  const result = await queryRunner.query(
    `
      UPDATE public.cajas_cierres_notificaciones_email
      SET estado = 'ENVIADO',
          message_id = $2,
          email_destino = COALESCE($3, email_destino),
          ultimo_error = NULL,
          bloqueado_hasta = NULL,
          fecha_envio = NOW(),
          fecha_actualizacion = NOW()
      WHERE id_notificacion = $1
      RETURNING *
    `,
    [notification.id_notificacion, messageId, emailDestino]
  );
  return result.rows?.[0] || null;
};

export const markCajaCloseEmailNotificationFailed = async (queryRunner, notification, error) => {
  const nextAttempts = Number(notification.intentos || 0) + 1;
  const finalState = nextAttempts >= MAX_ATTEMPTS
    ? CAJA_CLOSE_EMAIL_OUTBOX_STATES.FALLIDO
    : CAJA_CLOSE_EMAIL_OUTBOX_STATES.REINTENTO;
  const result = await queryRunner.query(
    `
      UPDATE public.cajas_cierres_notificaciones_email
      SET estado = $2,
          intentos = $3,
          proximo_intento = CASE
            WHEN $2 = 'FALLIDO' THEN NULL
            ELSE NOW() + ($4::text)::interval
          END,
          bloqueado_hasta = NULL,
          ultimo_error = $5,
          fecha_actualizacion = NOW()
      WHERE id_notificacion = $1
      RETURNING *
    `,
    [
      notification.id_notificacion,
      finalState,
      nextAttempts,
      `${resolveBackoffSeconds(nextAttempts)} seconds`,
      clampErrorMessage(error)
    ]
  );
  return result.rows?.[0] || null;
};

export const processClaimedCajaCloseEmailNotification = async (notification, {
  queryRunner = pool,
  sendEmail,
  buildPdf,
  buildPdfFilename
} = {}) => {
  try {
    const sent = await sendCajaCloseEmailFromOutbox(notification, {
      queryRunner,
      sendEmail,
      buildPdf,
      buildPdfFilename
    });
    return markCajaCloseEmailNotificationSent(queryRunner, notification, {
      messageId: sent.messageId,
      emailDestino: sent.recipient
    });
  } catch (error) {
    return markCajaCloseEmailNotificationFailed(queryRunner, notification, error);
  }
};

export const processCajaCloseEmailOutboxBatch = async ({
  notificationPool = pool,
  batchSize = DEFAULT_BATCH_SIZE,
  lockMs = DEFAULT_LOCK_MS,
  sendEmail,
  buildPdf,
  buildPdfFilename
} = {}) => {
  const client = await notificationPool.connect();
  let claimed = [];
  try {
    await client.query('BEGIN');
    claimed = await claimCajaCloseEmailNotifications({ queryRunner: client, batchSize, lockMs });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error?.code === '42P01') {
      console.warn('[caja_close_email_outbox] Tabla de outbox no encontrada. Aplique la migracion pendiente.');
      return { claimed: 0, processed: 0, missing_table: true };
    }
    throw error;
  } finally {
    client.release();
  }

  let processed = 0;
  for (const notification of claimed) {
    await processClaimedCajaCloseEmailNotification(notification, {
      queryRunner: notificationPool,
      sendEmail,
      buildPdf,
      buildPdfFilename
    });
    processed += 1;
  }

  return { claimed: claimed.length, processed };
};
