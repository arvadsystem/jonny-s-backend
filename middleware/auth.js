import jwt from 'jsonwebtoken';
import { buildAccessTokenCookieOptions } from '../utils/security/authCookieOptions.js';

const FALLBACK_JWT_SECRET = 'CAMBIA_ESTE_SECRET_EN_ENV';
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : FALLBACK_JWT_SECRET);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_TOKEN_RE = /^[a-f0-9]{64}$/i;
const normalizeSameSite = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'lax' || normalized === 'strict') {
    return normalized;
  }
  return fallback;
};

const csrfTokenCookieOptions = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    path: '/',
    secure: String(process.env.CSRF_COOKIE_SECURE || '').toLowerCase() === 'true' || isProd,
    sameSite: normalizeSameSite(process.env.CSRF_COOKIE_SAMESITE, isProd ? 'none' : 'lax'),
    domain: String(process.env.CSRF_COOKIE_DOMAIN || '').trim() || undefined
  };
};

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

export const authRequired = (req, res, next) => {
  if (!JWT_SECRET) {
    return res.status(500).json({
      error: true,
      message: 'Configuracion de seguridad incompleta: JWT_SECRET no definido'
    });
  }

  const token = req.cookies?.access_token;

  if (!token) {
    return res.status(401).json({ error: true, message: 'No autorizado' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    // Si el token expiró o es inválido, limpiamos cookies
    res.clearCookie('access_token', buildAccessTokenCookieOptions());
    res.clearCookie('csrf_token', csrfTokenCookieOptions());

    return res.status(401).json({ error: true, message: 'Sesión expirada o inválida' });
  }
};

export const csrfProtect = (req, res, next) => {
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
    return res.status(403).json({ error: true, message: 'CSRF token inválido' });
  }

  return next();
};
