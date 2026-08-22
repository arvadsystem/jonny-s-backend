import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sqlUrl = new URL('../docs/sql/2026-08-22-oc-captura-rapida-base.sql', import.meta.url);
const contractUrl = new URL('../docs/oc-captura-rapida-contract.md', import.meta.url);
const readArtifacts = async () => Promise.all([readFile(sqlUrl, 'utf8'), readFile(contractUrl, 'utf8')]);

test('migracion es transaccional y crea las dos tablas requeridas', async () => {
  const [sql] = await readArtifacts();
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.capturas_compra_rapida\s*\(/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.capturas_compra_rapida_evidencias\s*\(/);
});

test('tabla principal conserva columnas tipos y cinco foreign keys restrict', async () => {
  const [sql] = await readArtifacts();
  for (const definition of [
    /id_captura_compra_rapida bigserial PRIMARY KEY/,
    /id_sucursal integer NOT NULL/,
    /id_almacen integer NOT NULL/,
    /id_usuario_registro integer NOT NULL/,
    /estado varchar\(20\) NOT NULL DEFAULT 'BORRADOR'/,
    /observacion varchar\(1000\)/,
    /fecha_creacion timestamp with time zone NOT NULL DEFAULT NOW\(\)/,
    /id_solicitud_compra integer/
  ]) assert.match(sql, definition);
  for (const reference of [
    /REFERENCES public\.sucursales\(id_sucursal\)/,
    /REFERENCES public\.almacenes\(id_almacen\)/,
    /REFERENCES public\.usuarios\(id_usuario\)/,
    /REFERENCES public\.solicitudes_compra\(id_solicitud_compra\)/
  ]) assert.match(sql, reference);
  assert.ok((sql.match(/ON UPDATE RESTRICT ON DELETE RESTRICT/g) || []).length >= 7);
});

test('constraints definen estados consistencia fuerte y orden temporal', async () => {
  const [sql] = await readArtifacts();
  for (const state of ['BORRADOR', 'PENDIENTE', 'FORMALIZADA', 'RECHAZADA']) assert.match(sql, new RegExp(`'${state}'`));
  assert.match(sql, /capturas_compra_rapida_consistencia_estado_ck/);
  assert.match(sql, /NULLIF\(BTRIM\(motivo_rechazo\), ''\) IS NOT NULL/);
  assert.match(sql, /fecha_envio IS NULL OR fecha_envio >= fecha_creacion/);
  assert.match(sql, /fecha_gestion IS NULL OR \(fecha_envio IS NOT NULL AND fecha_gestion >= fecha_envio\)/);
});

test('una captura se vincula a una OC y una OC a una captura como maximo', async () => {
  const [sql] = await readArtifacts();
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_capturas_compra_rapida_solicitud[\s\S]*WHERE id_solicitud_compra IS NOT NULL/);
});

test('evidencias aceptan solo FACTURA y no reutilizan id_archivo entre capturas', async () => {
  const [sql] = await readArtifacts();
  assert.match(sql, /ON UPDATE RESTRICT ON DELETE CASCADE/);
  assert.match(sql, /CHECK \(tipo_evidencia = 'FACTURA'\)/);
  assert.match(sql, /UNIQUE \(id_archivo\)/);
});

test('script crea exclusivamente los indices requeridos', async () => {
  const [sql] = await readArtifacts();
  for (const index of [
    'idx_capturas_compra_rapida_estado_fecha',
    'idx_capturas_compra_rapida_sucursal_estado_fecha',
    'idx_capturas_compra_rapida_usuario_fecha',
    'idx_capturas_compra_rapida_evidencias_captura_fecha'
  ]) assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
});

test('permisos usan missing_perms MAX y ROW_NUMBER sin IDs hardcodeados', async () => {
  const [sql] = await readArtifacts();
  for (const permission of [
    'INVENTARIO_OC_CAPTURA_RAPIDA_CREAR',
    'INVENTARIO_OC_CAPTURA_RAPIDA_VER',
    'INVENTARIO_OC_CAPTURA_RAPIDA_GESTIONAR'
  ]) assert.match(sql, new RegExp(permission));
  assert.match(sql, /missing_perms/);
  assert.match(sql, /MAX\(id_permiso\)/);
  assert.match(sql, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(sql, /INSERT INTO public\.permisos[\s\S]*VALUES\s*\(\s*\d+/);
});

test('asignacion usa roles normalizados y matriz exacta sin root ni admin generico', async () => {
  const [sql] = await readArtifacts();
  const matrix = sql.slice(sql.indexOf('WITH role_permissions'), sql.indexOf('COMMIT;'));
  for (const role of ['cajero', 'cocina', 'administrador', 'super_admin']) assert.match(matrix, new RegExp(`'${role}'`));
  assert.doesNotMatch(matrix, /'root'|'admin'/);
  assert.match(matrix, /REGEXP_REPLACE\(LOWER\(BTRIM\(r\.nombre\)\)/);
  assert.match(matrix, /WHERE NOT EXISTS/);
});

test('contrato documenta estados API seguridad facturas y formalizacion', async () => {
  const [, contract] = await readArtifacts();
  for (const requirement of [
    /NUEVA → BORRADOR/,
    /BORRADOR → PENDIENTE/,
    /PENDIENTE → FORMALIZADA/,
    /PENDIENTE → RECHAZADA/,
    /SELECT \.\.\. FOR UPDATE/,
    /ROLLBACK/,
    /estado = 'RECIBIDA'/,
    /mismo `id_archivo`/,
    /PENDIENTE no mueve inventario/,
    /Una imagen por request/,
    /6 MB/,
    /10 imágenes/
  ]) assert.match(contract, requirement);
  assert.ok((contract.match(/`\/api\/solicitudes_compra\/capturas-rapidas/g) || []).length >= 10);
});

test('documento contiene las quince pruebas de escritorio', async () => {
  const [, contract] = await readArtifacts();
  const rows = contract.match(/^\| \d+ \|/gm) || [];
  assert.equal(rows.length, 15);
});
