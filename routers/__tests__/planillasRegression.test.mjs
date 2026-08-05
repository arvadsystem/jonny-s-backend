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

  assert.match(actionBlock, /ensureMovimientoAnuladoState/);
  assert.match(actionBlock, /id_movimiento_planilla:/);
  assert.match(actionBlock, /id_detalle_planilla:/);
  assert.match(actionBlock, /anulado:\s*true/);
  assert.match(actionBlock, /es_anulado:\s*true/);
  assert.match(actionBlock, /estado_movimiento:\s*'ANULADO'/);
  assert.match(actionBlock, /neto_actualizado:/);
  assert.match(actionBlock, /total_bonos:/);
  assert.match(actionBlock, /total_deducciones:/);
});

test('dataset de movimientos marca anulados y evita nueva anulacion', async () => {
  const source = await readFile(routerPath, 'utf8');
  const datasetBlock = source.slice(
    source.indexOf('const buildMovimientosDataset'),
    source.indexOf('const resolvePlanillaMeta')
  );

  assert.match(datasetBlock, /AS anulado/);
  assert.match(datasetBlock, /AS estado_movimiento/);
  assert.match(datasetBlock, /const isAnulado = row\.estado === false \|\| row\.anulado === true/);
  assert.match(datasetBlock, /es_anulado:\s*isAnulado/);
  assert.match(datasetBlock, /anulable:\s*!isAnulado/);
});

test('anulacion verifica estado persistido y recalcula detalle', async () => {
  const source = await readFile(routerPath, 'utf8');
  const helperBlock = source.slice(
    source.indexOf('const ensureMovimientoAnuladoState'),
    source.indexOf('const listPlanillaEligibleEmployeesBySucursal')
  );

  assert.match(helperBlock, /SET estado = FALSE/);
  assert.match(helperBlock, /fn_recalcular_detalle_planilla/);
  assert.match(helperBlock, /MOVIMIENTO_ANULACION_NO_CONFIRMADA/);
});

test('router de planillas no contiene mojibake', async () => {
  const source = await readFile(routerPath, 'utf8');

  assert.doesNotMatch(source, mojibakePattern);
});
