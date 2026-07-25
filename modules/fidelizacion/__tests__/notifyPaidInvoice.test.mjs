import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { notifyPaidInvoice } from '../application/notifyPaidInvoice.js';
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

describe('notifyPaidInvoice (unica interfaz publica que Ventas puede llamar)', () => {
  it('nunca rechaza, incluso si la conexion de fidelizacion falla por completo', async () => {
    await withMockedFidelizacionPoolConnect(
      async () => { throw new Error('ECONNREFUSED'); },
      async () => {
        await assert.doesNotReject(
          notifyPaidInvoice({ idFactura: 901 }).catch(() => undefined),
          'la forma exacta que Ventas usa: notifyPaidInvoice(...).catch(() => undefined)'
        );
        await assert.doesNotReject(notifyPaidInvoice({ idFactura: 901 }));
        await waitForFidelizacionQueueIdle();
      }
    );
  });

  it('ignora cualquier campo distinto de id_factura (monto, cliente, sucursal, etc.)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 902: baseContext({ monto_factura: 999 }) }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await notifyPaidInvoice({
        idFactura: 902,
        montoFactura: 1,
        idCliente: 1,
        idSucursal: 1,
        idUsuarioEjecutor: 1
      });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(state.movimientos.length, 1);
    assert.equal(state.movimientos[0].id_factura, 902);
  });

  it('efectivamente dispara la acumulacion en segundo plano para una factura valida', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 903: baseContext({ monto_factura: 300 }) }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await notifyPaidInvoice({ idFactura: 903 });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(state.movimientos.length, 1);
  });

  it('reinicio/reintento: una notificacion que fallo puede repetirse de forma segura tras "reiniciar"', async () => {
    const failing = createFidelizacionMockClient({
      facturaContexts: { 904: baseContext({ monto_factura: 250 }) },
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    await withMockedFidelizacionPoolConnect(async () => failing.client, async () => {
      await notifyPaidInvoice({ idFactura: 904 });
      await waitForFidelizacionQueueIdle();
    });
    assert.equal(failing.state.movimientos.length, 0);

    // Simula un reinicio del proceso: nueva conexion limpia, mismo id_factura.
    const retry = createFidelizacionMockClient({
      facturaContexts: { 904: baseContext({ monto_factura: 250 }) }
    });

    await withMockedFidelizacionPoolConnect(async () => retry.client, async () => {
      await notifyPaidInvoice({ idFactura: 904 });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(retry.state.movimientos.length, 1);
  });

  it('dos notificaciones concurrentes para facturas distintas se procesan una a la vez (no en paralelo)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        905: baseContext({ id_cliente: 5, monto_factura: 100 }),
        906: baseContext({ id_cliente: 6, monto_factura: 100 })
      }
    });

    let concurrent = 0;
    let maxConcurrent = 0;
    const originalQuery = client.query.bind(client);
    client.query = async (...args) => {
      if (String(args[0]).trim() === 'BEGIN') {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
      }
      const result = await originalQuery(...args);
      if (String(args[0]).trim() === 'COMMIT' || String(args[0]).trim() === 'ROLLBACK') {
        concurrent -= 1;
      }
      return result;
    };

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await notifyPaidInvoice({ idFactura: 905 });
      await notifyPaidInvoice({ idFactura: 906 });
      await waitForFidelizacionQueueIdle();
    });

    assert.equal(maxConcurrent, 1);
    assert.equal(state.movimientos.length, 2);
  });
});
