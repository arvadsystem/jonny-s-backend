import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const routerPath = path.join(repoRoot, 'routers/planillas.js');
const mojibakePattern = /Ãƒ|Ã‚|ï¿½|ÃƒÆ|Ãƒâ/;

test('estado CERRADA conserva permiso y alias propios', async () => {
  const source = await readFile(routerPath, 'utf8');

  assert.match(source, /CERRADA:\s*'CERRADA'/);
  assert.match(source, /normalized === 'CERRADA'\) return 'PLANILLAS_CERRAR'/);
  assert.doesNotMatch(source, /CERRADA:\s*'CALCULADA'/);
});

test('generacion oficial no usa la funcion mensual legacy', async () => {
  const source = await readFile(routerPath, 'utf8');

  assert.match(source, /const QUINCENA_FIXED_FACTOR = 0\.5;/);
  assert.match(source, /const factorProrrateo = resolvePlanillaFactor/);
  assert.doesNotMatch(source, /generar:\s*'fn_generar_planilla_mensual_por_sucursal'/);
  assert.doesNotMatch(source, /PLANILLA_FUNCTION_NAMES[\s\S]*fn_generar_planilla_mensual_por_sucursal/);
  assert.doesNotMatch(source, /queryFunction(?:Rows|Scalar)\(PLANILLA_ENDPOINT_CONTRACT\.generar/);
});

test('sincronizacion de salario y nuevos empleados usa factor de planilla', async () => {
  const source = await readFile(routerPath, 'utf8');

  assert.match(source, /const factor = resolvePlanillaFactor\(planillaMeta\);/);
  assert.match(source, /ROUND\(\(COALESCE\(e\.salario_base, 0\) \* \$4::numeric\)::numeric, 2\)/);
  assert.match(source, /ROUND\(\(COALESCE\(e\.salario_base, 0\) \* \$3::numeric\)::numeric, 2\)/);
});

test('respuesta de anulacion expone totales actualizados', async () => {
  const source = await readFile(routerPath, 'utf8');
  const actionBlock = source.slice(source.indexOf('async anularMovimiento(req)'));

  assert.match(actionBlock, /id_movimiento_planilla:/);
  assert.match(actionBlock, /id_detalle_planilla:/);
  assert.match(actionBlock, /neto_actualizado:/);
  assert.match(actionBlock, /total_bonos:/);
  assert.match(actionBlock, /total_deducciones:/);
});

test('router de planillas no contiene mojibake', async () => {
  const source = await readFile(routerPath, 'utf8');

  assert.doesNotMatch(source, mojibakePattern);
});
