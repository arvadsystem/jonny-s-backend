import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL('../20260805001726_secure_ventas_idempotency_keys.sql', import.meta.url);
const migration = await readFile(migrationUrl, 'utf8');

test('revoca todos los privilegios de anon y authenticated sobre la tabla interna', () => {
  assert.match(
    migration,
    /REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+public\.ventas_idempotency_keys\s+FROM\s+anon\s*,\s*authenticated\s*;/i
  );
});

test('habilita RLS sin forzarlo para preservar el acceso del backend propietario', () => {
  assert.match(
    migration,
    /ALTER\s+TABLE\s+public\.ventas_idempotency_keys\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY\s*;/i
  );
  assert.doesNotMatch(migration, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
});

test('no crea politicas publicas ni concede permisos de reemplazo', () => {
  assert.doesNotMatch(migration, /CREATE\s+POLICY/i);
  assert.doesNotMatch(migration, /GRANT\s+/i);
});

test('no contiene DML ni operaciones destructivas', () => {
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i);
});

test('no referencia el proyecto de produccion', () => {
  assert.doesNotMatch(migration, /ooofeoziqaoqcufifqci/i);
});
