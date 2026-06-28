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

const cleanText = (value, fallback = 'N/A') => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
};

const cleanOptionalText = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
};

const escapeHtml = (value) =>
  cleanText(value, '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

const money = (value) => Number(value || 0).toFixed(2);

const resolveActorName = ({ nombre, usuario } = {}) =>
  cleanOptionalText(nombre) || cleanOptionalText(usuario) || 'No disponible';

const formatHtmlDateTime = (value) => {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return date.toLocaleString('es-HN', {
    timeZone: 'America/Tegucigalpa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export const normalizeManualMovement = (row = {}) => ({
  fecha_hora: row.fecha_movimiento || row.fecha_creacion || null,
  tipo_codigo: cleanText(row.tipo_codigo, 'N/A'),
  tipo: cleanText(row.tipo_nombre || row.tipo_codigo, 'N/A'),
  monto: Number(row.monto || 0),
  observacion: cleanText(row.observacion, 'N/A'),
  referencia: cleanText(row.referencia, 'N/A'),
  usuario_ejecutor: resolveActorName({
    nombre: row.usuario_ejecutor_nombre,
    usuario: row.usuario_ejecutor_usuario
  }),
  signo: Number(row.signo || 0)
});

export const splitManualMovements = (rows = []) =>
  (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => {
      const normalized = normalizeManualMovement(row);
      if (normalized.signo > 0) acc.ingresos.push(normalized);
      if (normalized.signo < 0) acc.egresos.push(normalized);
      return acc;
    },
    { ingresos: [], egresos: [] }
  );

export const fetchCajaCloseEmailActors = async (queryRunner, {
  idUsuarioResponsable,
  idUsuarioCierre
} = {}) => {
  const ids = [
    Number.parseInt(String(idUsuarioResponsable || ''), 10),
    Number.parseInt(String(idUsuarioCierre || ''), 10)
  ].filter((value) => Number.isInteger(value) && value > 0);
  if (ids.length === 0) {
    return {
      responsable_nombre: null,
      responsable_usuario: null,
      cierre_nombre: null,
      cierre_usuario: null
    };
  }

  const result = await queryRunner.query(
    `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), '') AS nombre_completo
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE u.id_usuario = ANY($1::bigint[])
    `,
    [[...new Set(ids)]]
  );
  const byId = new Map((result.rows || []).map((row) => [Number(row.id_usuario), row]));
  const responsable = byId.get(Number(idUsuarioResponsable)) || {};
  const cierre = byId.get(Number(idUsuarioCierre)) || {};
  return {
    responsable_nombre: cleanOptionalText(responsable.nombre_completo),
    responsable_usuario: cleanOptionalText(responsable.nombre_usuario),
    cierre_nombre: cleanOptionalText(cierre.nombre_completo),
    cierre_usuario: cleanOptionalText(cierre.nombre_usuario)
  };
};

export const fetchCajaCloseManualMovements = async (queryRunner, idSesionCaja) => {
  const result = await queryRunner.query(
    `
      SELECT
        cm.id_movimiento_caja,
        cm.fecha_movimiento,
        cm.fecha_creacion,
        cm.monto,
        cm.observacion,
        cm.referencia,
        mt.codigo AS tipo_codigo,
        mt.nombre AS tipo_nombre,
        mt.signo,
        u.nombre_usuario AS usuario_ejecutor_usuario,
        NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), '') AS usuario_ejecutor_nombre
      FROM public.cajas_movimientos cm
      INNER JOIN public.cat_cajas_movimientos_tipos mt
        ON mt.id_tipo_movimiento_caja = cm.id_tipo_movimiento_caja
      LEFT JOIN public.usuarios u ON u.id_usuario = cm.id_usuario_ejecutor
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.personas per ON per.id_persona = e.id_persona
      WHERE cm.id_sesion_caja = $1
        AND UPPER(TRIM(mt.codigo)) NOT IN ('APERTURA', 'REVERSION', 'REVERSO')
      ORDER BY cm.fecha_movimiento ASC, cm.id_movimiento_caja ASC
    `,
    [idSesionCaja]
  );
  return splitManualMovements(result.rows || []);
};

export const fetchCajaCloseArqueos = async (queryRunner, idCierreCaja) => {
  const result = await queryRunner.query(
    `
      SELECT
        metodo_pago_codigo,
        monto_teorico,
        monto_declarado,
        diferencia,
        requiere_revision,
        observacion
      FROM public.cajas_cierres_arqueos_metodos
      WHERE id_cierre_caja = $1
      ORDER BY id_arqueo_metodo ASC
    `,
    [idCierreCaja]
  );
  return (result.rows || []).map((row) => ({
    metodo_pago_codigo: cleanText(row.metodo_pago_codigo, 'N/A'),
    monto_teorico: Number(row.monto_teorico || 0),
    monto_declarado: Number(row.monto_declarado || 0),
    diferencia: Number(row.diferencia || 0),
    requiere_revision: Boolean(row.requiere_revision),
    observacion: cleanText(row.observacion, 'N/A')
  }));
};

export const buildCajaCloseEmailSubject = ({ payload = {} } = {}) => {
  const cajaLabel = payload.session?.nombre_caja || payload.session?.codigo_caja || `Caja ${payload.session?.id_caja || ''}`.trim();
  const sucursalLabel = payload.session?.nombre_sucursal || `Sucursal ${payload.session?.id_sucursal || ''}`.trim();
  const subjectPrefix = payload.requiresAudit
    ? 'Cierre de caja pendiente de revision'
    : 'Cierre de caja registrado';
  return `${subjectPrefix} - ${cajaLabel || 'Caja'} - ${sucursalLabel || 'Sucursal'}`;
};

const buildHtmlRows = (rows = [], columns = [], emptyMessage = 'Sin registros.') => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `<tr><td colspan="${columns.length}" style="padding:8px;border:1px solid #eaecf0;color:#667085;">${escapeHtml(emptyMessage)}</td></tr>`;
  }
  return rows.map((row) => `
    <tr>
      ${columns.map((column) => `<td style="padding:8px;border:1px solid #eaecf0;vertical-align:top;${column.align === 'right' ? 'text-align:right;' : ''}">${escapeHtml(column.render(row))}</td>`).join('')}
    </tr>
  `).join('');
};

const buildHtmlTable = ({ title, columns, rows, emptyMessage }) => `
  <h3 style="margin:18px 0 8px;">${escapeHtml(title)}</h3>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #eaecf0;width:100%;">
    <thead>
      <tr>
        ${columns.map((column) => `<th style="padding:8px;border:1px solid #eaecf0;background:#f2f4f7;text-align:${column.align === 'right' ? 'right' : 'left'};">${escapeHtml(column.label)}</th>`).join('')}
      </tr>
    </thead>
    <tbody>${buildHtmlRows(rows, columns, emptyMessage)}</tbody>
  </table>
`;

export const buildCajaCloseEmailHtml = ({ payload = {}, pdfAttached = false } = {}) => {
  const session = payload.session || {};
  const actors = payload.actors || {};
  const manualColumns = [
    { label: 'Fecha/hora', render: (row) => formatHtmlDateTime(row.fecha_hora) },
    { label: 'Monto', align: 'right', render: (row) => `L ${money(row.monto)}` },
    { label: 'Observacion', render: (row) => row.observacion || 'N/A' },
    { label: 'Referencia', render: (row) => row.referencia || 'N/A' },
    { label: 'Usuario ejecutor', render: (row) => row.usuario_ejecutor || 'No disponible' }
  ];
  const arqueoColumns = [
    { label: 'Metodo', render: (row) => row.metodo_pago_codigo || 'N/A' },
    { label: 'Teorico', align: 'right', render: (row) => `L ${money(row.monto_teorico)}` },
    { label: 'Declarado', align: 'right', render: (row) => `L ${money(row.monto_declarado)}` },
    { label: 'Diferencia', align: 'right', render: (row) => `L ${money(row.diferencia)}` },
    { label: 'Revision', render: (row) => (row.requiere_revision ? 'Si' : 'No') },
    { label: 'Observacion', render: (row) => row.observacion || 'N/A' }
  ];
  return `<!doctype html>
<html>
<body style="font-family:Arial,sans-serif;color:#111827;">
  <h2 style="margin:0 0 12px;">Cierre de caja registrado</h2>
  <p>Se registro un cierre de caja en JONNY'S SmartOrder.</p>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #eaecf0;">
    <tr><td><strong>Cierre</strong></td><td>${payload.idCierreCaja || 'N/A'}</td></tr>
    <tr><td><strong>Caja</strong></td><td>${session.nombre_caja || session.codigo_caja || 'N/A'}</td></tr>
    <tr><td><strong>Sucursal</strong></td><td>${session.nombre_sucursal || session.id_sucursal || 'N/A'}</td></tr>
    <tr><td><strong>Responsable</strong></td><td>${escapeHtml(resolveActorName({ nombre: actors.responsable_nombre, usuario: actors.responsable_usuario }))}</td></tr>
    <tr><td><strong>Usuario de cierre</strong></td><td>${escapeHtml(resolveActorName({ nombre: actors.cierre_nombre, usuario: actors.cierre_usuario }))}</td></tr>
    <tr><td><strong>Total teorico</strong></td><td>L ${money(payload.montoTeorico)}</td></tr>
    <tr><td><strong>Total declarado</strong></td><td>L ${money(payload.montoDeclaradoCierre)}</td></tr>
    <tr><td><strong>Diferencia</strong></td><td>L ${money(payload.diferencia)}</td></tr>
    <tr><td><strong>Revision</strong></td><td>${payload.requiresAudit ? 'Requiere revision' : 'Sin inconsistencias pendientes'}</td></tr>
  </table>
  ${buildHtmlTable({
    title: 'Arqueos por metodo',
    columns: arqueoColumns,
    rows: payload.arqueos,
    emptyMessage: 'Sin arqueos segmentados asociados.'
  })}
  ${buildHtmlTable({
    title: 'Ingresos manuales',
    columns: manualColumns,
    rows: payload.movimientosManuales?.ingresos,
    emptyMessage: 'Sin ingresos manuales registrados.'
  })}
  ${buildHtmlTable({
    title: 'Egresos manuales',
    columns: manualColumns,
    rows: payload.movimientosManuales?.egresos,
    emptyMessage: 'Sin egresos manuales registrados.'
  })}
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
  const idUsuarioResponsable = row.id_usuario_responsable || row.sesion_id_usuario_responsable;
  const actors = await fetchCajaCloseEmailActors(queryRunner, {
    idUsuarioResponsable,
    idUsuarioCierre: row.id_usuario_cierre
  });
  const movimientosManuales = await fetchCajaCloseManualMovements(queryRunner, row.id_sesion_caja);
  const arqueos = await fetchCajaCloseArqueos(queryRunner, row.id_cierre_caja);
  return {
    idCierreCaja: String(row.id_cierre_caja),
    idSesionCaja: String(row.id_sesion_caja),
    session: {
      id_sesion_caja: row.id_sesion_caja,
      id_caja: row.id_caja,
      id_sucursal: row.id_sucursal,
      id_usuario_responsable: idUsuarioResponsable,
      codigo_caja: row.codigo_caja,
      nombre_caja: row.nombre_caja,
      nombre_sucursal: row.nombre_sucursal
    },
    actors,
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
    arqueos,
    movimientosManuales
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
