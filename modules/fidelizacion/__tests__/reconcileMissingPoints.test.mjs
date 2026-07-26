import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fidelizacionPool } from '../infrastructure/fidelizacionPool.js';
import { reconcileMissingPoints } from '../workers/reconcileMissingPoints.js';
import { createFidelizacionMockClient } from './fidelizacionMockClient.mjs';

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
    assert.equal(result.next_cursor, 1002);
    assert.equal(state.movimientos.length, 2, 'no debe reportar exito solo por encolar: el lote ya debe estar procesado al responder');
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
});
