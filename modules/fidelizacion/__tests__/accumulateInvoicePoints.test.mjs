import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { buildAccumulationSnapshot } from '../infrastructure/fidelizacionRepository.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';
import { createFidelizacionLockCoordinator } from './fidelizacionLockCoordinator.mjs';

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

  it('fallo especifico al resolver el snapshot de elegibilidad: tampoco propaga (la venta ya respondio 201 antes)', async () => {
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
      // La elegibilidad ahora se resuelve con el snapshot historico
      // (buildAccumulationSnapshot), identificable por su alias nombre_maestro.
      failOn: 'AS nombre_maestro'
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

describe('accumulateInvoicePoints: bloqueante 3 ronda 4 -- precedencia de cliente por factura: COALESCE(f.id_cliente, p.id_cliente)', () => {
  // La factura gana sobre el dueno del pedido: en una cuenta dividida, una
  // factura puede facturarse a un cliente distinto de quien hizo el pedido,
  // y fidelizacion es por factura. facturaContexts[...].id_cliente y
  // pedidos[...].id_cliente se declaran POR SEPARADO en cada prueba -nunca
  // un valor ya combinado- para ejercitar de verdad la precedencia real.
  const ctxDividida = (overrides = {}) => ({
    id_sucursal: 1,
    id_usuario: 9,
    monto_factura: 100,
    fecha_referencia_config: '2026-03-01T10:00:00Z',
    tiene_pago_control: false,
    pago_control_monto_pendiente: null,
    pago_control_estado_codigo: null,
    ...overrides
  });

  it('16: factura SIN id_cliente propio + pedido del cliente 5 -> cliente efectivo es 5 (fallback al dueno del pedido)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 950: ctxDividida({ id_pedido: 700, id_cliente: null }) },
      pedidos: { 700: { id_cliente: 5 } }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 950 });
    });

    assert.equal(result.created, true);
    assert.ok(state.saldos.has(5), 'el cliente efectivo (fallback al pedido) es quien recibe el saldo');
    assert.equal(state.movimientos[0].id_factura, 950);
  });

  it('17: factura con id_cliente PROPIO (9) + pedido del cliente 5 -> cliente efectivo es 9 (la factura gana)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 951: ctxDividida({ id_pedido: 701, id_cliente: 9 }) },
      pedidos: { 701: { id_cliente: 5 } }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 951 });
    });

    assert.equal(result.created, true);
    assert.ok(state.saldos.has(9), 'la factura tiene su propio cliente: gana sobre el dueno del pedido');
    assert.ok(!state.saldos.has(5), 'el dueno del pedido nunca recibe el saldo de una factura ajena');
  });

  it('18: el contacto del pedido (dueno cliente 5) nunca se usa como snapshot para la factura del cliente 9', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: { 952: ctxDividida({ id_pedido: 702, id_cliente: 9 }) },
      pedidos: { 702: { id_cliente: 5, origen_pedido: 'MENU' } },
      pedidosContacto: { 702: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' } },
      // Perfil maestro del cliente 9 (acompanante) incompleto: si el
      // contacto del pedido (del cliente 5) se filtrara por error, igual
      // acumularia.
      clienteProfiles: { 9: { estado: true, nombre: 'Acompanante', telefono: '' } }
    });

    const snapshot = await buildAccumulationSnapshot(client, { idFactura: 952 });
    assert.equal(snapshot.idCliente, 9, 'el snapshot resuelve al cliente EFECTIVO de la factura, no al dueno del pedido');
    assert.equal(snapshot.fuenteSnapshot, 'PERFIL_MAESTRO', 'el contacto es del dueno del pedido (5), no del cliente de la factura (9): no es utilizable');
    assert.equal(snapshot.perfilCompletoSnapshot, false);
  });

  it('19: cuenta dividida con clientes DISTINTOS (una factura reasignada) -> cada una acumula a SU cliente, sin mezclar saldos ni snapshots', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        // Sin id_cliente propio: hereda el dueno del pedido (5).
        960: ctxDividida({ id_pedido: 910, id_cliente: null, monto_factura: 120 }),
        // Del MISMO pedido, pero re-facturada a otro cliente (9).
        961: ctxDividida({ id_pedido: 910, id_cliente: 9, monto_factura: 180 })
      },
      pedidos: { 910: { id_cliente: 5 } }
    });

    let result960;
    let result961;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result960 = await accumulateInvoicePoints({ idFactura: 960 });
      result961 = await accumulateInvoicePoints({ idFactura: 961 });
    });

    assert.equal(result960.created, true);
    assert.equal(result961.created, true);
    assert.ok(state.saldos.has(5), 'la factura sin id_cliente propio acredito al dueno del pedido');
    assert.ok(state.saldos.has(9), 'la factura con id_cliente propio acredito a SU cliente, no al dueno del pedido');
    assert.equal(state.movimientos.length, 2, 'una factura = un movimiento, nunca combinados');
    assert.ok(state.movimientos.some((m) => m.id_factura === 960));
    assert.ok(state.movimientos.some((m) => m.id_factura === 961));
  });

  it('20: el mock modela factura.id_cliente y pedido.id_cliente como conceptos separados (no un id_cliente ya resuelto)', () => {
    // Estructural: las pruebas 16-19 solo prueban algo si facturaContexts[...].id_cliente
    // y pedidos[...].id_cliente conviven sin que el mock los combine antes de
    // tiempo -si lo hiciera, ocultaria de nuevo el bug de precedencia SQL.
    const { state } = createFidelizacionMockClient({
      facturaContexts: { 999: ctxDividida({ id_pedido: 800, id_cliente: 9 }) },
      pedidos: { 800: { id_cliente: 5 } }
    });

    assert.equal(state.facturaContexts[999].id_cliente, 9, 'factura.id_cliente se preserva tal cual lo declaro la prueba');
    assert.equal(state.pedidos[800].id_cliente, 5, 'pedido.id_cliente se preserva tal cual, sin combinarse con el de la factura');
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

describe('accumulateInvoicePoints: bloqueante 1 (PENDING antes de evaluar en LIVE; RECONCILE nunca es el primero en evaluar)', () => {
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

  it('regla 1: LIVE crea PENDING (con snapshot) antes de evaluar configuracion/tasa/puntos', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 860: ctx() }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await accumulateInvoicePoints({ idFactura: 860 });
    });

    const snapshotIdx = state.calls.findIndex((c) => c.sql.includes('AS nombre_maestro'));
    const insertPendingIdx = state.calls.findIndex((c) => c.sql.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado') && c.sql.includes("VALUES ($1, 'PENDING'"));
    const configIdx = state.calls.findIndex((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal'));
    const movimientoIdx = state.calls.findIndex((c) => c.sql.includes('INSERT INTO public.fidelizacion_movimientos'));

    assert.notEqual(snapshotIdx, -1, 'debe resolver el snapshot historico');
    assert.notEqual(insertPendingIdx, -1, 'debe reservar PENDING');
    assert.notEqual(configIdx, -1, 'debe evaluar la configuracion');
    assert.ok(snapshotIdx < insertPendingIdx, 'el snapshot se resuelve para poder congelarlo en la fila PENDING');
    assert.ok(insertPendingIdx < configIdx, 'PENDING debe existir ANTES de evaluar configuracion/tasa');
    assert.ok(insertPendingIdx < movimientoIdx, 'PENDING debe existir ANTES de crear el movimiento de puntos');
  });

  it('regla 1b: la elegibilidad sale del snapshot, no de una consulta al perfil actual', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 867: ctx() }
    });

    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await accumulateInvoicePoints({ idFactura: 867 });
    });

    // fetchClienteProfileForFidelizacion (la consulta del perfil ACTUAL) ya
    // no participa: su lugar lo ocupa el snapshot historico.
    const perfilActualIdx = state.calls.findIndex((c) => c.sql.includes('FROM public.clientes c') && c.sql.includes('LEFT JOIN public.personas p') && !c.sql.includes('AS nombre_maestro'));
    assert.equal(perfilActualIdx, -1, 'no debe consultarse el perfil actual del cliente');
  });

  it('regla 2: LIVE con perfil valido termina PROCESSED', async () => {
    const { client, state } = createFidelizacionMockClient({ facturaContexts: { 861: ctx() } });
    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 861 });
    });
    assert.equal(result.created, true);
    assert.equal(state.estadoFacturas.get(861).estado, 'PROCESSED');
  });

  it('regla 3: LIVE con perfil incompleto termina SKIPPED_TERMINAL', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } },
      facturaContexts: { 862: ctx() }
    });
    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 862 });
    });
    assert.equal(result.created, false);
    assert.equal(state.estadoFacturas.get(862).estado, 'SKIPPED_TERMINAL');
  });

  it('regla 5: RECONCILE sin estado previo y perfil ACTUAL completo no acumula igual (nunca lo llega a evaluar)', async () => {
    const { client, state } = createFidelizacionMockClient({
      // Perfil por defecto: activo, con nombre y telefono validos.
      facturaContexts: { 863: ctx() }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 863, trigger: 'RECONCILE' });
    });

    assert.equal(result.created, false, 'aunque el perfil actual sea perfectamente valido, RECONCILE sin fila previa nunca acumula');
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(863).estado, 'SKIPPED_TERMINAL');
    // No debe haber consultado ni el perfil ni la configuracion: se corta antes de cualquiera de las dos.
    assert.ok(!state.calls.some((c) => c.sql.includes('FROM public.clientes c') && c.sql.includes('LEFT JOIN public.personas p')), 'RECONCILE sin fila previa nunca consulta el perfil');
    assert.ok(!state.calls.some((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal')), 'RECONCILE sin fila previa nunca consulta la configuracion');
  });

  it('regla 8 (ronda 4, bloqueante 1): un RETRYABLE_ERROR YA EXISTENTE sin snapshot y sin evidencia historica nunca usa el perfil actual', async () => {
    // Antes de la ronda 4, `trigger === RECONCILE && !existingState` dejaba
    // pasar exactamente este caso (fila ya existente) al `else`, que
    // reconstruia el snapshot con el perfil ACTUAL. Con la fila existente y
    // sin evidencia historica confiable (pedidos_contacto), debe terminar
    // LEGACY_ELIGIBILITY_UNVERIFIABLE igual que si nunca hubiera existido fila.
    const { client, state } = createFidelizacionMockClient({
      // Perfil actual completo (nombre/telefono validos): la prueba de que
      // NO se usa es que aun asi no acumula.
      facturaContexts: { 864: ctx() },
      estadoFacturasIniciales: { 864: { estado: 'RETRYABLE_ERROR', intentos: 2, ultimo_error: 'timeout previo' } }
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      result = await accumulateInvoicePoints({ idFactura: 864, trigger: 'RECONCILE' });
    });

    assert.equal(result.created, false, 'sin snapshot y sin evidencia historica, RECONCILE nunca acumula aunque ya exista fila reintentable');
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.estadoFacturas.get(864).estado, 'SKIPPED_TERMINAL');
    assert.ok(
      !state.calls.some((c) => c.sql.includes('FROM public.clientes c') && c.sql.includes('LEFT JOIN public.personas p')),
      'nunca consulta el perfil actual del cliente'
    );
  });

  it('regla 11: dos notificaciones para la misma factura no duplican el movimiento (idempotencia por estado, no solo por el chequeo interno de movimientos)', async () => {
    const { client, state } = createFidelizacionMockClient({ facturaContexts: { 865: ctx() } });

    let first;
    let second;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      first = await accumulateInvoicePoints({ idFactura: 865 });
      second = await accumulateInvoicePoints({ idFactura: 865 });
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.reason, 'ALREADY_REGISTERED');
    assert.equal(state.movimientos.length, 1);
  });

  it('regla 12: una falla registrando PENDING (antes de evaluar nada) no impide que accumulateInvoicePoints responda sin lanzar', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: { 866: ctx() },
      failOn: "VALUES ($1, 'PENDING'"
    });

    let result;
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await assert.doesNotReject(
        (async () => { result = await accumulateInvoicePoints({ idFactura: 866 }); })()
      );
    });

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ERROR');
  });
});

describe('accumulateInvoicePoints: bloqueante 3 (prueba de concurrencia REAL, no dos llamadas secuenciales)', () => {
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

  it('dos transacciones concurrentes (Promise.all) sobre la MISMA factura, con un coordinador que simula pg_advisory_xact_lock real: la segunda espera hasta que la primera libera el lock', async () => {
    // Dos "conexiones" independientes (dos clientes mock distintos, cada
    // uno representando su propia transaccion), compartiendo la MISMA
    // "base de datos" (sharedState) y el MISMO coordinador de lock. Esto
    // reproduce de verdad lo que pg_advisory_xact_lock hace en Postgres:
    // la segunda transaccion que pide el mismo lock queda bloqueada
    // (await) hasta que la primera hace COMMIT.
    const lockCoordinator = createFidelizacionLockCoordinator();
    const mockA = createFidelizacionMockClient({
      facturaContexts: { 900: ctx() },
      lockCoordinator
    });
    const mockB = createFidelizacionMockClient({
      sharedState: mockA.state,
      lockCoordinator
    });

    // Instrumentacion: registra CUANDO cada query realmente resuelve (no
    // cuando se emite), para poder probar el orden real de adquisicion del
    // lock y del COMMIT, sin depender de timings fragiles.
    const events = [];
    const instrument = (label, client) => {
      const originalQuery = client.query.bind(client);
      client.query = async (sql, params) => {
        const text = String(sql).trim();
        const result = await originalQuery(sql, params);
        if (text.includes('pg_advisory_xact_lock')) events.push(`${label}:lock_acquired`);
        if (text === 'COMMIT') events.push(`${label}:commit`);
        return result;
      };
    };
    instrument('A', mockA.client);
    instrument('B', mockB.client);

    let connectCount = 0;
    const connectImpl = async () => {
      connectCount += 1;
      return connectCount === 1 ? mockA.client : mockB.client;
    };

    let results;
    await withMockedFidelizacionPoolConnect(connectImpl, async () => {
      results = await Promise.all([
        accumulateInvoicePoints({ idFactura: 900 }),
        accumulateInvoicePoints({ idFactura: 900 })
      ]);
    });

    assert.equal(connectCount, 2, 'deben usarse dos conexiones/transacciones independientes, no la misma');

    const createdCount = results.filter((r) => r.created).length;
    const alreadyRegisteredCount = results.filter((r) => r.reason === 'ALREADY_REGISTERED').length;
    assert.equal(createdCount, 1, 'solo una de las dos transacciones debe otorgar puntos');
    assert.equal(alreadyRegisteredCount, 1, 'la otra debe responder ALREADY_REGISTERED');
    assert.equal(mockA.state.movimientos.length, 1, 'solo un movimiento');
    const saldoUpdateCalls = mockA.state.calls.filter((c) => c.sql.includes('UPDATE public.fidelizacion_saldos_cliente')).length;
    assert.equal(saldoUpdateCalls, 1, 'solo una modificacion de saldo');
    assert.equal(mockA.state.estadoFacturas.get(900).estado, 'PROCESSED', 'el estado final es PROCESSED');

    // Prueba real de que hubo bloqueo (no solo un resultado correcto por
    // casualidad de scheduling): quien haya adquirido el lock SEGUNDO solo
    // pudo hacerlo DESPUES de que el primero hiciera COMMIT (y asi lo
    // liberara). Si el coordinador no bloqueara de verdad, este orden no
    // estaria garantizado.
    const lockEvents = events.filter((e) => e.endsWith(':lock_acquired'));
    assert.equal(lockEvents.length, 2, `ambas transacciones deben haber adquirido el lock: ${JSON.stringify(events)}`);
    const firstLocker = lockEvents[0].split(':')[0];
    const secondLocker = firstLocker === 'A' ? 'B' : 'A';
    const firstCommitIdx = events.indexOf(`${firstLocker}:commit`);
    const secondLockIdx = events.indexOf(`${secondLocker}:lock_acquired`);
    assert.notEqual(firstCommitIdx, -1, `falta el COMMIT del primero: ${JSON.stringify(events)}`);
    assert.notEqual(secondLockIdx, -1, `falta el lock del segundo: ${JSON.stringify(events)}`);
    assert.ok(
      secondLockIdx > firstCommitIdx,
      `la segunda transaccion debio adquirir el lock DESPUES del COMMIT de la primera. Orden real: ${JSON.stringify(events)}`
    );
  });
});
