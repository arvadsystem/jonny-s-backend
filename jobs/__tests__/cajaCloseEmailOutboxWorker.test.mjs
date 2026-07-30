import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureCajaCloseEmailOutboxWorkerForTests,
  getCajaCloseEmailOutboxWorkerState,
  isCajaCloseEmailOutboxEnabled,
  resetCajaCloseEmailOutboxWorkerForTests,
  resolveCajaCloseEmailOutboxBackoffMs,
  startCajaCloseEmailOutboxWorker,
  stopCajaCloseEmailOutboxWorker
} from '../cajaCloseEmailOutboxWorker.js';

const createTimeoutHarness = () => {
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

const createIntervalHarness = () => {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setInterval(callback, delayMs) {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      cleared.push(timer);
    }
  };
};

const waitUntil = async (predicate, timeoutMs = 1000, intervalMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('WAIT_UNTIL_TIMEOUT');
};

const noopDeps = (timeouts, intervals, overrides = {}) => ({
  setTimeout: timeouts.setTimeout,
  clearTimeout: timeouts.clearTimeout,
  setInterval: intervals.setInterval,
  clearInterval: intervals.clearInterval,
  log: () => {},
  warn: () => {},
  error: () => {},
  ...overrides
});

beforeEach(() => {
  resetCajaCloseEmailOutboxWorkerForTests();
});

afterEach(() => {
  resetCajaCloseEmailOutboxWorkerForTests();
  delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED;
  delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_INTERVAL_MS;
});

describe('CAJA_CLOSE_EMAIL_OUTBOX_ENABLED', () => {
  afterEach(() => {
    delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED;
  });

  it('esta habilitado por defecto cuando la variable esta ausente', () => {
    delete process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED;
    assert.equal(isCajaCloseEmailOutboxEnabled(), true);
  });

  it('solo se deshabilita con el valor "false" (insensible a mayusculas); cualquier otro valor mantiene el comportamiento actual', () => {
    process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED = 'false';
    assert.equal(isCajaCloseEmailOutboxEnabled(), false);
    process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED = 'FALSE';
    assert.equal(isCajaCloseEmailOutboxEnabled(), false);
    process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED = 'true';
    assert.equal(isCajaCloseEmailOutboxEnabled(), true);
    process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED = 'otro-valor';
    assert.equal(isCajaCloseEmailOutboxEnabled(), true);
  });
});

describe('backoff ante fallos consecutivos', () => {
  it('sigue 15s, 30s, 60s, 120s y se estabiliza en el tope de 300s', () => {
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(1), 15000);
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(2), 30000);
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(3), 60000);
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(4), 120000);
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(5), 300000);
    assert.equal(resolveCajaCloseEmailOutboxBackoffMs(9), 300000);
  });
});

describe('worker de outbox de cierre de caja', () => {
  it('no inicia (ni ejecuta ningun claim) cuando CAJA_CLOSE_EMAIL_OUTBOX_ENABLED=false', async () => {
    process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED = 'false';
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    let batchCalls = 0;
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => { batchCalls += 1; return { claimed: 0, processed: 0 }; }
    }));

    const result = await startCajaCloseEmailOutboxWorker();

    assert.equal(result.started, false);
    assert.equal(result.reason, 'DISABLED');
    assert.equal(batchCalls, 0, 'no debe ejecutar ningun claim si esta deshabilitado');
    assert.equal(timeouts.timers.length, 0, 'no debe programar ningun tick');
    assert.equal(intervals.timers.length, 0, 'no debe programar el resumen periodico');
    assert.equal(getCajaCloseEmailOutboxWorkerState().enabled, false);
    assert.equal(getCajaCloseEmailOutboxWorkerState().started, false);
  });

  it('el servidor no depende de este resultado: un fallo del batch nunca hace que start() rechace', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => {
        throw Object.assign(new Error('db unreachable'), { code: 'ECONNREFUSED' });
      }
    }));

    await assert.doesNotReject(startCajaCloseEmailOutboxWorker());
    assert.equal(getCajaCloseEmailOutboxWorkerState().last_error_code, 'ECONNREFUSED');
    assert.equal(getCajaCloseEmailOutboxWorkerState().started, true, 'el worker sigue activo y reprogramado pese al fallo');

    await stopCajaCloseEmailOutboxWorker();
  });

  it('timeout de claim: un error de statement_timeout (57014) se registra como fallo del tick', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => {
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      }
    }));

    await startCajaCloseEmailOutboxWorker();
    const state = getCajaCloseEmailOutboxWorkerState();

    assert.equal(state.last_error_code, '57014');
    assert.equal(state.failed_ticks, 1);
    assert.equal(state.consecutive_failures, 1);

    await stopCajaCloseEmailOutboxWorker();
  });

  it('aplica backoff creciente tras fallos consecutivos y vuelve al intervalo normal tras un exito', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    let shouldFail = true;
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => {
        if (shouldFail) throw Object.assign(new Error('db down'), { code: 'DB_DOWN' });
        return { claimed: 0, processed: 0 };
      }
    }));

    await startCajaCloseEmailOutboxWorker(); // tick 1: falla
    assert.equal(timeouts.timers.length, 1);
    assert.equal(timeouts.timers[0].delayMs, 15000);

    const fireNextAndExpect = async (expectedDelayMs) => {
      const beforeLength = timeouts.timers.length;
      timeouts.timers.at(-1).callback();
      await waitUntil(() => timeouts.timers.length > beforeLength);
      assert.equal(timeouts.timers.at(-1).delayMs, expectedDelayMs);
    };

    await fireNextAndExpect(30000); // tick 2: falla
    await fireNextAndExpect(60000); // tick 3: falla
    await fireNextAndExpect(120000); // tick 4: falla
    await fireNextAndExpect(300000); // tick 5: falla, tope absoluto

    shouldFail = false;
    await fireNextAndExpect(60000); // tick 6: exito -> vuelve al intervalo normal (default 60000ms)

    assert.equal(getCajaCloseEmailOutboxWorkerState().consecutive_failures, 0);

    await stopCajaCloseEmailOutboxWorker();
  });

  it('nunca hay dos ticks superpuestos: el siguiente solo se agenda cuando el anterior termina', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    let concurrent = 0;
    let maxConcurrent = 0;
    let resolveBatch;
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: () => new Promise((resolve) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        resolveBatch = () => { concurrent -= 1; resolve({ claimed: 0, processed: 0 }); };
      })
    }));

    const startPromise = startCajaCloseEmailOutboxWorker();
    await waitUntil(() => concurrent === 1);
    // El primer tick sigue en vuelo (processBatch no ha resuelto): todavia no debe existir
    // ningun timer programado para el siguiente.
    assert.equal(timeouts.timers.length, 0);

    resolveBatch();
    await startPromise;

    assert.equal(timeouts.timers.length, 1, 'el siguiente tick recien se agenda tras terminar el anterior');
    assert.equal(maxConcurrent, 1, 'jamas hubo dos ticks corriendo a la vez');

    await stopCajaCloseEmailOutboxWorker();
  });

  it('correos pendientes siguen procesandose: processed>0 se acumula en total_processed y se registra', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    const logs = [];
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => ({ claimed: 3, processed: 3 }),
      log: (...args) => logs.push(args)
    }));

    await startCajaCloseEmailOutboxWorker();

    assert.equal(getCajaCloseEmailOutboxWorkerState().total_processed, 3);
    assert.ok(logs.some(([message]) => message.includes('correos procesados')));

    await stopCajaCloseEmailOutboxWorker();
  });

  it('no registra ticks vacios (sin correos, sin error, sin lentitud): solo la linea de arranque', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    const logs = [];
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => ({ claimed: 0, processed: 0 }),
      log: (...args) => logs.push(args)
    }));

    await startCajaCloseEmailOutboxWorker();

    assert.equal(logs.length, 1, 'solo la linea "activo" del arranque; ningun tick vacio adicional');
    assert.ok(logs[0][0].includes('activo'));

    await stopCajaCloseEmailOutboxWorker();
  });

  it('registra ticks lentos aunque no hayan procesado correos', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    const warnings = [];
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      slowTickMs: 1,
      processBatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { claimed: 0, processed: 0 };
      },
      warn: (...args) => warnings.push(args)
    }));

    await startCajaCloseEmailOutboxWorker();

    assert.ok(warnings.some(([message]) => message.includes('tick lento')));

    await stopCajaCloseEmailOutboxWorker();
  });

  it('resumen periodico: programa un unico timer independiente del tick', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => ({ claimed: 0, processed: 0 })
    }));

    await startCajaCloseEmailOutboxWorker();

    assert.equal(intervals.timers.length, 1, 'debe programar el timer de resumen periodico al arrancar');

    const logs = [];
    configureCajaCloseEmailOutboxWorkerForTests({ log: (...args) => logs.push(args) });
    intervals.timers[0].callback();
    assert.ok(logs.some(([message]) => message.includes('resumen')));

    await stopCajaCloseEmailOutboxWorker();
  });

  it('shutdown limpio: stop() cancela el timer de reconexion y el resumen periodico; un timer viejo que dispare despues no crea un tick', async () => {
    const timeouts = createTimeoutHarness();
    const intervals = createIntervalHarness();
    configureCajaCloseEmailOutboxWorkerForTests(noopDeps(timeouts, intervals, {
      processBatch: async () => ({ claimed: 0, processed: 0 })
    }));

    await startCajaCloseEmailOutboxWorker();
    assert.equal(timeouts.timers.length, 1);
    assert.equal(intervals.timers.length, 1);

    const stopped = await stopCajaCloseEmailOutboxWorker();

    assert.equal(stopped.stopped, true);
    assert.equal(timeouts.cleared.length, 1);
    assert.equal(intervals.cleared.length, 1);

    timeouts.timers.at(-1).callback();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(getCajaCloseEmailOutboxWorkerState().started, false, 'un timer viejo disparado tras stop() no debe reactivar el worker');
    assert.equal(timeouts.timers.length, 1, 'no debe agendarse un nuevo tick tras stop()');
  });
});
