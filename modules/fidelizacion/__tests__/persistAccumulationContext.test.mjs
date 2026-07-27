import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import {
  ensurePendingAccumulationState,
  getAccumulationState
} from '../infrastructure/fidelizacionRepository.js';
import { resolveEffectiveAccumulationContext } from '../domain/resolveEffectiveAccumulationContext.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

// Ronda 4: pruebas de los 3 bloqueantes de la auditoria independiente sobre
// el commit 6f0e3399b9c99772d9d7aa22aebf1c5e6dd1d368 -las numeradas 1-15 de
// esa auditoria; 16-20 (precedencia de cliente) viven en
// accumulateInvoicePoints.test.mjs, junto al resto de "cuenta dividida".

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

describe('Bloqueante 1 (ronda 4): RECONCILE nunca reconstruye elegibilidad desde el perfil ACTUAL', () => {
  it('1: RETRYABLE_ERROR sin snapshot + perfil actual completo + sin pedidos_contacto -> no acumula, termina LEGACY_ELIGIBILITY_UNVERIFIABLE', async () => {
    const { client, state } = createFidelizacionMockClient({
      // Perfil actual (por defecto) completo: la prueba de que NO se usa es
      // que, aun asi, no acumula.
      facturaContexts: { 1201: ctx() },
      estadoFacturasIniciales: { 1201: { estado: 'RETRYABLE_ERROR', intentos: 2, ultimo_error: 'timeout previo' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1201, trigger: 'RECONCILE' }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(1201).estado, 'SKIPPED_TERMINAL');
    assert.ok(
      !state.calls.some((c) => c.sql.includes('FROM public.clientes c') && c.sql.includes('LEFT JOIN public.personas p')),
      'nunca consulta el perfil actual del cliente'
    );
  });

  it('2: PENDING sin snapshot + perfil actual completo -> no usa el perfil actual', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1202: ctx() },
      estadoFacturasIniciales: { 1202: { estado: 'PENDING' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1202, trigger: 'RECONCILE' }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.estadoFacturas.get(1202).estado, 'SKIPPED_TERMINAL');
  });

  it('3: RETRYABLE_ERROR sin snapshot pero con pedidos_contacto historico valido -> completa el snapshot y procesa correctamente', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1203: ctx({ id_pedido: 700 }) },
      pedidos: { 700: { id_cliente: 5, origen_pedido: 'MENU' } },
      pedidosContacto: { 700: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' } },
      // Perfil maestro incompleto: si se usara el perfil actual, no acumularia.
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Menu', telefono: '' } },
      estadoFacturasIniciales: { 1203: { estado: 'RETRYABLE_ERROR', intentos: 1, ultimo_error: 'timeout previo' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1203, trigger: 'RECONCILE' }));

    assert.equal(result.created, true, 'la evidencia historica del pedido (menu publico) si permite procesar');
    assert.equal(state.movimientos.length, 1);
    const row = state.estadoFacturas.get(1203);
    assert.equal(row.estado, 'PROCESSED');
    assert.equal(row.nombre_snapshot, 'Ana Menu');
    assert.equal(row.telefono_snapshot, '9999-8888');
    assert.equal(row.perfil_completo_snapshot, true);
  });

  it('4: completar el perfil DESPUES de crear un RETRYABLE_ERROR sin snapshot no otorga puntos retroactivos', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1204: ctx() },
      // Perfil actual incompleto en el primer intento.
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } },
      estadoFacturasIniciales: { 1204: { estado: 'RETRYABLE_ERROR', intentos: 1, ultimo_error: 'timeout previo' } }
    });

    const primero = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1204, trigger: 'RECONCILE' }));
    assert.equal(primero.created, false);
    assert.equal(primero.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.estadoFacturas.get(1204).estado, 'SKIPPED_TERMINAL');

    // El cliente completa su perfil DESPUES de que la factura ya quedo terminal.
    state.clienteProfiles[5] = { estado: true, nombre: 'Ya Completo', telefono: '9999-2222' };

    const segundo = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1204, trigger: 'RECONCILE' }));
    assert.equal(segundo.created, false, 'un estado terminal nunca se reabre, ni siquiera con el perfil ya completo');
    assert.equal(segundo.reason, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
    assert.equal(state.movimientos.length, 0, 'nunca hay puntos retroactivos');
  });
});

describe('ensurePendingAccumulationState (ronda 4): completa columnas NULL sin pisar snapshot ni tocar terminales/intentos', () => {
  const snapshot = (overrides = {}) => ({
    idPedido: 700,
    idCliente: 5,
    idSucursal: 1,
    origenPedido: 'MENU',
    nombreSnapshot: 'Ana Menu',
    telefonoSnapshot: '9999-8888',
    perfilCompletoSnapshot: true,
    fechaReferencia: '2026-03-01T10:00:00Z',
    ...overrides
  });

  it('5: completa columnas NULL de un estado PENDING/RETRYABLE_ERROR existente', async () => {
    const { client } = createFidelizacionMockClient({
      estadoFacturasIniciales: { 1301: { estado: 'RETRYABLE_ERROR', intentos: 2 } }
    });

    const row = await ensurePendingAccumulationState(client, 1301, '2026-03-01T10:00:00Z', snapshot());

    assert.equal(row.id_cliente, 5);
    assert.equal(row.nombre_snapshot, 'Ana Menu');
    assert.equal(row.perfil_completo_snapshot, true);
  });

  it('6: no sobrescribe un snapshot ya grabado', async () => {
    const { client } = createFidelizacionMockClient({
      estadoFacturasIniciales: {
        1302: {
          estado: 'RETRYABLE_ERROR',
          intentos: 1,
          id_cliente: 5,
          nombre_snapshot: 'Original',
          telefono_snapshot: '9999-0000',
          perfil_completo_snapshot: true
        }
      }
    });

    await ensurePendingAccumulationState(client, 1302, '2026-03-01T10:00:00Z', snapshot({ nombreSnapshot: 'Otro Valor', telefonoSnapshot: '9999-1111' }));

    const row = await getAccumulationState(client, 1302);
    assert.equal(row.nombre_snapshot, 'Original', 'el snapshot ya grabado nunca se pisa');
    assert.equal(row.telefono_snapshot, '9999-0000');
  });

  it('7: no modifica un estado terminal (PROCESSED/SKIPPED_TERMINAL)', async () => {
    const { client } = createFidelizacionMockClient({
      estadoFacturasIniciales: { 1303: { estado: 'SKIPPED_TERMINAL', motivo: 'CLIENT_PROFILE_INCOMPLETE', intentos: 3 } }
    });

    await ensurePendingAccumulationState(client, 1303, '2026-03-01T10:00:00Z', snapshot());

    const row = await getAccumulationState(client, 1303);
    assert.equal(row.estado, 'SKIPPED_TERMINAL');
    assert.equal(row.motivo, 'CLIENT_PROFILE_INCOMPLETE');
    assert.equal(row.id_cliente ?? null, null, 'un estado terminal jamas recibe snapshot despues de determinado');
    assert.equal(row.intentos, 3);
  });

  it('8: no incrementa intentos al completar el snapshot', async () => {
    const { client } = createFidelizacionMockClient({
      estadoFacturasIniciales: { 1304: { estado: 'RETRYABLE_ERROR', intentos: 3 } }
    });

    const row = await ensurePendingAccumulationState(client, 1304, '2026-03-01T10:00:00Z', snapshot());

    assert.equal(row.intentos, 3, 'completar el snapshot no es un intento de evaluacion');
  });
});

describe('resolveEffectiveAccumulationContext (funcion pura)', () => {
  it('sin snapshot: usa el contexto actual tal cual, sin mismatch', () => {
    const { effective, mismatch } = resolveEffectiveAccumulationContext({
      currentContext: { idCliente: 5, idSucursal: 1, idPedido: 700, referenceDate: '2026-03-01T10:00:00Z' },
      eligibilitySnapshot: null
    });
    assert.deepEqual(effective, { idCliente: 5, idSucursal: 1, idPedido: 700, referenceDate: '2026-03-01T10:00:00Z' });
    assert.equal(mismatch, null);
  });

  it('con snapshot consistente (mismo valor, distinta representacion de fecha): usa el snapshot, sin mismatch', () => {
    const { effective, mismatch } = resolveEffectiveAccumulationContext({
      currentContext: { idCliente: 5, idSucursal: 1, idPedido: 700, referenceDate: '2026-03-01T10:00:00.000Z' },
      eligibilitySnapshot: { idCliente: 5, idSucursal: 1, idPedido: 700, fechaReferencia: '2026-03-01T10:00:00Z' }
    });
    assert.equal(mismatch, null);
    assert.equal(effective.referenceDate, '2026-03-01T10:00:00Z', 'usa la representacion EXACTA del snapshot, no la del contexto actual');
  });

  it('con snapshot y contexto actual sin ese dato (null): no es mismatch, el snapshot gana', () => {
    const { effective, mismatch } = resolveEffectiveAccumulationContext({
      currentContext: { idCliente: 5, idSucursal: 1, idPedido: null, referenceDate: '2026-03-01T10:00:00Z' },
      eligibilitySnapshot: { idCliente: 5, idSucursal: 1, idPedido: 777, fechaReferencia: '2026-03-01T10:00:00Z' }
    });
    assert.equal(mismatch, null);
    assert.equal(effective.idPedido, 777);
  });

  it('con snapshot que contradice al contexto actual (mismo dato, valores distintos): reporta el campo en mismatch', () => {
    const { effective, mismatch } = resolveEffectiveAccumulationContext({
      currentContext: { idCliente: 9, idSucursal: 1, idPedido: 700, referenceDate: '2026-03-01T10:00:00Z' },
      eligibilitySnapshot: { idCliente: 5, idSucursal: 1, idPedido: 700, fechaReferencia: '2026-03-01T10:00:00Z' }
    });
    assert.deepEqual(mismatch, ['idCliente']);
    assert.equal(effective.idCliente, 5, 'effective sigue siendo el del snapshot aunque haya mismatch: el caller decide cortar antes de usarlo');
  });
});

describe('Bloqueante 2 (ronda 4): el snapshot es el contexto autoritativo completo', () => {
  it('9: snapshot cliente 5 + contexto actual cliente 5 (coinciden) -> acredita al cliente 5', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1401: ctx({ id_cliente: 5 }) },
      estadoFacturasIniciales: {
        1401: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1401 }));

    assert.equal(result.created, true);
    assert.ok(state.saldos.has(5));
  });

  it('10: snapshot cliente 5 + contexto actual cliente 9 (contradiccion) -> no acredita a ninguno, ACCUMULATION_CONTEXT_MISMATCH', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1402: ctx({ id_cliente: 9 }) },
      estadoFacturasIniciales: {
        1402: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1402 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_CONTEXT_MISMATCH');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(1402).motivo, 'ACCUMULATION_CONTEXT_MISMATCH');
    assert.equal(state.estadoFacturas.get(1402).estado, 'SKIPPED_TERMINAL');
  });

  it('11: snapshot sucursal 1 + contexto actual sucursal 2 (contradiccion) -> terminal, no acredita', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1403: ctx({ id_cliente: 5, id_sucursal: 2 }) },
      estadoFacturasIniciales: {
        1403: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1403 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_CONTEXT_MISMATCH');
    assert.equal(state.movimientos.length, 0);
    assert.ok(
      !state.calls.some((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal')),
      'una inconsistencia de contexto corta ANTES de evaluar cualquier configuracion'
    );
  });

  it('12: snapshot fecha A + contexto actual fecha B (contradiccion) -> terminal, nunca evalua la config de la fecha B', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1404: ctx({ id_cliente: 5, fecha_referencia_config: '2026-06-01T00:00:00Z' }) },
      estadoFacturasIniciales: {
        1404: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-01-01T00:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1404 }));

    assert.equal(result.created, false);
    assert.equal(result.reason, 'ACCUMULATION_CONTEXT_MISMATCH');
    assert.ok(!state.calls.some((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal')));
  });

  it('13: un snapshot consistente pasa sus valores EXACTOS (no los del contexto actual) a registerFacturaLoyaltyAccumulation', async () => {
    const { client, state } = createFidelizacionMockClient({
      // El contexto actual no puede resolver el pedido (venta ya no lo trae),
      // pero el snapshot durable si lo tenia congelado: no es un mismatch (el
      // lado actual esta ausente), y el pedido del snapshot debe ser el que
      // se usa en el movimiento.
      facturaContexts: { 1405: ctx({ id_cliente: 5, id_pedido: null, monto_factura: 250 }) },
      estadoFacturasIniciales: {
        1405: { estado: 'PENDING', id_pedido: 777, id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1405 }));

    assert.equal(result.created, true);
    const insertMovimiento = state.calls.find((c) => c.sql.includes('INSERT INTO public.fidelizacion_movimientos'));
    assert.equal(Number(insertMovimiento.params[8]), 777, 'usa el id_pedido del snapshot, no el (ausente) del contexto actual');
  });

  it('14: el monto acreditado siempre es el de la factura ACTUAL, nunca uno derivado del snapshot (que no lo almacena)', async () => {
    const { client: clientA, state: stateA } = createFidelizacionMockClient({
      facturaContexts: { 1406: ctx({ id_cliente: 5, monto_factura: 100 }) },
      estadoFacturasIniciales: {
        1406: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });
    const { client: clientB, state: stateB } = createFidelizacionMockClient({
      facturaContexts: { 1407: ctx({ id_cliente: 5, monto_factura: 300 }) },
      estadoFacturasIniciales: {
        1407: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    const resultA = await withMockedFidelizacionPoolConnect(async () => clientA, () => accumulateInvoicePoints({ idFactura: 1406 }));
    const resultB = await withMockedFidelizacionPoolConnect(async () => clientB, () => accumulateInvoicePoints({ idFactura: 1407 }));

    assert.equal(resultA.points, 10, 'floor(100/10): el mismo snapshot (sin monto) con distinto monto actual da distintos puntos');
    assert.equal(resultB.points, 30, 'floor(300/10)');
  });

  it('15: en una inconsistencia de contexto, no se consulta ni actualiza el saldo de NINGUN cliente', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1408: ctx({ id_cliente: 9 }) },
      estadoFacturasIniciales: {
        1408: { estado: 'PENDING', id_cliente: 5, id_sucursal: 1, fecha_referencia: '2026-03-01T10:00:00Z', perfil_completo_snapshot: true, nombre_snapshot: 'X', telefono_snapshot: '9999-0000' }
      }
    });

    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 1408 }));

    assert.equal(state.saldos.size, 0, 'ni el cliente del snapshot (5) ni el del contexto actual (9) reciben saldo');
    assert.ok(
      !state.calls.some((c) => c.sql.includes('FROM public.fidelizacion_saldos_cliente')),
      'ni siquiera se consulta el saldo de ninguno de los dos clientes'
    );
  });
});
