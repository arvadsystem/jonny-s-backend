import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
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

describe('accumulateInvoicePoints (capa unica: gate de pago + decide + persiste)', () => {
  it('venta inmediata sin control de pago: se considera pagada por construccion y acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        801: {
          id_pedido: null,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 250,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: false,
          pago_control_monto_pendiente: null,
          pago_control_estado_codigo: null
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 801 });
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 25);
    assert.equal(state.movimientos.length, 1);
  });

  it('pedido pendiente pagado (PAGADO_CONFIRMADO, monto_pendiente=0): acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        802: {
          id_pedido: 55,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 100,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: true,
          pago_control_monto_pendiente: 0,
          pago_control_estado_codigo: 'PAGADO_CONFIRMADO'
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 802 });
    });

    assert.equal(result.created, true);
    assert.equal(state.movimientos[0].id_factura, 802);
  });

  it('pago parcial (monto_pendiente > 0): no acumula y no evalua config ni puntos', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        803: {
          id_pedido: 60,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 100,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: true,
          pago_control_monto_pendiente: 40,
          pago_control_estado_codigo: 'PENDIENTE'
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 803 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'INVOICE_NOT_FULLY_PAID');
    assert.equal(state.movimientos.length, 0);
    assert.ok(!state.calls.some((c) => c.sql.includes('fidelizacion_configuracion_sucursal')), 'no debe consultar configuracion si el pago no esta confirmado');
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('COMMIT'));
    assert.ok(!sqlCalls.includes('ROLLBACK'));
  });

  it('estado distinto de PAGADO_CONFIRMADO con monto_pendiente=0: tampoco acumula', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        804: {
          id_pedido: 61,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 100,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: true,
          pago_control_monto_pendiente: 0,
          pago_control_estado_codigo: 'ANULADO'
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 804 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'INVOICE_NOT_FULLY_PAID');
    assert.equal(state.movimientos.length, 0);
  });

  it('configuracion historica: usa la vigente en la fecha de pago/factura, no la de hoy', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, vigente_desde: '2020-01-01T00:00:00Z', vigente_hasta: '2026-01-01T00:00:00Z' },
        { lempiras_por_punto: 50, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ],
      facturaContexts: {
        805: {
          id_pedido: null,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 250,
          // Fecha historica: cae en la ventana vieja (ratio 10), aunque "ahora"
          // (tiempo de ejecucion del test) ya rige la ventana nueva (ratio 50).
          fecha_referencia_config: '2025-06-01T12:00:00Z',
          tiene_pago_control: false,
          pago_control_monto_pendiente: null,
          pago_control_estado_codigo: null
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 805 });
    });

    assert.equal(result.created, true);
    assert.equal(result.points, 25, 'debe usar el ratio 10 (vigente en 2025-06-01), no el ratio 50 (vigente hoy)');
    const configCall = state.calls.find((c) => c.sql.includes('fidelizacion_configuracion_sucursal'));
    assert.ok(configCall, 'debe consultar la configuracion');
    assert.equal(configCall.params[1], '2025-06-01T12:00:00Z', 'debe pasar la fecha de referencia, no NOW()');
  });

  it('factura ya acumulada: sigue siendo idempotente (la deteccion vive en una sola capa)', async () => {
    const { client, state } = createFidelizacionMockClient({
      movimientos: [{ id_movimiento: 1, id_factura: 806, tipo: 'ACUMULACION', origen: 'FACTURA' }],
      facturaContexts: {
        806: {
          id_pedido: null,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 100,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: false,
          pago_control_monto_pendiente: null,
          pago_control_estado_codigo: null
        }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 806 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ALREADY_REGISTERED');
    assert.equal(state.movimientos.length, 1);
  });

  it('reintento tras fallo: un intento fallido no deja estado parcial, y el reintento si acumula', async () => {
    const failingCtx = {
      id_pedido: null,
      id_sucursal: 1,
      id_usuario: 9,
      id_cliente: 5,
      monto_factura: 100,
      fecha_referencia_config: '2026-03-01T10:00:00Z',
      tiene_pago_control: false,
      pago_control_monto_pendiente: null,
      pago_control_estado_codigo: null
    };
    const failing = createFidelizacionMockClient({
      facturaContexts: { 807: failingCtx },
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    await withMockedFidelizacionPoolConnect(async () => failing.client, async () => {
      const failedResult = await accumulateInvoicePoints({ idFactura: 807 });
      assert.equal(failedResult.reason, 'ERROR');
    });

    // El ROLLBACK real de Postgres deshace saldo/movimiento; se simula con un
    // cliente limpio para el reintento (reinicio del proceso o reconciliacion).
    const retry = createFidelizacionMockClient({ facturaContexts: { 807: failingCtx } });

    let retryResult;
    await withMockedFidelizacionPoolConnect(async () => retry.client, async () => {
      retryResult = await accumulateInvoicePoints({ idFactura: 807 });
    });

    assert.equal(retryResult.created, true);
    assert.equal(retry.state.movimientos.length, 1);
  });

  it('fallo simulado: hace ROLLBACK de su propia transaccion y nunca propaga el error', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        808: {
          id_pedido: null,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 100,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: false,
          pago_control_monto_pendiente: null,
          pago_control_estado_codigo: null
        }
      },
      failOn: 'FROM public.facturas f'
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 808 }); })()
      );
    });

    assert.equal(result.reason, 'ERROR');
    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.includes('ROLLBACK'));
    assert.ok(!sqlCalls.includes('COMMIT'));
  });

  it('pool.connect fallando: nunca propaga el error', async () => {
    let result;
    await withMockedFidelizacionPoolConnect(
      async () => { throw new Error('ECONNREFUSED'); },
      async () => {
        await assert.doesNotReject(
          (async () => { result = await accumulateInvoicePoints({ idFactura: 809 }); })()
        );
      }
    );
    assert.equal(result.created, false);
    assert.equal(result.reason, 'ERROR');
  });

  it('client.release fallando: nunca propaga el error y el resultado sigue siendo valido', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        810: {
          id_pedido: null,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 250,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: false,
          pago_control_monto_pendiente: null,
          pago_control_estado_codigo: null
        }
      },
      releaseError: new Error('RELEASE_BOOM')
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 810 }); })()
      );
    });

    assert.equal(result.created, true);
    assert.equal(state.releaseCallCount, 1);
    assert.equal(state.movimientos.length, 1);
  });

  it('cuenta dividida: dos facturas del MISMO pedido acumulan por separado segun su propio monto, no el total del pedido', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfig: { lempiras_por_punto: 10 },
      facturaContexts: {
        // Mismo id_pedido (900), pero cada division genero su propia factura
        // y su propio cobro; el total del pedido seria 300, pero cada
        // factura solo debe usar SU sub-total (SUM(facturas_cobros.monto)
        // filtrado por su propia id_factura), nunca los 300 combinados.
        901: {
          id_pedido: 900,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 5,
          monto_factura: 120,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: true,
          pago_control_monto_pendiente: 0,
          pago_control_estado_codigo: 'PAGADO_CONFIRMADO'
        },
        902: {
          id_pedido: 900,
          id_sucursal: 1,
          id_usuario: 9,
          id_cliente: 6,
          monto_factura: 180,
          fecha_referencia_config: '2026-03-01T10:00:00Z',
          tiene_pago_control: true,
          pago_control_monto_pendiente: 0,
          pago_control_estado_codigo: 'PAGADO_CONFIRMADO'
        }
      }
    });

    let result901;
    let result902;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result901 = await accumulateInvoicePoints({ idFactura: 901 });
      result902 = await accumulateInvoicePoints({ idFactura: 902 });
    });

    assert.equal(result901.created, true);
    assert.equal(result901.points, 12, 'floor(120/10), no floor(300/10)');
    assert.equal(result902.created, true);
    assert.equal(result902.points, 18, 'floor(180/10), no floor(300/10)');
    assert.equal(state.movimientos.length, 2, 'cada id_factura genera su propio movimiento');
    assert.notEqual(state.movimientos[0].id_factura, state.movimientos[1].id_factura);
  });

  it('id_factura invalido: no abre conexion alguna', async () => {
    let connectCalled = false;
    await withMockedFidelizacionPoolConnect(
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
