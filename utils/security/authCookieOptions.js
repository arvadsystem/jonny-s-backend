const normalizeSameSite = (value, fallback) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'none' || normalized === 'lax' || normalized === 'strict') {
    return normalized;
  }
  return fallback;
};

export const buildAccessTokenCookieOptions = ({ maxAgeMs } = {}) => {
  const isProd = process.env.NODE_ENV === 'production';
  const options = {
    httpOnly: true,
    secure: String(process.env.AUTH_COOKIE_SECURE || '').toLowerCase() === 'true' || isProd,
    sameSite: normalizeSameSite(process.env.AUTH_COOKIE_SAMESITE, isProd ? 'none' : 'lax'),
    domain: String(process.env.AUTH_COOKIE_DOMAIN || '').trim() || undefined,
    path: '/'
  };

  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
    options.maxAge = maxAgeMs;
  }

  return options;
};
