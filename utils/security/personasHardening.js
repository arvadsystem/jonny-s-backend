const SAFE_GENERIC_MESSAGES = Object.freeze({
  badRequest: 'Los datos enviados no son validos.',
  unauthorized: 'No autorizado.',
  forbidden: 'Acceso denegado.',
  notFound: 'No se encontro el recurso solicitado.',
  conflict: 'El registro ya existe.',
  serverError: 'No se pudo procesar la solicitud.'
});

const TECHNICAL_MESSAGE_PATTERNS = [
  /function\s+[\w.]+\s*\(/i,
  /relation\s+["'\w.]+\s+does not exist/i,
  /column\s+["'\w.]+\s+does not exist/i,
  /syntax error at or near/i,
  /duplicate key value violates/i,
  /violates (foreign key|unique|check|not-null)/i,
  /pg_/i,
  /at\s+\w.+\(\S+:\d+:\d+\)/i
];

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
export const DNI_REGEX = /^(?:\d{13}|\d{4}-\d{4}-\d{5})$/;
export const HN_PHONE_REGEX = /^\d{4}-\d{4}$/;
export const HUMAN_NAME_REGEX = /^[\p{L}\s.'-]+$/u;
export const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const normalizeText = (value) => String(value ?? '').trim();

const includesTechnicalPattern = (message) => {
  const text = normalizeText(message);
  if (!text) return false;
  return TECHNICAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
};

export const normalizePhoneHN = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
};

export const isValidDateOnly = (value) => {
  const text = normalizeText(value);
  if (!DATE_ONLY_REGEX.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime());
};

export const isFutureDateOnly = (value) => {
  if (!isValidDateOnly(value)) return false;
  const input = new Date(`${normalizeText(value)}T00:00:00Z`);
  const today = new Date();
  const utcToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return input.getTime() > utcToday.getTime();
};

export const isSafeEmail = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  return EMAIL_REGEX.test(text);
};

export const isSafeDni = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  return DNI_REGEX.test(text);
};

export const isSafeHumanName = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  return HUMAN_NAME_REGEX.test(text);
};

export const isSafePhoneHN = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  return HN_PHONE_REGEX.test(text);
};

export const buildErrorBody = ({
  message = SAFE_GENERIC_MESSAGES.serverError,
  code = 'INTERNAL_ERROR',
  details
} = {}) => {
  const body = {
    ok: false,
    error: true,
    code,
    message
  };

  if (details && typeof details === 'object' && Object.keys(details).length > 0) {
    body.details = details;
  }

  return body;
};

export const unknownFieldsFromPayload = (payload, allowedFields = new Set()) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.keys(payload).filter((field) => !allowedFields.has(field));
};

export const mapDbErrorToSafe = (err, options = {}) => {
  if (!err) return null;

  const defaultMessage = options.defaultMessage || SAFE_GENERIC_MESSAGES.serverError;
  const fallback = {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: defaultMessage
  };

  const code = String(err.code || '').trim();
  if (!code) {
    if (includesTechnicalPattern(err?.message)) return fallback;
    return null;
  }

  const mappedByCode = {
    '22P02': { status: 400, code: 'VALIDATION_ERROR', message: SAFE_GENERIC_MESSAGES.badRequest },
    '22003': { status: 400, code: 'VALIDATION_ERROR', message: SAFE_GENERIC_MESSAGES.badRequest },
    '22007': { status: 400, code: 'VALIDATION_ERROR', message: 'La fecha enviada no es valida.' },
    '22008': { status: 400, code: 'VALIDATION_ERROR', message: 'La fecha enviada no es valida.' },
    '23502': { status: 400, code: 'VALIDATION_ERROR', message: SAFE_GENERIC_MESSAGES.badRequest },
    '23503': { status: 400, code: 'RELATION_ERROR', message: 'La relacion enviada no es valida.' },
    '23505': { status: 409, code: 'CONFLICT_ERROR', message: SAFE_GENERIC_MESSAGES.conflict },
    '42P01': { status: 500, code: 'DB_SCHEMA_ERROR', message: defaultMessage },
    '42703': { status: 500, code: 'DB_SCHEMA_ERROR', message: defaultMessage },
    '42883': { status: 500, code: 'DB_FUNCTION_ERROR', message: defaultMessage }
  };

  if (mappedByCode[code]) {
    return mappedByCode[code];
  }

  if (code === 'P0001') {
    const rawMessage = normalizeText(err.message);
    if (/no existe|not found|no encontrado/i.test(rawMessage)) {
      return { status: 404, code: 'NOT_FOUND', message: SAFE_GENERIC_MESSAGES.notFound };
    }
    if (includesTechnicalPattern(rawMessage)) return fallback;
    return { status: 400, code: 'BUSINESS_RULE_ERROR', message: rawMessage || SAFE_GENERIC_MESSAGES.badRequest };
  }

  return fallback;
};

export const sanitizeApiErrorMessage = (message, status = 500) => {
  const text = normalizeText(message);
  if (!text) {
    if (status === 401) return SAFE_GENERIC_MESSAGES.unauthorized;
    if (status === 403) return SAFE_GENERIC_MESSAGES.forbidden;
    if (status === 404) return SAFE_GENERIC_MESSAGES.notFound;
    if (status === 409) return SAFE_GENERIC_MESSAGES.conflict;
    if (status >= 400 && status < 500) return SAFE_GENERIC_MESSAGES.badRequest;
    return SAFE_GENERIC_MESSAGES.serverError;
  }

  if (includesTechnicalPattern(text)) {
    if (status === 401) return SAFE_GENERIC_MESSAGES.unauthorized;
    if (status === 403) return SAFE_GENERIC_MESSAGES.forbidden;
    if (status === 404) return SAFE_GENERIC_MESSAGES.notFound;
    if (status === 409) return SAFE_GENERIC_MESSAGES.conflict;
    if (status >= 400 && status < 500) return SAFE_GENERIC_MESSAGES.badRequest;
    return SAFE_GENERIC_MESSAGES.serverError;
  }

  return text;
};

