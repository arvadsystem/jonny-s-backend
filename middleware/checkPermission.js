/**
 * middleware/checkPermission.js
 * Valida permisos efectivos del usuario autenticado.
 *
 * Soporta:
 * - string: un permiso exacto
 * - array: acceso si tiene al menos uno de los permisos indicados
 * - bypass para rol SUPER_ADMIN
 * - compatibilidad temporal segura (endpoint nuevo -> permiso legacy equivalente)
 */

import pool from '../config/db-connection.js';

const LEGACY_PERMISSION_ALIASES = Object.freeze({
  // Compatibilidad segura (unidireccional): endpoint nuevo -> permiso legacy equivalente
  PERSONAS_MODULO_VER: ['PERSONAS_VER'],
  PERSONAS_LISTADO_VER: ['PERSONAS_VER'],
  PERSONAS_DETALLE_VER: ['PERSONAS_VER'],
  PERSONAS_USAR_FILTROS: ['PERSONAS_FILTROS_USAR'],

  EMPRESAS_MODULO_VER: ['EMPRESAS_VER'],
  EMPRESAS_LISTADO_VER: ['EMPRESAS_VER'],
  EMPRESAS_DETALLE_VER: ['EMPRESAS_VER'],
  EMPRESAS_USAR_FILTROS: ['EMPRESAS_FILTROS_USAR'],

  CLIENTES_MODULO_VER: ['CLIENTES_VER'],
  CLIENTES_LISTADO_VER: ['CLIENTES_VER'],
  CLIENTES_DETALLE_VER: ['CLIENTES_VER'],
  CLIENTES_USAR_FILTROS: ['CLIENTES_FILTROS_USAR'],

  EMPLEADOS_MODULO_VER: ['EMPLEADOS_VER'],
  EMPLEADOS_LISTADO_VER: ['EMPLEADOS_VER'],
  EMPLEADOS_DETALLE_VER: ['EMPLEADOS_VER'],
  EMPLEADOS_USAR_FILTROS: ['EMPLEADOS_FILTROS_USAR'],

  // Compatibilidad temporal del modulo Planillas mientras se propagan permisos PLANILLAS_* en roles.
  PLANILLAS_MODULO_VER: ['PERSONAS_MODULO_VER'],
  PLANILLAS_LISTADO_VER: ['PERSONAS_MODULO_VER'],
  PLANILLAS_DETALLE_VER: ['PERSONAS_MODULO_VER'],

  USUARIOS_MODULO_VER: ['USUARIOS_VER'],
  USUARIOS_LISTADO_VER: ['USUARIOS_VER'],
  USUARIOS_DETALLE_VER: ['USUARIOS_VER'],
  USUARIOS_USAR_FILTROS: ['USUARIOS_FILTROS_USAR'],
  USUARIOS_PASSWORD_CAMBIAR_PROPIO: ['USUARIOS_PASSWORD_CAMBIAR', 'PERFIL_PASSWORD_CAMBIAR'],

  ROLES_PERMISOS_MODULO_VER: ['ROLES_PERMISOS_VER'],
  ROLES_PERMISOS_ROLES_LISTADO_VER: ['ROLES_PERMISOS_VER'],
  ROLES_PERMISOS_ROLES_DETALLE_VER: ['ROLES_PERMISOS_DETALLE_VER', 'ROLES_PERMISOS_VER'],
  ROLES_PERMISOS_ROLES_CREAR: ['ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_ROLES_EDITAR: ['ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_ROLES_ELIMINAR: ['ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_ROLES_BUSCAR: ['ROLES_PERMISOS_BUSCAR'],
  ROLES_PERMISOS_PERMISOS_LISTADO_VER: ['ROLES_PERMISOS_VER'],
  ROLES_PERMISOS_PERMISOS_BUSCAR: ['ROLES_PERMISOS_BUSCAR'],
  ROLES_PERMISOS_PERMISOS_TOGGLE: ['ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_PERMISOS_SELECCIONAR_TODOS: ['ROLES_PERMISOS_SELECCIONAR_TODOS', 'ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_PERMISOS_QUITAR_TODOS: ['ROLES_PERMISOS_QUITAR_TODOS', 'ROLES_PERMISOS_EDITAR'],
  ROLES_PERMISOS_PERMISOS_GUARDAR: ['ROLES_PERMISOS_EDITAR'],
});

const normalizePermissionName = (value) =>
  String(value ?? '').trim().toUpperCase();

const buildCompatibilityAliasMap = (baseAliases) => {
  const normalizedMap = new Map();

  const ensureBucket = (key) => {
    const normalizedKey = normalizePermissionName(key);
    if (!normalizedKey) return null;
    if (!normalizedMap.has(normalizedKey)) normalizedMap.set(normalizedKey, new Set());
    return normalizedMap.get(normalizedKey);
  };

  for (const [targetPermission, aliasList] of Object.entries(baseAliases || {})) {
    const normalizedTarget = normalizePermissionName(targetPermission);
    if (!normalizedTarget) continue;

    const targetBucket = ensureBucket(normalizedTarget);
    if (!targetBucket) continue;

    for (const alias of Array.isArray(aliasList) ? aliasList : []) {
      const normalizedAlias = normalizePermissionName(alias);
      if (!normalizedAlias) continue;

      targetBucket.add(normalizedAlias);
    }
  }

  return Object.freeze(
    Object.fromEntries(
      [...normalizedMap.entries()].map(([key, values]) => [key, [...values]])
    )
  );
};

const COMPATIBILITY_PERMISSION_ALIASES = buildCompatibilityAliasMap(LEGACY_PERMISSION_ALIASES);

const expandPermissionAliases = (permission) => {
  const normalized = normalizePermissionName(permission);
  if (!normalized) return [];

  const aliases = COMPATIBILITY_PERMISSION_ALIASES[normalized] || [];
  return [normalized, ...aliases.map(normalizePermissionName).filter(Boolean)];
};

const normalizeRequiredPermissions = (value) => {
  const rows = Array.isArray(value) ? value : [value];
  const expanded = rows.flatMap(expandPermissionAliases).filter(Boolean);
  return [...new Set(expanded)];
};

const normalizeRoleName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const getRequestUser = (req) => req.user || req.usuario || null;

const resolveRequestUserId = (req) => {
  const user = getRequestUser(req);
  const idUsuario = Number.parseInt(String(user?.id_usuario ?? ''), 10);
  return Number.isInteger(idUsuario) && idUsuario > 0 ? idUsuario : null;
};

const readRequestPermissions = async (req) => {
  if (req?.__permissionAccess) return req.__permissionAccess;

  const idUsuario = resolveRequestUserId(req);
  if (!idUsuario) {
    const empty = {
      idUsuario: null,
      isSuperAdmin: false,
      permissions: new Set()
    };
    req.__permissionAccess = empty;
    return empty;
  }

  const sql = `
    SELECT
      COALESCE(
        BOOL_OR(UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'),
        FALSE
      ) AS is_super_admin,
      COALESCE(
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(p.nombre_permiso))), NULL),
        ARRAY[]::text[]
      ) AS permisos
    FROM roles_usuarios ru
    INNER JOIN roles r ON r.id_rol = ru.id_rol
    LEFT JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
    LEFT JOIN permisos p ON p.id_permiso = rp.id_permiso
    WHERE ru.id_usuario = $1
  `;

  const result = await pool.query(sql, [idUsuario]);
  const access = result.rows?.[0] || {};
  const permissions = new Set(
    (Array.isArray(access.permisos) ? access.permisos : [])
      .map(normalizePermissionName)
      .filter(Boolean)
  );

  const payload = {
    idUsuario,
    isSuperAdmin: Boolean(access.is_super_admin),
    permissions
  };

  req.__permissionAccess = payload;
  req.__isSuperAdmin = payload.isSuperAdmin;
  return payload;
};

export const requestHasAnyPermission = async (req, requiredPermission) => {
  const requiredPermissions = normalizeRequiredPermissions(requiredPermission);
  if (requiredPermissions.length === 0) return true;

  const access = await readRequestPermissions(req);
  if (access.isSuperAdmin) return true;
  return requiredPermissions.some((permission) => access.permissions.has(permission));
};

export const isRequestUserSuperAdmin = async (req) => {
  if (typeof req?.__isSuperAdmin === 'boolean') {
    return req.__isSuperAdmin;
  }

  const idUsuario = resolveRequestUserId(req);
  if (!idUsuario) {
    const empty = {
      idUsuario: null,
      isSuperAdmin: false,
      permissions: new Set()
    };
    req.__permissionAccess = empty;
    req.__isSuperAdmin = false;
    return false;
  }

  const user = getRequestUser(req);
  const tokenRoles = Array.isArray(user?.roles)
    ? user.roles.map(normalizeRoleName).filter(Boolean)
    : [];

  if (tokenRoles.includes('SUPER_ADMIN')) {
    req.__permissionAccess = {
      idUsuario,
      isSuperAdmin: true,
      permissions: new Set()
    };
    req.__isSuperAdmin = true;
    return true;
  }

  const access = await readRequestPermissions(req);
  return Boolean(access.isSuperAdmin);
};

export function checkPermission(requiredPermission) {
  const requiredPermissions = normalizeRequiredPermissions(requiredPermission);

  return async (req, res, next) => {
    try {
      const idUsuario = resolveRequestUserId(req);
      if (!idUsuario) {
        return res.status(401).json({ error: true, message: 'No autorizado' });
      }

      if (requiredPermissions.length === 0) {
        return next();
      }

      const access = await readRequestPermissions(req);
      const hasPermission = requiredPermissions.some((permission) =>
        access.permissions.has(permission)
      );

      if (access.isSuperAdmin || hasPermission) {
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

