/**
 * middleware/requireActiveSession.js
 * HU79: valida que la sesión (sid) del JWT exista y esté activa en la BD.
 */

import pool from '../config/db-connection.js';

export async function requireActiveSession(req, res, next) {
  try {
    const user = req.user || req.usuario;

    // Si por alguna razón no hay user o sid, bloqueamos
    if (!user?.id_usuario || !user?.sid) {
      return res.status(401).json({ error: true, message: 'No autorizado (sin sesión)' });
    }

    // Verificar que la sesión exista, pertenezca al usuario y esté activa
    const sql = `
      SELECT 1
      FROM sesiones_activas
      WHERE id_sesion = $1
        AND id_usuario = $2
        AND activa = TRUE
      LIMIT 1
    `;

    const result = await pool.query(sql, [user.sid, user.id_usuario]);

    if (result.rows.length === 0) {
      // Sesión no existe o está cerrada -> limpiar cookies y bloquear
      const isProd = process.env.NODE_ENV === 'production';
      const sameSite = isProd ? 'none' : 'lax';
      const secure = isProd;

      res.clearCookie('access_token', { path: '/', sameSite, secure });
      res.clearCookie('csrf_token', { path: '/', sameSite, secure });

      return res.status(401).json({
        error: true,
        message: 'Sesión cerrada o inválida (cierre remoto)'
      });
    }

    return next();
  } catch (err) {
    console.error('requireActiveSession error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
}
