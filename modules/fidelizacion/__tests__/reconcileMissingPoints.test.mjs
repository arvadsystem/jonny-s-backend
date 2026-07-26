import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { reconcileMissingPoints } from '../workers/reconcileMissingPoints.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';
import { createFakeLimitedPool, withTimeout } from './fakeLimitedPool.mjs';
import { enqueueInvoiceAccumulation, waitForFidelizacionQueueIdle } from '../infrastructure/fidelizacionQueue.js';

const originalQueueMaxSize = process.env.FIDELIZACION_QUEUE_MAX_SIZE;
afterEach(() => {
  if (originalQueueMaxSize === undefined) delete process.env.FIDELIZACION_QUEUE_MAX_SIZE;
  else process.env.FIDELIZACION_QUEUE_MAX_SIZE = originalQueueMaxSize;
});

const withMockedFidelizacionPoolConnect = async (connectImpl, run) => {
  const originalConnect = fidelizacionPool.connect;
  fidelizacionPool.connect = connectImpl;
  try {
    return await run();
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

describe('reconcileMissingPoints (worker de reconciliacion idempotente, sin inanicion)', () => {
  it('encuentra facturas pagadas sin movimiento, espera el lote completo y reporta resultados reales', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        1001: baseContext({ id_cliente: 5, monto_factura: 100 }),
        1002: baseContext({ id_cliente: 6, monto_factura: 200 })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.implemented, true);
    assert.equal(result.scanned, 2);
    assert.equal(result.queued, 2);
    assert.equal(result.processed, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.next_cursor, 1002);
    assert.equal(result.retry_cursor, null);
    assert.equal(result.success, true);
    assert.equal(result.partial, false);
    assert.equal(result.reached_end, false);
    assert.equal(state.movimientos.length, 2, 'no debe reportar exito solo por encolar: el lote ya debe estar procesado al responder');
  });

  it('sin candidatos: reached_end en true, para que el scheduler pueda reiniciar el cursor', async () => {
    const { client } = createFidelizacionMockClient({ facturaContexts: {} });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ cursor: 999999, limit: 25 }));

    assert.equal(result.scanned, 0);
    assert.equal(result.success, true);
    assert.equal(result.reached_end, true);
    assert.equal(result.retry_cursor, null);
  });

  it('es idempotente: si ya tiene movimiento, no vuelve a listarla ni a duplicar', async () => {
    const { client, state } = createFidelizacionMockClient({
      movimientos: [{ id_movimiento: 1, id_factura: 1003, tipo: 'ACUMULACION', origen: 'FACTURA' }],
      facturaContexts: { 1003: baseContext() }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.scanned, 0);
    assert.equal(state.movimientos.length, 1);
  });

  it('filtra clientes no elegibles: primer lote sin candidatos procesables, segundo lote (cliente elegible) si avanza', async () => {
    const { client, state } = createFidelizacionMockClient({
      eligibleClienteIds: [6],
      facturaContexts: {
        // id_cliente 5 no esta en eligibleClienteIds: nunca debe aparecer como candidato.
        2001: baseContext({ id_cliente: 5, monto_factura: 100 }),
        2002: baseContext({ id_cliente: 5, monto_factura: 100 }),
        2003: baseContext({ id_cliente: 6, monto_factura: 100 })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.scanned, 1, 'las facturas de cliente no elegible nunca deben listarse como candidatas');
    assert.deepEqual(result.ids_factura, [2003]);
    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.movimientos[0].id_factura, 2003);
  });

  it('cursor keyset: avanza y el siguiente lote no repite siempre las primeras facturas', async () => {
    const { client } = createFidelizacionMockClient({
      facturaContexts: {
        3001: baseContext({ id_cliente: 5 }),
        3002: baseContext({ id_cliente: 5 }),
        3003: baseContext({ id_cliente: 5 })
      }
    });

    const firstBatch = await withMockedFidelizacionPoolConnect(
      async () => client,
      () => reconcileMissingPoints({ cursor: 0, limit: 2 })
    );
    assert.deepEqual(firstBatch.ids_factura, [3001, 3002]);
    assert.equal(firstBatch.next_cursor, 3002);

    const secondBatch = await withMockedFidelizacionPoolConnect(
      async () => client,
      () => reconcileMissingPoints({ cursor: firstBatch.next_cursor, limit: 2 })
    );
    assert.deepEqual(secondBatch.ids_factura, [3003], 'el segundo lote debe continuar, no repetir 3001/3002');
    assert.equal(secondBatch.next_cursor, 3003);
  });

  it('factura sin configuracion historica valida no bloquea a las siguientes', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ],
      facturaContexts: {
        // Fecha fuera de cualquier ventana de configuracion: nunca sera procesable.
        4001: baseContext({ id_cliente: 5, fecha_referencia_config: '2020-01-01T00:00:00Z' }),
        4002: baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [4002], 'la factura sin configuracion historica no debe listarse, pero no debe impedir listar 4002');
    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
  });

  it('un fallo individual en el lote no cancela el resto', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        5001: baseContext({ id_cliente: 5 }),
        5002: baseContext({ id_cliente: 6 }),
        5003: baseContext({ id_cliente: 7 })
      }
    });

    // Forzamos que SOLO la primera escritura falle, dejando pasar las demas.
    let insertCount = 0;
    const originalQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      if (String(sql).includes('INSERT INTO public.fidelizacion_movimientos')) {
        insertCount += 1;
        if (insertCount === 1) throw new Error('SIMULATED_SINGLE_FAILURE');
      }
      return originalQuery(sql, params);
    };

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.scanned, 3);
    assert.equal(result.processed, 2);
    assert.equal(result.failed, 1);
    assert.equal(state.movimientos.length, 2);
    assert.equal(result.success, false);
    assert.equal(result.partial, true);
  });

  it('factura fallida temporalmente: retry_cursor no avanza mas alla de la primera fallida, y el siguiente tick la reintenta', async () => {
    const contexts = {
      6001: baseContext({ id_cliente: 5 }),
      6002: baseContext({ id_cliente: 6 }),
      6003: baseContext({ id_cliente: 7 })
    };
    const { client, state } = createFidelizacionMockClient({ facturaContexts: contexts });

    // Solo la factura 6002 (la del medio) falla en este primer intento:
    // la segunda escritura de movimiento que se procese es la suya, dado el
    // orden ascendente del lote (6001, 6002, 6003).
    let insertAttempt = 0;
    const originalInsertQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      if (String(sql).includes('INSERT INTO public.fidelizacion_movimientos')) {
        insertAttempt += 1;
        if (insertAttempt === 2) throw new Error('SIMULATED_TEMP_FAILURE_6002');
      }
      return originalInsertQuery(sql, params);
    };

    const firstAttempt = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ cursor: 0, limit: 25 }));

    assert.equal(firstAttempt.success, false);
    assert.equal(firstAttempt.partial, true);
    assert.equal(firstAttempt.failed, 1);
    assert.equal(firstAttempt.retry_cursor, 6001, 'no debe avanzar mas alla de la factura anterior a la fallida (6002 - 1)');
    assert.equal(state.movimientos.some((m) => m.id_factura === 6002), false, 'la fallida no debe quedar con movimiento');
    assert.equal(state.movimientos.some((m) => m.id_factura === 6001), true, 'la exitosa antes de la fallida si se procesa');

    // Siguiente tick: retoma desde retry_cursor. Ya sin la falla simulada.
    client.query = originalInsertQuery;
    const secondAttempt = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ cursor: firstAttempt.retry_cursor, limit: 25 }));

    // 6003 ya acumulo con exito en el primer intento (no fue la que fallo);
    // queda excluida por idempotencia. Solo 6002 vuelve a aparecer.
    assert.deepEqual(secondAttempt.ids_factura, [6002], '6001 y 6003 ya tienen movimiento; solo 6002 se reintenta');
    assert.equal(secondAttempt.success, true);
    assert.equal(state.movimientos.some((m) => m.id_factura === 6002), true, 'el reintento si logra acumular la factura que antes fallo');
    assert.equal(state.movimientos.length, 3);
  });

  it('factura rechazada por cola llena: no se abandona, tambien genera retry_cursor', async () => {
    process.env.FIDELIZACION_QUEUE_MAX_SIZE = '1';
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7001: baseContext({ id_cliente: 5 }) }
    });

    const shortWait = () => new Promise((resolve) => setTimeout(resolve, 5));

    // Ocupa la unica conexion "en proceso" (occupantA) y llena el unico
    // lugar de espera de la cola (occupantB, max=1), para que la factura de
    // la reconciliacion llegue como excedente y sea rechazada de inmediato.
    const occupantA = enqueueInvoiceAccumulation({ idFactura: 9999 }, async () => { await shortWait(); return { created: false }; });
    const occupantB = enqueueInvoiceAccumulation({ idFactura: 9998 }, async () => { await shortWait(); return { created: false }; });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.rejected, 1);
    assert.equal(result.success, false);
    assert.equal(result.partial, true);
    assert.equal(result.retry_cursor, 7000, 'debe permitir reintentar la factura rechazada, no saltarsela');
    assert.equal(state.movimientos.length, 0);

    await Promise.all([occupantA, occupantB]);
    await waitForFidelizacionQueueIdle();
  });

  it('un error real al listar candidatos se propaga (tick fallido, no exito silencioso)', async () => {
    await withMockedFidelizacionPoolConnect(
      async () => { throw new Error('ECONNREFUSED'); },
      async () => {
        await assert.rejects(reconcileMissingPoints(), /ECONNREFUSED/);
      }
    );
  });

  it('libera la conexion incluso si release() falla', async () => {
    const { client, state } = createFidelizacionMockClient({ releaseError: new Error('RELEASE_BOOM') });

    await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints());

    assert.equal(state.releaseCallCount, 1);
  });

  it('libera la conexion incluso si el listado falla (no deja la conexion abierta)', async () => {
    const { client, state } = createFidelizacionMockClient({ failOn: 'NOT EXISTS' });

    await withMockedFidelizacionPoolConnect(
      async () => client,
      async () => { await assert.rejects(reconcileMissingPoints()); }
    );

    assert.equal(state.releaseCallCount, 1);
  });

  it('pool max:1 REAL: reconciliar con candidatos no genera deadlock', async () => {
    const { client: backendClient, state } = createFidelizacionMockClient({
      facturaContexts: {
        8001: baseContext({ id_cliente: 5 }),
        8002: baseContext({ id_cliente: 6 })
      }
    });
    const fakePool = createFakeLimitedPool({ max: 1, backendQuery: backendClient.query });

    const result = await withMockedFidelizacionPoolConnect(
      () => fakePool.connect(),
      () => withTimeout(
        reconcileMissingPoints({ limit: 25 }),
        500,
        'DEADLOCK_TIMEOUT: la conexion de listado sigue retenida mientras se procesa el lote'
      )
    );

    assert.equal(result.processed, 2);
    assert.equal(state.movimientos.length, 2);
    assert.equal(fakePool.getInUse(), 0, 'no debe quedar ninguna conexion retenida al terminar');
    assert.equal(fakePool.getWaitingCount(), 0);
  });

  it('la conexion de listado se libera ANTES de procesar el lote (orden verificable)', async () => {
    const { client: backendClient, state } = createFidelizacionMockClient({
      facturaContexts: { 8101: baseContext({ id_cliente: 5 }) }
    });

    const timeline = [];
    const fakePool = createFakeLimitedPool({
      max: 1,
      backendQuery: (sql, params) => {
        if (String(sql).trim() === 'BEGIN') timeline.push('accumulate_begin');
        return backendClient.query(sql, params);
      },
      onRelease: () => timeline.push('release')
    });

    await withMockedFidelizacionPoolConnect(
      () => fakePool.connect(),
      () => withTimeout(reconcileMissingPoints({ limit: 25 }), 500, 'DEADLOCK_TIMEOUT')
    );

    assert.equal(state.movimientos.length, 1);
    // 'release' (conexion de listado) -> 'accumulate_begin' (la acumulacion
    // ya pudo abrir SU PROPIA conexion) -> 'release' (la acumulacion libera
    // la suya al terminar). Si la conexion de listado no se liberara antes,
    // 'accumulate_begin' nunca aparecería (deadlock).
    assert.deepEqual(
      timeline,
      ['release', 'accumulate_begin', 'release'],
      'la conexion de listado debe liberarse antes de que la acumulacion pida/abra su propia conexion'
    );
  });
});
