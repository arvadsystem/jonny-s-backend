/**
 * middleware/touchSession.js
 * HU79: actualiza ultima_actividad de la sesión actual en cada request autenticada.
 */

import { touchSession } from '../utils/security/sessionService.js';

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

    await touchSession(user.sid);
    return next();
  } catch (err) {
    // No bloqueamos la request si falla el touch
    console.error('touchSessionMiddleware error:', err);
    return next();
  }
}
