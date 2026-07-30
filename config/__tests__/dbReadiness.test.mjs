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
// setTimeout/clearTimeout nativos), para probar de forma determinista el backoff, el chequeo
// periodico y el cancelado en shutdown sin esperar tiempo real (hasta 30s).
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

const HEALTHY_INTERVAL_MS = 5000;

const baseDeps = (timers, overrides = {}) => ({
  setTimeout: timers.setTimeoutImpl,
  clearTimeout: timers.clearTimeoutImpl,
  getHealthyCheckIntervalMs: () => HEALTHY_INTERVAL_MS,
  randomImpl: () => 0,
  log: () => {},
  warn: () => {},
  error: () => {},
  ...overrides
});

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

describe('startDatabaseReadinessLoop: DB caida al iniciar', () => {
  it('nunca lanza ni bloquea aunque checkDatabaseReady() falle repetidamente (el puerto puede abrir igual)', () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); }
    }));

    assert.doesNotThrow(() => startDatabaseReadinessLoop({ onReady: () => {} }));
  });

  it('nunca hay mas de un ciclo de reconexion activo, ni checks superpuestos (item 6)', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    let rejectCheck;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: () => {
        checkCalls += 1;
        return new Promise((resolve, reject) => { rejectCheck = reject; });
      }
    }));

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

  it('aplica backoff 2s -> 4s -> 8s -> 15s -> 30s ante fallos consecutivos (backoff maximo 30s)', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); }
    }));

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
    assert.deepEqual(timers.delays, [2000, 4000, 8000, 15000, 30000, 30000], 'del 5to fallo en adelante se estabiliza en 30000ms, nunca mas');
  });

  it('recuperacion antes de vencer un backoff mayor: readiness pasa a true y onReady se dispara exactamente una vez', async () => {
    const timers = createControllableTimeout();
    let shouldFail = true;
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => {
        if (shouldFail) throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
        return true;
      }
    }));

    assert.equal(isDatabaseReady(), false);
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    assert.equal(isDatabaseReady(), false);
    assert.deepEqual(timers.delays, [2000], 'el siguiente intento esta agendado a 2s, antes de escalar a 4s');

    shouldFail = false;
    timers.fireLast(); // se recupera justo en el intento de 2s, sin llegar a esperar el de 4s
    await flushMicrotasks();

    assert.equal(isDatabaseReady(), true);
    assert.equal(onReadyCalls, 1);
    assert.deepEqual(timers.delays, [2000, HEALTHY_INTERVAL_MS], 'tras el exito, pasa a chequeo periodico, no a otro backoff');

    // Llamadas posteriores (p.ej. si algo mas invoca startDatabaseReadinessLoop de nuevo)
    // nunca deben re-disparar onReady ni reprogramar otro ciclo (workers arrancan una sola vez).
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    assert.equal(onReadyCalls, 1, 'onReady nunca se dispara mas de una vez');
    assert.equal(timers.delays.length, 2, 'no debe programarse ningun timer adicional solo por llamar start() de nuevo estando listo');
  });

  it('getDatabaseReadinessState() refleja intentos y estado en vuelo/pendiente', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    const state = getDatabaseReadinessState();
    assert.equal(state.ready, false);
    assert.equal(state.attempt, 1);
    assert.equal(state.retrying, true);
    assert.equal(state.monitoring, false);
  });
});

describe('monitor continuo: DB caida despues del primer exito', () => {
  it('un chequeo periodico fallido marca readiness=false de inmediato y retoma el backoff desde el primer escalon', async () => {
    const timers = createControllableTimeout();
    let mode = 'ok';
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => {
        if (mode === 'fail') throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
        return true;
      }
    }));

    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    assert.equal(isDatabaseReady(), true);
    assert.deepEqual(timers.delays, [HEALTHY_INTERVAL_MS], 'tras el primer exito, agenda el proximo chequeo periodico');
    assert.equal(getDatabaseReadinessState().monitoring, true);

    mode = 'fail';
    timers.fireLast(); // dispara el chequeo periodico, que ahora falla
    await flushMicrotasks();

    assert.equal(isDatabaseReady(), false, 'un chequeo periodico fallido marca readiness=false de inmediato');
    assert.deepEqual(timers.delays, [HEALTHY_INTERVAL_MS, 2000], 'retoma el backoff desde el primer escalon (2s), no desde donde iba antes de estar listo');
    assert.equal(onReadyCalls, 1, 'onReady no se vuelve a disparar solo porque la DB caiga: los workers no se duplican');
    assert.equal(getDatabaseReadinessState().retrying, true);
  });

  it('readiness pasa true -> false -> true y onReady sigue disparado una sola vez en toda la vida del proceso', async () => {
    const timers = createControllableTimeout();
    let mode = 'ok';
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => {
        if (mode === 'fail') throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
        return true;
      }
    }));

    const readyTransitions = [];
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();
    readyTransitions.push(isDatabaseReady());

    mode = 'fail';
    timers.fireLast();
    await flushMicrotasks();
    readyTransitions.push(isDatabaseReady());

    mode = 'ok';
    timers.fireLast(); // el retry de 2s ahora vuelve a conectar
    await flushMicrotasks();
    readyTransitions.push(isDatabaseReady());

    assert.deepEqual(readyTransitions, [true, false, true]);
    assert.equal(onReadyCalls, 1, 'onReady se dispara una sola vez en toda la vida del proceso, no en cada recuperacion');
  });

  it('la DB sigue funcionando (el monitor sigue con su propia logica) aunque caiga varias veces seguidas', async () => {
    const timers = createControllableTimeout();
    let mode = 'ok';
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => {
        if (mode === 'fail') throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
        return true;
      }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(isDatabaseReady(), true);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      mode = 'fail';
      timers.fireLast();
      await flushMicrotasks();
      assert.equal(isDatabaseReady(), false);

      mode = 'ok';
      timers.fireLast();
      await flushMicrotasks();
      assert.equal(isDatabaseReady(), true);
    }
  });

  it('nunca hay dos chequeos periodicos en vuelo a la vez', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => { checkCalls += 1; return true; }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(checkCalls, 1);

    startDatabaseReadinessLoop({ onReady: () => {} }); // redundante mientras el chequeo periodico esta agendado
    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(checkCalls, 1, 'no debe disparar un chequeo adicional solo por llamar start() de nuevo');
    assert.equal(timers.delays.length, 1, 'sigue habiendo un unico timer agendado');
  });
});

describe('stopDatabaseReadinessLoop', () => {
  it('cancela el timer pendiente (retry o chequeo periodico)', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => { throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' }); }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    const pendingId = timers.lastId();

    await stopDatabaseReadinessLoop();

    assert.deepEqual(timers.cleared, [pendingId], 'debe cancelar exactamente el timer pendiente');
  });

  it('un timer ya cancelado que de todas formas vence no debe disparar otro intento', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => {
        checkCalls += 1;
        throw Object.assign(new Error('db down'), { code: 'ECONNREFUSED' });
      }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(checkCalls, 1);

    await stopDatabaseReadinessLoop();
    timers.fireLast(); // simula que el timer, ya cancelado, vence de todas formas
    await flushMicrotasks();

    assert.equal(checkCalls, 1, 'un timer cancelado no debe generar un intento adicional');
  });

  it('espera (acotado) el chequeo en vuelo antes de resolver, y no reprograma nada al terminar', async () => {
    const timers = createControllableTimeout();
    let checkCalls = 0;
    let resolveCheck;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: () => {
        checkCalls += 1;
        return new Promise((resolve) => { resolveCheck = resolve; });
      }
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();
    assert.equal(checkCalls, 1);
    const delaysBeforeStop = timers.delays.length;

    const stopPromise = stopDatabaseReadinessLoop({ timeoutMs: 1000 });
    let settledEarly = false;
    stopPromise.then(() => { settledEarly = true; });
    await flushMicrotasks();
    assert.equal(settledEarly, false, 'stop() no debe resolver mientras el chequeo original sigue en vuelo');
    // stop() en si agenda su propio timer-guardia acotado (timeoutMs) para no esperar para
    // siempre; eso es esperado. Lo que NO debe pasar es que runCheck() agende un retry o un
    // chequeo periodico nuevo una vez que el resultado (tardio) del check llegue.
    assert.equal(timers.delays.length, delaysBeforeStop + 1, 'stop() agrega unicamente su propio timer-guardia');

    resolveCheck(true); // el chequeo en curso termina (exitoso) despues de pedir el stop
    const result = await stopPromise;

    assert.equal(result.stopped, true);
    assert.equal(isDatabaseReady(), false, 'un resultado que llega despues de stop() no debe mutar el estado');
    assert.equal(timers.delays.length, delaysBeforeStop + 1, 'runCheck() no debe reprogramar nada tras stop(), ni siquiera con un resultado exitoso tardio');
  });

  it('si el chequeo en vuelo no termina dentro de timeoutMs, stop() igual resuelve de forma acotada', async () => {
    const timers = createControllableTimeout();
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: () => new Promise(() => {}) // nunca se resuelve
    }));

    startDatabaseReadinessLoop({ onReady: () => {} });
    await flushMicrotasks();

    const stopPromise = stopDatabaseReadinessLoop({ timeoutMs: 1000 });
    await flushMicrotasks();
    timers.fireLast(); // vence el timeout interno de stop(), no el chequeo colgado
    const result = await stopPromise;

    assert.equal(result.stopped, false);
    assert.equal(result.reason, 'IN_FLIGHT_CHECK_TIMEOUT');
  });

  it('start() despues de stop() reanuda el ciclo normalmente', async () => {
    const timers = createControllableTimeout();
    let onReadyCalls = 0;
    configureDatabaseReadinessForTests(baseDeps(timers, {
      checkDatabaseReady: async () => true
    }));

    await stopDatabaseReadinessLoop(); // nada que cancelar todavia, no debe romper nada
    startDatabaseReadinessLoop({ onReady: () => { onReadyCalls += 1; } });
    await flushMicrotasks();

    assert.equal(isDatabaseReady(), true);
    assert.equal(onReadyCalls, 1);
  });
});
