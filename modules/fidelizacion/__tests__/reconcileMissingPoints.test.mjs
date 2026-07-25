import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { reconcileMissingPoints } from '../workers/reconcileMissingPoints.js';
import { waitForFidelizacionQueueIdle } from '../infrastructure/fidelizacionQueue.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

const withMockedFidelizacionPoolConnect = async (connectImpl, run) => {
  const originalConnect = fidelizacionPool.connect;
  fidelizacionPool.connect = connectImpl;
  try {
    await run();
  } finally {
    fidelizacionPool.connect = originalConnect;
  }
};

const baseContext = (overrides = {}) => ({
  id_pedido: null,
  id_sucursal: 1,
  id_usuario: 9,
  id_cliente: 5,
  monto_factura: 100,
  fecha_referencia_config: '2026-03-01T10:00:00Z',
  tiene_pago_control: false,
  pago_control_monto_pendiente: null,
  pago_control_estado_codigo: null,
  ...overrides
});

describe('reconcileMissingPoints (worker de reconciliacion idempotente)', () => {
  it('encuentra facturas pagadas sin movimiento y las acumula via notifyPaidInvoice', async () => {
    const { client, state } = createFidelizacionMockClient({
      missingAccumulationIds: [1001, 1002],
      facturaContexts: {
        1001: baseContext({ id_cliente: 5, monto_factura: 100 }),
        1002: baseContext({ id_cliente: 6, monto_factura: 200 })
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await reconcileMissingPoints({ limit: 25 });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(result.implemented, true);
    assert.equal(result.candidates, 2);
    assert.deepEqual(result.ids_factura, [1001, 1002]);
    assert.equal(state.movimientos.length, 2);
  });

  it('es idempotente: si ya tiene movimiento, no vuelve a listarla ni a duplicar', async () => {
    const { client, state } = createFidelizacionMockClient({
      missingAccumulationIds: [],
      movimientos: [{ id_movimiento: 1, id_factura: 1003, tipo: 'ACUMULACION', origen: 'FACTURA' }],
      facturaContexts: { 1003: baseContext() }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await reconcileMissingPoints({ limit: 25 });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(result.candidates, 0);
    assert.equal(state.movimientos.length, 1);
  });

  it('nunca propaga un error si la conexion de listado falla', async () => {
    let result;
    await withMockedFidelizacionPoolConnect(
      async () => { throw new Error('ECONNREFUSED'); },
      async () => {
        await assert.doesNotReject((async () => { result = await reconcileMissingPoints(); })());
      }
    );
    assert.equal(result.error, true);
    assert.equal(result.candidates, 0);
  });

  it('libera la conexion incluso si release() falla', async () => {
    const { client, state } = createFidelizacionMockClient({
      missingAccumulationIds: [],
      releaseError: new Error('RELEASE_BOOM')
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(reconcileMissingPoints());
    });

    assert.equal(state.releaseCallCount, 1);
  });
});
