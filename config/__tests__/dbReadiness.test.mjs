import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  configureDatabaseReadinessForTests,
  getDatabaseReadinessState,
  isDatabaseReady,
  resetDatabaseReadinessForTests,
  resolveDatabaseReadinessBackoffMs,
  startDatabaseReadinessLoop,
  stopDatabaseReadinessLoop
} from '../dbReadiness.js';

// Temporizador controlable manualmente: setTimeoutImpl no dispara nada por si solo, solo
// registra el callback; fire(id) lo ejecuta y clearTimeoutImpl(id) lo cancela (como el
// setTimeout/clearTimeout nativos), para probar de forma determinista el backoff y el
// cancelado en shutdown sin esperar tiempo real (hasta 30s).
const createControllableTimeout = () => {
  let nextId = 1;
  const callbacks = new Map();
  const delays = [];
  const cleared = [];
  const setTimeoutImpl = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, fn);
    delays.push(ms);
    return id;
  };
  const clearTimeoutImpl = (id) => {
    cleared.push(id);
    callbacks.delete(id);
  };
  const fire = (id) => {
    const fn = callbacks.get(id);
    callbacks.delete(id);
    if (fn) fn();
  };
  const fireLast = () => fire(nextId - 1);
  return { setTimeoutImpl, clearTimeoutImpl, fire, fireLast, delays, cleared, lastId: () => nextId - 1 };
};

const flushMicrotasks = async (times = 10) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetDatabaseReadinessForTests();
});

afterEach(() => {
  resetDatabaseReadinessForTests();
});

describe('resolveDatabaseReadinessBackoffMs', () => {
  it('sigue 2s,4s,8s,15s,30s (sin jitter) y se estabiliza en el tope', () => {
    const noJitter = () => 0;
    assert.equal(resolveDatabaseReadinessBackoffMs(1, noJitter), 2000);
    assert.equal(resolveDatabaseReadinessBackoffMs(2, noJitter), 4000);
    assert.equal(resolveDatabaseReadinessBackoffMs(3, noJitter), 8000);
    assert.equal(resolveDatabaseReadinessBackoffMs(4, noJitter), 15000);
    assert.equal(resolveDatabaseReadinessBackoffMs(5, noJitter), 30000);
    assert.equal(resolveDatabaseReadinessBackoffMs(9, noJitter), 30000);
  });

  it('aplica jitter (hasta +20%) pero nunca supera el tope absoluto de 30000ms', () => {
    const maxJitter = () => 1;
    assert.ok(resolveDatabaseReadinessBackoffMs(1, maxJitter) > 2000);
    assert.ok(resolveDatabaseReadinessBackoffMs(1, maxJitter) <= 2400);
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      assert.ok(resolveDatabaseReadinessBackoffMs(attempt, maxJitter) <= 30000);
    }
    assert.equal(resolveDatabaseReadinessBackoffMs(5, maxJitter), 30000);
  });
});

describe('startDatabaseReadinessLoop', () => {
  it('nunca lanza ni bloquea aunque checkDatabaseReady() falle repetidamente (el puerto puede abrir igual)', () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    assert.doesNotThrow(() => startDatabaseReadinessLoop({ onReady: () => {} }));
  });

  it('nunca hay mas de un ciclo de reconexion activo (item 7)', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    let rejectCheck;
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: () => {
        checkCalls += 1;
        return new Promise((resolve, reject) => { rejectCheck = reject; });
      },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    startDatabaseReadinessLoop({ onReady: () => {} });
    startDatabaseReadinessLoop({ onReady: () => {} }); // llamada redundante mientras el primer intento sigue en vuelo
    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();

    assert.equal(checkCalls, 1, 'una segunda/tercera llamada mientras hay un intento en vuelo no debe iniciar otro');

    rejectCheck(Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }));
    await flushMicrotasks();
    assert.equal(timers.delays.length, 1, 'tras fallar, solo debe quedar un retry programado');

    startDatabaseReadinessLoop({ onReady: () => {} }); // llamada redundante mientras hay un retry pendiente
    await flushMicrotasks();
    assert.equal(checkCalls, 1, 'una llamada mientras hay un retry pendiente no debe disparar un intento inmediato adicional');
    assert.equal(timers.delays.length, 1, 'ni programar un segundo timer de retry');
  });

  it('aplica backoff 2s -> 4s -> 8s -> 15s -> 30s ante fallos consecutivos', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000]);

    timers.fireLast();
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000, 4000]);

    timers.fireLast();
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000, 4000, 8000]);

    timers.fireLast();
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000, 4000, 8000, 15000]);

    timers.fireLast();
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000, 4000, 8000, 15000, 30000]);

    timers.fireLast();
    await flushMicrotasks();
    assert.deepEqual(timers.delays, [2000, 4000, 8000, 15000, 30000, 30000], 'del 5to fallo en adelante se estabiliza en 30000ms');
  });

  it('cuando PostgreSQL se recupera: readiness pasa a true y onReady se dispara exactamente una vez', async () => {
    const timers = createControllableTimeout();
    let shouldFail = true;
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => {
        if (shouldFail) throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
        return true;
      },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    assert.equal(isDatabaseReady(), false);
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    assert.equal(isDatabaseReady(), false);

    shouldFail = false;
    timers.fireLast(); // el proximo intento programado ahora si conecta
    await flushMicrotasks();

    assert.equal(isDatabaseReady(), true);
    assert.equal(onReadyCalls, 1);

    // Llamadas posteriores (p.ej. si algo mas invoca startDatabaseReadinessLoop de nuevo)
    // nunca deben re-disparar onReady ni reprogramar otro ciclo (workers arrancan una sola vez).
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    assert.equal(onReadyCalls, 1, 'onReady nunca se dispara mas de una vez');
    assert.equal(timers.delays.length, 1, 'no debe programarse ningun retry adicional tras estar listo');
  });

  it('getDatabaseReadinessState() refleja intentos y estado en vuelo/pendiente', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    const state = getDatabaseReadinessState();
    assert.equal(state.ready, false);
    assert.equal(state.attempt, 1);
    assert.equal(state.retrying, true);
  });
});

describe('stopDatabaseReadinessLoop', () => {
  it('cancela el retry pendiente (item 9)', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    const pendingId = timers.lastId();

    stopDatabaseReadinessLoop();

    assert.deepEqual(timers.cleared, [pendingId], 'debe cancelar exactamente el retry pendiente');
  });

  it('un retry ya cancelado que de todas formas vence no debe disparar otro intento', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => {
        checkCalls += 1;
        throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
      },
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(checkCalls, 1);

    stopDatabaseReadinessLoop();
    timers.fireLast(); // simula que el timer, ya cancelado, vence de todas formas
    await flushMicrotasks();

    assert.equal(checkCalls, 1, 'un timer cancelado no debe generar un intento adicional');
  });

  it('start() despues de stop() reanuda el ciclo normalmente', async () => {
    const timers = createControllableTimeout();
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests({
      setTimeout: timers.setTimeoutImpl,
      clearTimeout: timers.clearTimeoutImpl,
      checkDatabaseReady: async () => true,
      randomImpl: () => 0,
      log: () => {},
      warn: () => {},
      error: () => {}
    });

    stopDatabaseReadinessLoop(); // nada que cancelar todavia, no debe romper nada
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();

    assert.equal(isDatabaseReady(), true);
    assert.equal(onReadyCalls, 1);
  });
});
