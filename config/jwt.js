/**
 * config/jwt.js
 * Fuente única de verdad para el JWT_SECRET.
 * Todas las partes del sistema importan desde aquí.
 */

const FALLBACK_JWT_SECRET = 'CAMBIA_ESTE_SECRET_EN_ENV';

const JWT_SECRET = (() => {
  const fromEnv = process.env.JWT_SECRET;

  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (process.env.NODE_ENV === 'production') {
    console.error('❌ [FATAL] JWT_SECRET no está definido o es demasiado corto en producción.');
    process.exit(1);
  }

  if (!fromEnv) {
    console.warn('⚠️  [jwt] JWT_SECRET no definido — usando secret de desarrollo (NO USAR EN PRODUCCIÓN)');
  }

  return fromEnv || FALLBACK_JWT_SECRET;
})();

export default JWT_SECRET;
