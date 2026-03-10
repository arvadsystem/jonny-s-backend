/**
 * middleware/checkPermission.js
 * Valida permisos efectivos del usuario autenticado.
 *
 * Soporta:
 * - string: un permiso exacto
 * - array: acceso si tiene al menos uno de los permisos indicados
 * - bypass para rol SUPER_ADMIN
 */

import pool from '../config/db-connection.js';

const normalizeRequiredPermissions = (value) => {
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .map((row) => String(row ?? '').trim().toUpperCase())
    .filter(Boolean);
};

const normalizeRoleName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const getRequestUser = (req) => req.user || req.usuario || null;

export const isRequestUserSuperAdmin = async (req) => {
  if (typeof req?.__isSuperAdmin === 'boolean') {
    return req.__isSuperAdmin;
  }

  const user = getRequestUser(req);
  const idUsuario = Number.parseInt(String(user?.id_usuario ?? ''), 10);
  if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
    req.__isSuperAdmin = false;
    return false;
  }

  const tokenRoles = Array.isArray(user?.roles)
    ? user.roles.map(normalizeRoleName).filter(Boolean)
    : [];

  if (tokenRoles.includes('SUPER_ADMIN')) {
    req.__isSuperAdmin = true;
    return true;
  }

  const sql = `
    SELECT EXISTS (
      SELECT 1
      FROM roles_usuarios ru
      INNER JOIN roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1
        AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'
    ) AS is_super_admin
  `;

  const result = await pool.query(sql, [idUsuario]);
  const isSuperAdmin = Boolean(result.rows?.[0]?.is_super_admin);
  req.__isSuperAdmin = isSuperAdmin;
  return isSuperAdmin;
};

export function checkPermission(requiredPermission) {
  const requiredPermissions = normalizeRequiredPermissions(requiredPermission);

  return async (req, res, next) => {
    try {
      const user = getRequestUser(req);
      const idUsuario = Number.parseInt(String(user?.id_usuario ?? ''), 10);

      if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
        return res.status(401).json({ error: true, message: 'No autorizado' });
      }

      if (requiredPermissions.length === 0) {
        return next();
      }

      const sql = `
        SELECT
          COALESCE(
            BOOL_OR(UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'),
            FALSE
          ) AS is_super_admin,
          COALESCE(BOOL_OR(p.nombre_permiso = ANY($2::text[])), FALSE) AS has_permission
        FROM roles_usuarios ru
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        LEFT JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
        LEFT JOIN permisos p ON p.id_permiso = rp.id_permiso
        WHERE ru.id_usuario = $1
      `;

      const result = await pool.query(sql, [idUsuario, requiredPermissions]);
      const access = result.rows?.[0] || {};
      const isSuperAdmin = Boolean(access.is_super_admin);

      req.__isSuperAdmin = isSuperAdmin;

      if (isSuperAdmin || Boolean(access.has_permission)) {
        return next();
      }

      return res.status(403).json({
        error: true,
        message: 'Acceso denegado: permisos insuficientes'
      });
    } catch (err) {
      console.error('checkPermission error:', err);
      return res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
  };
}
