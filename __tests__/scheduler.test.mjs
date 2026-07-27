import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// scheduler.js dispara un autostart real (con dependencias reales, incluida
// una conexion real a la base de datos) en su ultima linea, a menos que esta
// bandera este activa. Debe fijarse ANTES de importar el modulo (por eso se
// usa import() dinamico en vez de un import estatico) para que estas pruebas
// nunca toquen una base de datos real.
process.env.SCHEDULER_RUNTIME_AUTOSTART_DISABLED = 'true';

const { createSchedulerRuntime } = await import('../scheduler.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildRuntime = (overrides = {}) => createSchedulerRuntime({
  runtimeConfig: { gracefulShutdownTimeoutMs: 5000 },
  dbReady: async () => {},
  startScheduler: async () => ({ started: true, reason: 'STARTED', interval_ms: 60000 }),
  stopScheduler: async () => ({ stopped: true, reason: 'STOPPED' }),
  startFidelizacionScheduler: async () => ({ started: true, reason: 'STARTED', interval_ms: 15000 }),
  stopFidelizacionScheduler: async () => ({ stopped: true, reason: 'STOPPED' }),
  waitForFidelizacionQueue: async () => {},
  closeDatabasePool: async () => {},
  closeFidelizacionDatabasePool: async () => {},
  runtimeProcess: { exit: () => {} },
  ...overrides
});

describe('scheduler.js createSchedulerRuntime (correo + fidelizacion, independientes)', () => {
  it('start() inicia el scheduler de correo y el de fidelizacion', async () => {
    const calls = [];
    const runtime = buildRuntime({
      startScheduler: async () => { calls.push('email'); return { started: true, reason: 'STARTED', interval_ms: 60000 }; },
      startFidelizacionScheduler: async () => { calls.push('fidelizacion'); return { started: true, reason: 'STARTED', interval_ms: 15000 }; }
    });

    const result = await runtime.start();

    assert.deepEqual(calls, ['email', 'fidelizacion']);
    assert.equal(result.started, true);
    assert.deepEqual(result.fidelizacion, { started: true, reason: 'STARTED', interval_ms: 15000 });
  });

  it('fidelizacion deshabilitada (DISABLED) no impide que el scheduler de correo arranque', async () => {
    const runtime = buildRuntime({
      startFidelizacionScheduler: async () => ({ started: false, reason: 'DISABLED' })
    });

    const result = await runtime.start();

    assert.equal(result.started, true);
    assert.deepEqual(result.fidelizacion, { started: false, reason: 'DISABLED' });
  });

  it('un fallo al iniciar fidelizacion no aborta el arranque del scheduler de correo', async () => {
    const runtime = buildRuntime({
      startFidelizacionScheduler: async () => { throw Object.assign(new Error('boom'), { code: 'BOOM' }); }
    });

    const result = await runtime.start();

    assert.equal(result.started, true);
    assert.equal(result.fidelizacion.started, false);
    assert.equal(result.fidelizacion.reason, 'START_ERROR');
  });

  it('si el scheduler de correo falla al iniciar, start() sigue lanzando (comportamiento critico preexistente)', async () => {
    const runtime = buildRuntime({
      startScheduler: async () => ({ started: false, reason: 'DISABLED' })
    });

    await assert.rejects(runtime.start(), /EMAIL_SCHEDULER_START_FAILED/);
  });

  it('shutdown() detiene ambos schedulers, espera la cola de fidelizacion y cierra ambos pools', async () => {
    const stopped = [];
    let queueWaited = false;
    let mainPoolClosed = false;
    let fidelizacionPoolClosed = false;
    let exitCode = null;

    const runtime = buildRuntime({
      stopScheduler: async () => { stopped.push('email'); return { stopped: true, reason: 'STOPPED' }; },
      stopFidelizacionScheduler: async () => { stopped.push('fidelizacion'); return { stopped: true, reason: 'STOPPED' }; },
      waitForFidelizacionQueue: async () => { queueWaited = true; },
      closeDatabasePool: async () => { mainPoolClosed = true; },
      closeFidelizacionDatabasePool: async () => { fidelizacionPoolClosed = true; },
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.ok(stopped.includes('email'));
    assert.ok(stopped.includes('fidelizacion'));
    assert.equal(queueWaited, true);
    assert.equal(mainPoolClosed, true);
    assert.equal(fidelizacionPoolClosed, true);
    assert.equal(exitCode, 0);
  });

  it('un fallo al detener fidelizacion no impide completar el shutdown (correo y pools se cierran igual)', async () => {
    let mainPoolClosed = false;
    let fidelizacionPoolClosed = false;
    let exitCode = null;

    const runtime = buildRuntime({
      stopFidelizacionScheduler: async () => { throw Object.assign(new Error('boom'), { code: 'BOOM' }); },
      closeDatabasePool: async () => { mainPoolClosed = true; },
      closeFidelizacionDatabasePool: async () => { fidelizacionPoolClosed = true; },
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(mainPoolClosed, true);
    assert.equal(fidelizacionPoolClosed, true);
    assert.equal(exitCode, 0);
  });

  it('si falla el cierre del scheduler de correo, el proceso sale con codigo distinto de 0 (critico)', async () => {
    let exitCode = null;
    const runtime = buildRuntime({
      stopScheduler: async () => ({ stopped: false, reason: 'TIMEOUT' }),
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(exitCode, 1);
  });

  it('evita doble cierre: una segunda llamada a shutdown() reutiliza el mismo cierre en curso', async () => {
    let stopCount = 0;
    const runtime = buildRuntime({
      stopScheduler: async () => { stopCount += 1; await wait(10); return { stopped: true, reason: 'STOPPED' }; }
    });

    const first = runtime.shutdown('SIGTERM');
    const second = runtime.shutdown('SIGINT');

    await Promise.all([first, second]);
    assert.equal(stopCount, 1, 'stopScheduler solo debe invocarse una vez sin importar cuantas senales lleguen');
  });

  it('start() durante un shutdown en curso no arranca nada nuevo', async () => {
    let stopResolve;
    const stopPromise = new Promise((resolve) => { stopResolve = resolve; });
    let startedAfterShutdown = false;

    const runtime = buildRuntime({
      stopScheduler: async () => { await stopPromise; return { stopped: true, reason: 'STOPPED' }; },
      startScheduler: async () => { startedAfterShutdown = true; return { started: true, reason: 'STARTED', interval_ms: 60000 }; }
    });

    const shutdownPromise = runtime.shutdown('SIGTERM');
    const startResult = await runtime.start();

    assert.equal(startResult.started, false);
    assert.equal(startResult.reason, 'SHUTTING_DOWN');
    assert.equal(startedAfterShutdown, false);

    stopResolve();
    await shutdownPromise;
  });
});
