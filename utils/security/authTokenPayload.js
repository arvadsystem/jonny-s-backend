const normalizeAuthCollection = (rows) =>
  (Array.isArray(rows) ? rows : [])
    .map((row) => String(row ?? '').trim())
    .filter(Boolean);

const isLegacyNumericRoleValue = (value) => /^\d+$/.test(String(value ?? '').trim());

const resolvePrimaryRoleName = (roles, ...fallbacks) => {
  const normalizedRoles = normalizeAuthCollection(roles);
  if (normalizedRoles.length > 0) return normalizedRoles[0];

  for (const fallback of fallbacks) {
    const candidate = String(fallback ?? '').trim();
    if (!candidate || isLegacyNumericRoleValue(candidate)) continue;
    return candidate;
  }

  return null;
};

export const getUserAuthzSnapshot = async (pool, idUsuario) => {
  const userId = Number.parseInt(String(idUsuario ?? ''), 10);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { roles: [], permisos: [] };
  }

  const [rolesResult, permisosResult] = await Promise.all([
    pool.query(
      `
        SELECT DISTINCT r.nombre
        FROM roles_usuarios ru
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        WHERE ru.id_usuario = $1
        ORDER BY r.nombre
      `,
      [userId]
    ),
    pool.query(
      `
        SELECT DISTINCT p.nombre_permiso
        FROM roles_usuarios ru
        INNER JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
        INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
        WHERE ru.id_usuario = $1
        ORDER BY p.nombre_permiso
      `,
      [userId]
    )
  ]);

  return {
    roles: normalizeAuthCollection(rolesResult.rows.map((row) => row?.nombre)),
    permisos: normalizeAuthCollection(permisosResult.rows.map((row) => row?.nombre_permiso))
  };
};

export const buildAuthRoleCompatFields = (roles, user = {}) => {
  const normalizedRoles = normalizeAuthCollection(roles);
  const primaryRole = resolvePrimaryRoleName(normalizedRoles, user?.nombre_rol, user?.rol);

  return {
    rol: primaryRole,
    nombre_rol: primaryRole,
    roles: normalizedRoles
  };
};

export const buildAuthTokenPayload = (user = {}, authz = {}) => {
  const roleFields = buildAuthRoleCompatFields(authz?.roles ?? user?.roles, user);

  return {
    id_usuario: user?.id_usuario ?? null,
    nombre_usuario: user?.nombre_usuario ?? null,
    rol: roleFields.rol,
    nombre_rol: roleFields.nombre_rol,
    roles: roleFields.roles,
    id_sucursal: user?.id_sucursal ?? null,
    must_change_password: Boolean(user?.must_change_password),
    sid: user?.sid ?? null
  };
};
