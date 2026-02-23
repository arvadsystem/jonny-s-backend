/**
 * utils/security/sessionService.js
 * Maneja sesiones activas (HU79).
 */

import pool from '../../config/db-connection.js';

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
      timezone('America/Tegucigalpa', now()),
      timezone('America/Tegucigalpa', now())
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
    SET ultima_actividad = timezone('America/Tegucigalpa', now())
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
        fecha_cierre = timezone('America/Tegucigalpa', now()),
        motivo_cierre = $2
    WHERE id_sesion = $1 AND activa = TRUE
  `;
  await pool.query(sql, [id_sesion, motivo_cierre]);
}