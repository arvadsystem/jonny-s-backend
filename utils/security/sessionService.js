/**
 * utils/security/sessionService.js
 * Maneja sesiones activas (HU79).
 */

import pool from '../../config/db-connection.js';

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

/**
 * Crea una sesión activa al iniciar sesión.
 * @returns {string} id_sesion (UUID)
 */
export async function createSession({
  id_usuario,
  ip_origen = null,
  user_agent = null,
  dispositivo = null,
  navegador = null,
  sistema_operativo = null,
  ubicacion = null
}) {
  const sql = `
    INSERT INTO sesiones_activas (
      id_usuario,
      ip_origen,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion,
      fecha_inicio,
      ultima_actividad
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,
      ${HN_NOW_SQL},
      ${HN_NOW_SQL}
    )
    RETURNING id_sesion
  `;

  const result = await pool.query(sql, [
    id_usuario,
    ip_origen,
    user_agent,
    dispositivo,
    navegador,
    sistema_operativo,
    ubicacion
  ]);

  return result.rows[0].id_sesion;
}

/**
 * Actualiza la última actividad de una sesión.
 */
export async function touchSession(id_sesion) {
  const sql = `
    UPDATE sesiones_activas
    SET ultima_actividad = ${HN_NOW_SQL}
    WHERE id_sesion = $1 AND activa = TRUE
  `;
  await pool.query(sql, [id_sesion]);
}

/**
 * Cierra una sesión (logout o cierre remoto).
 */
export async function closeSession(id_sesion, motivo_cierre = 'logout') {
  const sql = `
    UPDATE sesiones_activas
    SET activa = FALSE,
        fecha_cierre = ${HN_NOW_SQL},
        motivo_cierre = $2
    WHERE id_sesion = $1 AND activa = TRUE
  `;
  await pool.query(sql, [id_sesion, motivo_cierre]);
}

/**
 * Cierra todas las sesiones activas de un usuario.
 * Util para hardening despues de reset/cambio de contrasena.
 */
export async function closeAllUserSessions(id_usuario, motivo_cierre = 'password_reset') {
  const sql = `
    UPDATE sesiones_activas
    SET activa = FALSE,
        fecha_cierre = ${HN_NOW_SQL},
        motivo_cierre = $2
    WHERE id_usuario = $1
      AND activa = TRUE
  `;
  const result = await pool.query(sql, [id_usuario, motivo_cierre]);
  return result.rowCount || 0;
}

/**
 * Cierra sesiones activas que ya superaron el umbral de inactividad.
 * Se usa en endpoints de consulta para mantener la vista de sesiones consistente.
 */
export async function closeInactiveSessions(minutes = SESSION_INACTIVITY_MINUTES) {
  const safeMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : SESSION_INACTIVITY_MINUTES;

  const sql = `
    UPDATE sesiones_activas sa
    SET activa = FALSE,
        fecha_cierre = ${HN_NOW_SQL},
        motivo_cierre = 'inactividad'
    WHERE sa.activa = TRUE
      AND sa.ultima_actividad <= (${HN_NOW_SQL} - make_interval(mins => $1))
      AND NOT EXISTS (
        SELECT 1
        FROM roles_usuarios ru
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = sa.id_usuario
          AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = ANY($2::text[])
      )
  `;

  const result = await pool.query(sql, [safeMinutes, INACTIVITY_EXCLUDED_ROLE_CODES]);
  return result.rowCount || 0;
}
