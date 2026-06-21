/**
 * middleware/touchSession.js
 * HU79: actualiza ultima_actividad de la sesión actual en cada request autenticada.
 */

import { touchSession } from '../utils/security/sessionService.js';

const TOUCH_SESSION_THROTTLE_MS = 60 * 1000;
const lastTouchBySid = new Map();

/**
 * Este middleware asume que tu middleware auth (authRequired)
 * ya decodificó el JWT y dejó el payload en req.user o req.usuario.
 *
 * Si en tu proyecto el payload queda en otro nombre, cambia solo esa línea.
 */
export async function touchSessionMiddleware(req, res, next) {
  try {
    // Ajusta según tu auth.js: en muchos proyectos es req.user
    const user = req.user || req.usuario;

    // Si no hay user o no hay sid, continuamos sin romper la request
    if (!user?.sid) return next();

    const sid = user.sid;
    const now = Date.now();
    const lastTouch = lastTouchBySid.get(sid);

    if (lastTouch && now - lastTouch < TOUCH_SESSION_THROTTLE_MS) {
      return next();
    }

    lastTouchBySid.set(sid, now);

    if (lastTouchBySid.size > 1000) {
      const staleBefore = now - TOUCH_SESSION_THROTTLE_MS * 5;
      for (const [storedSid, storedAt] of lastTouchBySid.entries()) {
        if (storedAt < staleBefore) {
          lastTouchBySid.delete(storedSid);
        }
      }
    }

    await touchSession(sid);
    return next();
  } catch (err) {
    // No bloqueamos la request si falla el touch
    console.error('touchSessionMiddleware error:', err);
    return next();
  }
}
