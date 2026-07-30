import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  createVentasPerfTracker,
  instrumentVentasSqlClient
} from '../utils/perfUtils.js';
import { persistVentaPedidoSnapshotRows } from '../services/ventaPedidoSnapshotPersistenceService.js';

process.env.VENTAS_PERF_LOGS = 'true';

const getPostVentasHandlerSource = async () => {
  const source = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');
  const start = source.indexOf("router.post('/ventas', checkPermission(['VENTAS_CREAR'])");
  assert.notEqual(start, -1, 'No se encontro el handler POST /ventas.');
  const exportStart = source.indexOf('export default router;', start);
  assert.notEqual(exportStart, -1, 'No se encontro el export final de ventas.js.');
  const end = source.lastIndexOf('\n});', exportStart);
  assert.notEqual(end, -1, 'No se encontro el cierre del handler POST /ventas.');
  return source.slice(start, end);
};

const simulatePostVentasTransaction = async ({
  failBeforeCommit = false,
  failCommit = false
} = {}) => {
  const calls = [];
  const responses = [];
  const client = {
    async query(sql) {
      const command = String(sql).trim();
      calls.push(command);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failBeforeCommit && command === 'SAVE_SUCCESS') {
        throw new Error('idempotency success failed');
      }
      if (failCommit && command === 'COMMIT') {
        throw new Error('commit failed');
      }
      return { rows: [] };
    }
  };
  const perf = createVentasPerfTracker();
  instrumentVentasSqlClient(client, perf);

  let transactionStarted = false;
  let transactionCommitted = false;
  const transactionStart = perf.now();

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('INSERT_SALE');
    await client.query('SAVE_SUCCESS');
    await client.query('COMMIT');
    transactionStarted = false;
    transactionCommitted = true;
    perf.add('transaction_ms', transactionStart);
    responses.push('HTTP_SUCCESS');
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
      transactionStarted = false;
    }
    if (!transactionCommitted) {
      await client.query('SAVE_FAILURE');
    }
  }

  return { calls, responses, summary: perf.summary() };
};

const assertAtomicSuccessOrder = (block, label, responseBodyName) => {
  const saveIndex = block.indexOf('await saveVentasIdempotencySuccess({');
  const reserveIndex = block.indexOf('await reservePaidInvoiceAccumulation({');
  const commitIndex = block.indexOf("await client.query('COMMIT');");
  const responseIndex = block.indexOf(`res.status(201).json(${responseBodyName});`);
  const notifyIndex = block.indexOf('void notifyPaidInvoice({');

  assert.notEqual(saveIndex, -1, `${label}: falta guardar idempotencia SUCCESS`);
  assert.match(
    block.slice(saveIndex, reserveIndex),
    /await saveVentasIdempotencySuccess\(\{\s*client,/,
    `${label}: SUCCESS debe usar el mismo client transaccional`
  );
  assert.ok(saveIndex < reserveIndex, `${label}: SUCCESS debe preceder la reserva de fidelizacion`);
  assert.ok(reserveIndex < commitIndex, `${label}: la reserva debe preceder el COMMIT`);
  assert.ok(commitIndex < responseIndex, `${label}: no debe responder exito antes del COMMIT`);
  assert.ok(responseIndex < notifyIndex, `${label}: notifyPaidInvoice debe ser post-COMMIT y posterior a la respuesta`);
};

describe('POST /ventas transaction regression guard', () => {
  it('declara transactionStart e instrumenta SQL antes de iniciar la transaccion', async () => {
    const handler = await getPostVentasHandlerSource();
    assert.ok(handler.includes('const poolWaitStart = ventasPerf.now();'));
    assert.ok(handler.includes("ventasPerf.add('pool_wait_ms', poolWaitStart);"));
    assert.ok(handler.includes('instrumentVentasSqlClient(client, ventasPerf);'));
    assert.ok(handler.includes('let transactionStarted = false;'));
    assert.ok(handler.includes('let transactionCommitted = false;'));
    assert.ok(handler.includes('const transactionStart = ventasPerf.now();'));
    assert.ok(
      handler.indexOf('const transactionStart = ventasPerf.now();') < handler.indexOf("await client.query('BEGIN');"),
      'transactionStart debe estar en alcance antes de BEGIN.'
    );
    assert.ok(
      handler.indexOf('instrumentVentasSqlClient(client, ventasPerf);') < handler.indexOf("await client.query('BEGIN');"),
      'El cliente SQL debe instrumentarse antes de BEGIN.'
    );
  });

  it('V3/V2/V1/legacy mantienen venta, idempotencia SUCCESS y fidelizacion en la misma frontera atomica', async () => {
    const handler = await getPostVentasHandlerSource();
    const v3Start = handler.indexOf('if (ventasRpcV3Enabled) {');
    const v2Start = handler.indexOf('if (ventasRpcV2Enabled && !ventaHasSalsasInventario)', v3Start);
    const v1Start = handler.indexOf('if (ventasRpcV1Enabled && !ventaHasExtras && !ventaHasSalsasInventario)', v2Start);
    const legacyStart = handler.indexOf('const correlativoStart = ventasPerf.now();', v1Start);
    const catchStart = handler.lastIndexOf('  } catch (err) {');

    assert.notEqual(v3Start, -1, 'No se encontro el bloque V3');
    assert.notEqual(v2Start, -1, 'No se encontro el bloque V2');
    assert.notEqual(v1Start, -1, 'No se encontro el bloque V1');
    assert.notEqual(legacyStart, -1, 'No se encontro el bloque legacy');
    assert.notEqual(catchStart, -1, 'No se encontro el catch de POST /ventas');

    assertAtomicSuccessOrder(handler.slice(v3Start, v2Start), 'V3', 'rpcV3ResponseBody');
    assertAtomicSuccessOrder(handler.slice(v2Start, v1Start), 'V2', 'rpcV2ResponseBody');
    assertAtomicSuccessOrder(handler.slice(v1Start, legacyStart), 'V1', 'rpcV1ResponseBody');
    assertAtomicSuccessOrder(handler.slice(legacyStart, catchStart), 'legacy', 'createVentaResponse');
  });

  it('POST /ventas V3 persiste snapshots e idempotencia antes del COMMIT sin inventario Node', async () => {
    const handler = await getPostVentasHandlerSource();
    const v3Start = handler.indexOf('if (ventasRpcV3Enabled) {');
    assert.notEqual(v3Start, -1, 'No se encontro el bloque V3.');
    const v2Start = handler.indexOf('if (ventasRpcV2Enabled && !ventaHasSalsasInventario)', v3Start);
    assert.notEqual(v2Start, -1, 'No se encontro el bloque V2 posterior.');
    const v3Block = handler.slice(v3Start, v2Start);
    assert.match(v3Block, /createVentaWithRpcV3Transaction/);
    assert.match(v3Block, /const idPedidoRpc = parseOptionalPositiveInt\(rpcCreateResult\.response\?\.id_pedido\)/);
    assert.match(v3Block, /VENTAS_RPC_V3_PEDIDO_INVALIDO/);
    assert.match(v3Block, /await persistVentaPedidoSnapshots\(/);
    assert.match(v3Block, /skipExisting:\s*true/);
    assert.ok(
      v3Block.indexOf('await persistVentaPedidoSnapshots(') < v3Block.indexOf("await client.query('COMMIT');"),
      'Los snapshots V3 deben guardarse antes del COMMIT.'
    );
    assert.ok(
      v3Block.indexOf('await persistVentaPedidoSnapshots(') < v3Block.indexOf('await saveVentasIdempotencySuccess({'),
      'Los snapshots V3 deben existir antes de guardar la respuesta idempotente reconciliada.'
    );
    assert.ok(
      v3Block.indexOf('await saveVentasIdempotencySuccess({') < v3Block.indexOf("await client.query('COMMIT');"),
      'La idempotencia V3 debe quedar confirmada atomicamente con la venta.'
    );
    assert.doesNotMatch(v3Block, /validarYDescontarInventarioCajaPedido/);
  });

  it('saveVentasIdempotencySuccess ejecuta el UPDATE mediante el client recibido', async () => {
    const source = await readFile(new URL('../../ventas.js', import.meta.url), 'utf8');
    const start = source.indexOf('const saveVentasIdempotencySuccess = async ({');
    const end = source.indexOf('\n};', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const helper = source.slice(start, end);

    assert.match(helper, /client = pool/);
    assert.match(helper, /await client\.query\(/);
    assert.doesNotMatch(helper, /await pool\.query\(/);
  });

  it('persistencia de snapshots evita duplicados por replay para el mismo pedido', async () => {
    const persistence = await readFile(
      new URL('../services/ventaPedidoSnapshotPersistenceService.js', import.meta.url),
      'utf8'
    );
    assert.equal((persistence.match(/WHERE NOT EXISTS \(/g) || []).length, 2);
    assert.match(persistence, /FROM public\.pedidos_contexto\s+WHERE id_pedido = \$1/);
    assert.match(persistence, /FROM public\.pedidos_contacto\s+WHERE id_pedido = \$1/);
  });

  it('persiste una sola vez modalidad y contacto exactos en replay V3', async () => {
    const stored = { contexto: new Map(), contacto: new Map() };
    const client = {
      query: async (sql, params = []) => {
        if (sql.includes('information_schema.columns')) {
          return { rowCount: 1, rows: [{ is_nullable: 'YES' }] };
        }
        if (sql.includes('INSERT INTO public.pedidos_contexto')) {
          const inserted = !stored.contexto.has(params[0]);
          if (inserted) stored.contexto.set(params[0], [...params]);
          return { rowCount: inserted ? 1 : 0, rows: [] };
        }
        if (sql.includes('INSERT INTO public.pedidos_contacto')) {
          const inserted = !stored.contacto.has(params[0]);
          if (inserted) stored.contacto.set(params[0], [...params]);
          return { rowCount: inserted ? 1 : 0, rows: [] };
        }
        throw new Error(`Consulta inesperada: ${sql}`);
      }
    };
    const venta = {
      id_usuario: 10,
      id_sesion_caja: 77,
      contexto: {
        id_canal_pedido: 4,
        id_modalidad_entrega: 11,
        observacion_contexto: 'Mesa QA'
      },
      contacto: {
        nombre_contacto: 'Cliente QA',
        telefono_contacto: '9999-0000',
        telefono_normalizado: '99990000',
        dni: null,
        rtn: null,
        correo: null
      }
    };

    const contactoSnapshot = venta.contacto;
    await persistVentaPedidoSnapshotRows({
      client,
      pedidoId: 501,
      venta,
      contactoSnapshot,
      skipExisting: true
    });
    await persistVentaPedidoSnapshotRows({
      client,
      pedidoId: 501,
      venta,
      contactoSnapshot,
      skipExisting: true
    });

    assert.equal(stored.contexto.size, 1);
    assert.equal(stored.contacto.size, 1);
    assert.deepEqual(stored.contexto.get(501), [501, 4, 11, 10, 77, 'Mesa QA']);
    assert.deepEqual(stored.contacto.get(501), [501, 'Cliente QA', '9999-0000', '99990000', null, null, null]);
  });

  it('no ejecuta ROLLBACK ni marca FAILED despues de un COMMIT confirmado', async () => {
    const { calls, summary } = await simulatePostVentasTransaction();
    assert.deepEqual(calls, ['BEGIN', 'INSERT_SALE', 'SAVE_SUCCESS', 'COMMIT']);
    assert.equal(calls.filter((call) => call === 'COMMIT').length, 1);
    assert.equal(calls.filter((call) => call === 'ROLLBACK').length, 0);
    assert.equal(calls.filter((call) => call === 'SAVE_FAILURE').length, 0);
    assert.ok(summary.transaction_ms > 0);
    assert.ok(summary.sql_query_count > 0);
    assert.ok(summary.sql_total_ms > 0);
  });

  it('ejecuta ROLLBACK y marca FAILED si falla antes del COMMIT', async () => {
    const { calls, summary } = await simulatePostVentasTransaction({ failBeforeCommit: true });
    assert.deepEqual(calls, ['BEGIN', 'INSERT_SALE', 'SAVE_SUCCESS', 'ROLLBACK', 'SAVE_FAILURE']);
    assert.equal(calls.filter((call) => call === 'COMMIT').length, 0);
    assert.equal(calls.filter((call) => call === 'ROLLBACK').length, 1);
    assert.equal(summary.sql_query_count, calls.length);
    assert.ok(summary.sql_total_ms > 0);
  });

  it('un error de COMMIT revierte, marca FAILED y nunca permite responder exito', async () => {
    const { calls, responses, summary } = await simulatePostVentasTransaction({ failCommit: true });
    assert.deepEqual(calls, ['BEGIN', 'INSERT_SALE', 'SAVE_SUCCESS', 'COMMIT', 'ROLLBACK', 'SAVE_FAILURE']);
    assert.deepEqual(responses, []);
    assert.equal(calls.filter((call) => call === 'ROLLBACK').length, 1);
    assert.ok(summary.sql_total_ms > 0);
  });
});
