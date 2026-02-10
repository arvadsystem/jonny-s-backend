/**
 * utils/security/loginLogger.js
 * Inserta un registro en la tabla logins.
 */

import pool from '../../config/db-connection.js';

export async function insertLoginLog({
  id_usuario = null,
  id_sesion = null,
  ip_origen = null,
  nombre_usuario_intentado = null,
  user_agent = null,
  dispositivo = null,
  navegador = null,
  sistema_operativo = null,
  ubicacion = null,
  exito = null,
  mensaje_error = null
}) {
  const sql = `
    INSERT INTO logins (
      id_usuario,
      id_sesion,
      ip_origen,
      nombre_usuario_intentado,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion,
      exito,
      mensaje_error
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `;

  const params = [
    id_usuario,
    id_sesion,
    ip_origen,
    nombre_usuario_intentado,
    user_agent,
    dispositivo,
    navegador,
    sistema_operativo,
    ubicacion,
    exito,
    mensaje_error
  ];

  await pool.query(sql, params);
}
