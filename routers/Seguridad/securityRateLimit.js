import rateLimit from 'express-rate-limit';

const sanitizePart = (value, max = 80) =>
  String(value ?? '')
    .trim()
    .slice(0, max);

const resolveActorId = (req) =>
  sanitizePart(req?.user?.id_usuario ?? req?.usuario?.id_usuario ?? 'anon', 24);

const resolveKey = (req) => `${sanitizePart(req?.ip || req?.socket?.remoteAddress || 'unknown')}|${resolveActorId(req)}`;

const buildLimiter = (options = {}) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: resolveKey,
    ...options
  });

export const securityReadLimiter = buildLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    error: true,
    message: 'Demasiadas solicitudes. Intenta nuevamente en unos segundos.'
  }
});

export const securityWriteLimiter = buildLimiter({
  windowMs: 5 * 60 * 1000,
  max: 45,
  message: {
    error: true,
    message: 'Demasiadas operaciones de seguridad. Intenta nuevamente en unos minutos.'
  }
});

