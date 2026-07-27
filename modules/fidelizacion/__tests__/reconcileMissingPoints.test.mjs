import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { reconcileMissingPoints } from '../workers/reconcileMissingPoints.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';
import { createFakeLimitedPool, withTimeout } from './fakeLimitedPool.mjs';
import { createFidelizacionLockCoordinator } from './fidelizacionLockCoordinator.mjs';
import { enqueueInvoiceAccumulation, waitForFidelizacionQueueIdle } from '../infrastructure/fidelizacionQueue.js';

const originalQueueMaxSize = process.env.FIDELIZACION_QUEUE_MAX_SIZE;
const originalGraceMs = process.env.FIDELIZACION_RECONCILE_GRACE_MS;
afterEach(() => {
  if (originalQueueMaxSize === undefined) delete process.env.FIDELIZACION_QUEUE_MAX_SIZE;
  else process.env.FIDELIZACION_QUEUE_MAX_SIZE = originalQueueMaxSize;
  if (originalGraceMs === undefined) delete process.env.FIDELIZACION_RECONCILE_GRACE_MS;
  else process.env.FIDELIZACION_RECONCILE_GRACE_MS = originalGraceMs;
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

// Simula lo que reservePaidInvoiceAccumulation habria dejado: una fila
// PENDING con el snapshot YA congelado (ronda 4, bloqueante 2: el snapshot
// es el contexto autoritativo -id_cliente/id_sucursal/fecha_referencia-, asi
// que declararlo sin esos campos ya no representa una reserva real; antes de
// la ronda 4 esos campos no importaban porque persistAccumulation nunca los
// leia del snapshot). Toma id_cliente/id_sucursal/fecha del mismo contexto
// que la prueba ya declaro en facturaContexts, para que ambos coincidan.
const pendingConSnapshot = (context, overrides = {}) => ({
  estado: 'PENDING',
  id_pedido: context.id_pedido ?? null,
  id_cliente: context.id_cliente,
  id_sucursal: context.id_sucursal,
  origen_pedido: null,
  nombre_snapshot: 'Cliente Demo',
  telefono_snapshot: '9999-9999',
  perfil_completo_snapshot: true,
  fecha_referencia: context.fecha_referencia_config ?? null,
  ...overrides
});

describe('reconcileMissingPoints (worker de reconciliacion idempotente, sin inanicion)', () => {
  it('bloqueante 1 (regla 7): RECONCILE con PENDING ya existente (LIVE lo reservo antes) si procesa, espera el lote completo y reporta resultados reales', async () => {
    // PENDING simula que el camino LIVE ya reservo el estado (justo tras el
    // COMMIT de la venta) pero algo interrumpio antes de terminar de
    // evaluar (p.ej. reinicio del proceso) -- por eso RECONCILE si puede
    // continuarla, a diferencia de una factura sin fila alguna.
    const ctx1001 = baseContext({ id_cliente: 5, monto_factura: 100 });
    const ctx1002 = baseContext({ id_cliente: 6, monto_factura: 200 });
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1001: ctx1001, 1002: ctx1002 },
      estadoFacturasIniciales: {
        1001: pendingConSnapshot(ctx1001),
        1002: pendingConSnapshot(ctx1002)
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
    assert.equal(state.estadoFacturas.get(1001).estado, 'PROCESSED');
    assert.equal(state.estadoFacturas.get(1002).estado, 'PROCESSED');
  });

  it('bloqueante 1 (regla 8): RECONCILE con RETRYABLE_ERROR ya existente si reintenta', async () => {
    const ctx1050 = baseContext({ id_cliente: 5, monto_factura: 100 });
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 1050: ctx1050 },
      estadoFacturasIniciales: {
        1050: pendingConSnapshot(ctx1050, { estado: 'RETRYABLE_ERROR', intentos: 1, ultimo_error: 'ECONNRESET previo' })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [1050]);
    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(1050).estado, 'PROCESSED');
    assert.equal(state.estadoFacturas.get(1050).intentos, 2, 'el reintento incrementa intentos sobre la fila existente');
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

  it('bloqueante 1 (reglas 4 y 5): RECONCILE sin fila de estado nunca acumula, tenga o no perfil completo el cliente actualmente', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: {
        5: { estado: true, nombre: '', telefono: '9999-9999' } // perfil incompleto
        // id_cliente 6 usa el perfil por defecto (completo/valido).
      },
      facturaContexts: {
        2001: baseContext({ id_cliente: 5, monto_factura: 100 }),
        2002: baseContext({ id_cliente: 5, monto_factura: 100 }),
        2003: baseContext({ id_cliente: 6, monto_factura: 100 })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    // Sin fila de estado previa, RECONCILE nunca evalua perfil/config/puntos
    // -ni siquiera para 2003, cuyo cliente (6) tiene un perfil actual
    // perfectamente valido-: las 3 se listan pero NINGUNA acumula.
    assert.equal(result.scanned, 3);
    assert.deepEqual(result.ids_factura, [2001, 2002, 2003]);
    assert.equal(result.processed, 0, 'ninguna acumula, ni siquiera la de perfil actual valido (2003)');
    assert.equal(result.skipped, 3);
    assert.equal(state.movimientos.length, 0);

    for (const id of [2001, 2002, 2003]) {
      const row = state.estadoFacturas.get(id);
      assert.equal(row.estado, 'SKIPPED_TERMINAL');
      assert.equal(row.motivo, 'LEGACY_ELIGIBILITY_UNVERIFIABLE', 'reconciliacion sin fila previa nunca consulta el perfil actual');
      assert.equal(row.elegibilidad_determinada, false);
    }
  });

  it('bug reportado: completar el perfil DESPUES de que la factura quedo terminal no la reabre en un tick posterior', async () => {
    const { client, state } = createFidelizacionMockClient({
      clienteProfiles: {
        5: { estado: true, nombre: '', telefono: '' } // perfil incompleto al momento de la compra
      },
      facturaContexts: {
        2501: baseContext({ id_cliente: 5, monto_factura: 100 })
      }
    });

    const firstTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.deepEqual(firstTick.ids_factura, [2501]);
    assert.equal(firstTick.processed, 0);
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(2501).estado, 'SKIPPED_TERMINAL');

    // El cliente completa su perfil DESPUES (nombre y telefono validos).
    state.clienteProfiles[5] = { estado: true, nombre: 'Ahora Completo', telefono: '9999-9999' };

    const secondTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    // La factura 2501 ya no debe ni listarse (esta terminal): no reaparece,
    // y sobre todo nunca genera un movimiento con los datos de hoy.
    assert.deepEqual(secondTick.ids_factura, []);
    assert.equal(secondTick.scanned, 0);
    assert.equal(state.movimientos.length, 0, 'completar el perfil no debe generar puntos retroactivos para la factura antigua');
    assert.equal(state.estadoFacturas.get(2501).estado, 'SKIPPED_TERMINAL', 'el estado terminal sobrevive intacto');
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

  it('factura sin configuracion historica valida (con PENDING previo): se procesa, queda SKIPPED_TERMINAL/CONFIG_NOT_FOUND, y no bloquea a las siguientes', async () => {
    // Fecha fuera de cualquier ventana de configuracion: nunca sera procesable.
    const ctx4001 = baseContext({ id_cliente: 5, fecha_referencia_config: '2020-01-01T00:00:00Z' });
    const ctx4002 = baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' });
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ],
      facturaContexts: { 4001: ctx4001, 4002: ctx4002 },
      // PENDING previo (LIVE ya las reservo): sin esto, RECONCILE no evaluaria
      // nada -ninguna fila de estado significa terminal inmediato, ver
      // bloqueante 1 reglas 4/5-.
      estadoFacturasIniciales: {
        4001: pendingConSnapshot(ctx4001),
        4002: pendingConSnapshot(ctx4002)
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [4001, 4002]);
    assert.equal(result.processed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(4001).estado, 'SKIPPED_TERMINAL');
    assert.equal(state.estadoFacturas.get(4001).motivo, 'CONFIG_NOT_FOUND');

    // Un tick posterior no vuelve a listar 4001 (ya es terminal), sin importar cuanto cambie el reloj.
    const secondTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.deepEqual(secondTick.ids_factura, []);
  });

  it('sucursal con switch de acumulacion apagado en la fecha de referencia (con PENDING previo): se procesa, queda SKIPPED_TERMINAL/ACCUMULATION_DISABLED', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, acumulacion_habilitada: false, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ],
      facturaContexts: {
        4101: baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' }),
        4102: baseContext({ id_cliente: 6, fecha_referencia_config: '2026-02-01T00:00:00Z' })
      },
      estadoFacturasIniciales: {
        4101: pendingConSnapshot(baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' })),
        4102: pendingConSnapshot(baseContext({ id_cliente: 6, fecha_referencia_config: '2026-02-01T00:00:00Z' }))
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [4101, 4102]);
    assert.equal(result.processed, 0);
    assert.equal(result.skipped, 2);
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(4101).motivo, 'ACCUMULATION_DISABLED');
    assert.equal(state.estadoFacturas.get(4102).motivo, 'ACCUMULATION_DISABLED');
  });

  it('configuracion sin tasa valida (lempiras_por_punto <= 0, con PENDING previo): se procesa, queda SKIPPED_TERMINAL/ACCUMULATION_RULE_NOT_CONFIGURED', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 0, acumulacion_habilitada: true, vigente_desde: '2026-01-01T00:00:00Z', vigente_hasta: null }
      ],
      facturaContexts: {
        4201: baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' })
      },
      estadoFacturasIniciales: {
        4201: pendingConSnapshot(baseContext({ id_cliente: 5, fecha_referencia_config: '2026-02-01T00:00:00Z' }))
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [4201]);
    assert.equal(result.processed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(4201).motivo, 'ACCUMULATION_RULE_NOT_CONFIGURED');
  });

  it('un fallo individual en el lote no cancela el resto', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        5001: baseContext({ id_cliente: 5 }),
        5002: baseContext({ id_cliente: 6 }),
        5003: baseContext({ id_cliente: 7 })
      },
      // PENDING previo en las 3: sin fila de estado, RECONCILE nunca llega a
      // evaluar (y por lo tanto nunca a INSERT INTO fidelizacion_movimientos,
      // que es donde este test simula el fallo tecnico).
      estadoFacturasIniciales: {
        5001: pendingConSnapshot(baseContext({ id_cliente: 5 })),
        5002: pendingConSnapshot(baseContext({ id_cliente: 6 })),
        5003: pendingConSnapshot(baseContext({ id_cliente: 7 }))
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
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: contexts,
      estadoFacturasIniciales: {
        6001: pendingConSnapshot(contexts[6001]),
        6002: pendingConSnapshot(contexts[6002]),
        6003: pendingConSnapshot(contexts[6003])
      }
    });

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
      },
      estadoFacturasIniciales: {
        8001: pendingConSnapshot(baseContext({ id_cliente: 5 })),
        8002: pendingConSnapshot(baseContext({ id_cliente: 6 }))
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
      facturaContexts: { 8101: baseContext({ id_cliente: 5 }) },
      estadoFacturasIniciales: { 8101: pendingConSnapshot(baseContext({ id_cliente: 5 })) }
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

  it('bloqueante 1 (regla 9): RECONCILE no procesa facturas pagadas dentro del periodo de gracia', async () => {
    process.env.FIDELIZACION_RECONCILE_GRACE_MS = '300000';
    const recienPagada = new Date(Date.now() - 60000).toISOString(); // pagada hace 1 minuto: dentro de la gracia de 5 minutos.
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        9001: baseContext({ id_cliente: 5, fecha_referencia_config: recienPagada })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [], 'una factura pagada hace 1 minuto no debe listarse con gracia de 5 minutos');
    assert.equal(result.scanned, 0);
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.has(9001), false, 'ni siquiera queda una fila de estado: nunca se evaluo');
  });

  it('bloqueante 1 (regla 10): despues del periodo de gracia, una factura sin fila de estado queda terminal (no vuelve a intentarse via perfil actual)', async () => {
    process.env.FIDELIZACION_RECONCILE_GRACE_MS = '300000';
    const pagadaHaceOchoMinutos = new Date(Date.now() - 8 * 60000).toISOString();
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: {
        9002: baseContext({ id_cliente: 5, fecha_referencia_config: pagadaHaceOchoMinutos })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [9002], 'ya paso el periodo de gracia: si se lista');
    assert.equal(result.processed, 0);
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(9002).estado, 'SKIPPED_TERMINAL');
    assert.equal(state.estadoFacturas.get(9002).motivo, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');

    // Un tick posterior (con el perfil del cliente ya completo, si aplicara) no la reabre.
    const secondTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.deepEqual(secondTick.ids_factura, []);
  });

  it('bloqueante 1: el valor de FIDELIZACION_RECONCILE_GRACE_MS invalido cae al default seguro (300000 ms) en vez de desactivar la gracia', async () => {
    process.env.FIDELIZACION_RECONCILE_GRACE_MS = 'no-es-un-numero';
    const recienPagada = new Date(Date.now() - 60000).toISOString();
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 9003: baseContext({ id_cliente: 5, fecha_referencia_config: recienPagada }) }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [], 'un valor invalido de env debe caer al default (300000ms), no a 0 (sin gracia)');
    assert.equal(state.movimientos.length, 0);
  });
});

describe('Elegibilidad historica en RECONCILE (snapshot durable vs evidencia vs nada)', () => {
  it('26: RECONCILE con reserva PENDING valida procesa usando SU snapshot, no el perfil actual', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7101: baseContext({ id_cliente: 5 }) },
      estadoFacturasIniciales: {
        7101: pendingConSnapshot(baseContext({ id_cliente: 5 }), {
          nombre_snapshot: 'Valido Al Pagar',
          telefono_snapshot: '9999-1111',
          perfil_completo_snapshot: true
        })
      },
      // El perfil ACTUAL esta incompleto: si se usara, no acumularia.
      clienteProfiles: { 5: { estado: true, nombre: '', telefono: '' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.processed, 1, 'manda el snapshot historico, no el perfil de hoy');
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(7101).estado, 'PROCESSED');
  });

  it('25: reserva con snapshot INCOMPLETO -> terminal, y completar el perfil despues no lo reabre', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7102: baseContext({ id_cliente: 5 }) },
      estadoFacturasIniciales: {
        7102: pendingConSnapshot(baseContext({ id_cliente: 5 }), {
          nombre_snapshot: 'Sin Telefono',
          telefono_snapshot: null,
          perfil_completo_snapshot: false
        })
      }
    });

    const primero = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.equal(primero.processed, 0);
    assert.equal(state.estadoFacturas.get(7102).estado, 'SKIPPED_TERMINAL');
    assert.equal(state.estadoFacturas.get(7102).motivo, 'CLIENT_PROFILE_INCOMPLETE');

    // El cliente completa su perfil DESPUES.
    state.clienteProfiles[5] = { estado: true, nombre: 'Ya Completo', telefono: '9999-2222' };

    const segundo = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.deepEqual(segundo.ids_factura, [], 'una factura terminal no vuelve a listarse');
    assert.equal(state.movimientos.length, 0, 'nunca hay puntos retroactivos');
  });

  it('28: RECONCILE sin reserva pero con evidencia historica de pedidos_contacto (menu publico) SI puede procesar', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7103: baseContext({ id_cliente: 5, id_pedido: 800 }) },
      pedidos: { 800: { id_cliente: 5, origen_pedido: 'MENU' } },
      pedidosContacto: { 800: { nombre_contacto: 'Ana Menu', telefono_normalizado: '99998888' } },
      // Perfil maestro incompleto: la evidencia valida es la del pedido.
      clienteProfiles: { 5: { estado: true, nombre: 'Ana Menu', telefono: '' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
    assert.equal(state.estadoFacturas.get(7103).estado, 'PROCESSED');
  });

  it('27: RECONCILE sin reserva y SIN evidencia historica queda LEGACY_ELIGIBILITY_UNVERIFIABLE (jamas usa el perfil actual)', async () => {
    const { client, state } = createFidelizacionMockClient({
      // Venta directa (sin pedido), por lo tanto sin pedidos_contacto: no hay
      // forma de probar como era el perfil al momento de la compra.
      facturaContexts: { 7104: baseContext({ id_cliente: 5, id_pedido: null }) },
      // Perfil actual perfectamente valido: aun asi NO debe acumular.
      clienteProfiles: { 5: { estado: true, nombre: 'Perfecto Hoy', telefono: '9999-3333' } }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(result.processed, 0, 'un perfil valido HOY no prueba nada sobre el momento de la compra');
    assert.equal(state.movimientos.length, 0);
    assert.equal(state.estadoFacturas.get(7104).motivo, 'LEGACY_ELIGIBILITY_UNVERIFIABLE');
  });

  it('29: un estado terminal nunca vuelve a evaluar el perfil actual', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7105: baseContext({ id_cliente: 5 }) },
      estadoFacturasIniciales: {
        7105: { estado: 'SKIPPED_TERMINAL', motivo: 'CLIENT_PROFILE_INCOMPLETE', perfil_completo_snapshot: false }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [], 'ni siquiera se lista');
    const consultoPerfil = state.calls.some((c) => c.sql.includes('AS nombre_maestro'));
    assert.equal(consultoPerfil, false, 'no debe resolver ningun snapshot para una factura ya terminal');
  });

  it('31: LIVE y RECONCILE concurrentes sobre la misma factura no duplican el movimiento (advisory lock real simulado)', async () => {
    // Conexiones independientes que comparten la misma "base de datos" y el
    // mismo coordinador de advisory lock: la segunda transaccion que pide el
    // lock de esa factura espera de verdad a que la primera haga COMMIT.
    const lockCoordinator = createFidelizacionLockCoordinator();
    const principal = createFidelizacionMockClient({
      facturaContexts: { 7106: baseContext({ id_cliente: 5 }) },
      estadoFacturasIniciales: {
        7106: pendingConSnapshot(baseContext({ id_cliente: 5 }), { nombre_snapshot: 'X', telefono_snapshot: '9999-4444' })
      },
      lockCoordinator
    });
    const secundario = createFidelizacionMockClient({ sharedState: principal.state, lockCoordinator });

    let conexiones = 0;
    const connectImpl = async () => {
      conexiones += 1;
      return conexiones === 1 ? principal.client : secundario.client;
    };

    await withMockedFidelizacionPoolConnect(connectImpl, async () => {
      await Promise.all([
        accumulateInvoicePoints({ idFactura: 7106 }),
        reconcileMissingPoints({ limit: 25 })
      ]);
    });

    assert.equal(principal.state.movimientos.length, 1, 'un solo movimiento entre ambos disparadores');
    const saldoUpdates = principal.state.calls.filter((c) => c.sql.includes('UPDATE public.fidelizacion_saldos_cliente')).length;
    assert.equal(saldoUpdates, 1, 'una sola actualizacion de saldo');
    assert.equal(principal.state.estadoFacturas.get(7106).estado, 'PROCESSED');
  });
});

describe('Ronda 6, bloqueante 1: la consulta de candidatos ya no descarta clientes que solo viven en el snapshot durable', () => {
  it('caso obligatorio: factura y pedido con id_cliente NULL, pero con reserva durable PENDING (id_cliente=5, snapshot completo) -> reconcileMissingPoints la encuentra, encola, procesa y acredita', async () => {
    // factura.id_cliente = NULL, pedido.id_cliente = NULL: el UNICO rastro
    // de a quien acreditar vive en la fila durable (est.id_cliente).
    const contextoSinCliente = baseContext({ id_cliente: null, id_pedido: 800 });
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7001: contextoSinCliente },
      pedidos: { 800: { id_cliente: null } },
      estadoFacturasIniciales: {
        7001: pendingConSnapshot(contextoSinCliente, {
          id_cliente: 5,
          id_sucursal: 1,
          nombre_snapshot: 'Cliente Historico',
          telefono_snapshot: '9999-0000',
          perfil_completo_snapshot: true,
          fecha_referencia: '2026-03-01T10:00:00Z'
        })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [7001], 'la consulta de candidatos SI la encuentra via COALESCE(est.id_cliente, f.id_cliente, p.id_cliente)');
    assert.equal(result.processed, 1);
    assert.equal(state.movimientos.length, 1);
    assert.ok(state.saldos.has(5), 'el saldo se acredita al cliente del snapshot durable');
    assert.equal(state.estadoFacturas.get(7001).estado, 'PROCESSED');
  });

  it('prueba negativa: factura y pedido con id_cliente NULL, sin estado durable y sin pedidos_contacto -> no se acredita, no se inventa cliente, y no hay bucle', async () => {
    const contextoSinCliente = baseContext({ id_cliente: null, id_pedido: null });
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 7002: contextoSinCliente }
      // Sin estadoFacturasIniciales, sin pedidos, sin pedidosContacto: no hay
      // absolutamente ninguna evidencia -ni durable ni historica- de a quien
      // acreditar.
    });

    const primerTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.equal(state.movimientos.length, 0, 'nunca se acredita sin evidencia de cliente');
    assert.equal(state.saldos.size, 0, 'no se inventa ningun cliente');

    // Politica definida: o bien nunca se lista (sin cliente conocido), o se
    // lista y termina en un motivo terminal reconocido (no un perfil actual
    // inventado). Cualquiera de las dos es aceptable segun la forma final de
    // la consulta; lo que NO es aceptable es un bucle permanente.
    if (primerTick.ids_factura.includes(7002)) {
      const row = state.estadoFacturas.get(7002);
      assert.ok(row, 'si se lista, debe quedar una fila de estado con una decision');
      assert.equal(row.estado, 'SKIPPED_TERMINAL', 'termina en una politica definida, no en un bucle reintentable');
      assert.ok(
        ['LEGACY_ELIGIBILITY_UNVERIFIABLE', 'MISSING_REQUIRED_DATA'].includes(row.motivo),
        `motivo terminal reconocido, no perfil actual inventado (recibido: ${row.motivo})`
      );
    } else {
      assert.equal(state.estadoFacturas.has(7002), false, 'si no se lista, tampoco queda ninguna fila huerfana');
    }

    // Segundo tick: nunca debe volver a acreditar ni a crecer indefinidamente.
    const segundoTick = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));
    assert.equal(state.movimientos.length, 0);
    assert.equal(segundoTick.ids_factura.includes(7002) && state.estadoFacturas.get(7002)?.estado !== 'SKIPPED_TERMINAL', false, 'sin bucle permanente');
  });

  it('prueba de control del mock: si el mock volviera a ignorar est.id_cliente, este caso fallaria (candidato solo visible via estado durable)', async () => {
    // Deliberadamente NO usa pendingConSnapshot para dejar explicito que el
    // UNICO id_cliente disponible es el de la fila durable -si
    // computeMissingAccumulationCandidates volviera a usar solo
    // resolveClienteEfectivo(context), este candidato jamas aparaceria.
    const contextoSinCliente = baseContext({ id_cliente: null, id_pedido: null });
    const { client } = createFidelizacionMockClient({
      facturaContexts: { 7003: contextoSinCliente },
      estadoFacturasIniciales: {
        7003: {
          estado: 'PENDING',
          id_cliente: 5,
          id_sucursal: 1,
          nombre_snapshot: 'Solo En Snapshot',
          telefono_snapshot: '9999-2222',
          perfil_completo_snapshot: true,
          fecha_referencia: '2026-03-01T10:00:00Z'
        }
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => reconcileMissingPoints({ limit: 25 }));

    assert.deepEqual(result.ids_factura, [7003], 'el mock debe reproducir COALESCE(est.id_cliente, f.id_cliente, p.id_cliente), no solo el contexto de factura/pedido');
  });
});

describe('Ronda 6, bloqueante 2: RETRYABLE_ERROR conserva la fecha historica del snapshot, nunca la del contexto actual', () => {
  it('caso 1: contexto actual sin fecha, snapshot con fecha valida, error tecnico posterior -> RETRYABLE_ERROR usa la fecha del snapshot', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 8001: baseContext({ fecha_referencia_config: null }) },
      estadoFacturasIniciales: {
        8001: pendingConSnapshot(baseContext(), { fecha_referencia: '2026-03-01T10:00:00Z' })
      },
      failOn: 'UPDATE public.fidelizacion_saldos_cliente'
    });

    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8001 }));

    const row = state.estadoFacturas.get(8001);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.fecha_referencia, '2026-03-01T10:00:00Z');
  });

  it('caso 2: fechas contradictorias (snapshot A, contexto actual B, ambas presentes) -> es un ACCUMULATION_CONTEXT_MISMATCH terminal (no un error tecnico), pero la fecha conservada sigue siendo A, jamas B', async () => {
    // Con cliente/sucursal/pedido iguales entre snapshot y contexto actual,
    // una fecha distinta y presente en ambos lados es una CONTRADICCION real
    // -no un error tecnico-: resolveEffectiveAccumulationContext (rondas 4/5)
    // ya la detecta y la vuelve terminal antes de llegar a ningun punto de
    // fallo tecnico. Esta prueba confirma que, incluso en ese camino
    // terminal, la fecha durable ya confirmada (A) es la que sobrevive -el
    // COALESCE(existente, EXCLUDED) de upsertAccumulationState protege la
    // fecha ya grabada aunque el motivo terminal reciba la fecha B como
    // referenceDate-.
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 8002: baseContext({ fecha_referencia_config: '2026-06-01T00:00:00Z' }) },
      estadoFacturasIniciales: {
        8002: pendingConSnapshot(baseContext(), { fecha_referencia: '2026-01-01T00:00:00Z' })
      }
    });

    const result = await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8002 }));

    assert.equal(result.reason, 'ACCUMULATION_CONTEXT_MISMATCH');
    const row = state.estadoFacturas.get(8002);
    assert.equal(row.estado, 'SKIPPED_TERMINAL');
    assert.equal(row.fecha_referencia, '2026-01-01T00:00:00Z', 'la fecha durable original (A) se conserva; la fecha del contexto actual (B) nunca la reemplaza');
  });

  it('caso 3: contexto actual sin fecha (no contradictoria, simplemente ausente), error tecnico, y la reconciliacion posterior usa la fecha historica preservada al consultar la configuracion vigente', async () => {
    const { client, state } = createFidelizacionMockClient({
      activeConfigs: [
        { lempiras_por_punto: 10, vigente_desde: '2025-01-01T00:00:00Z', vigente_hasta: '2026-02-01T00:00:00Z' },
        { lempiras_por_punto: 999, vigente_desde: '2026-02-01T00:00:00Z', vigente_hasta: null }
      ],
      // Sin fecha en el contexto actual: no hay contradiccion posible con el
      // snapshot (resolveEffectiveAccumulationContext nunca marca mismatch
      // cuando un lado esta ausente), asi que el flujo SI llega al punto de
      // fallo tecnico simulado mas abajo.
      facturaContexts: { 8003: baseContext({ fecha_referencia_config: null }) },
      estadoFacturasIniciales: {
        8003: pendingConSnapshot(baseContext(), { fecha_referencia: '2026-01-15T00:00:00Z' })
      }
    });

    // Falla UNA sola vez (no via `failOn`, que persistiria en el reintento):
    // se necesita que la primera pasada falle tecnicamente y la segunda, ya
    // limpia, procese de verdad -para inspeccionar la fecha que realmente le
    // llega a getActiveFidelizacionConfig en ese reintento-.
    const originalQuery = client.query.bind(client);
    let falloUsado = false;
    client.query = async (sql, params) => {
      if (!falloUsado && String(sql).includes('UPDATE public.fidelizacion_saldos_cliente')) {
        falloUsado = true;
        throw new Error('SIMULATED_SALDO_UPDATE_FAILURE');
      }
      return originalQuery(sql, params);
    };

    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8003 }));
    assert.equal(state.estadoFacturas.get(8003).estado, 'RETRYABLE_ERROR');
    assert.equal(state.estadoFacturas.get(8003).fecha_referencia, '2026-01-15T00:00:00Z');

    const configCallsAntes = state.calls.filter((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal')).length;
    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8003, trigger: 'RECONCILE' }));
    const configCalls = state.calls.filter((c) => c.sql.includes('FROM public.fidelizacion_configuracion_sucursal'));
    assert.ok(configCalls.length > configCallsAntes, 'debe haber consultado la configuracion en el reintento');

    const ultimaConfigCall = configCalls[configCalls.length - 1];
    assert.equal(ultimaConfigCall.params[1], '2026-01-15T00:00:00Z', 'getActiveFidelizacionConfig recibe la fecha historica preservada del snapshot, no la (ausente) del contexto actual');
    assert.equal(state.estadoFacturas.get(8003).estado, 'PROCESSED');
  });

  it('caso 4: snapshot sin fecha, contexto actual con fecha B -> RETRYABLE_ERROR usa la fecha B (fallback)', async () => {
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 8004: baseContext({ fecha_referencia_config: '2026-04-01T00:00:00Z' }) },
      estadoFacturasIniciales: {
        8004: pendingConSnapshot(baseContext(), { fecha_referencia: null })
      },
      failOn: 'UPDATE public.fidelizacion_saldos_cliente'
    });

    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8004 }));

    const row = state.estadoFacturas.get(8004);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.fecha_referencia, '2026-04-01T00:00:00Z', 'sin fecha en el snapshot, se usa la del contexto actual');
  });

  it('caso 5: la fila ya tenia una fecha durable confirmada pero SIN snapshot -> se reconstruye un snapshot con otra fecha, y el COALESCE de upsertAccumulationState igual conserva la fecha original', async () => {
    // Fila legada: tiene fecha_referencia durable confirmada, pero
    // perfil_completo_snapshot es NULL (nunca llego a tener snapshot) -> a
    // efectos de snapshotFromStateRow, esto es "sin snapshot", asi que
    // persistAccumulation reconstruye uno fresco desde el contexto ACTUAL,
    // que trae una fecha DISTINTA. Aun asi, el COALESCE(existente, EXCLUDED)
    // de upsertAccumulationState debe conservar la fecha original -nunca
    // reemplazar una fecha durable ya confirmada, ni con el contexto actual
    // ni con un snapshot recien reconstruido-.
    const { client, state } = createFidelizacionMockClient({
      facturaContexts: { 8005: baseContext({ fecha_referencia_config: '2026-05-01T00:00:00Z' }) },
      estadoFacturasIniciales: {
        8005: { estado: 'RETRYABLE_ERROR', fecha_referencia: '2026-01-01T00:00:00Z', perfil_completo_snapshot: null }
      },
      failOn: 'UPDATE public.fidelizacion_saldos_cliente'
    });

    await withMockedFidelizacionPoolConnect(async () => client, () => accumulateInvoicePoints({ idFactura: 8005 }));

    const row = state.estadoFacturas.get(8005);
    assert.equal(row.estado, 'RETRYABLE_ERROR');
    assert.equal(row.fecha_referencia, '2026-01-01T00:00:00Z', 'la fecha durable original (confirmada antes) se conserva; ni el contexto actual ni un snapshot recien reconstruido la reemplazan');
  });
});
