import jwt from 'jsonwebtoken';
import JWT_SECRET from '../../config/jwt.js';

export const KITCHEN_DISPLAY_ROLE_CODE = 'P_COCINA';
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
export const KITCHEN_DISPLAY_REFRESH_MIN_AGE_SECONDS = 6 * 60 * 60;

export const normalizeAuthRoleCode = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

export const collectNormalizedAuthRoleCodes = (roles, ...fallbacks) => {
  const values = [
    ...(Array.isArray(roles) ? roles : []),
    ...fallbacks
  ];

  return [...new Set(values.map(normalizeAuthRoleCode).filter(Boolean))];
};

export const hasKitchenDisplayRole = (roles, ...fallbacks) =>
  collectNormalizedAuthRoleCodes(roles, ...fallbacks).includes(KITCHEN_DISPLAY_ROLE_CODE);

export const resolveAccessTokenTtlSeconds = (roles, ...fallbacks) =>
  hasKitchenDisplayRole(roles, ...fallbacks)
    ? KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS
    : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

export const issueAccessToken = (
  payload,
  {
    roles = payload?.roles,
    roleFallbacks = [payload?.nombre_rol, payload?.rol],
    ttlSeconds = resolveAccessTokenTtlSeconds(roles, ...roleFallbacks),
    secret = JWT_SECRET,
    issuedAtSeconds = null
  } = {}
) => {
  const cleanPayload = { ...(payload || {}) };
  delete cleanPayload.exp;
  delete cleanPayload.iat;
  delete cleanPayload.nbf;

  if (Number.isInteger(issuedAtSeconds) && issuedAtSeconds > 0) {
    cleanPayload.iat = issuedAtSeconds;
  }

  const token = jwt.sign(cleanPayload, secret, { expiresIn: ttlSeconds });

  return {
    token,
    ttlSeconds,
    cookieMaxAgeMs: ttlSeconds * 1000,
    payload: jwt.decode(token)
  };
};
