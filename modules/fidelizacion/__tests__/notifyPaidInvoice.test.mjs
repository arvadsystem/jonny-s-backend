import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pool from '../../../config/db-connection.js';
import { notifyPaidInvoice } from '../application/notifyPaidInvoice.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

const withMockedPoolConnect = async (connectImpl, run) => {
  const originalConnect = pool.connect;
  pool.connect = connectImpl;
  try {
    await run();
  } finally {
    pool.connect = originalConnect;
  }
};

const waitForDeferredWork = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('notifyPaidInvoice (unica interfaz que Ventas puede llamar)', () => {
  it('nunca rechaza, incluso si la acumulacion diferida termina en error', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: { 901: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 } },
      failOn: 'FROM public.facturas f'
    });

    await withMockedPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        notifyPaidInvoice({ idFactura: 901 }).catch(() => undefined),
        'la forma exacta que Ventas usa: notifyPaidInvoice(...).catch(() => undefined)'
      );
      await assert.doesNotReject(notifyPaidInvoice({ idFactura: 901 }));
      await waitForDeferredWork();
    });
  });

  it('ignora cualquier campo distinto de id_factura (monto, cliente, sucursal, etc.)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 902: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 999 } }
    });

    await withMockedPoolConnect(async () => client, async () => {
      await notifyPaidInvoice({
        idFactura: 902,
        montoFactura: 1,
        idCliente: 1,
        idSucursal: 1,
        idUsuarioEjecutor: 1
      });
      await waitForDeferredWork();
    });

    assert.equal(state.movimientos.length, 1);
    // El monto usado para calcular puntos vino del contexto persistido (999),
    // no del valor (ignorado) que se intento pasar junto a idFactura.
    assert.equal(state.movimientos[0].id_factura, 902);
  });

  it('efectivamente dispara la acumulacion en segundo plano para una factura valida', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 903: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 300 } }
    });

    await withMockedPoolConnect(async () => client, async () => {
      await notifyPaidInvoice({ idFactura: 903 });
      await waitForDeferredWork();
    });

    assert.equal(state.movimientos.length, 1);
  });
});
