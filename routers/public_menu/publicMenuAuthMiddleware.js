import jwt from 'jsonwebtoken';
import { requireActiveSession } from '../../middleware/requireActiveSession.js';
import { touchSessionMiddleware } from '../../middleware/touchSession.js';
import { sendPublicMenuClientError, sendPublicMenuError } from './publicMenuResponse.js';

const FALLBACK_JWT_SECRET = 'CAMBIA_ESTE_SECRET_EN_ENV';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_TOKEN_RE = /^[a-f0-9]{64}$/i;

const decodeCookieValue = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const normalizeCsrfToken = (value) => {
  const decoded = decodeCookieValue(value);
  if (!decoded) return null;
  return CSRF_TOKEN_RE.test(decoded) ? decoded.toLowerCase() : null;
};

const collectRawCookieValuesByName = (cookieHeader, name) => {
  const safeHeader = String(cookieHeader || '');
  const safeName = String(name || '').trim();
  if (!safeHeader || !safeName) return [];

  const prefix = `${safeName}=`;
  const values = [];

  for (const segment of safeHeader.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed || !trimmed.startsWith(prefix)) continue;
    values.push(trimmed.slice(prefix.length));
  }

  return values;
};

const resolveJwtSecret = () => {
  const secret = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : FALLBACK_JWT_SECRET);
  return String(secret || '').trim();
};

const clearPublicAuthCookies = (res) => {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd ? 'none' : 'lax';
  const secure = isProd;

  res.clearCookie('access_token', { path: '/', sameSite, secure });
  res.clearCookie('csrf_token', { path: '/', sameSite, secure });
};

// Convierte cualquier entrada a entero positivo. Devuelve null si no cumple.
const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

// Replica authRequired para el modulo publico, pero con contrato de error seguro.
const publicMenuAuthRequired = (req, res, next) => {
  const jwtSecret = resolveJwtSecret();
  if (!jwtSecret) {
    return sendPublicMenuError(req, res, {
      status: 500,
      fallbackMessage: 'Servicio temporalmente no disponible.'
    });
  }

  const token = req.cookies?.access_token;
  if (!token) {
    return sendPublicMenuClientError(req, res, {
      status: 401,
      message: 'No autorizado'
    });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = payload;
    return next();
  } catch (_error) {
    clearPublicAuthCookies(res);

    return sendPublicMenuClientError(req, res, {
      status: 401,
      message: 'Sesion expirada o invalida'
    });
  }
};

// Replica csrfProtect para conservar la misma regla de seguridad con respuesta saneada.
const publicMenuCsrfProtect = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const csrfHeader = normalizeCsrfToken(req.get('x-csrf-token'));
  const csrfCandidates = new Set();

  const cookieParserToken = normalizeCsrfToken(req.cookies?.csrf_token);
  if (cookieParserToken) csrfCandidates.add(cookieParserToken);

  const rawCookieHeader = req.get('cookie');
  const rawCookieTokens = collectRawCookieValuesByName(rawCookieHeader, 'csrf_token');
  for (const rawToken of rawCookieTokens) {
    const normalized = normalizeCsrfToken(rawToken);
    if (normalized) csrfCandidates.add(normalized);
  }

  if (!csrfHeader || csrfCandidates.size === 0 || !csrfCandidates.has(csrfHeader)) {
    return sendPublicMenuClientError(req, res, {
      status: 403,
      message: 'CSRF token invalido'
    });
  }

  return next();
};

// Reglas finales del modulo: solo clientes autenticados pueden crear pedidos.
export const requireAuthenticatedPublicCustomer = [
  publicMenuAuthRequired,
  requireActiveSession,
  publicMenuCsrfProtect,
  (req, res, next) => {
    const tipoUsuario = String(req.user?.tipo_usuario || '').trim().toUpperCase();
    const idUsuario = toPositiveInt(req.user?.id_usuario);
    const idCliente = toPositiveInt(req.user?.id_cliente);

    if (tipoUsuario !== 'CLIENTE') {
      return sendPublicMenuClientError(req, res, {
        status: 403,
        message: 'Solo clientes autenticados pueden crear pedidos.'
      });
    }

    if (!idUsuario || !idCliente) {
      return sendPublicMenuClientError(req, res, {
        status: 401,
        message: 'Sesion de cliente invalida. Inicia sesion nuevamente.'
      });
    }

    req.publicMenu = {
      ...(req.publicMenu || {}),
      auth: {
        idUsuario,
        idCliente,
        tipoUsuario
      }
    };

    return next();
  },
  touchSessionMiddleware
];
