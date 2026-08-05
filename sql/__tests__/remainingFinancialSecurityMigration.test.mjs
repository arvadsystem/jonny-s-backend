import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(here, '..');
const migrationName = '20260805020131_secure_remaining_financial_surface_and_defaults.sql';
const migration = readFileSync(path.join(sqlDir, migrationName), 'utf8');
const executableMigration = migration.replace(/--.*$/gm, '');
const functionDefaultFix = readFileSync(
  path.join(sqlDir, '20260805020414_secure_postgres_function_default_public_execute.sql'),
  'utf8'
);
const executableFunctionDefaultFix = functionDefaultFix.replace(/--.*$/gm, '');

const protectedTables = [
  'productos_almacenes',
  'facturacion_rangos_cai',
  'cat_metodos_pago',
  'fidelizacion_saldos_cliente',
  'fidelizacion_canjes',
  'fidelizacion_canjes_detalle',
  'fidelizacion_ajustes_pendientes',
  'fidelizacion_configuracion_sucursal',
  'fidelizacion_productos_canjeables_sucursal'
];

test('remaining financial migration closes each table and enables RLS', () => {
  for (const table of protectedTables) {
    assert.match(migration, new RegExp(`public\\.${table}\\b`));
    assert.match(migration, new RegExp(`ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'));
  }
  assert.match(migration, /FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  assert.doesNotMatch(executableMigration, /FROM[^;]*service_role/i);
  assert.doesNotMatch(migration, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
});

test('postgres defaults are private for future tables, sequences and functions', () => {
  for (const objectType of ['TABLES', 'SEQUENCES']) {
    assert.match(migration, new RegExp(
      `ALTER\\s+DEFAULT\\s+PRIVILEGES\\s+FOR\\s+ROLE\\s+postgres\\s+IN\\s+SCHEMA\\s+public[\\s\\S]*?REVOKE\\s+ALL\\s+PRIVILEGES\\s+ON\\s+${objectType}\\s+FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`,
      'i'
    ));
  }
  assert.match(migration, /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+postgres\s+IN\s+SCHEMA\s+public[\s\S]*?REVOKE\s+EXECUTE\s+ON\s+FUNCTIONS\s+FROM\s+PUBLIC,\s*anon,\s*authenticated/i);
  assert.match(functionDefaultFix, /ALTER\s+DEFAULT\s+PRIVILEGES\s+FOR\s+ROLE\s+postgres\s+REVOKE\s+EXECUTE\s+ON\s+FUNCTIONS\s+FROM\s+PUBLIC/i);
  assert.doesNotMatch(executableFunctionDefaultFix, /service_role/i);
});

test('pending-order RPCs retain internal resolution and deny Data API execution', () => {
  for (const version of ['v1', 'v2']) {
    const signature = `public\\.registrar_pedido_pendiente_pos_${version}\\(jsonb,\\s*jsonb\\)`;
    assert.match(migration, new RegExp(`ALTER\\s+FUNCTION\\s+${signature}[\\s\\S]*?SET\\s+search_path\\s*=\\s*pg_catalog,\\s*public`, 'i'));
    assert.match(migration, new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${signature}[\\s\\S]*?FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, 'i'));
  }
});

test('new security migrations cannot introduce unprotected public objects', () => {
  const candidates = readdirSync(sqlDir)
    .filter((name) => /^20260805.*(?:secure|financial).*\.sql$/i.test(name));

  for (const name of candidates) {
    const sql = readFileSync(path.join(sqlDir, name), 'utf8');
    const createdTables = [...sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z0-9_]+)/gi)].map((match) => match[1]);
    const createdSequences = [...sql.matchAll(/CREATE\s+SEQUENCE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-z0-9_]+)/gi)].map((match) => match[1]);
    const createdFunctions = [...sql.matchAll(/CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi)];

    for (const table of createdTables) {
      assert.match(sql, new RegExp(`ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i'), `${name}: ${table} must enable RLS`);
      assert.match(sql, new RegExp(`REVOKE[\\s\\S]*?ON\\s+TABLE[\\s\\S]*?public\\.${table}[\\s\\S]*?FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, 'i'), `${name}: ${table} must revoke Data API roles`);
    }
    for (const sequence of createdSequences) {
      assert.match(sql, new RegExp(`REVOKE[\\s\\S]*?ON\\s+SEQUENCE[\\s\\S]*?public\\.${sequence}[\\s\\S]*?FROM\\s+PUBLIC,\\s*anon,\\s*authenticated`, 'i'), `${name}: ${sequence} must revoke Data API roles`);
    }
    for (const [, functionName] of createdFunctions) {
      assert.match(sql, new RegExp(`REVOKE\\s+EXECUTE[\\s\\S]*?public\\.${functionName}\\s*\\(`, 'i'), `${name}: ${functionName} must revoke execute`);
    }
  }
});
