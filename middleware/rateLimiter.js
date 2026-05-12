/**
 * middleware/rateLimiter.js
 * Rate limiters especificos para endpoints de autenticacion.
 * Objetivo:
 * - evitar bloqueo cruzado entre usuarios distintos en la misma IP
 * - contar principalmente intentos fallidos de login por cuenta+IP
 */
import rateLimit from 'express-rate-limit';

const sanitizeIdentifier = (value) => String(value || '').trim().toLowerCase().slice(0, 160);

const resolveLoginIdentifier = (req) =>
  sanitizeIdentifier(
    req?.body?.identifier ??
    req?.body?.nombre_usuario ??
    req?.body?.email ??
    'anonymous'
  );

const safeIp = (req) => String(req?.ip || req?.socket?.remoteAddress || 'unknown');

const buildLimiter = (options) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options
  });

/**
 * Limiter amplio por IP para bloquear abuso masivo.
 * No debe bloquear uso legitimo en redes compartidas.
 */
export const internalLoginIpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: {
    error: true,
    message: 'Demasiadas solicitudes de autenticacion desde esta red. Intenta de nuevo en unos minutos.'
  }
});

export const publicLoginIpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: {
    error: true,
    message: 'Demasiadas solicitudes de autenticacion desde esta red. Intenta de nuevo en unos minutos.'
  }
});

/**
 * Limiter estricto por cuenta + IP para intentos fallidos.
 * skipSuccessfulRequests evita consumir cupo con logins correctos.
 */
export const internalLoginAccountIpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 7,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${safeIp(req)}|${resolveLoginIdentifier(req)}`,
  message: {
    error: true,
    message: 'Demasiados intentos fallidos para esta cuenta. Intenta nuevamente en 15 minutos.'
  }
});

export const publicLoginAccountIpLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${safeIp(req)}|${resolveLoginIdentifier(req)}`,
  message: {
    error: true,
    message: 'Demasiados intentos fallidos para esta cuenta. Intenta nuevamente en 15 minutos.'
  }
});

/**
 * Limiter para registro: 5 registros cada 60 minutos por IP.
 */
export const registerLimiter = buildLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    error: true,
    message: 'Demasiados intentos de registro. Intenta de nuevo en una hora.'
  }
});

/**
 * Limiter para recuperacion de contrasena: 3 intentos cada 15 minutos por IP.
 */
export const forgotPasswordLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    error: true,
    message: 'Demasiados intentos. Intenta de nuevo en 15 minutos.'
  }
});

/**
 * Limiter para reenvio de verificacion: controla spam por cuenta + IP.
 */
export const resendVerificationLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 4,
  keyGenerator: (req) => `${safeIp(req)}|${resolveLoginIdentifier(req)}`,
  message: {
    error: true,
    message: 'Demasiados reenvios de verificacion. Intenta de nuevo en 15 minutos.'
  }
});

/**
 * Limiter especifico para cambio de contrasena autenticado.
 * Protege contra abuso de intentos con sesion comprometida.
 */
export const passwordChangeLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 6,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const userId = String(req?.user?.id_usuario || '').trim();
    return `${safeIp(req)}|${userId || 'anon'}`;
  },
  message: {
    error: true,
    message: 'Demasiados intentos de cambio de contrasena. Intenta nuevamente en 15 minutos.'
  }
});
