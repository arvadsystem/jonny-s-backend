import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../sql/20260731_fidelizacion_roles_cajero_administrador.sql', import.meta.url),
  'utf8'
);
const router = await readFile(new URL('../routers/fidelizacion.js', import.meta.url), 'utf8');
const executableMigration = migration.replace(/^--.*$/gm, '');

const OPERATIONAL_PERMISSIONS = [
  'FIDELIZACION_VER_PANEL',
  'FIDELIZACION_VER_CLIENTES',
  'FIDELIZACION_VER_MOVIMIENTOS',
  'FIDELIZACION_CANJEAR_PRESENCIAL',
  'FIDELIZACION_VER_CANJES'
];

const ADMIN_PERMISSIONS = [
  'FIDELIZACION_CONFIGURAR_REGLAS',
  'FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES'
];

test('la migracion concede al cajero solo el flujo operativo de Fidelizacion', () => {
  for (const permission of OPERATIONAL_PERMISSIONS) {
    assert.match(migration, new RegExp(`'${permission}'`));
  }

  assert.match(
    migration,
    /REGEXP_REPLACE\(TRIM\(r\.nombre\), '\[\\s-\]\+', '_', 'g'\)\) = 'CAJERO'/
  );
  assert.match(migration, /DELETE FROM public\.roles_permisos[\s\S]*= 'CAJERO'[\s\S]*FIDELIZACION_CONFIGURAR_REGLAS/);
  assert.match(migration, /FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES/);
  assert.doesNotMatch(executableMigration, /FIDELIZACION_VER_MULTISUCURSAL/);
});

test('la migracion concede capacidades operativas y administrativas a ADMINISTRADOR', () => {
  assert.match(migration, /IN \('ADMIN', 'ADMINISTRADOR'\)/);
  for (const permission of [...OPERATIONAL_PERMISSIONS, ...ADMIN_PERMISSIONS]) {
    assert.match(migration, new RegExp(`'${permission}'`));
  }
});

test('la migracion es transaccional e idempotente', () => {
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /WHERE NOT EXISTS \(/);
  assert.match(migration, /GROUP BY UPPER\(TRIM\(p\.nombre_permiso\)\)/);
});

test('el backend mantiene separados consulta, canje e administracion', () => {
  assert.match(router, /checkPermission\(\['fidelizacion_ver_clientes'\]\)/);
  assert.match(router, /checkPermission\(\['fidelizacion_ver_movimientos'\]\)/);
  assert.match(router, /checkPermission\(\['fidelizacion_canjear_presencial'\]\)/);
  assert.match(router, /checkPermission\(\['fidelizacion_ver_canjes'\]\)/);
  assert.match(
    router,
    /assertAllPermissions\(req, \[\s*'fidelizacion_configurar_reglas',\s*'fidelizacion_gestionar_productos_canjeables'\s*\]\)/
  );
});
