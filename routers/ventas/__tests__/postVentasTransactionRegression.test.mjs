import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  createVentasPerfTracker,
  instrumentVentasSqlClient
} from '../utils/perfUtils.js';

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

const simulatePostVentasTransaction = async ({ failBeforeCommit = false } = {}) => {
  const calls = [];
  const client = {
    async query(sql) {
      const command = String(sql).trim();
      calls.push(command);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failBeforeCommit && command === 'SAVE_SUCCESS') {
        throw new Error('idempotency success failed');
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
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
      transactionStarted = false;
    }
    if (!transactionCommitted) {
      await client.query('SAVE_FAILURE');
    }
  }

  return { calls, summary: perf.summary() };
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

  it('guarda SUCCESS idempotente antes de cada COMMIT exitoso de POST /ventas', async () => {
    const handler = await getPostVentasHandlerSource();
    const commitMatches = [...handler.matchAll(/await client\.query\('COMMIT'\);/g)];
    assert.equal(commitMatches.length, 3);
    for (const match of commitMatches) {
      const beforeCommit = handler.slice(Math.max(0, match.index - 900), match.index);
      const afterCommit = handler.slice(match.index, match.index + 450);
      assert.match(beforeCommit, /await saveVentasIdempotencySuccess\(/);
      assert.doesNotMatch(afterCommit, /await saveVentasIdempotencySuccess\(/);
    }
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
});
