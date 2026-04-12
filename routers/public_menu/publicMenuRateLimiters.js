import rateLimit from 'express-rate-limit';
import { sendPublicMenuClientError } from './publicMenuResponse.js';

const ONE_MINUTE_MS = 60 * 1000;

const normalizeIpKey = (request) => {
  const rawIp = String(request?.ip || '')
    .trim()
    .toLowerCase();

  if (!rawIp) return 'ip:unknown';
  return `ip:${rawIp}`;
};

const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const getRetryAfterSeconds = (request) => {
  const resetTime = request?.rateLimit?.resetTime;
  if (!(resetTime instanceof Date)) return 60;

  const milliseconds = resetTime.getTime() - Date.now();
  const seconds = Math.ceil(milliseconds / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
};

const buildPublicMenuRateLimiter = ({ max, message, keyGenerator }) =>
  rateLimit({
    windowMs: ONE_MINUTE_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (request, response, _next, options) => {
      const retryAfter = getRetryAfterSeconds(request);
      return sendPublicMenuClientError(request, response, {
        status: options.statusCode,
        code: 'PUBLIC_MENU_RATE_LIMIT',
        message: `${message} Intenta de nuevo en ${retryAfter}s.`
      });
    }
  });

// Lectura publica por IP (sucursales).
export const publicMenuBranchesReadLimiter = buildPublicMenuRateLimiter({
  max: 120,
  message: 'Demasiadas consultas de sucursales desde esta IP.',
  keyGenerator: normalizeIpKey
});

// Lectura publica por IP (menu vigente por sucursal).
export const publicMenuBranchMenuReadLimiter = buildPublicMenuRateLimiter({
  max: 90,
  message: 'Demasiadas consultas de menu vigente desde esta IP.',
  keyGenerator: normalizeIpKey
});

// Lectura publica por IP (catalogo).
export const publicMenuCatalogReadLimiter = buildPublicMenuRateLimiter({
  max: 60,
  message: 'Demasiadas consultas de catalogo desde esta IP.',
  keyGenerator: normalizeIpKey
});

// Lectura publica por IP (detalle de item).
export const publicMenuItemDetailReadLimiter = buildPublicMenuRateLimiter({
  max: 90,
  message: 'Demasiadas consultas de detalle de item desde esta IP.',
  keyGenerator: normalizeIpKey
});

// Escritura por IP en creacion de pedidos.
export const publicMenuOrderCreateIpLimiter = buildPublicMenuRateLimiter({
  max: 6,
  message: 'Demasiados intentos de crear pedido desde esta IP.',
  keyGenerator: normalizeIpKey
});

// Escritura por cuenta cliente en creacion de pedidos.
export const publicMenuOrderCreateCustomerLimiter = buildPublicMenuRateLimiter({
  max: 3,
  message: 'Demasiados intentos de crear pedido para esta cuenta.',
  keyGenerator: (request) => {
    const idCliente = toPositiveInt(request?.publicMenu?.auth?.idCliente);
    if (!idCliente) return normalizeIpKey(request);
    return `cliente:${idCliente}`;
  }
});
