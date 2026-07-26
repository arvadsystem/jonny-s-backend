import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

// Ronda 5: 2 bloqueantes residuales de la auditoria independiente sobre el
// commit 1bca7ed1b5fdf4266b7d1c04e3ad34e9eeece864.
//
// Bloqueante 1 (pruebas 1-8): accumulateInvoicePoints ya no exige
// id_cliente/id_sucursal del contexto ACTUAL antes de llamar a
// persistAccumulation -eso le negaba al snapshot durable la posibilidad de
// rellenar exactamente esos huecos-. Ademas, MISSING_REQUIRED_DATA (cuando
// ni el snapshot ni el contexto actual resuelven cliente/sucursal) ahora
// queda SKIPPED_TERMINAL: sin eso, la fila PENDING reaparecia indefinidamente
// en cada tick de reconciliacion.
//
// Bloqueante 2 (pruebas 9-15): persistAccumulation preserva el snapshot ya
// resuelto ante CUALQUIER error posterior -no solo el de
// registerFacturaLoyaltyAccumulation-, via un unico try/catch que envuelve
// todo el cuerpo de la funcion. El mock ahora simula un ROLLBACK real
// (restaura saldos/movimientos/estado al momento del BEGIN), asi que estas
// pruebas demuestran una recuperacion transaccional autentica, no solo que
// "aborted" se limpia.

const withMockedFidelizacionPoolConnect = async (connectImpl, run) => {
  const originalConnect = fidelizacionPool.connect;
  fidelizacionPool.connect = connectImpl;
  try {
    return await run();
  } finally {
    fidelizacionPool.connect = originalConnect;
  }
};

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

const snapshotRow = (overrides = {}) => ({
  estado: 'PENDING',
  id_pedido: null,
  id_cliente: 5,
  id_sucursal: 1,
  origen_pedido: null,
  nombre_snapshot: 'Ana Reservada',
  telefono_snapshot: '9999-0000',
  perfil_completo_snapshot: true,
  fecha_referencia: '2026-03-01T10:00:00Z',
  ...overrides
});

describe('Bloqueante 1 (ronda 5): el snapshot rellena cliente/sucursal ausentes en el contexto actual', () => {
  it('1: snapshot idCliente=5, contexto actual id_cliente NULL -> acredita al cliente 5', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4001: ctx({ id_cliente: null }) },
      estadoFacturasIniciales: { 4001: snapshotRow() }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4001 }));

    assert.equal(result.created, true);
    assert.ok(state.saldos.has(5), 'el snapshot resolvio el cliente que el contexto actual no traia');
  });

  it('2: snapshot idSucursal=1, contexto actual id_sucursal NULL -> usa la sucursal del snapshot', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4002: ctx({ id_sucursal: null }) },
      estadoFacturasIniciales: { 4002: snapshotRow() }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4002 }));

    assert.equal(result.created, true);
    const insertMovimiento = state.calls.find((c) => c.sql.includes('INSERT INTO public.fidelizacion_movimientos'));
    assert.equal(Number(insertMovimiento.params[1]), 1, 'el movimiento usa la sucursal del snapshot (params[1] = id_sucursal)');
  });

  it('3: snapshot con pedido y fecha validos, contexto actual sin esos valores -> usa integramente el snapshot', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4003: ctx({ id_pedido: null, fecha_referencia_config: null }) },
      estadoFacturasIniciales: {
        4003: snapshotRow({ id_pedido: 777, fecha_referencia: '2026-02-01T00:00:00Z' })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4003 }));

    assert.equal(result.created, true);
    const insertMovimiento = state.calls.find((c) => c.sql.includes('INSERT INTO public.fidelizacion_movimientos'));
    assert.equal(Number(insertMovimiento.params[8]), 777, 'usa el id_pedido del snapshot');
    const configCall = state.calls.find((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal'));
    assert.equal(configCall.params[1], '2026-02-01T00:00:00Z', 'usa la fecha_referencia del snapshot, no la (ausente) del contexto actual');
  });

  it('4: snapshot valido y contexto actual sin cliente NI sucursal -> procesa correctamente', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4004: ctx({ id_cliente: null, id_sucursal: null }) },
      estadoFacturasIniciales: { 4004: snapshotRow() }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4004 }));

    assert.equal(result.created, true);
    assert.ok(state.saldos.has(5));
    assert.equal(state.estadoFacturas.get(4004).estado, 'PROCESSED');
  });

  it('5: sin snapshot, contexto actual sin cliente (LIVE) -> no lanza, no acredita, resultado definido y sin bucle permanente', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4005: ctx({ id_cliente: null }) }
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4005 }));
    })());

    assert.equal(result.created, false);
    assert.equal(typeof result.reason, 'string');
    assert.notEqual(result.reason, '');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(4005).estado, 'SKIPPED_TERMINAL', 'queda con una politica definida, no PENDING reapareciendo');

    // Un tick posterior no vuelve a re-evaluar nada (estado terminal).
    const nombreMaestroCallsAntes = state.calls.filter((c) => c.sql.includes('AS nombre_maestro')).length;
    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4005 }));
    const nombreMaestroCallsDespues = state.calls.filter((c) => c.sql.includes('AS nombre_maestro')).length;
    assert.equal(nombreMaestroCallsDespues, nombreMaestroCallsAntes, 'un estado terminal no vuelve a reconstruir el snapshot');
  });

  it('6: sin snapshot, RECONCILE y datos actuales incompletos -> termina LEGACY_ELIGIBILITY_UNVERIFIABLE, sin bucle permanente', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 4006: ctx({ id_cliente: null, id_sucursal: null }) }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4006, trigger: 'RECONCILE' }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.estadoFacturas.get(4006).estado, 'SKIPPED_TERMINAL');

    const segundo = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 4006, trigger: 'RECONCILE' }));
    assert.equal(segundo.created, false);
    assert.equal(state.movimientos.length, 0);
  });

  it('7: factura inexistente -> continua devolviendo MISSING_REQUIRED_DATA, sin crear fila de estado', async () => {
    const { client, state } = createFidelizacionMockClient({ facturaContexts: {} });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 5001 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'MISSING_REQUIRED_DATA');
    assert.equal(state.estadoFacturas.has(5001), false, 'sin factura no hay nada que reservar ni marcar terminal');
    assert.ok(state.calls.some((c) => c.sql === 'COMMIT'));
    assert.ok(!state.calls.some((c) => c.sql === 'ROLLBACK'));
  });

  it('8: factura no completamente pagada -> continua devolviendo INVOICE_NOT_FULLY_PAID, sin tocar saldo', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        5002: ctx({ tiene_pago_control: true, pago_control_monto_pendiente: 40, pago_control_estado_codigo: 'PENDIENTE' })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 5002 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'INVOICE_NOT_FULLY_PAID');
    assert.ok(!state.calls.some((c) => c.sql.includes('fidelizacion_saldos_cliente')), 'no consulta ni modifica saldo');
    assert.equal(state.estadoFacturas.has(5002), false);
  });
});

describe('Bloqueante 2 (ronda 5): el snapshot ya resuelto sobrevive a CUALQUIER error posterior', () => {
  it('9: falla ensurePendingAccumulationState DESPUES de construir el snapshot -> RETRYABLE_ERROR conserva cliente, sucursal, nombre, telefono y elegibilidad', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6001: ctx({ id_cliente: 5, id_sucursal: 1 }) },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Real', telefono: '9999-5555' } },
      failOn: "VALUES ($1, 'PENDING'"
    });

    let result;
    await assert.doesNotReject((async () => {
      result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6001 }));
    })());

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ERROR');
    const row = state.estadoFacturas.get(6001);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.id_cliente, 5);
    assert.equal(row.id_sucursal, 1);
    assert.equal(row.nombre_snapshot, 'Ana Real');
    assert.equal(row.telefono_snapshot, '9999-5555');
    assert.equal(row.perfil_completo_snapshot, true);
  });

  it('10 (prueba de control obligatoria): falla el upsert final PROCESSED -> ROLLBACK deshace saldo y movimiento, RETRYABLE_ERROR conserva snapshot, y RECONCILE despues genera EXACTAMENTE un movimiento', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6002: ctx({ id_cliente: 5, id_sucursal: 1 }) },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Real', telefono: '9999-5555' } }
    });

    const originalQuery = client.query.bind(client);
    let procesarFalloUsado = false;
    client.query = async (sql, params) => {
      const text = String(sql);
      if (!procesarFalloUsado
        && text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')
        && !text.includes("VALUES ($1, 'PENDING'")
        && params[1] === 'PROCESSED') {
        procesarFalloUsado = true;
        throw new Error('SIMULATED_PROCESSED_UPSERT_FAILURE');
      }
      return originalQuery(sql, params);
    };

    let primerResultado;
    await assert.doesNotReject((async () => {
      primerResultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6002 }));
    })());

    // --- Control ANTES del reintento: el ROLLBACK debio deshacer TODO lo
    // escrito dentro de esa transaccion (saldo, movimiento, y hasta la
    // propia reserva PENDING de esta pasada), y solo queda la escritura
    // separada (fuera de transaccion) de recordAccumulationRetryableError.
    assert.equal(primerResultado.created, false);
    assert.equal(primerResultado.reason, 'ERROR');
    assert.equal(state.movimientos.length, 0, 'el movimiento se deshizo con el ROLLBACK');
    assert.equal(state.saldos.has(5), false, 'el saldo se deshizo con el ROLLBACK: nunca quedo acreditado');
    const rowTrasFallo = state.estadoFacturas.get(6002);
    assert.equal(rowTrasFallo.estado, 'RETRYABLE_ERROR');
    assert.equal(rowTrasFallo.id_cliente, 5, 'el snapshot sobrevive al ROLLBACK porque se preserva DESPUES, fuera de la transaccion fallida');
    assert.equal(rowTrasFallo.nombre_snapshot, 'Ana Real');
    assert.equal(rowTrasFallo.perfil_completo_snapshot, true);

    // --- Reintento (RECONCILE), ya sin la falla simulada.
    client.query = originalQuery;
    const segundoResultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6002, trigger: 'RECONCILE' }));

    assert.equal(segundoResultado.created, true);
    assert.equal(state.movimientos.length, 1, 'exactamente un movimiento tras la reconciliacion');
    assert.ok(state.saldos.has(5));
    assert.equal(state.estadoFacturas.get(6002).estado, 'PROCESSED');
  });

  it('11: falla el upsert SKIPPED_TERMINAL -> RETRYABLE_ERROR conserva snapshot, y el siguiente intento no vuelve a consultar el perfil actual', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6003: ctx({ id_cliente: 5 }) },
      // Perfil incompleto: registerFacturaLoyaltyAccumulation rechaza con
      // CLIENT_PROFILE_INCOMPLETE (motivo de negocio -> SKIPPED_TERMINAL).
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Incompleta', telefono: '' } }
    });

    const originalQuery = client.query.bind(client);
    let falloUsado = false;
    client.query = async (sql, params) => {
      const text = String(sql);
      if (!falloUsado
        && text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')
        && !text.includes("VALUES ($1, 'PENDING'")
        && params[1] === 'SKIPPED_TERMINAL') {
        falloUsado = true;
        throw new Error('SIMULATED_SKIPPED_TERMINAL_UPSERT_FAILURE');
      }
      return originalQuery(sql, params);
    };

    let resultado;
    await assert.doesNotReject((async () => {
      resultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6003 }));
    })());

    assert.equal(resultado.reason, 'ERROR');
    const row = state.estadoFacturas.get(6003);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.id_cliente, 5, 'el snapshot (aunque incompleto) se preserva igual');
    assert.equal(row.perfil_completo_snapshot, false);

    client.query = originalQuery;
    const callsAntes = state.calls.length;
    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6003, trigger: 'RECONCILE' }));
    const nuevasLlamadas = state.calls.slice(callsAntes);
    assert.ok(
      !nuevasLlamadas.some((c) => c.sql.includes('FROM public.clientes c') && c.sql.includes('LEFT JOIN public.personas p')),
      'con snapshot ya conocido (aunque incompleto), el siguiente intento no vuelve a consultar el perfil actual'
    );
  });

  it('12: falla el upsert de ACCUMULATION_CONTEXT_MISMATCH -> snapshot preservado, no se acredita a ningun cliente', async () => {
    const { client, state } = createFidelizacionMockClient({
      // Snapshot (fila previa) del cliente 5; la factura actual resuelve al
      // cliente 9: contradiccion real -> ACCUMULATION_CONTEXT_MISMATCH.
      facturaContexts: { 6004: ctx({ id_cliente: 9 }) },
      estadoFacturasIniciales: { 6004: snapshotRow({ id_cliente: 5 }) }
    });

    const originalQuery = client.query.bind(client);
    let falloUsado = false;
    client.query = async (sql, params) => {
      const text = String(sql);
      if (!falloUsado
        && text.includes('INSERT INTO public.fidelizacion_acumulacion_facturas_estado')
        && !text.includes("VALUES ($1, 'PENDING'")
        && params[2] === 'ACCUMULATION_CONTEXT_MISMATCH') {
        falloUsado = true;
        throw new Error('SIMULATED_MISMATCH_UPSERT_FAILURE');
      }
      return originalQuery(sql, params);
    };

    let resultado;
    await assert.doesNotReject((async () => {
      resultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6004 }));
    })());

    assert.equal(resultado.reason, 'ERROR');
    assert.equal(state.saldos.size, 0, 'ni el cliente del snapshot (5) ni el del contexto actual (9) reciben saldo');
    const row = state.estadoFacturas.get(6004);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.id_cliente, 5, 'el snapshot original se preserva pese al fallo tecnico');
  });

  it('13: falla registerFacturaLoyaltyAccumulation -> el snapshot sigue preservandose en el RETRYABLE_ERROR resultante', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6005: ctx({ id_cliente: 5, id_sucursal: 1 }) },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Real', telefono: '9999-5555' } },
      // Falla el UPDATE de saldo (dentro de registerFacturaLoyaltyAccumulation),
      // despues de que el snapshot ya fue construido y la reserva PENDING
      // ya se completo.
      failOn: 'UPDATE public.fidelizacion_saldos_cliente'
    });

    let resultado;
    await assert.doesNotReject((async () => {
      resultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6005 }));
    })());

    assert.equal(resultado.reason, 'ERROR');
    assert.equal(state.movimientos.length, 0, 'ROLLBACK deshace cualquier escritura previa de este intento');
    const row = state.estadoFacturas.get(6005);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.id_cliente, 5);
    assert.equal(row.nombre_snapshot, 'Ana Real');
    assert.equal(row.perfil_completo_snapshot, true);
  });

  it('14: error ANTES de poder construir el snapshot -> eligibilitySnapshot permanece null, no se inventan datos historicos', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6006: ctx({ id_cliente: 5 }) },
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Real', telefono: '9999-5555' } },
      // Falla la PRIMERISIMA lectura de persistAccumulation (getAccumulationState),
      // antes de que exista cualquier posibilidad de snapshot.
      failOn: 'FROM public.fidelizacion_acumulacion_facturas_estado'
    });

    let resultado;
    await assert.doesNotReject((async () => {
      resultado = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6006 }));
    })());

    assert.equal(resultado.reason, 'ERROR');
    const row = state.estadoFacturas.get(6006);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.id_cliente ?? null, null, 'sin snapshot resuelto, no se inventa ningun dato historico');
    assert.equal(row.nombre_snapshot ?? null, null);
    assert.equal(row.perfil_completo_snapshot ?? null, null);
  });

  it('15: un error posterior nunca sobrescribe un snapshot ya grabado en la fila', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 6007: ctx({ id_cliente: 5, id_sucursal: 1 }) },
      estadoFacturasIniciales: {
        6007: snapshotRow({ nombre_snapshot: 'Original Congelado', telefono_snapshot: '9999-1111' })
      },
      failOn: 'UPDATE public.fidelizacion_saldos_cliente'
    });

    await assert.doesNotReject((async () => {
      await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 6007 }));
    })());

    const row = state.estadoFacturas.get(6007);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.nombre_snapshot, 'Original Congelado', 'el snapshot ya grabado no se sobrescribe con un error posterior');
    assert.equal(row.telefono_snapshot, '9999-1111');
  });
});
