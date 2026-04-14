import pool from '../config/db-connection.js';
import { isSmtpConfigured, sendCampaignEmail } from './smtpMailer.js';

const CAMPAIGN_STATUS = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  PROCESSING: 'processing',
  SENT: 'sent',
  PARTIAL_FAILURE: 'partial_failure',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const RECIPIENT_STATUS = Object.freeze({
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped'
});

const ALLOWED_AUDIENCE = new Set(['all_clients', 'selected_clients']);
const ALLOWED_CREATE_STATUS = new Set([CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED]);
const ALLOWED_UPDATE_STATUS = new Set([CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED]);
const ALLOWED_LIST_STATUS = new Set(Object.values(CAMPAIGN_STATUS));
const ALLOWED_RECIPIENT_STATUS = new Set(Object.values(RECIPIENT_STATUS));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const SCRIPT_TAG_RE = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const EVENT_HANDLER_RE = /\son\w+\s*=\s*(['"]).*?\1/gi;
const JS_URI_RE = /\s(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi;

const MAX_TITLE = 180;
const MAX_SUBJECT = 240;
const MAX_HTML = 250000;
const MAX_ERR = 800;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH = 100;
const DEFAULT_BATCH = 15;
const DEFAULT_DELAY = 300;
const DEFAULT_MAX_SCHEDULED = 3;

let cachedClienteStateColumn = null;

class CampaignError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const hasValue = (v) =>
  v !== undefined &&
  v !== null &&
  !(typeof v === 'string' && v.trim() === '');

const toText = (v, maxLen = 0) => {
  const text = String(v ?? '').trim();
  if (!text) return '';
  return maxLen > 0 ? text.slice(0, maxLen) : text;
};

const toNullableText = (v, maxLen = 0) => {
  if (!hasValue(v)) return null;
  const text = toText(v, maxLen);
  return text || null;
};

const toInt = (v) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const toPage = (v) => toInt(v) || DEFAULT_PAGE;
const toLimit = (v) => {
  const n = toInt(v) || DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};

const toIsoFuture = (v, fieldName) => {
  if (!hasValue(v)) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new CampaignError(400, 'VALIDATION_ERROR', `${fieldName} no es valido.`);
  if (d.getTime() <= Date.now()) throw new CampaignError(400, 'VALIDATION_ERROR', `${fieldName} debe ser futuro.`);
  return d.toISOString();
};

const toIso = (v, fieldName) => {
  if (!hasValue(v)) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new CampaignError(400, 'VALIDATION_ERROR', `${fieldName} no es valido.`);
  return d.toISOString();
};

const normalizeStatus = (v) => String(v ?? '').trim().toLowerCase();
const normalizeAudience = (v) => String(v ?? '').trim().toLowerCase();
const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase();
const isEmail = (v) => EMAIL_RE.test(String(v ?? '').trim());
const sanitizeHtml = (v) =>
  String(v ?? '')
    .replace(SCRIPT_TAG_RE, '')
    .replace(EVENT_HANDLER_RE, '')
    .replace(JS_URI_RE, '')
    .trim();
const truncateErr = (v) => toText(v, MAX_ERR);
const toLogMeta = (meta) => {
  if (!meta || typeof meta !== 'object') return null;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
};

const logCampaignEvent = async ({ idCampaign, level = 'info', message, meta = null, db = pool }) => {
  const campaignId = toInt(idCampaign);
  const safeMessage = truncateErr(message || '');
  const safeLevel = String(level || 'info').trim().toLowerCase();
  if (!campaignId || !safeMessage || !safeLevel) return;

  await db.query(
    `
      INSERT INTO public.email_campaign_logs (id_campaign, level, message, meta, created_at)
      VALUES ($1, $2, $3, $4::jsonb, NOW())
    `,
    [campaignId, safeLevel, safeMessage, toLogMeta(meta)]
  ).catch(() => {});
};

const parseBoolEnv = (v, fallback = false) => {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t) return fallback;
  if (['1', 'true', 'yes', 'si', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return fallback;
};

const parsePositiveIntEnv = (v, fallback, max = null) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  if (Number.isInteger(max) && max > 0) return Math.min(n, max);
  return n;
};

const getBatchSize = () => parsePositiveIntEnv(process.env.EMAIL_BATCH_SIZE, DEFAULT_BATCH, MAX_BATCH);
const getBatchDelay = () => parsePositiveIntEnv(process.env.EMAIL_BATCH_DELAY_MS, DEFAULT_DELAY, 30000);
const getMaxScheduled = () =>
  parsePositiveIntEnv(process.env.EMAIL_SCHEDULER_MAX_PER_TICK, DEFAULT_MAX_SCHEDULED, 20);

const normalizeClientIds = (raw) => {
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  raw.forEach((it) => {
    const parsed = toInt(it);
    if (parsed) ids.add(parsed);
  });
  return [...ids];
};

const extractSelectedClientIds = (body = {}) => {
  if (Array.isArray(body.selected_client_ids)) return normalizeClientIds(body.selected_client_ids);
  if (Array.isArray(body.selectedClients)) return normalizeClientIds(body.selectedClients);
  return null;
};

const ensureSmtp = () => {
  if (!isSmtpConfigured()) {
    throw new CampaignError(500, 'SMTP_NOT_CONFIGURED', 'SMTP no configurado en backend.');
  }
};

const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getClienteStateColumn = async () => {
  if (cachedClienteStateColumn !== null) return cachedClienteStateColumn;
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'clientes'
        AND column_name = ANY($1::text[])
    `,
    [['estado', 'activo', 'habilitado']]
  );
  const set = new Set((result.rows || []).map((r) => String(r.column_name || '')));
  cachedClienteStateColumn = set.has('estado')
    ? 'estado'
    : set.has('activo')
    ? 'activo'
    : set.has('habilitado')
    ? 'habilitado'
    : '';
  return cachedClienteStateColumn;
};

const loadAudienceRecipients = async ({ audienceType, selectedClientIds = [], db }) => {
  const stateCol = await getClienteStateColumn();
  const params = [];
  const where = [];

  if (audienceType === 'selected_clients') {
    if (!selectedClientIds.length) return [];
    params.push(selectedClientIds);
    where.push(`c.id_cliente = ANY($${params.length}::int[])`);
  }
  if (stateCol) where.push(`COALESCE(c.${stateCol}, true) = true`);

  const sqlWhere = where.length ? where.join(' AND ') : '1=1';
  const result = await db.query(
    `
      SELECT
        c.id_cliente,
        COALESCE(
          NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
          NULLIF(TRIM(COALESCE(e.nombre_empresa, '')), ''),
          CONCAT('Cliente #', c.id_cliente::text)
        ) AS recipient_name,
        LOWER(TRIM(COALESCE(cp.direccion_correo, ce.direccion_correo, ''))) AS recipient_email
      FROM public.clientes c
      LEFT JOIN public.personas p ON p.id_persona = c.id_persona
      LEFT JOIN public.correos cp ON cp.id_correo = p.id_correo
      LEFT JOIN public.empresas e ON e.id_empresa = c.id_empresa
      LEFT JOIN public.correos ce ON ce.id_correo = e.id_correo
      WHERE ${sqlWhere}
    `,
    params
  );

  const seen = new Set();
  const rows = [];
  (result.rows || []).forEach((row) => {
    const email = normalizeEmail(row.recipient_email);
    if (!email || !isEmail(email) || seen.has(email)) return;
    seen.add(email);
    rows.push({
      id_cliente: toInt(row.id_cliente),
      recipient_name: toNullableText(row.recipient_name, 180),
      recipient_email: email
    });
  });
  return rows;
};

const insertRecipients = async ({ idCampaign, recipients, db }) => {
  if (!recipients.length) return;
  await db.query(
    `
      INSERT INTO public.email_campaign_recipients (
        id_campaign,
        id_cliente,
        recipient_email,
        recipient_name,
        send_status,
        created_at,
        updated_at
      )
      SELECT
        $1::bigint,
        x.id_cliente,
        x.recipient_email,
        x.recipient_name,
        $3::text,
        NOW(),
        NOW()
      FROM jsonb_to_recordset($2::jsonb) AS x (
        id_cliente integer,
        recipient_email text,
        recipient_name text
      )
      ON CONFLICT (id_campaign, lower(recipient_email))
      DO UPDATE SET
        id_cliente = EXCLUDED.id_cliente,
        recipient_name = EXCLUDED.recipient_name,
        send_status = $3::text,
        error_message = NULL,
        sent_at = NULL,
        updated_at = NOW()
    `,
    [idCampaign, JSON.stringify(recipients), RECIPIENT_STATUS.PENDING]
  );
};

const getCampaignRow = async (idCampaign, db = pool) => {
  const result = await db.query(
    `
      SELECT
        id_campaign,
        title,
        subject,
        html_content,
        audience_type,
        audience_snapshot,
        status,
        scheduled_for,
        started_at,
        finished_at,
        created_by,
        total_recipients,
        sent_count,
        failed_count,
        created_at,
        updated_at
      FROM public.email_campaigns
      WHERE id_campaign = $1
      LIMIT 1
    `,
    [idCampaign]
  );
  return result.rows?.[0] || null;
};

const getCampaignSummary = async (idCampaign, db = pool) => {
  const result = await db.query(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE send_status = $2)::int AS pending,
        COUNT(*) FILTER (WHERE send_status = $3)::int AS sending,
        COUNT(*) FILTER (WHERE send_status = $4)::int AS sent,
        COUNT(*) FILTER (WHERE send_status = $5)::int AS failed,
        COUNT(*) FILTER (WHERE send_status = $6)::int AS skipped
      FROM public.email_campaign_recipients
      WHERE id_campaign = $1
    `,
    [
      idCampaign,
      RECIPIENT_STATUS.PENDING,
      RECIPIENT_STATUS.SENDING,
      RECIPIENT_STATUS.SENT,
      RECIPIENT_STATUS.FAILED,
      RECIPIENT_STATUS.SKIPPED
    ]
  );
  return result.rows?.[0] || { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
};

const mapCampaign = (row) => ({
  ...row,
  id_campaign: toInt(row.id_campaign),
  total_recipients: Number(row.total_recipients || 0),
  sent_count: Number(row.sent_count || 0),
  failed_count: Number(row.failed_count || 0)
});

const readCampaignDetail = async (idCampaign, db = pool) => {
  const campaign = await getCampaignRow(idCampaign, db);
  if (!campaign) return null;
  const summary = await getCampaignSummary(idCampaign, db);
  let selectedClients = [];
  if (String(campaign.audience_type || '').toLowerCase() === 'selected_clients') {
    const selected = await db.query(
      `
        SELECT DISTINCT id_cliente, recipient_name, recipient_email
        FROM public.email_campaign_recipients
        WHERE id_campaign = $1
          AND id_cliente IS NOT NULL
        ORDER BY recipient_name ASC NULLS LAST, recipient_email ASC
        LIMIT 5000
      `,
      [idCampaign]
    );
    selectedClients = (selected.rows || []).map((row) => ({
      id_cliente: toInt(row.id_cliente),
      recipient_name: toNullableText(row.recipient_name, 180),
      recipient_email: normalizeEmail(row.recipient_email)
    }));
  }
  return mapCampaign({ ...campaign, summary, selected_clients: selectedClients });
};

const parsePayload = ({ payload, mode, current = null }) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  const title = toNullableText(body.title, MAX_TITLE);
  const subject = toNullableText(body.subject, MAX_SUBJECT);
  const audienceType = toNullableText(body.audience_type, 40);
  const selectedIds = extractSelectedClientIds(body);
  const hasSelectedIds = selectedIds !== null;
  const htmlRaw = body.html_content;
  const statusRaw = hasValue(body.status) ? normalizeStatus(body.status) : '';
  const output = {
    title,
    subject,
    audience_type: audienceType ? normalizeAudience(audienceType) : null,
    selected_client_ids: selectedIds || [],
    has_selected_ids: hasSelectedIds,
    html_content: null,
    status: null,
    scheduled_for: null
  };

  if (mode === 'create') {
    if (!title) throw new CampaignError(400, 'VALIDATION_ERROR', 'title es obligatorio.');
    if (!subject) throw new CampaignError(400, 'VALIDATION_ERROR', 'subject es obligatorio.');
    if (!output.audience_type || !ALLOWED_AUDIENCE.has(output.audience_type)) {
      throw new CampaignError(400, 'VALIDATION_ERROR', 'audience_type invalido.');
    }
    if (!hasValue(htmlRaw)) throw new CampaignError(400, 'VALIDATION_ERROR', 'html_content es obligatorio.');
    const html = sanitizeHtml(htmlRaw);
    if (!html) throw new CampaignError(400, 'VALIDATION_ERROR', 'html_content no puede quedar vacio.');
    if (html.length > MAX_HTML) throw new CampaignError(413, 'PAYLOAD_TOO_LARGE', 'html_content demasiado grande.');
    output.html_content = html;
    output.status = statusRaw || CAMPAIGN_STATUS.DRAFT;
    if (!ALLOWED_CREATE_STATUS.has(output.status)) {
      throw new CampaignError(400, 'VALIDATION_ERROR', 'status inicial invalido.');
    }
    output.scheduled_for =
      output.status === CAMPAIGN_STATUS.SCHEDULED ? toIsoFuture(body.scheduled_for, 'scheduled_for') : null;
    if (output.status === CAMPAIGN_STATUS.SCHEDULED && !output.scheduled_for) {
      throw new CampaignError(400, 'VALIDATION_ERROR', 'scheduled_for es obligatorio para scheduled.');
    }
    if (output.audience_type === 'selected_clients' && output.selected_client_ids.length === 0) {
      throw new CampaignError(400, 'VALIDATION_ERROR', 'selected_client_ids es obligatorio para selected_clients.');
    }
    return output;
  }

  if (!current) throw new CampaignError(500, 'INTERNAL_ERROR', 'No se pudo validar edicion.');
  if (hasValue(htmlRaw)) {
    const html = sanitizeHtml(htmlRaw);
    if (!html) throw new CampaignError(400, 'VALIDATION_ERROR', 'html_content no puede quedar vacio.');
    if (html.length > MAX_HTML) throw new CampaignError(413, 'PAYLOAD_TOO_LARGE', 'html_content demasiado grande.');
    output.html_content = html;
  }

  output.status = statusRaw || normalizeStatus(current.status);
  if (!ALLOWED_UPDATE_STATUS.has(output.status)) {
    throw new CampaignError(400, 'VALIDATION_ERROR', 'status invalido para edicion.');
  }

  if (hasValue(body.scheduled_for)) output.scheduled_for = toIsoFuture(body.scheduled_for, 'scheduled_for');
  else if (output.status === CAMPAIGN_STATUS.SCHEDULED) {
    output.scheduled_for = toIsoFuture(current.scheduled_for, 'scheduled_for');
  } else output.scheduled_for = null;

  if (output.audience_type && !ALLOWED_AUDIENCE.has(output.audience_type)) {
    throw new CampaignError(400, 'VALIDATION_ERROR', 'audience_type invalido.');
  }

  const resolvedAudience = output.audience_type || normalizeAudience(current.audience_type);
  if (resolvedAudience === 'selected_clients') {
    const currentIds = normalizeClientIds(current?.audience_snapshot?.selected_client_ids || []);
    const ids = output.has_selected_ids ? output.selected_client_ids : currentIds;
    if (!ids.length) {
      throw new CampaignError(400, 'VALIDATION_ERROR', 'selected_client_ids es obligatorio para selected_clients.');
    }
    output.selected_client_ids = ids;
  } else {
    output.selected_client_ids = [];
  }

  return output;
};

const assertEditableCampaign = (campaign) => {
  if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
  const status = normalizeStatus(campaign.status);
  if (![CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED].includes(status)) {
    throw new CampaignError(409, 'INVALID_STATE', 'Solo se puede editar en draft o scheduled.');
  }
  if (campaign.started_at) throw new CampaignError(409, 'INVALID_STATE', 'La campana ya inicio procesamiento.');
};

const requireRecipientsForExecutableStatus = (status, totalRecipients) => {
  if (status === CAMPAIGN_STATUS.DRAFT) return;
  if (Number(totalRecipients || 0) > 0) return;
  throw new CampaignError(400, 'VALIDATION_ERROR', 'No hay destinatarios validos para esta campana.');
};

const resolveFinalStatus = ({ total, pending, sending, sent, failed }) => {
  if (total <= 0) return CAMPAIGN_STATUS.FAILED;
  if (sent === total && failed === 0 && pending === 0 && sending === 0) return CAMPAIGN_STATUS.SENT;
  if (sent > 0) return CAMPAIGN_STATUS.PARTIAL_FAILURE;
  if (failed > 0) return CAMPAIGN_STATUS.FAILED;
  return CAMPAIGN_STATUS.PARTIAL_FAILURE;
};

const refreshCounters = async (idCampaign, db = pool) => {
  const s = await getCampaignSummary(idCampaign, db);
  const counters = {
    total: Number(s.total || 0),
    pending: Number(s.pending || 0),
    sending: Number(s.sending || 0),
    sent: Number(s.sent || 0),
    failed: Number(s.failed || 0)
  };
  const status = resolveFinalStatus(counters);
  await db.query(
    `
      UPDATE public.email_campaigns
      SET
        total_recipients = $2,
        sent_count = $3,
        failed_count = $4,
        status = $5,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id_campaign = $1
    `,
    [idCampaign, counters.total, counters.sent, counters.failed, status]
  );
  return { ...counters, status };
};

const logProcessingCompleted = async ({ idCampaign, trigger, counters, db = pool }) => {
  await logCampaignEvent({
    idCampaign,
    level: 'info',
    message: 'Procesamiento finalizado.',
    meta: { trigger, status: counters?.status || null },
    db
  });
  await logCampaignEvent({
    idCampaign,
    level: 'info',
    message: 'Resumen final de campana.',
    meta: {
      trigger,
      total_recipients: Number(counters?.total || 0),
      sent_count: Number(counters?.sent || 0),
      failed_count: Number(counters?.failed || 0),
      status: counters?.status || null
    },
    db
  });
};

const markFailed = async (idCampaign, message, db = pool, meta = null) => {
  await db.query(
    `
      UPDATE public.email_campaigns
      SET
        status = $2,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id_campaign = $1
    `,
    [idCampaign, CAMPAIGN_STATUS.FAILED]
  );
  await logCampaignEvent({
    idCampaign,
    level: 'error',
    message: 'Error general de campana.',
    meta: {
      ...(meta && typeof meta === 'object' ? meta : {}),
      error_message: truncateErr(message || 'Error de envio.')
    },
    db
  });
};

const processCampaignById = async (idCampaign, trigger = 'manual', options = {}) => {
  ensureSmtp();
  const requestedStatuses = Array.isArray(options?.targetStatuses)
    ? options.targetStatuses
        .map((item) => normalizeStatus(item))
        .filter((item) => ALLOWED_RECIPIENT_STATUS.has(item))
    : [];
  const targetStatuses = requestedStatuses.length > 0
    ? [...new Set(requestedStatuses)]
    : [RECIPIENT_STATUS.PENDING, RECIPIENT_STATUS.SENDING];
  const db = await pool.connect();
  try {
    const campaign = await getCampaignRow(idCampaign, db);
    if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
    if (normalizeStatus(campaign.status) !== CAMPAIGN_STATUS.PROCESSING) {
      throw new CampaignError(409, 'INVALID_STATE', 'La campana no esta en processing.');
    }
    await logCampaignEvent({
      idCampaign,
      level: 'info',
      message: 'Procesamiento iniciado.',
      meta: { trigger },
      db
    });

    const recipientsResult = await db.query(
      `
        SELECT id_campaign_recipient, recipient_email
        FROM public.email_campaign_recipients
        WHERE id_campaign = $1
          AND send_status = ANY($2::text[])
        ORDER BY id_campaign_recipient ASC
      `,
      [idCampaign, targetStatuses]
    );

    const recipients = recipientsResult.rows || [];
    if (!recipients.length) {
      const counters = await refreshCounters(idCampaign, db);
      await logProcessingCompleted({ idCampaign, trigger, counters, db });
      return { id_campaign: idCampaign, trigger, counters };
    }

    const batch = getBatchSize();
    const delay = getBatchDelay();

    for (let i = 0; i < recipients.length; i += batch) {
      const rows = recipients.slice(i, i + batch);
      for (const row of rows) {
        const idRecipient = toInt(row.id_campaign_recipient);
        if (!idRecipient) continue;
        await db.query(
          `
            UPDATE public.email_campaign_recipients
            SET send_status = $2, error_message = NULL, updated_at = NOW()
            WHERE id_campaign_recipient = $1
          `,
          [idRecipient, RECIPIENT_STATUS.SENDING]
        );

        try {
          await sendCampaignEmail({
            to: normalizeEmail(row.recipient_email),
            subject: campaign.subject,
            html: campaign.html_content
          });

          await db.query(
            `
              UPDATE public.email_campaign_recipients
              SET
                send_status = $2,
                sent_at = NOW(),
                error_message = NULL,
                updated_at = NOW()
              WHERE id_campaign_recipient = $1
            `,
            [idRecipient, RECIPIENT_STATUS.SENT]
          );
        } catch (error) {
          await db.query(
            `
              UPDATE public.email_campaign_recipients
              SET
                send_status = $2,
                error_message = $3,
                updated_at = NOW()
              WHERE id_campaign_recipient = $1
            `,
            [idRecipient, RECIPIENT_STATUS.FAILED, truncateErr(error?.message || 'No se pudo enviar el correo.')]
          );
        }
      }

      const hasMore = i + batch < recipients.length;
      if (hasMore && delay > 0) await sleep(delay);
    }

    const counters = await refreshCounters(idCampaign, db);
    await logProcessingCompleted({ idCampaign, trigger, counters, db });
    return { id_campaign: idCampaign, trigger, counters };
  } catch (error) {
    await markFailed(idCampaign, error?.message || 'Error procesando campana.', db, { trigger }).catch(() => {});
    if (error instanceof CampaignError) throw error;
    throw new CampaignError(500, 'INTERNAL_ERROR', 'No se pudo procesar la campana.');
  } finally {
    db.release();
  }
};

const claimScheduledCampaign = async () => {
  const result = await pool.query(
    `
      WITH next_campaign AS (
        SELECT id_campaign
        FROM public.email_campaigns
        WHERE status = $1
          AND scheduled_for IS NOT NULL
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC, id_campaign ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.email_campaigns c
      SET
        status = $2,
        started_at = COALESCE(c.started_at, NOW()),
        updated_at = NOW()
      FROM next_campaign n
      WHERE c.id_campaign = n.id_campaign
      RETURNING c.id_campaign
    `,
    [CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.PROCESSING]
  );
  return toInt(result.rows?.[0]?.id_campaign);
};

const claimSendNowCampaign = async (idCampaign) => {
  const result = await pool.query(
    `
      UPDATE public.email_campaigns
      SET
        status = $2,
        started_at = COALESCE(started_at, NOW()),
        scheduled_for = NULL,
        updated_at = NOW()
      WHERE id_campaign = $1
        AND status = ANY($3::text[])
      RETURNING id_campaign
    `,
    [idCampaign, CAMPAIGN_STATUS.PROCESSING, [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED]]
  );
  return toInt(result.rows?.[0]?.id_campaign);
};

const claimRetryFailedCampaign = async (idCampaign) => {
  const result = await pool.query(
    `
      UPDATE public.email_campaigns c
      SET
        status = $2,
        started_at = COALESCE(c.started_at, NOW()),
        finished_at = NULL,
        updated_at = NOW()
      WHERE c.id_campaign = $1
        AND c.status <> $3
        AND EXISTS (
          SELECT 1
          FROM public.email_campaign_recipients r
          WHERE r.id_campaign = c.id_campaign
            AND r.send_status = $4
        )
      RETURNING c.id_campaign
    `,
    [idCampaign, CAMPAIGN_STATUS.PROCESSING, CAMPAIGN_STATUS.CANCELLED, RECIPIENT_STATUS.FAILED]
  );
  return toInt(result.rows?.[0]?.id_campaign);
};

export const listCampaigns = async (filters = {}) => {
  const page = toPage(filters.page);
  const limit = toLimit(filters.limit);
  const offset = (page - 1) * limit;
  const status = normalizeStatus(filters.status);
  const q = toNullableText(filters.q, 120);
  const dateFrom = filters.date_from ? toIso(filters.date_from, 'date_from') : null;
  const dateTo = filters.date_to ? toIso(filters.date_to, 'date_to') : null;

  if (status && !ALLOWED_LIST_STATUS.has(status)) {
    throw new CampaignError(400, 'VALIDATION_ERROR', 'Filtro status invalido.');
  }

  const qText = q ? `%${q}%` : null;
  const count = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.email_campaigns
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR title ILIKE $2 OR subject ILIKE $2)
        AND ($3::timestamptz IS NULL OR created_at >= $3)
        AND ($4::timestamptz IS NULL OR created_at <= $4)
    `,
    [status || null, qText, dateFrom, dateTo]
  );
  const total = Number(count.rows?.[0]?.total || 0);

  const result = await pool.query(
    `
      SELECT
        id_campaign,
        title,
        subject,
        audience_type,
        status,
        scheduled_for,
        started_at,
        finished_at,
        total_recipients,
        sent_count,
        failed_count,
        created_at,
        updated_at
      FROM public.email_campaigns
      WHERE ($1::text IS NULL OR status = $1)
        AND ($2::text IS NULL OR title ILIKE $2 OR subject ILIKE $2)
        AND ($3::timestamptz IS NULL OR created_at >= $3)
        AND ($4::timestamptz IS NULL OR created_at <= $4)
      ORDER BY created_at DESC, id_campaign DESC
      LIMIT $5 OFFSET $6
    `,
    [status || null, qText, dateFrom, dateTo, limit, offset]
  );

  return {
    rows: (result.rows || []).map(mapCampaign),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit))
    }
  };
};

export const getCampaignById = async (idCampaign) => {
  const detail = await readCampaignDetail(idCampaign);
  if (!detail) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
  return detail;
};

export const getCampaignRecipients = async (idCampaign, filters = {}) => {
  const campaign = await getCampaignRow(idCampaign);
  if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');

  const page = toPage(filters.page);
  const limit = toLimit(filters.limit);
  const offset = (page - 1) * limit;
  const status = normalizeStatus(filters.status);
  const q = toNullableText(filters.q, 120);

  if (status && !ALLOWED_RECIPIENT_STATUS.has(status)) {
    throw new CampaignError(400, 'VALIDATION_ERROR', 'Filtro status destinatario invalido.');
  }

  const qText = q ? `%${q}%` : null;
  const count = await pool.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.email_campaign_recipients
      WHERE id_campaign = $1
        AND ($2::text IS NULL OR send_status = $2)
        AND ($3::text IS NULL OR recipient_email ILIKE $3 OR COALESCE(recipient_name, '') ILIKE $3)
    `,
    [idCampaign, status || null, qText]
  );
  const total = Number(count.rows?.[0]?.total || 0);

  const rows = await pool.query(
    `
      SELECT
        id_campaign_recipient,
        id_campaign,
        id_cliente,
        recipient_email,
        recipient_name,
        send_status,
        error_message,
        sent_at,
        created_at,
        updated_at
      FROM public.email_campaign_recipients
      WHERE id_campaign = $1
        AND ($2::text IS NULL OR send_status = $2)
        AND ($3::text IS NULL OR recipient_email ILIKE $3 OR COALESCE(recipient_name, '') ILIKE $3)
      ORDER BY id_campaign_recipient ASC
      LIMIT $4 OFFSET $5
    `,
    [idCampaign, status || null, qText, limit, offset]
  );

  return {
    rows: (rows.rows || []).map((r) => ({
      ...r,
      id_campaign_recipient: toInt(r.id_campaign_recipient),
      id_campaign: toInt(r.id_campaign),
      id_cliente: toInt(r.id_cliente)
    })),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit))
    }
  };
};

export const createCampaign = async ({ payload, idUsuario }) => {
  const parsed = parsePayload({ payload, mode: 'create' });
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const recipients = await loadAudienceRecipients({
      audienceType: parsed.audience_type,
      selectedClientIds: parsed.selected_client_ids,
      db
    });
    requireRecipientsForExecutableStatus(parsed.status, recipients.length);

    const insert = await db.query(
      `
        INSERT INTO public.email_campaigns (
          title,
          subject,
          html_content,
          audience_type,
          audience_snapshot,
          status,
          scheduled_for,
          created_by,
          total_recipients,
          sent_count,
          failed_count,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8, $9, 0, 0, NOW(), NOW())
        RETURNING id_campaign
      `,
      [
        parsed.title,
        parsed.subject,
        parsed.html_content,
        parsed.audience_type,
        JSON.stringify({
          selected_client_ids: parsed.audience_type === 'selected_clients' ? parsed.selected_client_ids : []
        }),
        parsed.status,
        parsed.scheduled_for,
        toInt(idUsuario),
        recipients.length
      ]
    );
    const idCampaign = toInt(insert.rows?.[0]?.id_campaign);
    if (!idCampaign) throw new CampaignError(500, 'INTERNAL_ERROR', 'No se pudo crear la campana.');

    await insertRecipients({ idCampaign, recipients, db });
    await db.query('COMMIT');
    await logCampaignEvent({
      idCampaign,
      level: 'info',
      message: 'Campana creada.',
      meta: {
        status: parsed.status,
        audience_type: parsed.audience_type,
        total_recipients: recipients.length
      }
    });
    if (parsed.status === CAMPAIGN_STATUS.SCHEDULED) {
      await logCampaignEvent({
        idCampaign,
        level: 'info',
        message: 'Campana programada.',
        meta: { scheduled_for: parsed.scheduled_for }
      });
    }
    return getCampaignById(idCampaign);
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof CampaignError) throw error;
    throw new CampaignError(500, 'INTERNAL_ERROR', 'No se pudo crear la campana.');
  } finally {
    db.release();
  }
};

export const updateCampaign = async ({ idCampaign, payload }) => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = await getCampaignRow(idCampaign, db);
    assertEditableCampaign(current);
    const parsed = parsePayload({ payload, mode: 'update', current });

    const audienceType = parsed.audience_type || normalizeAudience(current.audience_type);
    const rebuildRecipients = Boolean(parsed.audience_type) || parsed.has_selected_ids;
    let selectedIds = normalizeClientIds(current?.audience_snapshot?.selected_client_ids || []);
    let recipientsCount = Number(current.total_recipients || 0);

    if (rebuildRecipients) {
      selectedIds = audienceType === 'selected_clients' ? parsed.selected_client_ids : [];
      const recipients = await loadAudienceRecipients({
        audienceType,
        selectedClientIds: selectedIds,
        db
      });
      const status = parsed.status || normalizeStatus(current.status);
      requireRecipientsForExecutableStatus(status, recipients.length);
      await db.query('DELETE FROM public.email_campaign_recipients WHERE id_campaign = $1', [idCampaign]);
      await insertRecipients({ idCampaign, recipients, db });
      recipientsCount = recipients.length;
    }

    const status = parsed.status || normalizeStatus(current.status);
    requireRecipientsForExecutableStatus(status, recipientsCount);

    await db.query(
      `
        UPDATE public.email_campaigns
        SET
          title = $2,
          subject = $3,
          html_content = $4,
          audience_type = $5,
          audience_snapshot = $6::jsonb,
          status = $7,
          scheduled_for = $8::timestamptz,
          total_recipients = $9,
          sent_count = 0,
          failed_count = 0,
          updated_at = NOW()
        WHERE id_campaign = $1
      `,
      [
        idCampaign,
        parsed.title || current.title,
        parsed.subject || current.subject,
        parsed.html_content || current.html_content,
        audienceType,
        JSON.stringify({ selected_client_ids: audienceType === 'selected_clients' ? selectedIds : [] }),
        status,
        status === CAMPAIGN_STATUS.SCHEDULED ? parsed.scheduled_for : null,
        recipientsCount
      ]
    );

    await db.query('COMMIT');
    if (status === CAMPAIGN_STATUS.SCHEDULED) {
      await logCampaignEvent({
        idCampaign,
        level: 'info',
        message: 'Campana programada.',
        meta: { scheduled_for: parsed.scheduled_for }
      });
    }
    return getCampaignById(idCampaign);
  } catch (error) {
    await db.query('ROLLBACK');
    if (error instanceof CampaignError) throw error;
    throw new CampaignError(500, 'INTERNAL_ERROR', 'No se pudo actualizar la campana.');
  } finally {
    db.release();
  }
};

export const sendCampaignNow = async ({ idCampaign }) => {
  ensureSmtp();
  const campaign = await getCampaignRow(idCampaign);
  if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
  if (![CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED].includes(normalizeStatus(campaign.status))) {
    throw new CampaignError(409, 'INVALID_STATE', 'Solo se puede enviar en draft o scheduled.');
  }
  if (campaign.started_at) throw new CampaignError(409, 'INVALID_STATE', 'La campana ya inicio procesamiento.');
  requireRecipientsForExecutableStatus(normalizeStatus(campaign.status), campaign.total_recipients);

  const claimed = await claimSendNowCampaign(idCampaign);
  if (!claimed) throw new CampaignError(409, 'INVALID_STATE', 'No se pudo tomar la campana para envio.');
  await logCampaignEvent({
    idCampaign,
    level: 'info',
    message: 'Envio manual iniciado.',
    meta: { trigger: 'send_now' }
  });

  const result = await processCampaignById(idCampaign, 'send_now');
  const detail = await getCampaignById(idCampaign);
  return { ...result, campaign: detail };
};

export const retryFailedRecipients = async ({ idCampaign }) => {
  ensureSmtp();
  const campaign = await getCampaignRow(idCampaign);
  if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
  if (normalizeStatus(campaign.status) === CAMPAIGN_STATUS.PROCESSING) {
    throw new CampaignError(409, 'INVALID_STATE', 'La campana ya esta en procesamiento.');
  }

  const failedResult = await pool.query(
    `
      SELECT COUNT(*)::int AS total_failed
      FROM public.email_campaign_recipients
      WHERE id_campaign = $1
        AND send_status = $2
    `,
    [idCampaign, RECIPIENT_STATUS.FAILED]
  );
  const totalFailed = Number(failedResult.rows?.[0]?.total_failed || 0);
  if (totalFailed <= 0) {
    throw new CampaignError(409, 'INVALID_STATE', 'No hay destinatarios fallidos para reintentar.');
  }

  const claimed = await claimRetryFailedCampaign(idCampaign);
  if (!claimed) {
    throw new CampaignError(409, 'INVALID_STATE', 'No se pudo tomar la campana para reintento.');
  }
  await logCampaignEvent({
    idCampaign,
    level: 'info',
    message: 'Reintento de fallidos iniciado.',
    meta: { trigger: 'retry_failed', failed_candidates: totalFailed }
  });

  const result = await processCampaignById(idCampaign, 'retry_failed', {
    targetStatuses: [RECIPIENT_STATUS.FAILED]
  });
  await logCampaignEvent({
    idCampaign,
    level: 'info',
    message: 'Reintento de fallidos finalizado.',
    meta: {
      trigger: 'retry_failed',
      total_recipients: Number(result?.counters?.total || 0),
      sent_count: Number(result?.counters?.sent || 0),
      failed_count: Number(result?.counters?.failed || 0),
      status: result?.counters?.status || null
    }
  });
  const detail = await getCampaignById(idCampaign);
  return { ...result, campaign: detail };
};

export const cancelScheduledCampaign = async ({ idCampaign }) => {
  const result = await pool.query(
    `
      UPDATE public.email_campaigns
      SET
        status = $2,
        finished_at = NOW(),
        updated_at = NOW()
      WHERE id_campaign = $1
        AND status = $3
        AND started_at IS NULL
      RETURNING id_campaign
    `,
    [idCampaign, CAMPAIGN_STATUS.CANCELLED, CAMPAIGN_STATUS.SCHEDULED]
  );
  if (!result.rowCount) {
    const campaign = await getCampaignRow(idCampaign);
    if (!campaign) throw new CampaignError(404, 'NOT_FOUND', 'Campana no encontrada.');
    throw new CampaignError(409, 'INVALID_STATE', 'Solo se puede cancelar campanas scheduled no iniciadas.');
  }
  return getCampaignById(idCampaign);
};

export const processScheduledCampaigns = async ({ maxCampaigns = null } = {}) => {
  ensureSmtp();
  const max = Number.isInteger(maxCampaigns) && maxCampaigns > 0 ? maxCampaigns : getMaxScheduled();
  const processed = [];
  for (let i = 0; i < max; i += 1) {
    const idCampaign = await claimScheduledCampaign();
    if (!idCampaign) break;
    await logCampaignEvent({
      idCampaign,
      level: 'info',
      message: 'Scheduler tomo campana programada.',
      meta: { trigger: 'scheduler' }
    });
    try {
      processed.push(await processCampaignById(idCampaign, 'scheduler'));
    } catch (error) {
      console.error('[email_campaigns] scheduler error:', error);
    }
  }
  return { processed: processed.length, campaigns: processed };
};

export const normalizeCampaignError = (error) => {
  if (error instanceof CampaignError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details || null
    };
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'No se pudo completar la operacion solicitada.',
    details: null
  };
};

export const isEmailSchedulerEnabled = () => parseBoolEnv(process.env.EMAIL_SCHEDULER_ENABLED, true);

export const emailCampaignService = {
  listCampaigns,
  getCampaignById,
  getCampaignRecipients,
  createCampaign,
  updateCampaign,
  sendCampaignNow,
  retryFailedRecipients,
  cancelScheduledCampaign,
  processScheduledCampaigns
};
