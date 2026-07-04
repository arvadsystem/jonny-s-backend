/**
 * utils/security/sessionService.js
 * Maneja sesiones activas (HU79).
 */

import pool from '../../config/db-connection.js';
import { withDbTransaction } from '../../services/dbTransactionService.js';

const HN_NOW_SQL = "timezone('America/Tegucigalpa', now())";
export const INACTIVITY_EXCLUDED_ROLE_CODES = Object.freeze([
  'COCINA',
  'MESERO',
  'AUXILIAR_COCINA',
  'P_COCINA'
]);
export const CLIENT_SESSION_INACTIVITY_MINUTES = 60;
export const OPERATIONAL_DAILY_CUTOFF_ROLE_CODES = INACTIVITY_EXCLUDED_ROLE_CODES;
export const DAILY_CUTOFF_PROTECTED_ROLE_CODES = Object.freeze([
  'CLIENTE',
  'ADMINISTRADOR',
  'SUPER_ADMIN',
  'CAJERO',
  'ROOT',
  'AUXILIAR_INVENTARIO',
  'GESTOR_DE_EMPLEADOS'
]);

const CLIENT_ROLE_CODE = 'CLIENTE';
const CLIENT_SESSION_LOCK_NAMESPACE = 'auth:cliente:single-session';
const OPERATIONAL_CUTOFF_LOCK_NAMESPACE = 'auth:operational:daily-cutoff';
const HONDURAS_CUTOFF_RE = /^\d{4}-\d{2}-\d{2} 23:59:00$/;

const parseInactivityMinutes = () => {
  const raw = Number.parseInt(String(process.env.SESSION_INACTIVITY_MINUTES ?? ''), 10);
  if (!Number.isInteger(raw) || raw <= 0) return 20;
  return raw;
};

export const SESSION_INACTIVITY_MINUTES = parseInactivityMinutes();

const toPositiveUserId = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const insertSession = async (db, {
  id_usuario,
  ip_origen = null,
  user_agent = null,
  dispositivo = null,
  navegador = null,
  sistema_operativo = null,
  ubicacion = null
}) => {
  const result = await db.query(
    `
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
    `,
    [
      id_usuario,
      ip_origen,
      user_agent,
      dispositivo,
      navegador,
      sistema_operativo,
      ubicacion
    ]
  );

  return result.rows[0].id_sesion;
};

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
  return insertSession(pool, {
    id_usuario,
    ip_origen,
    user_agent,
    dispositivo,
    navegador,
    sistema_operativo,
    ubicacion
  });
}

export async function createExclusiveClientSession(sessionData, { poolOverride = null } = {}) {
  const idUsuario = toPositiveUserId(sessionData?.id_usuario);
  if (!idUsuario) {
    const error = new Error('CLIENT_SESSION_USER_INVALID');
    error.code = 'CLIENT_SESSION_USER_INVALID';
    throw error;
  }

  return withDbTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), $2::integer)',
      [CLIENT_SESSION_LOCK_NAMESPACE, idUsuario]
    );

    const scopeResult = await client.query(
      `
        SELECT 1
        FROM usuarios
        WHERE id_usuario = $1
          AND UPPER(TRIM(COALESCE(tipo_usuario, ''))) = $2
        LIMIT 1
        FOR SHARE
      `,
      [idUsuario, CLIENT_ROLE_CODE]
    );

    if (scopeResult.rowCount !== 1) {
      const error = new Error('CLIENT_SESSION_SCOPE_REQUIRED');
      error.code = 'CLIENT_SESSION_SCOPE_REQUIRED';
      throw error;
    }

    await client.query(
      `
        UPDATE sesiones_activas
        SET activa = FALSE,
            fecha_cierre = ${HN_NOW_SQL},
            motivo_cierre = 'replaced_by_new_login'
        WHERE id_usuario = $1
          AND activa = TRUE
      `,
      [idUsuario]
    );

    return insertSession(client, {
      ...sessionData,
      id_usuario: idUsuario
    });
  }, {
    label: 'create_exclusive_client_session',
    poolOverride
  });
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
  const result = await pool.query(sql, [id_sesion]);
  return result.rowCount || 0;
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
      AND sa.ultima_actividad <= (
        ${HN_NOW_SQL} - make_interval(
          mins => (CASE
            WHEN UPPER(TRIM(COALESCE((
              SELECT u_cliente.tipo_usuario
              FROM usuarios u_cliente
              WHERE u_cliente.id_usuario = sa.id_usuario
              LIMIT 1
            ), ''))) = '${CLIENT_ROLE_CODE}'
              OR EXISTS (
                SELECT 1
                FROM roles_usuarios ru_cliente
                INNER JOIN roles r_cliente ON r_cliente.id_rol = ru_cliente.id_rol
                WHERE ru_cliente.id_usuario = sa.id_usuario
                  AND UPPER(REGEXP_REPLACE(TRIM(r_cliente.nombre), '[\\s-]+', '_', 'g')) = '${CLIENT_ROLE_CODE}'
              )
            THEN $3
            ELSE $1
          END)::integer
        )
      )
      AND EXISTS (
        SELECT 1
        FROM usuarios u
        WHERE u.id_usuario = sa.id_usuario
      )
      AND NOT EXISTS (
        SELECT 1
        FROM roles_usuarios ru
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = sa.id_usuario
          AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = ANY($2::text[])
      )
      AND NOT EXISTS (
        SELECT 1
        FROM usuarios u_excluded
        WHERE u_excluded.id_usuario = sa.id_usuario
          AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(u_excluded.tipo_usuario, '')), '[\\s-]+', '_', 'g')) = ANY($2::text[])
      )
  `;

  const result = await pool.query(sql, [
    safeMinutes,
    INACTIVITY_EXCLUDED_ROLE_CODES,
    CLIENT_SESSION_INACTIVITY_MINUTES
  ]);
  return result.rowCount || 0;
}

export async function closeOperationalSessionsAtDailyCutoff(
  { cutoffLocal },
  { poolOverride = null } = {}
) {
  const normalizedCutoff = String(cutoffLocal || '').trim();
  if (!HONDURAS_CUTOFF_RE.test(normalizedCutoff)) {
    const error = new Error('OPERATIONAL_CUTOFF_INVALID');
    error.code = 'OPERATIONAL_CUTOFF_INVALID';
    throw error;
  }

  return withDbTransaction(async (client) => {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtext($1), 0) AS acquired',
      [OPERATIONAL_CUTOFF_LOCK_NAMESPACE]
    );

    if (lockResult.rows[0]?.acquired !== true) {
      return {
        executed: false,
        reason: 'LOCK_NOT_ACQUIRED',
        closedSessions: 0,
        cutoffLocal: normalizedCutoff
      };
    }

    const result = await client.query(
      `
        UPDATE sesiones_activas sa
        SET activa = FALSE,
            fecha_cierre = ${HN_NOW_SQL},
            motivo_cierre = 'daily_cutoff'
        WHERE sa.activa = TRUE
          AND sa.fecha_inicio <= $1::timestamp
          AND (
            EXISTS (
              SELECT 1
              FROM usuarios u_target
              WHERE u_target.id_usuario = sa.id_usuario
                AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(u_target.tipo_usuario, '')), '[\\s-]+', '_', 'g')) = ANY($2::text[])
            )
            OR EXISTS (
              SELECT 1
              FROM roles_usuarios ru_target
              INNER JOIN roles r_target ON r_target.id_rol = ru_target.id_rol
              WHERE ru_target.id_usuario = sa.id_usuario
                AND UPPER(REGEXP_REPLACE(TRIM(r_target.nombre), '[\\s-]+', '_', 'g')) = ANY($2::text[])
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM usuarios u_protected
            WHERE u_protected.id_usuario = sa.id_usuario
              AND UPPER(REGEXP_REPLACE(TRIM(COALESCE(u_protected.tipo_usuario, '')), '[\\s-]+', '_', 'g')) = ANY($3::text[])
          )
          AND NOT EXISTS (
            SELECT 1
            FROM roles_usuarios ru_other
            INNER JOIN roles r_other ON r_other.id_rol = ru_other.id_rol
            WHERE ru_other.id_usuario = sa.id_usuario
              AND UPPER(REGEXP_REPLACE(TRIM(r_other.nombre), '[\\s-]+', '_', 'g')) <> ALL($2::text[])
          )
      `,
      [
        normalizedCutoff,
        OPERATIONAL_DAILY_CUTOFF_ROLE_CODES,
        DAILY_CUTOFF_PROTECTED_ROLE_CODES
      ]
    );

    return {
      executed: true,
      reason: 'COMPLETED',
      closedSessions: result.rowCount || 0,
      cutoffLocal: normalizedCutoff
    };
  }, {
    label: 'close_operational_sessions_daily_cutoff',
    poolOverride
  });
}
