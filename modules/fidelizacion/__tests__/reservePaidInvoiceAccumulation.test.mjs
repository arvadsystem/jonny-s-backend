import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reservePaidInvoiceAccumulation } from '../application/reservePaidInvoiceAccumulation.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { reconcileMissingPoints } from '../workers/reconcileMissingPoints.js';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';
import { enqueueInvoiceAccumulation, waitForFidelizacionQueueIdle } from '../infrastructure/fidelizacionQueue.js';

// Durabilidad de la reserva de acumulacion.
//
// La reserva corre DENTRO de la transaccion financiera, antes de su COMMIT.
// Estas pruebas ejecutan la funcion real contra un cliente pg simulado con
// semantica realista de transaccion (SAVEPOINT, ROLLBACK TO SAVEPOINT y el
// estado ABORTADO 25P02 de PostgreSQL).
//
// ALCANCE: se ejercita la funcion de reserva y su interaccion con la
// secuencia transaccional, NO el handler completo de registrar-pago
// (~800 lineas inline en routers/ventas.js, con pool.connect() fijo y sin
// costura de inyeccion: no es ejecutable en prueba sin refactorizar el
// corazon de la transaccion financiera, lo cual queda fuera de alcance).
// El anclaje de los 5 call sites reales se verifica en
// routers/ventas/__tests__/fidelizacionBoundary.test.mjs.

// Sentencia con la que las pruebas simulan las escrituras propias de la
// venta (ajenas a fidelizacion) dentro de la misma transaccion.
const SIMULACION_FINANCIERA = 'INSERT INTO facturas';

const ventaContext = (overrides = {}) => ({
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

// Reproduce la secuencia real de la transaccion financiera:
// BEGIN -> escrituras de la venta -> reserva -> COMMIT.
const simulateFinancialTransaction = async (client, { idFactura, reservar = true }) => {
  await client.query('BEGIN');
  await client.query('INSERT INTO facturas (id_factura) VALUES ($1)', [idFactura]);
  let reserva = null;
  if (reservar) {
    reserva = await reservePaidInvoiceAccumulation({ client, idFactura });
  }
  await client.query('COMMIT');
  return reserva;
};

const withMockedFidelizacionPoolConnect = async (connectImpl, run) => {
  const originalConnect = fidelizacionPool.connect;
  fidelizacionPool.connect = connectImpl;
  try {
    return await run();
  } finally {
    fidelizacionPool.connect = originalConnect;
  }
};

describe('reservePaidInvoiceAccumulation: reserva durable dentro de la transaccion financiera', () => {
  it('1: venta directa crea la reserva PENDING ANTES del COMMIT', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1000: ventaContext() }
    });

    const reserva = await simulateFinancialTransaction(client, { idFactura: 1000 });

    assert.equal(reserva.reserved, true);
    assert.equal(state.estadoFacturas.get(1000).estado, 'PENDING');

    const insertIdx = state.calls.findIndex((c) => c.sql.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado'));
    const commitIdx = state.calls.findIndex((c) => c.sql === 'COMMIT');
    assert.ok(insertIdx > -1 && commitIdx > -1);
    assert.ok(insertIdx < commitIdx, 'la reserva debe persistirse ANTES del COMMIT financiero');
  });

  it('2: pedido pendiente completamente pagado tambien reserva antes del COMMIT, con su snapshot', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: {
        1001: ventaContext({
          id_pedido: 55,
          tiene_pago_control: true,
          pago_control_monto_pendiente: 0,
          pago_control_estado_codigo: 'PAGADO_CONFIRMADO'
        })
      },
      pedidos: { 55: { id_cliente: 5, origen_pedido: 'MENU' } },
      pedidosContacto: { 55: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' } },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Menu', telefono: '' } }
    });

    const reserva = await simulateFinancialTransaction(client, { idFactura: 1001 });

    assert.equal(reserva.reserved, true);
    assert.equal(reserva.snapshot.fuenteSnapshot, 'PEDIDO_CONTACTO');
    assert.equal(reserva.snapshot.perfilCompletoSnapshot, true, 'el telefono del menu publico basta como evidencia historica');
  });

  it('3/4: no se reserva lo que no corresponde (pago parcial / pedido pendiente sin factura)', async () => {
    // El guard vive en el call site de Ventas (solo se llama con el pedido
    // completamente pagado). Aqui se verifica el contrato de la funcion: sin
    // un id_factura utilizable no toca la transaccion en absoluto.
    const { client, state } = createFidelizacionMockClient({ facturaContexts: {} });

    await client.query('BEGIN');
    const sinFactura = await reservePaidInvoiceAccumulation({ client, idFactura: null });
    assert.equal(sinFactura.reserved, false);
    assert.equal(sinFactura.reason, 'INVALID_INVOICE_ID');
    assert.equal(state.calls.filter((c) => c.sql.startsWith('SAVEPOINT')).length, 0, 'no debe ni abrir un savepoint');

    // Factura inexistente (p.ej. pedido aun sin facturar): no reserva nada.
    const inexistente = await reservePaidInvoiceAccumulation({ client, idFactura: 4242 });
    assert.equal(inexistente.reserved, false);
    assert.equal(inexistente.reason, 'INVOICE_NOT_FOUND');
    assert.equal(state.estadoFacturas.size, 0);
  });

  it('5/6: usa el client financiero recibido y NUNCA abre el pool de fidelizacion', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1002: ventaContext() }
    });

    let poolConnectCalls = 0;
    await withMockedFidelizacionPoolConnect(
      async () => { poolConnectCalls += 1; throw new Error('no deberia conectarse'); },
      async () => { await simulateFinancialTransaction(client, { idFactura: 1002 }); }
    );

    assert.equal(poolConnectCalls, 0, 'la reserva no debe pedir conexion al pool dedicado');
    assert.ok(state.calls.length > 0, 'todo el trabajo ocurrio sobre el client financiero recibido');
    assert.equal(state.estadoFacturas.get(1002).estado, 'PENDING');
  });

  it('7: si la reserva falla, hace ROLLBACK al savepoint y la venta hace COMMIT normalmente', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1003: ventaContext() },
      // Falla justo al insertar la reserva (p.ej. la migracion aun no se aplico).
      failOn: 'INSERT INTO public.fidelizacion_acumulacion_facturas_estado'
    });

    let reserva;
    await assert.doesNotReject((async () => {
      reserva = await simulateFinancialTransaction(client, { idFactura: 1003 });
    })(), 'un fallo de fidelizacion nunca debe romper la transaccion financiera');

    assert.equal(reserva.reserved, false);
    assert.equal(reserva.reason, 'ERROR');

    const sqlCalls = state.calls.map((c) => c.sql);
    assert.ok(sqlCalls.some((s) => s.startsWith('ROLLBACK TO SAVEPOINT')), 'debe volver al savepoint');
    assert.ok(sqlCalls.some((s) => s.startsWith('RELEASE SAVEPOINT')), 'debe liberar el savepoint');
    assert.ok(sqlCalls.includes('COMMIT'), 'la venta debe poder confirmarse igual');
    assert.equal(state.aborted, false, 'la transaccion quedo utilizable tras el rollback al savepoint');
    assert.equal(state.estadoFacturas.size, 0, 'no quedo ninguna reserva a medias');
  });

  it('7b: sin el SAVEPOINT, el mismo fallo dejaria la transaccion abortada y el COMMIT fallaria (por eso el aislamiento es obligatorio)', async () => {
    const { client } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1004: ventaContext() },
      failOn: 'INSERT INTO public.fidelizacion_acumulacion_facturas_estado'
    });

    await client.query('BEGIN');
    // Escritura riesgosa SIN savepoint, con el error capturado en JS:
    await assert.rejects(
      client.query('INSERT INTO public.fidelizacion_acumulacion_facturas_estado (id_factura) VALUES ($1)', [1004])
    );
    // PostgreSQL ya dejo la transaccion abortada: capturar el error no ayudo.
    await assert.rejects(client.query('COMMIT'), (err) => err.code === '25P02');
  });

  it('8: reinicio entre el COMMIT y el drenado de la cola: la fila PENDING sobrevive y RECONCILE otorga los puntos', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1005: ventaContext() }
    });

    // Transaccion financiera completa (reserva incluida).
    await simulateFinancialTransaction(client, { idFactura: 1005 });
    assert.equal(state.estadoFacturas.get(1005).estado, 'PENDING');

    // "Reinicio": la cola en memoria se pierde, nunca se ejecuto el LIVE.
    assert.equal(state.movimientos.length, 0);

    // La reconciliacion posterior encuentra la reserva y SI acumula, porque
    // hay evidencia durable (sin ella quedaria LEGACY_ELIGIBILITY_UNVERIFIABLE).
    const result = await withMockedFidelizacionPoolConnect(
      async () => client,
      () => reconcileMissingPoints({ limit: 25 })
    );

    assert.deepEqual(result.ids_factura, [1005]);
    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(1005).estado, 'PROCESSED');
  });

  it('8b: contraste -- sin reserva durable, la MISMA factura queda LEGACY_ELIGIBILITY_UNVERIFIABLE', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1006: ventaContext() }
    });

    // Transaccion financiera SIN reserva (comportamiento anterior al fix).
    await simulateFinancialTransaction(client, { idFactura: 1006, reservar: false });

    const result = await withMockedFidelizacionPoolConnect(
      async () => client,
      () => reconcileMissingPoints({ limit: 25 })
    );

    assert.equal(result.processed, 0);
    assert.equal(state.movimientos.length, 0, 'sin evidencia durable se pierden los puntos: exactamente el bug corregido');
    assert.equal(state.estadoFacturas.get(1006).motivo, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
  });

  it('9: cola llena tras el pago: la reserva sobrevive y RECONCILE procesa despues', async () => {
    const originalMax = process.env.FIDELIZACION_QUEUE_MAX_SIZE;
    process.env.FIDELIZACION_QUEUE_MAX_SIZE = '1';
    try {
      const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
        facturaContexts: { 1007: ventaContext() }
      });

      await simulateFinancialTransaction(client, { idFactura: 1007 });
      assert.equal(state.estadoFacturas.get(1007).estado, 'PENDING');

      // Se llena la cola: la notificacion LIVE es rechazada (QUEUE_FULL).
      const shortWait = () => new Promise((resolve) => setTimeout(resolve, 5));
      const ocupanteA = enqueueInvoiceAccumulation({ idFactura: 9999 }, async () => { await shortWait(); return { created: false }; });
      const ocupanteB = enqueueInvoiceAccumulation({ idFactura: 9998 }, async () => { await shortWait(); return { created: false }; });
      const rechazado = await enqueueInvoiceAccumulation({ idFactura: 1007 }, async () => ({ created: true }));
      assert.equal(rechazado.status, 'rejected');
      assert.equal(rechazado.reason, 'QUEUE_FULL');
      assert.equal(state.movimientos.length, 0);

      await Promise.all([ocupanteA, ocupanteB]);
      await waitForFidelizacionQueueIdle();

      // La reserva durable permite recuperarlo mas tarde.
      const result = await withMockedFidelizacionPoolConnect(
        async () => client,
        () => reconcileMissingPoints({ limit: 25 })
      );
      assert.equal(result.processed, 1);
      assert.equal(state.movimientos.length, 1);
    } finally {
      if (originalMax === undefined) delete process.env.FIDELIZACION_QUEUE_MAX_SIZE;
      else process.env.FIDELIZACION_QUEUE_MAX_SIZE = originalMax;
    }
  });

  it('10/32: dos reservas para la misma factura (callback duplicado) no duplican filas', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1008: ventaContext() }
    });

    await simulateFinancialTransaction(client, { idFactura: 1008 });
    const segunda = await simulateFinancialTransaction(client, { idFactura: 1008 });

    assert.equal(segunda.reserved, true, 'la segunda reserva es idempotente, no un error');
    assert.equal(state.estadoFacturas.size, 1, 'una sola fila por id_factura (PK)');
    assert.equal(state.estadoFacturas.get(1008).intentos, 0, 'el ON CONFLICT DO NOTHING no incrementa intentos');

    // Y la acumulacion posterior sigue generando un solo movimiento.
    await withMockedFidelizacionPoolConnect(async () => client, async () => {
      await accumulateInvoicePoints({ idFactura: 1008 });
      await accumulateInvoicePoints({ idFactura: 1008 });
    });
    assert.equal(state.movimientos.length, 1);
  });

  it('la reserva congela el snapshot: cambiar el perfil despues NO cambia la decision', async () => {
    const { client, state } = createFidelizacionMockClient({
      passthroughStatements: [SIMULACION_FINANCIERA],
      facturaContexts: { 1009: ventaContext() },
      clienteProfiles: { 5: { estado: true, nombre: 'Valido Al Pagar', telefono: '9999-1111' } }
    });

    await simulateFinancialTransaction(client, { idFactura: 1009 });
    assert.equal(state.estadoFacturas.get(1009).perfil_completo_snapshot, true);

    // El cliente borra su telefono DESPUES de pagar.
    state.clienteProfiles[5] = { estado: true, nombre: 'Valido Al Pagar', telefono: '' };

    const result = await withMockedFidelizacionPoolConnect(
      async () => client,
      () => reconcileMissingPoints({ limit: 25 })
    );

    assert.equal(result.processed, 1, 'se respeta la elegibilidad del momento del pago');
    assert.equal(state.movimientos.length, 1);
  });
});
