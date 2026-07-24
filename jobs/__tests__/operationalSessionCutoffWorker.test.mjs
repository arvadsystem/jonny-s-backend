import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureOperationalSessionCutoffWorkerForTests,
  getOperationalSessionCutoffWorkerState,
  resetOperationalSessionCutoffWorkerForTests,
  resolveLatestHondurasCutoff,
  resolveNextHondurasCutoff,
  startOperationalSessionCutoffWorker,
  stopOperationalSessionCutoffWorker
} from '../operationalSessionCutoffWorker.js';

const serverSource = readFileSync(resolve('server.js'), 'utf8');

const createTimerHarness = () => {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      cleared.push(timer);
    }
  };
};

beforeEach(() => {
  resetOperationalSessionCutoffWorkerForTests();
});

afterEach(() => {
  resetOperationalSessionCutoffWorkerForTests();
});

describe('calendario de corte operativo Honduras', () => {
  it('a las 23:58 programa el corte del mismo dia sin ejecutarlo anticipadamente', () => {
    const now = new Date('2026-06-29T05:58:00.000Z');

    assert.equal(resolveLatestHondurasCutoff(now), '2026-06-27 23:59:00');
    const next = resolveNextHondurasCutoff(now);
    assert.equal(next.cutoffLocal, '2026-06-28 23:59:00');
    assert.equal(next.cutoffAt.toISOString(), '2026-06-29T05:59:00.000Z');
    assert.equal(next.delayMs, 60000);
  });

  it('a las 23:59 reconoce el corte actual y agenda el siguiente dia', () => {
    const now = new Date('2026-06-29T05:59:00.000Z');

    assert.equal(resolveLatestHondurasCutoff(now), '2026-06-28 23:59:00');
    assert.equal(resolveNextHondurasCutoff(now).cutoffLocal, '2026-06-29 23:59:00');
  });

  it('despues de medianoche recupera solo el cutoff anterior', () => {
    const now = new Date('2026-06-29T06:10:00.000Z');

    assert.equal(resolveLatestHondurasCutoff(now), '2026-06-28 23:59:00');
    assert.equal(resolveNextHondurasCutoff(now).cutoffLocal, '2026-06-29 23:59:00');
  });
});

describe('worker de corte operativo', () => {
  it('ejecuta recuperacion al arrancar y registra un solo timer', async () => {
    const timers = createTimerHarness();
    const cutoffs = [];
    const now = new Date('2026-06-29T06:10:00.000Z');
    configureOperationalSessionCutoffWorkerForTests({
      now: () => now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      closeSessions: async ({ cutoffLocal }) => {
        cutoffs.push(cutoffLocal);
        return { executed: true, closedSessions: 4, reason: 'COMPLETED' };
      },
      log: () => {},
      error: () => {}
    });

    const first = await startOperationalSessionCutoffWorker();
    const second = await startOperationalSessionCutoffWorker();

    assert.equal(first.started, true);
    assert.equal(second.reason, 'ALREADY_STARTED');
    assert.deepEqual(cutoffs, ['2026-06-28 23:59:00']);
    assert.equal(timers.timers.length, 1);
    assert.equal(getOperationalSessionCutoffWorkerState().next_cutoff_local, '2026-06-29 23:59:00');

    const stopped = await stopOperationalSessionCutoffWorker();
    assert.equal(stopped.stopped, true);
    assert.equal(timers.cleared.length, 1);
  });

  it('mantiene el worker activo si un tick de recuperacion falla', async () => {
    const timers = createTimerHarness();
    configureOperationalSessionCutoffWorkerForTests({
      now: () => new Date('2026-06-29T06:10:00.000Z'),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      closeSessions: async () => {
        throw Object.assign(new Error('database unavailable'), { code: 'DB_UNAVAILABLE' });
      },
      log: () => {},
      error: () => {}
    });

    const result = await startOperationalSessionCutoffWorker();

    assert.equal(result.started, true);
    assert.equal(getOperationalSessionCutoffWorkerState().last_error_code, 'DB_UNAVAILABLE');
    assert.equal(timers.timers.length, 1);
  });
});

describe('arranque en server.js', () => {
  it('el servidor abre el puerto antes de iniciar el worker de corte operativo, y un fallo al iniciarlo no lo bloquea ni lo tumba', () => {
    const listenIndex = serverSource.indexOf('app.listen(PORT');
    const startIndex = serverSource.indexOf('startOperationalSessionCutoffWorker()');
    assert.ok(listenIndex >= 0, 'debe existir app.listen(PORT');
    assert.ok(startIndex >= 0, 'debe existir una llamada a startOperationalSessionCutoffWorker()');
    assert.ok(
      startIndex > listenIndex,
      'startOperationalSessionCutoffWorker() debe aparecer despues de app.listen(PORT (dentro de su callback), nunca antes'
    );
    assert.doesNotMatch(
      serverSource,
      /await\s+startOperationalSessionCutoffWorker\(\)/,
      'el arranque no debe esperar (await) el primer tick del corte operativo antes de abrir el puerto'
    );
    assert.match(
      serverSource,
      /startOperationalSessionCutoffWorker\(\)\.catch\(/,
      'un fallo al iniciar el worker de corte operativo en segundo plano debe capturarse, nunca tumbar el proceso'
    );
    assert.match(
      serverSource,
      /stopOperationalSessionCutoffWorker\(\{ timeoutMs: 5000 \}\)/,
      'el shutdown limpio debe seguir deteniendo el worker de corte operativo'
    );
  });
});
