import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  cajaCloseEmailOutboxTick,
  configureCajaCloseEmailOutboxWorkerForTests,
  getCajaCloseEmailOutboxWorkerState,
  resetCajaCloseEmailOutboxWorkerForTests,
  startCajaCloseEmailOutboxWorker,
  stopCajaCloseEmailOutboxWorker
} from '../cajaCloseEmailOutboxWorker.js';

const originalLogIdle = process.env.CAJA_CLOSE_EMAIL_OUTBOX_LOG_IDLE;

afterEach(async () => {
  await stopCajaCloseEmailOutboxWorker().catch(() => {});
  resetCajaCloseEmailOutboxWorkerForTests();
  if (originalLogIdle === undefined) delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_LOG_IDLE;
  else process.env.CAJA_CLOSE_EMAIL_OUTBOX_LOG_IDLE = originalLogIdle;
});

const runStart = async ({ result, error, logIdle } = {}) => {
  if (logIdle === undefined) delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_LOG_IDLE;
  else process.env.CAJA_CLOSE_EMAIL_OUTBOX_LOG_IDLE = String(logIdle);
  const logs = [];
  const errors = [];
  configureCajaCloseEmailOutboxWorkerForTests({
    processBatch: async () => {
      if (error) throw error;
      return result;
    },
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => new Date('2026-06-30T10:00:00.000Z'),
    log: (message, payload) => logs.push({ message, payload }),
    error: (message, payload) => errors.push({ message, payload })
  });
  await startCajaCloseEmailOutboxWorker();
  await stopCajaCloseEmailOutboxWorker();
  return { logs, errors };
};

describe('caja close email outbox worker logging', () => {
  it('no registra tick vacio cuando idle log esta desactivado', async () => {
    const { logs } = await runStart({ result: { claimed: 0, processed: 0 }, logIdle: false });
    assert.equal(logs.some((entry) => entry.message.includes('tick completed')), false);
  });

  it('registra tick vacio cuando idle log esta activado', async () => {
    const { logs } = await runStart({ result: { claimed: 0, processed: 0 }, logIdle: true });
    const tick = logs.find((entry) => entry.message.includes('tick completed'));
    assert.ok(tick);
    assert.equal(tick.payload.claimed, 0);
    assert.equal(tick.payload.processed, 0);
  });

  it('registra tick cuando reclama correos', async () => {
    const { logs } = await runStart({ result: { claimed: 2, processed: 1 }, logIdle: false });
    const tick = logs.find((entry) => entry.message.includes('tick completed'));
    assert.ok(tick);
    assert.equal(tick.payload.claimed, 2);
    assert.equal(tick.payload.processed, 1);
  });

  it('registra tick con claimed 1 y processed 0', async () => {
    const { logs } = await runStart({ result: { claimed: 1, processed: 0 }, logIdle: false });
    const tick = logs.find((entry) => entry.message.includes('tick completed'));
    assert.ok(tick);
    assert.equal(tick.payload.claimed, 1);
    assert.equal(tick.payload.processed, 0);
  });

  it('registra tick con claimed 1 y processed 1', async () => {
    const { logs } = await runStart({ result: { claimed: 1, processed: 1 }, logIdle: false });
    const tick = logs.find((entry) => entry.message.includes('tick completed'));
    assert.ok(tick);
    assert.equal(tick.payload.claimed, 1);
    assert.equal(tick.payload.processed, 1);
  });

  it('registra errores aunque el tick sea fallido', async () => {
    const error = new Error('smtp down');
    error.code = 'SMTP_DOWN';
    const { errors } = await runStart({ error, logIdle: false });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, '[caja_close_email_outbox_worker] tick failed');
    assert.equal(errors[0].payload.code, 'SMTP_DOWN');
  });

  it('omite tick concurrente mientras otro esta corriendo', async () => {
    let releaseBatch;
    let resolveBatchStarted;
    const batchStarted = new Promise((resolve) => {
      resolveBatchStarted = resolve;
    });
    configureCajaCloseEmailOutboxWorkerForTests({
      processBatch: async () => {
        resolveBatchStarted();
        await new Promise((release) => { releaseBatch = release; });
        return { claimed: 1, processed: 1 };
      },
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => new Date('2026-06-30T10:00:00.000Z'),
      log: () => {}
    });
    const tickPromise = cajaCloseEmailOutboxTick();
    assert.deepEqual(await tickPromise, { skipped: true, reason: 'STOPPING' });
    const startPromise = startCajaCloseEmailOutboxWorker();
    await batchStarted;
    const skipped = await cajaCloseEmailOutboxTick();
    assert.deepEqual(skipped, { skipped: true, reason: 'ALREADY_RUNNING' });
    releaseBatch();
    await startPromise;
    await stopCajaCloseEmailOutboxWorker();
  });

  it('stop espera un tick en ejecucion', async () => {
    let releaseBatch;
    configureCajaCloseEmailOutboxWorkerForTests({
      processBatch: async () => {
        await new Promise((release) => { releaseBatch = release; });
        return { claimed: 1, processed: 1 };
      },
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => new Date('2026-06-30T10:00:00.000Z'),
      log: () => {}
    });
    const startPromise = startCajaCloseEmailOutboxWorker();
    await new Promise((resolve) => setImmediate(resolve));
    const stopPromise = stopCajaCloseEmailOutboxWorker({ timeoutMs: 1000 });
    releaseBatch();
    const [startResult, stopResult] = await Promise.all([startPromise, stopPromise]);
    assert.equal(startResult.started, false);
    assert.equal(stopResult.stopped, true);
    assert.equal(getCajaCloseEmailOutboxWorkerState().running, false);
  });

  it('puede reiniciar despues de detener', async () => {
    configureCajaCloseEmailOutboxWorkerForTests({
      processBatch: async () => ({ claimed: 0, processed: 0 }),
      setInterval: () => 1,
      clearInterval: () => {},
      now: () => new Date('2026-06-30T10:00:00.000Z'),
      log: () => {}
    });
    const firstStart = await startCajaCloseEmailOutboxWorker();
    const firstStop = await stopCajaCloseEmailOutboxWorker();
    const secondStart = await startCajaCloseEmailOutboxWorker();
    assert.equal(firstStart.started, true);
    assert.equal(firstStop.stopped, true);
    assert.equal(secondStart.started, true);
  });
});
