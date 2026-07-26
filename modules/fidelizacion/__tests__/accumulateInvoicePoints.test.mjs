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

  it('fallo especifico al evaluar el perfil del cliente: tampoco propaga (la venta ya respondio 201 antes)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        815: {
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
      failOn: 'FROM public.clientes c'
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 815 }); })()
      );
    });

    assert.equal(result.created, false);
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

describe('accumulateInvoicePoints: bloqueante 3 (tabla de estado por factura, sin acumulacion retroactiva)', () => {
  const ctx = (overrides = {}) => ({
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

  it('camino LIVE (default): perfil incompleto queda SKIPPED_TERMINAL/CLIENT_PROFILE_INCOMPLETE (confiable: es tiempo de compra)', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } },
      facturaContexts: { 850: ctx() }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 850 });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.estadoFacturas.get(850).estado, 'SKIPPED_TERMINAL');
    assert.equal(state.estadoFacturas.get(850).motivo, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(state.movimientos.length, 0);
  });

  it('camino RECONCILE: mismo rechazo por perfil incompleto se relabela a LEGACY_ELIGIBILITY_UNVERIFIABLE', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } },
      facturaContexts: { 851: ctx() }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 851, trigger: 'RECONCILE' });
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.estadoFacturas.get(851).motivo, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
  });

  it('completar el perfil despues no reabre una factura ya terminal (el escenario exacto del bug reportado)', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } },
      facturaContexts: { 852: ctx() }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      const first = await accumulateInvoicePoints({ idFactura: 852, trigger: 'RECONCILE' });
      assert.equal(first.created, false);
    });
    assert.equal(state.movimientos.length, 0);

    // El cliente completa su perfil DESPUES de la primera evaluacion.
    state.clienteProfiles[5] = { estado: true, nombre: 'Completo Ahora', telefono: '9999-9999' };

    let second;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      second = await accumulateInvoicePoints({ idFactura: 852, trigger: 'RECONCILE' });
    });

    assert.equal(second.created, false, 'no debe otorgar puntos retroactivos');
    assert.equal(second.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE', 'debe devolver el motivo terminal ya grabado, sin volver a mirar el perfil');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(852).intentos, 1, 'la segunda llamada no debe incrementar intentos: se corta antes de volver a evaluar');
  });

  it('factura ya PROCESSED (idempotencia): una segunda llamada devuelve ALREADY_REGISTERED sin volver a evaluar nada', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 853: ctx() }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      const first = await accumulateInvoicePoints({ idFactura: 853 });
      assert.equal(first.created, true);
    });
    assert.equal(state.movimientos.length, 1);

    let second;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      second = await accumulateInvoicePoints({ idFactura: 853 });
    });

    assert.equal(second.created, false);
    assert.equal(second.reason, 'ALREADY_REGISTERED');
    assert.equal(state.movimientos.length, 1, 'no debe duplicar el movimiento');
  });

  // Nota sobre "dos workers concurrentes no duplican el movimiento": en
  // produccion esto lo garantizan dos capas independientes de esta funcion
  // (no simulables en el mock sin locking real de Postgres): (1) el pool
  // dedicado fidelizacionPool tiene max:1 conexion (ver fidelizacionPool.js
  // y fidelizacionPool.test.mjs: "esta configurado con max: 1 conexion"),
  // asi que un segundo connectClient() espera a que el primero libere la
  // conexion; (2) pg_advisory_xact_lock(idFactura) serializa incluso entre
  // procesos/instancias distintas. Lo que SI se prueba aqui con el mock es
  // la idempotencia que resulta de esa serializacion: una vez que la
  // primera llamada termina y persiste PROCESSED/SKIPPED_TERMINAL, cualquier
  // llamada posterior para la misma factura (la "segunda" tras esperar a la
  // primera) nunca vuelve a evaluar nada ni duplica el movimiento -ver
  // "factura ya PROCESSED (idempotencia)" arriba-.

  it('error tecnico: queda RETRYABLE_ERROR (no terminal)', async () => {
    const failing = createFidelizacionMockClient({
      facturaContexts: { 855: ctx() },
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    let firstResult;
    await withMockedFidelizacionPoolConnect(async () => failing.client, async () => {
      firstResult = await accumulateInvoicePoints({ idFactura: 855 });
    });
    assert.equal(firstResult.reason, 'ERROR');
    assert.equal(failing.state.estadoFacturas.get(855).estado, 'RETRYABLE_ERROR', 'un error tecnico nunca queda como skip terminal de negocio');
    assert.ok(failing.state.estadoFacturas.get(855).ultimo_error, 'debe guardar el ultimo error tecnico');
  });

  it('un estado RETRYABLE_ERROR persistido no bloquea el reintento (a diferencia de un estado terminal)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 857: ctx() },
      estadoFacturasIniciales: {
        857: { estado: 'RETRYABLE_ERROR', motivo: null, intentos: 1, ultimo_error: 'ECONNRESET previo' }
      }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 857 });
    });

    assert.equal(result.created, true, 'RETRYABLE_ERROR debe volver a evaluar normalmente, no quedarse bloqueado');
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(857).estado, 'PROCESSED');
    assert.equal(state.estadoFacturas.get(857).intentos, 2, 'el reintento incrementa intentos sobre la fila existente');
  });

  it('falla especifica al guardar el estado reintentable: nunca cambia el resultado ya decidido (ERROR) ni propaga', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: { 856: ctx() },
      failOn: 'INSERT INTO public.fidelizacion_movimientos'
    });

    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      const text = String(sql);
      if (text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')) {
        throw new Error('SIMULATED_STATE_TABLE_FAILURE');
      }
      return originalQuery(sql, params);
    };

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 856 }); })()
      );
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ERROR', 'una falla guardando el estado de fidelizacion no cambia el resultado ya decidido');
  });
});
