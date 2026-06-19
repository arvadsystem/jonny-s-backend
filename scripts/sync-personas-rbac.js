import pool from '../config/db-connection.js';

const PERSONAS_RBAC_PERMISSION_CATALOG = Object.freeze([
  'PERSONAS_MODULO_VER',
  'PERSONAS_LISTADO_VER',
  'PERSONAS_DETALLE_VER',
  'PERSONAS_CREAR',
  'PERSONAS_CREAR_DESDE_CLIENTES',
  'PERSONAS_EDITAR',
  'PERSONAS_ELIMINAR',
  'PERSONAS_BUSCAR',
  'PERSONAS_USAR_FILTROS',
  'PERSONAS_ESTADO_CAMBIAR',
  'PERSONAS_VER_SOLO_RELACIONADOS',

  'EMPRESAS_MODULO_VER',
  'EMPRESAS_LISTADO_VER',
  'EMPRESAS_DETALLE_VER',
  'EMPRESAS_CREAR',
  'EMPRESAS_CREAR_DESDE_CLIENTES',
  'EMPRESAS_EDITAR',
  'EMPRESAS_ELIMINAR',
  'EMPRESAS_BUSCAR',
  'EMPRESAS_USAR_FILTROS',
  'EMPRESAS_ESTADO_CAMBIAR',
  'EMPRESAS_IMAGEN_SUBIR',
  'EMPRESAS_VER_SOLO_RELACIONADOS',

  'CLIENTES_MODULO_VER',
  'CLIENTES_LISTADO_VER',
  'CLIENTES_DETALLE_VER',
  'CLIENTES_CREAR',
  'CLIENTES_EDITAR',
  'CLIENTES_ELIMINAR',
  'CLIENTES_BUSCAR',
  'CLIENTES_USAR_FILTROS',
  'CLIENTES_ESTADO_CAMBIAR',
  'CLIENTES_PUNTOS_AJUSTAR',
  'CLIENTES_VER_SOLO_RELACIONADOS',

  'EMPLEADOS_MODULO_VER',
  'EMPLEADOS_LISTADO_VER',
  'EMPLEADOS_DETALLE_VER',
  'EMPLEADOS_CREAR',
  'EMPLEADOS_EDITAR',
  'EMPLEADOS_ELIMINAR',
  'EMPLEADOS_BUSCAR',
  'EMPLEADOS_USAR_FILTROS',
  'EMPLEADOS_ESTADO_CAMBIAR',
  'EMPLEADOS_IMAGEN_SUBIR',
  'EMPLEADOS_FICHA_IMPRIMIR',
  'EMPLEADOS_VER_SOLO_RELACIONADOS',
  'EMPLEADOS_VER_SOLO_PROPIOS',

  'USUARIOS_MODULO_VER',
  'USUARIOS_LISTADO_VER',
  'USUARIOS_DETALLE_VER',
  'USUARIOS_CREAR',
  'USUARIOS_EDITAR',
  'USUARIOS_ELIMINAR',
  'USUARIOS_BUSCAR',
  'USUARIOS_USAR_FILTROS',
  'USUARIOS_ESTADO_CAMBIAR',
  'USUARIOS_ROL_ASIGNAR',
  'USUARIOS_IMAGEN_SUBIR',
  'USUARIOS_PASSWORD_RESETEAR',
  'USUARIOS_PASSWORD_CAMBIAR_PROPIO',
  'USUARIOS_VER_SOLO_PROPIOS',
  'USUARIOS_VER_SOLO_RELACIONADOS',

  'ROLES_PERMISOS_MODULO_VER',
  'ROLES_PERMISOS_ROLES_LISTADO_VER',
  'ROLES_PERMISOS_ROLES_DETALLE_VER',
  'ROLES_PERMISOS_ROLES_CREAR',
  'ROLES_PERMISOS_ROLES_EDITAR',
  'ROLES_PERMISOS_ROLES_ELIMINAR',
  'ROLES_PERMISOS_ROLES_BUSCAR',
  'ROLES_PERMISOS_PERMISOS_LISTADO_VER',
  'ROLES_PERMISOS_PERMISOS_BUSCAR',
  'ROLES_PERMISOS_PERMISOS_TOGGLE',
  'ROLES_PERMISOS_PERMISOS_SELECCIONAR_TODOS',
  'ROLES_PERMISOS_PERMISOS_QUITAR_TODOS',
  'ROLES_PERMISOS_PERMISOS_GUARDAR',
  'ROLES_PERMISOS_AUDITORIA_VER'
]);

const ALL_PERSONAS_PERMISSIONS = [...PERSONAS_RBAC_PERMISSION_CATALOG];

const ROLE_BASELINE = Object.freeze({
  super_admin: ALL_PERSONAS_PERMISSIONS,
  administrador: ALL_PERSONAS_PERMISSIONS,
  gerente: ALL_PERSONAS_PERMISSIONS,
  supervisor: [
    ...ALL_PERSONAS_PERMISSIONS.filter(
      (permission) =>
        permission !== 'ROLES_PERMISOS_ROLES_ELIMINAR' &&
        permission !== 'ROLES_PERMISOS_AUDITORIA_VER'
    )
  ],
  cajero: [
    'CLIENTES_MODULO_VER',
    'CLIENTES_LISTADO_VER',
    'CLIENTES_DETALLE_VER',
    'CLIENTES_CREAR',
    'CLIENTES_BUSCAR',
    'CLIENTES_USAR_FILTROS',
    'PERSONAS_CREAR_DESDE_CLIENTES',
    'EMPRESAS_CREAR_DESDE_CLIENTES'
  ],
  mesero: [],
  cocina: [],
  auxiliar_cocina: []
});

const PERSONAS_SCOPE_PREFIXES = Object.freeze([
  'PERSONAS_',
  'EMPRESAS_',
  'CLIENTES_',
  'EMPLEADOS_',
  'USUARIOS_',
  'ROLES_PERMISOS_'
]);

const args = new Set(process.argv.slice(2).map((value) => String(value).trim().toLowerCase()));
const applyChanges = args.has('--apply');
const verbose = args.has('--verbose');
const pruneExtra = args.has('--prune-extra');

const normalizeText = (value) => String(value ?? '').trim();
const normalizePermissionName = (value) => normalizeText(value).toUpperCase();
const normalizeRoleName = (value) =>
  normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

const uniqueNormalizedPermissions = (values) => {
  const seen = new Set();
  const unique = [];
  for (const value of values || []) {
    const normalized = normalizePermissionName(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

const isPersonasScopedPermission = (permissionName) => {
  const normalized = normalizePermissionName(permissionName);
  if (!normalized) return false;
  return PERSONAS_SCOPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const log = (...parts) => {
  // eslint-disable-next-line no-console
  console.log('[RBAC-PERSONAS]', ...parts);
};

const upsertPermissionCatalog = async (client, permissions) => {
  const catalog = uniqueNormalizedPermissions(permissions);
  if (!catalog.length) return { inserted: 0, catalog };

  await client.query(
    `
      INSERT INTO permisos (nombre_permiso)
      SELECT src.nombre_permiso
      FROM UNNEST($1::text[]) AS src(nombre_permiso)
      WHERE NOT EXISTS (
        SELECT 1
        FROM permisos p
        WHERE UPPER(TRIM(p.nombre_permiso)) = UPPER(TRIM(src.nombre_permiso))
      )
    `,
    [catalog]
  );

  return { inserted: null, catalog };
};

const loadPermissionMap = async (client, permissions) => {
  const result = await client.query(
    `
      SELECT id_permiso, nombre_permiso
      FROM permisos
      WHERE UPPER(TRIM(nombre_permiso)) = ANY($1::text[])
    `,
    [uniqueNormalizedPermissions(permissions)]
  );

  const map = new Map();
  for (const row of result.rows || []) {
    map.set(normalizePermissionName(row.nombre_permiso), Number(row.id_permiso));
  }
  return map;
};

const loadRoleMap = async (client) => {
  const result = await client.query('SELECT id_rol, nombre FROM roles');
  const map = new Map();
  for (const row of result.rows || []) {
    map.set(normalizeRoleName(row.nombre), Number(row.id_rol));
  }
  return map;
};

const loadAssignedPermissionsByRole = async (client, roleIds) => {
  const normalizedRoleIds = [...new Set(
    (Array.isArray(roleIds) ? roleIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];

  if (!normalizedRoleIds.length) return new Map();

  const result = await client.query(
    `
      SELECT
        rp.id_rol,
        UPPER(TRIM(p.nombre_permiso)) AS nombre_permiso
      FROM roles_permisos rp
      INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
      WHERE rp.id_rol = ANY($1::int[])
    `,
    [normalizedRoleIds]
  );

  const assignedByRole = new Map(normalizedRoleIds.map((idRol) => [idRol, new Set()]));
  for (const row of result.rows || []) {
    const idRol = Number(row.id_rol);
    const permissionName = normalizePermissionName(row.nombre_permiso);
    if (!permissionName || !assignedByRole.has(idRol)) continue;
    assignedByRole.get(idRol).add(permissionName);
  }

  return assignedByRole;
};

const assignPermissionsToRole = async (client, idRol, permissionIds) => {
  if (!permissionIds.length) return 0;

  const result = await client.query(
    `
      INSERT INTO roles_permisos (id_permiso, id_rol)
      SELECT src.id_permiso, $2
      FROM UNNEST($1::int[]) AS src(id_permiso)
      WHERE NOT EXISTS (
        SELECT 1
        FROM roles_permisos rp
        WHERE rp.id_rol = $2
          AND rp.id_permiso = src.id_permiso
      )
    `,
    [permissionIds, idRol]
  );

  return Number(result.rowCount || 0);
};

const prunePermissionsFromRole = async (client, idRol, permissionNames) => {
  const normalizedPermissionNames = uniqueNormalizedPermissions(permissionNames);
  if (!normalizedPermissionNames.length) return 0;

  const result = await client.query(
    `
      DELETE FROM roles_permisos rp
      USING permisos p
      WHERE rp.id_permiso = p.id_permiso
        AND rp.id_rol = $1
        AND UPPER(TRIM(p.nombre_permiso)) = ANY($2::text[])
    `,
    [idRol, normalizedPermissionNames]
  );

  return Number(result.rowCount || 0);
};

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const catalogResult = await upsertPermissionCatalog(client, PERSONAS_RBAC_PERMISSION_CATALOG);
    const permissionMap = await loadPermissionMap(client, PERSONAS_RBAC_PERMISSION_CATALOG);
    const roleMap = await loadRoleMap(client);
    const baselineRoleIds = Object.keys(ROLE_BASELINE)
      .map((roleName) => roleMap.get(normalizeRoleName(roleName)))
      .filter((idRol) => Number.isInteger(idRol) && idRol > 0);
    const assignedPermissionsByRole = await loadAssignedPermissionsByRole(client, baselineRoleIds);

    const report = [];

    for (const [roleName, rolePermissions] of Object.entries(ROLE_BASELINE)) {
      const idRol = roleMap.get(normalizeRoleName(roleName));
      if (!idRol) {
        report.push({
          role: roleName,
          status: 'missing-role',
          insertedPermissions: 0
        });
        continue;
      }

      const normalizedBaselinePermissions = uniqueNormalizedPermissions(rolePermissions);
      const baselinePermissionSet = new Set(normalizedBaselinePermissions);
      const permissionIds = normalizedBaselinePermissions
        .map((permissionName) => permissionMap.get(permissionName))
        .filter((id) => Number.isInteger(id) && id > 0);
      const existingPermissions = assignedPermissionsByRole.get(idRol) || new Set();
      const extraPermissions = [...existingPermissions]
        .filter((permissionName) => !baselinePermissionSet.has(permissionName))
        .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }));
      const prunableExtraPermissions = extraPermissions.filter(isPersonasScopedPermission);

      const insertedPermissions = await assignPermissionsToRole(client, idRol, permissionIds);
      let prunedPermissions = 0;
      if (pruneExtra && applyChanges && prunableExtraPermissions.length > 0) {
        prunedPermissions = await prunePermissionsFromRole(client, idRol, prunableExtraPermissions);
      }
      report.push({
        role: roleName,
        status: 'ok',
        assignedBaseline: permissionIds.length,
        insertedPermissions,
        existingAssignedPermissions: existingPermissions.size,
        extraPermissionsCount: extraPermissions.length,
        extraPermissionsPreview: extraPermissions.slice(0, 10),
        prunableExtraPermissionsCount: prunableExtraPermissions.length,
        prunableExtraPermissionsPreview: prunableExtraPermissions.slice(0, 10),
        prunedPermissions
      });
    }

    if (applyChanges) {
      await client.query('COMMIT');
      log('Catalogo y baseline aplicados.');
    } else {
      await client.query('ROLLBACK');
      log('Dry-run completado (sin cambios persistidos). Usa --apply para persistir.');
    }

    if (verbose) {
      log('Catalog permissions:', catalogResult.catalog.length);
    }

    log(
      'ADVERTENCIA: sincronizacion aditiva. No elimina permisos existentes; solo agrega faltantes del baseline.'
    );
    if (pruneExtra) {
      log(
        applyChanges
          ? 'Modo --prune-extra activo: se eliminaron permisos heredados extra SOLO dentro del dominio Personas.'
          : 'Modo --prune-extra en dry-run: no se eliminaron permisos. Use --apply para ejecutar la limpieza.'
      );
      log(
        'La limpieza --prune-extra no toca permisos de modulos fuera de PERSONAS/EMPRESAS/CLIENTES/EMPLEADOS/USUARIOS/ROLES_PERMISOS.'
      );
    }
    const rolesWithExtras = report.filter(
      (item) => item.status === 'ok' && Number(item.extraPermissionsCount || 0) > 0
    );
    if (rolesWithExtras.length > 0) {
      log(
        'Roles con permisos heredados fuera del baseline (no removidos por este script):',
        JSON.stringify(
          rolesWithExtras.map((item) => ({
            role: item.role,
            extraPermissionsCount: item.extraPermissionsCount,
            extraPermissionsPreview: item.extraPermissionsPreview
          })),
          null,
          2
        )
      );
    }
    const rolesWithPrunableExtras = report.filter(
      (item) => item.status === 'ok' && Number(item.prunableExtraPermissionsCount || 0) > 0
    );
    if (rolesWithPrunableExtras.length > 0) {
      log(
        'Roles con permisos extra removibles (dominio Personas):',
        JSON.stringify(
          rolesWithPrunableExtras.map((item) => ({
            role: item.role,
            prunableExtraPermissionsCount: item.prunableExtraPermissionsCount,
            prunableExtraPermissionsPreview: item.prunableExtraPermissionsPreview,
            prunedPermissions: item.prunedPermissions
          })),
          null,
          2
        )
      );
    }

    log('Reporte por rol:', JSON.stringify(report, null, 2));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    log('Error en sincronizacion RBAC Personas:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
};

run();
