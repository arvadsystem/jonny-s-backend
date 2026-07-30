import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureFidelizacionReconciliationSchedulerForTests,
  fidelizacionReconciliationTick,
  getFidelizacionReconciliationSchedulerState,
  resetFidelizacionReconciliationSchedulerForTests,
  startFidelizacionReconciliationScheduler,
  stopFidelizacionReconciliationScheduler
} from '../fidelizacionReconciliationScheduler.js';

const originalEnv = { ...process.env };

const setSchedulerEnv = () => {
  process.env.PROCESS_ROLE = 'scheduler';
  process.env.FIDELIZACION_RECONCILE_SCHEDULER_ENABLED = 'true';
  process.env.FIDELIZACION_RECONCILE_INTERVAL_MS = '15000';
};

const createTimerHarness = () => {
  const intervals = [];
  const cleared = [];
  return {
    intervals,
    cleared,
    setInterval(callback, ms) {
      const timer = { callback, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    }
  };
};

beforeEach(() => {
  process.env = { ...originalEnv };
  setSchedulerEnv();
  resetFidelizacionReconciliationSchedulerForTests();
});

afterEach(() => {
  resetFidelizacionReconciliationSchedulerForTests();
  process.env = { ...originalEnv };
});

describe('fidelizacion reconciliation scheduler runtime', () => {
  it('inicia, ejecuta el primer tick y crea el intervalo', async () => {
    const timers = createTimerHarness();
    let calls = 0;
    configureFidelizacionReconciliationSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      reconcileMissingPoints: async () => {
        calls += 1;
        return { implemented: true, candidates: 0, ids_factura: [] };
      },
      log: () => {},
      error: () => {}
    });

    const result = await startFidelizacionReconciliationScheduler();

    assert.deepEqual(result, { started: true, reason: 'STARTED', interval_ms: 15000 });
    assert.equal(calls, 1);
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 15000);
    assert.equal(getFidelizacionReconciliationSchedulerState().started, true);
    assert.equal(getFidelizacionReconciliationSchedulerState().successful_ticks, 1);
  });

  it('no arranca dos veces si ya estaba iniciado', async () => {
    const timers = createTimerHarness();
    configureFidelizacionReconciliationSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      reconcileMissingPoints: async () => ({ implemented: true, candidates: 0, ids_factura: [] })
    });

    await startFidelizacionReconciliationScheduler();
    const second = await startFidelizacionReconciliationScheduler();

    assert.equal(second.reason, 'ALREADY_STARTED');
    assert.equal(timers.intervals.length, 1);
  });

  it('devuelve DISABLED cuando el flag esta apagado', async () => {
    process.env.FIDELIZACION_RECONCILE_SCHEDULER_ENABLED = 'false';
    const result = await startFidelizacionReconciliationScheduler();
    assert.deepEqual(result, { started: false, reason: 'DISABLED' });
  });

  it('devuelve INVALID_PROCESS_ROLE fuera del proceso scheduler', async () => {
    process.env.PROCESS_ROLE = 'web';
    const result = await startFidelizacionReconciliationScheduler();
    assert.deepEqual(result, { started: false, reason: 'INVALID_PROCESS_ROLE' });
  });

  it('un tick es idempotente: no corre dos veces en paralelo', async () => {
    const timers = createTimerHarness();
    configureFidelizacionReconciliationSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      reconcileMissingPoints: async () => ({ implemented: true, candidates: 0, ids_factura: [] })
    });
    await startFidelizacionReconciliationScheduler();

    let running = 0;
    let maxConcurrent = 0;
    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return { implemented: true, candidates: 0, ids_factura: [] };
      }
    });

    const first = fidelizacionReconciliationTick();
    const second = await fidelizacionReconciliationTick();

    assert.deepEqual(second, { skipped: true, reason: 'ALREADY_RUNNING' });
    await first;
    assert.equal(maxConcurrent, 1);
  });

  it('un tick fallido se refleja en el estado sin detener al scheduler', async () => {
    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => { throw Object.assign(new Error('boom'), { code: 'RECONCILE_BOOM' }); },
      error: () => {}
    });

    await startFidelizacionReconciliationScheduler();
    const state = getFidelizacionReconciliationSchedulerState();
    assert.equal(state.failed_ticks, 1);
    assert.equal(state.last_error_code, 'RECONCILE_BOOM');
  });

  it('lote completamente exitoso: avanza el cursor a next_cursor', async () => {
    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => ({
        implemented: true, scanned: 2, queued: 2, processed: 2, skipped: 0,
        failed: 0, rejected: 0, next_cursor: 42, retry_cursor: null,
        success: true, partial: false, reached_end: false, ids_factura: [40, 42]
      })
    });

    await startFidelizacionReconciliationScheduler();

    assert.equal(getFidelizacionReconciliationSchedulerState().cursor, 42);
    assert.equal(getFidelizacionReconciliationSchedulerState().successful_ticks, 1);
    assert.equal(getFidelizacionReconciliationSchedulerState().failed_ticks, 0);
  });

  it('lote parcial (failed/rejected > 0): incrementa failed_ticks, NO successful_ticks, y usa retry_cursor', async () => {
    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => ({
        implemented: true, scanned: 3, queued: 3, processed: 1, skipped: 0,
        failed: 1, rejected: 0, next_cursor: 103, retry_cursor: 100,
        success: false, partial: true, reached_end: false, ids_factura: [101, 102, 103]
      })
    });

    await startFidelizacionReconciliationScheduler();
    const state = getFidelizacionReconciliationSchedulerState();

    assert.equal(state.successful_ticks, 0, 'un lote parcial no debe contar como tick exitoso');
    assert.equal(state.failed_ticks, 1, 'un lote parcial debe contar como tick fallido');
    assert.equal(state.cursor, 100, 'debe usar retry_cursor, no next_cursor, para no saltarse la fallida');
    assert.equal(state.last_error_code, 'FIDELIZACION_RECONCILE_PARTIAL_BATCH');
  });

  it('reached_end: reinicia el cursor a 0 para el siguiente ciclo', async () => {
    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => ({
        implemented: true, scanned: 0, queued: 0, processed: 0, skipped: 0,
        failed: 0, rejected: 0, next_cursor: 500, retry_cursor: null,
        success: true, partial: false, reached_end: true, ids_factura: []
      })
    });

    await startFidelizacionReconciliationScheduler();

    assert.equal(getFidelizacionReconciliationSchedulerState().cursor, 0);
    assert.equal(getFidelizacionReconciliationSchedulerState().successful_ticks, 1);
  });

  it('el scheduler sigue funcionando despues de un tick parcial: el siguiente tick corre normalmente', async () => {
    const timers = createTimerHarness();
    let call = 0;
    configureFidelizacionReconciliationSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      reconcileMissingPoints: async () => {
        call += 1;
        if (call === 1) {
          return {
            implemented: true, scanned: 1, queued: 1, processed: 0, skipped: 0,
            failed: 1, rejected: 0, next_cursor: 10, retry_cursor: 9,
            success: false, partial: true, reached_end: false, ids_factura: [10]
          };
        }
        return {
          implemented: true, scanned: 1, queued: 1, processed: 1, skipped: 0,
          failed: 0, rejected: 0, next_cursor: 10, retry_cursor: null,
          success: true, partial: false, reached_end: false, ids_factura: [10]
        };
      }
    });

    await startFidelizacionReconciliationScheduler();
    assert.equal(getFidelizacionReconciliationSchedulerState().failed_ticks, 1);
    assert.equal(getFidelizacionReconciliationSchedulerState().started, true, 'el scheduler debe seguir activo tras un tick parcial');

    await fidelizacionReconciliationTick();
    const state = getFidelizacionReconciliationSchedulerState();
    assert.equal(state.successful_ticks, 1);
    assert.equal(state.failed_ticks, 1);
    assert.equal(state.cursor, 10);
  });

  it('detiene el scheduler, limpia el intervalo y espera el tick en curso', async () => {
    const timers = createTimerHarness();
    let tickStarted = false;
    let tickFinished = false;
    configureFidelizacionReconciliationSchedulerForTests({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      reconcileMissingPoints: async () => ({ implemented: true, candidates: 0, ids_factura: [] })
    });

    await startFidelizacionReconciliationScheduler();

    configureFidelizacionReconciliationSchedulerForTests({
      reconcileMissingPoints: async () => {
        tickStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 15));
        tickFinished = true;
        return { implemented: true, candidates: 0, ids_factura: [] };
      }
    });

    const tickPromise = fidelizacionReconciliationTick();
    const stopResult = await stopFidelizacionReconciliationScheduler();

    await tickPromise;
    assert.equal(tickStarted, true);
    assert.equal(tickFinished, true);
    assert.deepEqual(stopResult, { stopped: true, reason: 'STOPPED' });
    assert.equal(timers.cleared.length, 1);
    assert.equal(getFidelizacionReconciliationSchedulerState().started, false);
  });
});
