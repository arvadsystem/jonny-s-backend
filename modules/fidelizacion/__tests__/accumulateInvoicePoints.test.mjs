import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pool from '../../../config/db-connection.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
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

describe('accumulateInvoicePoints (sucesor de registerVentaFidelizacionAfterCommit)', () => {
  it('venta inmediata: resuelve cliente/sucursal/monto desde la factura persistida y acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        801: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 250 }
      }
    });

    let result;
    await withMockedPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 801 });
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 25);
    assert.equal(state.movimientos.length, 1);
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('BEGIN'));
    assert.ok(sqlCalls.includes('COMMIT'));
    assert.ok(!sqlCalls.includes('ROLLBACK'));
  });

  it('pedido pendiente pagado: el contexto trae id_pedido y tambien acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        802: { id_pedido: 55, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 }
      }
    });

    let result;
    await withMockedPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 802 });
    });

    assert.equal(result.created, true);
    assert.equal(state.movimientos[0].id_factura, 802);
  });

  it('factura ya acumulada: es idempotente y no vuelve a resolver el contexto ni a escribir', async () => {
    const { client, state } = createFidelizacionMockClient({
      movimientos: [{ id_movimiento: 1, id_factura: 803, tipo: 'ACUMULACION', origen: 'FACTURA' }],
      facturaContexts: {
        803: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 }
      }
    });

    let result;
    await withMockedPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 803 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ALREADY_REGISTERED');
    assert.equal(state.movimientos.length, 1);
    assert.ok(!state.calls.some((c) => c.sql.includes('FROM public.facturas f')), 'no debe resolver el contexto si ya esta acumulada');
  });

  it('fallo simulado de fidelizacion: hace ROLLBACK de su propia transaccion y nunca propaga el error', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        804: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 }
      },
      failOn: 'FROM public.facturas f'
    });

    let result;
    await withMockedPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 804 }); })(),
        'un fallo de fidelizacion nunca debe propagarse'
      );
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ERROR');
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('ROLLBACK'));
    assert.ok(!sqlCalls.includes('COMMIT'));
  });

  it('reintento de acumulacion: tras un fallo, un intento posterior sobre estado limpio si acumula', async () => {
    const failing = createFidelizacionMockClient({
      facturaContexts: {
        805: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 }
      },
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    await withMockedPoolConnect(async () => failing.client, async () => {
      const failedResult = await accumulateInvoicePoints({ idFactura: 805 });
      assert.equal(failedResult.reason, 'ERROR');
    });

    // El ROLLBACK real de Postgres deshace saldo/movimiento; se simula con un
    // cliente limpio para el reintento, igual que en el nivel de servicio.
    const retry = createFidelizacionMockClient({
      facturaContexts: {
        805: { id_pedido: null, id_sucursal: 1, id_usuario: 9, id_cliente: 5, monto_factura: 100 }
      }
    });

    let retryResult;
    await withMockedPoolConnect(async () => retry.client, async () => {
      retryResult = await accumulateInvoicePoints({ idFactura: 805 });
    });

    assert.equal(retryResult.created, true);
    assert.equal(retry.state.movimientos.length, 1);
  });

  it('factura sin cliente/sucursal resoluble: no acumula y hace COMMIT (no ROLLBACK)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        806: { id_pedido: null, id_sucursal: null, id_usuario: 9, id_cliente: null, monto_factura: 100 }
      }
    });

    let result;
    await withMockedPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 806 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'MISSING_REQUIRED_DATA');
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('COMMIT'));
    assert.ok(!sqlCalls.includes('ROLLBACK'));
  });

  it('id_factura invalido: no abre conexion alguna', async () => {
    let connectCalled = false;
    await withMockedPoolConnect(
      async () => {
        connectCalled = true;
        throw new Error('no deberia conectarse');
      },
      async () => {
        const result = await accumulateInvoicePoints({ idFactura: null });
        assert.equal(result.reason, 'INVALID_INVOICE_ID');
      }
    );
    assert.equal(connectCalled, false);
  });
});
