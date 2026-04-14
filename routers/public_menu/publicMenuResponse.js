import { randomUUID } from 'crypto';

const REQUEST_ID_HEADER_IN = 'x-request-id';
const REQUEST_ID_HEADER_OUT = 'X-Request-Id';
const REQUEST_ID_PREFIX = 'pm';

const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'PUBLIC_MENU_BAD_REQUEST',
  401: 'PUBLIC_MENU_UNAUTHORIZED',
  403: 'PUBLIC_MENU_FORBIDDEN',
  404: 'PUBLIC_MENU_NOT_FOUND',
  409: 'PUBLIC_MENU_CONFLICT',
  422: 'PUBLIC_MENU_UNPROCESSABLE',
  429: 'PUBLIC_MENU_RATE_LIMIT'
});

const FALLBACK_SERVER_ERROR_MESSAGE =
  'No se pudo procesar la solicitud en este momento. Intenta nuevamente.';

const normalizeCompactText = (value, maxLength = 160) => {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!normalized) return '';
  return normalized.slice(0, maxLength);
};

const isSafeRequestId = (value) => /^[a-zA-Z0-9._:-]{6,80}$/.test(String(value || ''));

const buildGeneratedRequestId = () => `${REQUEST_ID_PREFIX}-${randomUUID()}`;

const resolveHttpStatus = (status) => {
  const parsed = Number(status);
  if (!Number.isInteger(parsed)) return 500;
  if (parsed < 400 || parsed > 599) return 500;
  return parsed;
};

const resolveErrorCode = (status, explicitCode = '') => {
  const code = normalizeCompactText(explicitCode, 80);
  if (code) return code;
  return ERROR_CODE_BY_STATUS[status] || 'PUBLIC_MENU_INTERNAL_ERROR';
};

const resolvePublicMessage = ({ status, explicitMessage = '', fallbackMessage = '' }) => {
  if (status >= 500) {
    const fallback = normalizeCompactText(fallbackMessage, 240);
    return fallback || FALLBACK_SERVER_ERROR_MESSAGE;
  }

  const safeMessage = normalizeCompactText(explicitMessage, 240);
  if (safeMessage) return safeMessage;

  const safeFallback = normalizeCompactText(fallbackMessage, 240);
  return safeFallback || 'No se pudo procesar la solicitud.';
};

const ensurePublicMenuRequestId = (req, res) => {
  const current = normalizeCompactText(req?.publicMenu?.requestId || res?.locals?.publicMenuRequestId, 80);
  if (current && isSafeRequestId(current)) {
    return current;
  }

  const incomingHeader = normalizeCompactText(req?.get?.(REQUEST_ID_HEADER_IN), 80);
  const requestId = isSafeRequestId(incomingHeader)
    ? incomingHeader
    : buildGeneratedRequestId();

  res.locals.publicMenuRequestId = requestId;
  req.publicMenu = {
    ...(req.publicMenu || {}),
    requestId
  };

  return requestId;
};

// Middleware del modulo publico para asegurar trazabilidad por request.
export const attachPublicMenuRequestContext = (req, res, next) => {
  const requestId = ensurePublicMenuRequestId(req, res);
  res.setHeader(REQUEST_ID_HEADER_OUT, requestId);
  return next();
};

export const getPublicMenuRequestId = (req, res) => ensurePublicMenuRequestId(req, res);

// Helper comun para errores esperados (4xx) en validaciones o reglas de negocio.
export const sendPublicMenuClientError = (
  req,
  res,
  {
    status = 400,
    code = '',
    message = '',
    fallbackMessage = ''
  } = {}
) =>
  sendPublicMenuError(req, res, {
    status,
    code,
    message,
    fallbackMessage
  });

// Maneja errores de controladores sin exponer mensajes internos al cliente.
export const sendPublicMenuError = (
  req,
  res,
  {
    status,
    code = '',
    message = '',
    fallbackMessage = '',
    error = null
  } = {}
) => {
  const effectiveStatus = resolveHttpStatus(status ?? error?.status);
  const resolvedCode = resolveErrorCode(effectiveStatus, code);
  const resolvedMessage = resolvePublicMessage({
    status: effectiveStatus,
    explicitMessage: message || error?.message,
    fallbackMessage
  });
  const requestId = ensurePublicMenuRequestId(req, res);

  if (effectiveStatus >= 500) {
    console.error(`Public menu error [${requestId}]`, {
      status: effectiveStatus,
      code: resolvedCode,
      errorMessage: normalizeCompactText(error?.message, 300),
      stack: error?.stack || null
    });
  }

  return res.status(effectiveStatus).json({
    ok: false,
    code: resolvedCode,
    message: resolvedMessage,
    request_id: requestId
  });
};
