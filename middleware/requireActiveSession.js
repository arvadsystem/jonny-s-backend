/**
 * middleware/requireActiveSession.js
 * HU79: valida que la sesion (sid) del JWT exista y este activa en la BD.
 * HU162: invalida transversalmente sesiones vencidas por inactividad.
 */

import pool from '../config/db-connection.js';

const HN_NOW_SQL = "timezone('America/Tegucigalpa', now())";
const INACTIVITY_EXCLUDED_ROLE_CODES = Object.freeze([
  'COCINA',
  'MESERO',
  'AUXILIAR_COCINA',
  'P_COCINA'
]);

const parseInactivityMinutes = () => {
  const raw = Number.parseInt(String(process.env.SESSION_INACTIVITY_MINUTES ?? ''), 10);
  if (!Number.isInteger(raw) || raw <= 0) return 20;
  return raw;
};

const SESSION_INACTIVITY_MINUTES = parseInactivityMinutes();

const clearAuthCookies = (res) => {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd ? 'none' : 'lax';
  const secure = isProd;

  res.clearCookie('access_token', { path: '/', sameSite, secure });
  res.clearCookie('csrf_token', { path: '/', sameSite, secure });
};

export async function requireActiveSession(req, res, next) {
  try {
    const user = req.user || req.usuario;

    // Si por alguna razon no hay user o sid, bloqueamos
    if (!user?.id_usuario || !user?.sid) {
      return res.status(401).json({ error: true, message: 'No autorizado (sin sesion)' });
    }

    // Verificar que la sesion exista, pertenezca al usuario y este activa.
    // Ademas, validar inactividad para cierre transversal en cualquier endpoint protegido.
    const sql = `
      SELECT
        activa,
        (
          NOT EXISTS (
            SELECT 1
            FROM roles_usuarios ru
            INNER JOIN roles r ON r.id_rol = ru.id_rol
            WHERE ru.id_usuario = $2
              AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = ANY($4::text[])
          )
          AND
          ultima_actividad <= (${HN_NOW_SQL} - make_interval(mins => $3))
        ) AS expirada_por_inactividad
      FROM sesiones_activas
      WHERE id_sesion = $1
        AND id_usuario = $2
      LIMIT 1
    `;

    const result = await pool.query(sql, [
      user.sid,
      user.id_usuario,
      SESSION_INACTIVITY_MINUTES,
      INACTIVITY_EXCLUDED_ROLE_CODES
    ]);

    if (result.rows.length === 0) {
      // Sesion no existe -> limpiar cookies y bloquear.
      clearAuthCookies(res);
      return res.status(401).json({
        error: true,
        message: 'Sesion cerrada o invalida'
      });
    }

    const sessionRow = result.rows[0];
    const isActive = Boolean(sessionRow?.activa);
    const expiredByInactivity = Boolean(sessionRow?.expirada_por_inactividad);

    if (!isActive) {
      clearAuthCookies(res);
      return res.status(401).json({
        error: true,
        message: 'Sesion cerrada o invalida (cierre remoto)'
      });
    }

    if (expiredByInactivity) {
      await pool.query(
        `
          UPDATE sesiones_activas
          SET activa = FALSE,
              fecha_cierre = ${HN_NOW_SQL},
              motivo_cierre = 'inactividad'
          WHERE id_sesion = $1
            AND id_usuario = $2
            AND activa = TRUE
        `,
        [user.sid, user.id_usuario]
      );

      clearAuthCookies(res);
      return res.status(401).json({
        error: true,
        message: 'Sesion expirada por inactividad'
      });
    }

    return next();
  } catch (err) {
    console.error('requireActiveSession error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
}
