import assert from 'node:assert/strict';
import test from 'node:test';
import { changeInsumoPresentacionEstado } from '../routers/admin_insumo_presentaciones/service.js';

const createHarness = ({ insumoUnit, presentationUnit }) => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push('RELEASE'); }
  };
  let updates = 0;
  const overrides = {
    getClient: async () => client,
    findInsumoById: async () => ({ id_insumo: 10, estado: true, id_unidad_medida: insumoUnit }),
    findPresentacionById: async () => ({
      id_presentacion: 20,
      id_insumo: 10,
      id_unidad_base: presentationUnit,
      uso_compra: true,
      uso_receta: false,
      es_predeterminada_compra: false,
      es_predeterminada_receta: false
    }),
    clearDefaultCompra: async () => {},
    clearDefaultReceta: async () => {},
    updatePresentacionEstado: async (_client, _id, estado) => {
      updates += 1;
      assert.equal(estado, true);
    }
  };
  return { calls, overrides, getUpdates: () => updates };
};

test('reactivar presentacion compatible actualiza el estado', async () => {
  const harness = createHarness({ insumoUnit: 5, presentationUnit: 5 });
  await changeInsumoPresentacionEstado(10, 20, true, harness.overrides);
  assert.equal(harness.getUpdates(), 1);
  assert.ok(harness.calls.includes('BEGIN'));
  assert.ok(harness.calls.includes('COMMIT'));
});

test('reactivar presentacion incompatible devuelve 409 y no cambia el estado', async () => {
  const harness = createHarness({ insumoUnit: 5, presentationUnit: 8 });
  await assert.rejects(
    changeInsumoPresentacionEstado(10, 20, true, harness.overrides),
    (error) => error.status === 409
      && error.code === 'PRESENTACION_UNIDAD_BASE_INCOMPATIBLE'
      && /no coincide/.test(error.message)
  );
  assert.equal(harness.getUpdates(), 0);
  assert.equal(harness.calls.includes('BEGIN'), false);
  assert.ok(harness.calls.includes('ROLLBACK'));
});
