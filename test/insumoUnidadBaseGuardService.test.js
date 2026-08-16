import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  INSUMO_UNIDAD_BASE_CON_PRESENTACIONES_INCOMPATIBLES,
  validateInsumoUnidadBaseChange
} from '../services/insumoUnidadBaseGuardService.js';

test('cambio de unidad sin presentaciones activas incompatibles queda permitido', async () => {
  const calls = [];
  const result = await validateInsumoUnidadBaseChange({
    idInsumo: 10,
    nombreInsumo: 'Azucar',
    currentUnitId: 5,
    nextUnitId: 8
  }, {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  });
  assert.deepEqual(result, { ok: true, changed: true });
  assert.deepEqual(calls[0].params, [10, 8]);
  assert.match(calls[0].sql, /COALESCE\(estado, true\) IS TRUE/);
  assert.match(calls[0].sql, /id_unidad_base IS DISTINCT FROM \$2::integer/);
});

test('cambio de unidad con presentacion activa incompatible devuelve 409', async () => {
  const result = await validateInsumoUnidadBaseChange({
    idInsumo: 10,
    nombreInsumo: 'AZUCAR 2 LB',
    currentUnitId: 5,
    nextUnitId: 8
  }, {
    async query() {
      return { rows: [{ id_presentacion: 4, nombre_presentacion: 'Bolsa' }], rowCount: 1 };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.code, INSUMO_UNIDAD_BASE_CON_PRESENTACIONES_INCOMPATIBLES);
  assert.match(result.message, /AZUCAR 2 LB/);
  assert.match(result.message, /Inactiva o corrige esas presentaciones/);
});

test('unidad sin cambio real no consulta presentaciones', async () => {
  let queries = 0;
  const result = await validateInsumoUnidadBaseChange({
    idInsumo: 10,
    currentUnitId: '5',
    nextUnitId: 5
  }, { async query() { queries += 1; } });
  assert.deepEqual(result, { ok: true, changed: false });
  assert.equal(queries, 0);
});

test('ambos endpoints de edicion invocan la misma guarda antes de actualizar unidad', async () => {
  const source = await readFile(new URL('../routers/insumos.js', import.meta.url), 'utf8');
  const fullRoute = source.slice(source.indexOf("router.put('/insumos/edicion'"), source.indexOf("router.put('/insumos',", source.indexOf("router.put('/insumos/edicion'")));
  const genericRoute = source.slice(source.indexOf("router.put('/insumos',"), source.indexOf("router.patch('/insumos/estado'"));

  for (const routeSource of [fullRoute, genericRoute]) assert.match(routeSource, /validateInsumoUnidadBaseChange\(/);
  assert.ok(fullRoute.indexOf('validateInsumoUnidadBaseChange(') < fullRoute.indexOf('updateInsumoCompleto('));
  assert.ok(genericRoute.indexOf('validateInsumoUnidadBaseChange(') < genericRoute.indexOf('UPDATE public.insumos'));
  assert.match(fullRoute, /idInsumo: mutationTarget\.masterId/);
  assert.match(genericRoute, /idInsumo: mutationTarget\.masterId/);
});
