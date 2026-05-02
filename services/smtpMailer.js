import nodemailer from 'nodemailer';

const parseBooleanEnv = (value, fallbackValue = false) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallbackValue;
  if (['1', 'true', 'yes', 'si', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallbackValue;
};

const parsePositiveIntEnv = (value, fallbackValue) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return fallbackValue;
};

const SMTP_HOST = String(process.env.SMTP_HOST ?? '').trim();
const SMTP_PORT = parsePositiveIntEnv(process.env.SMTP_PORT, 587);
const SMTP_SECURE = parseBooleanEnv(process.env.SMTP_SECURE, false);
const SMTP_USER = String(process.env.SMTP_USER ?? '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS ?? '').trim();
const SMTP_FROM_EMAIL = String(process.env.SMTP_FROM_EMAIL ?? 'noresponder@jonnyshn.com').trim();
const SMTP_FROM_NAME = String(process.env.SMTP_FROM_NAME ?? "Jonny's").trim();

let cachedTransporter = null;

const hasRequiredSmtpConfig = () =>
  Boolean(SMTP_HOST) &&
  Boolean(SMTP_PORT) &&
  Boolean(SMTP_USER) &&
  Boolean(SMTP_PASS) &&
  Boolean(SMTP_FROM_EMAIL);

const getTransporter = () => {
  if (!hasRequiredSmtpConfig()) {
    throw new Error('SMTP no configurado. Verifica variables SMTP_HOST/PORT/SECURE/USER/PASS/FROM.');
  }

  if (cachedTransporter) return cachedTransporter;

  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return cachedTransporter;
};

const getMissingSmtpFields = () => {
  const missing = [];
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  if (!SMTP_FROM_EMAIL) missing.push('SMTP_FROM_EMAIL');
  return missing;
};

export const isSmtpConfigured = () => hasRequiredSmtpConfig();

export const getSmtpSenderIdentity = () => ({
  email: SMTP_FROM_EMAIL,
  name: SMTP_FROM_NAME
});

export const runSmtpDiagnostic = async () => {
  const missingFields = getMissingSmtpFields();
  if (missingFields.length > 0 || !hasRequiredSmtpConfig()) {
    return {
      ok: false,
      status: 400,
      code: 'SMTP_NOT_CONFIGURED',
      message: 'Configuracion SMTP incompleta.',
      data: {
        configured: false,
        verified: false,
        missing_fields: missingFields
      }
    };
  }

  try {
    const transporter = getTransporter();
    await transporter.verify();
    return {
      ok: true,
      status: 200,
      data: {
        configured: true,
        verified: true,
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        from_email: SMTP_FROM_EMAIL,
        from_name: SMTP_FROM_NAME
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      code: 'SMTP_VERIFY_FAILED',
      message: 'No se pudo verificar conexion o autenticacion SMTP.',
      data: {
        configured: true,
        verified: false,
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        error_message: String(error?.message || 'Error SMTP desconocido')
      }
    };
  }
};

export const sendCampaignEmail = async ({ to, subject, html }) => {
  const transporter = getTransporter();
  const sender = getSmtpSenderIdentity();

  return transporter.sendMail({
    from: {
      name: sender.name,
      address: sender.email
    },
    to,
    subject,
    html
  });
};

export const sendReportEmail = async ({ to, subject, html, text, attachments = [] }) => {
  const transporter = getTransporter();
  const sender = getSmtpSenderIdentity();

  return transporter.sendMail({
    from: {
      name: sender.name,
      address: sender.email
    },
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {})
  });
};
