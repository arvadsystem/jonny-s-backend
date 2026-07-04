/**
 * middleware/requireActiveSession.js
 * HU79: valida que la sesion (sid) del JWT exista y este activa en la BD.
 * HU162: invalida transversalmente sesiones vencidas por inactividad.
 */

import pool from '../config/db-connection.js';
import {
  CLIENT_SESSION_INACTIVITY_MINUTES,
  INACTIVITY_EXCLUDED_ROLE_CODES,
  SESSION_INACTIVITY_MINUTES
} from '../utils/security/sessionService.js';

const HN_NOW_SQL = "timezone('America/Tegucigalpa', now())";

const clearAuthCookies = (res) => {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd ? 'none' : 'lax';
  const secure = isProd;

  res.clearCookie('access_token', { path: '/', sameSite, secure });
  res.clearCookie('csrf_token', { path: '/', sameSite, secure });
};

export const createRequireActiveSession = ({ sessionPool = pool } = {}) => async (req, res, next) => {
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
          AND NOT EXISTS (
            SELECT 1
            FROM usuarios u_excluded
            WHERE u_excluded.id_usuario = $2
              AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(u_excluded.tipo_usuario, '')), '[\\s-]+', '_', 'g')) = ANY($4::text[])
          )
          AND
          ultima_actividad <= (
            ${HN_NOW_SQL} - make_interval(
              mins => (CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM usuarios u_cliente
                  WHERE u_cliente.id_usuario = $2
                    AND UPPER(TRIM(COALESCE(u_cliente.tipo_usuario, ''))) = 'CLIENTE'
                )
                OR EXISTS (
                  SELECT 1
                  FROM roles_usuarios ru_cliente
                  INNER JOIN roles r_cliente ON r_cliente.id_rol = ru_cliente.id_rol
                  WHERE ru_cliente.id_usuario = $2
                    AND UPPER(REGEXP_REPLACE(TRIM(r_cliente.nombre), '[\\s-]+', '_', 'g')) = 'CLIENTE'
                )
                THEN $5
                ELSE $3
              END)::integer
            )
          )
        ) AS expirada_por_inactividad
      FROM sesiones_activas sa
      WHERE sa.id_sesion = $1
        AND sa.id_usuario = $2
      LIMIT 1
    `;

    const result = await sessionPool.query(sql, [
      user.sid,
      user.id_usuario,
      SESSION_INACTIVITY_MINUTES,
      INACTIVITY_EXCLUDED_ROLE_CODES,
      CLIENT_SESSION_INACTIVITY_MINUTES
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
      await sessionPool.query(
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
};

export const requireActiveSession = createRequireActiveSession();
