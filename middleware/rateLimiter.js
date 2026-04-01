/**
 * middleware/rateLimiter.js
 * Rate limiters específicos para endpoints de autenticación.
 * Protege contra ataques de fuerza bruta.
 */
import rateLimit from 'express-rate-limit';

/**
 * Limiter para login: 10 intentos cada 15 minutos por IP.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: true,
    message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Limiter para registro: 5 registros cada 60 minutos por IP.
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    error: true,
    message: 'Demasiados intentos de registro. Intenta de nuevo en una hora.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Limiter para recuperación de contraseña: 3 intentos cada 15 minutos por IP.
 */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: {
    error: true,
    message: 'Demasiados intentos. Intenta de nuevo en 15 minutos.'
  },
  standardHeaders: true,
  legacyHeaders: false
});
