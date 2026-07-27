import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// server.js abre un puerto HTTP real y arranca el ciclo de readiness contra
// una base de datos real en su ultima seccion, a menos que esta bandera este
// activa. Debe fijarse ANTES de importar el modulo (por eso se usa import()
// dinamico en vez de un import estatico) para que estas pruebas nunca abran
// un puerto ni toquen una base de datos real.
process.env.SERVER_RUNTIME_AUTOSTART_DISABLED = 'true';

const { createServerRuntime } = await import('../server.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildFakeHttpServer = () => ({
  close(callback) { callback(null); }
});

const buildRuntime = (overrides = {}) => createServerRuntime({
  server: buildFakeHttpServer(),
  runtimeConfig: { gracefulShutdownTimeoutMs: 5000 },
  stopReadiness: async () => {},
  stopCajaWorker: async () => {},
  stopSessionCutoffWorker: async () => {},
  detachPrintAgentWs: async () => {},
  waitForFidelizacionQueue: async () => {},
  closeFidelizacionDatabasePool: async () => {},
  closeDatabasePool: async () => {},
  runtimeProcess: { exit: () => {} },
  ...overrides
});

describe('server.js createServerRuntime (shutdown web: HTTP + workers + ambos pools)', () => {
  it('espera la cola de fidelizacion (waitForFidelizacionQueueIdle) antes de cerrar fidelizacionPool', async () => {
    const order = [];
    const runtime = buildRuntime({
      waitForFidelizacionQueue: async () => { order.push('queue_idle'); },
      closeFidelizacionDatabasePool: async () => { order.push('fidelizacion_pool_closed'); }
    });

    await runtime.shutdown('SIGTERM');

    assert.deepEqual(order, ['queue_idle', 'fidelizacion_pool_closed']);
  });

  it('cierra ambos pools (fidelizacion y principal) en un shutdown normal', async () => {
    let fidelizacionClosed = false;
    let mainClosed = false;
    let exitCode = null;

    const runtime = buildRuntime({
      closeFidelizacionDatabasePool: async () => { fidelizacionClosed = true; },
      closeDatabasePool: async () => { mainClosed = true; },
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(fidelizacionClosed, true);
    assert.equal(mainClosed, true);
    assert.equal(exitCode, 0);
  });

  it('el pool dedicado se cierra ANTES que el pool principal (orden del flujo pedido)', async () => {
    const order = [];
    const runtime = buildRuntime({
      closeFidelizacionDatabasePool: async () => { order.push('fidelizacion'); },
      closeDatabasePool: async () => { order.push('principal'); }
    });

    await runtime.shutdown('SIGTERM');

    assert.deepEqual(order, ['fidelizacion', 'principal']);
  });

  it('dos senales de cierre no ejecutan el shutdown dos veces', async () => {
    let stopCount = 0;
    const runtime = buildRuntime({
      stopReadiness: async () => { stopCount += 1; await wait(10); }
    });

    const first = runtime.shutdown('SIGTERM');
    const second = runtime.shutdown('SIGINT');

    await Promise.all([first, second]);
    assert.equal(stopCount, 1, 'stopReadiness solo debe invocarse una vez sin importar cuantas senales lleguen');
  });

  it('un fallo cerrando fidelizacionPool no impide cerrar el pool principal', async () => {
    let mainClosed = false;
    let exitCode = null;

    const runtime = buildRuntime({
      closeFidelizacionDatabasePool: async () => { throw Object.assign(new Error('boom'), { code: 'FIDELIZACION_POOL_BOOM' }); },
      closeDatabasePool: async () => { mainClosed = true; },
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(mainClosed, true, 'el pool principal debe cerrarse aunque fidelizacionPool falle al cerrar');
    assert.equal(exitCode, 0, 'un fallo protegido al cerrar fidelizacionPool no debe convertir un shutdown limpio en fallido');
  });

  it('timeout de graceful shutdown: en el catch tambien se intenta cerrar ambos pools', async () => {
    let fidelizacionClosed = false;
    let mainClosed = false;
    let exitCode = null;

    const runtime = buildRuntime({
      runtimeConfig: { gracefulShutdownTimeoutMs: 30 },
      stopReadiness: () => new Promise(() => {}), // nunca resuelve: fuerza el timeout
      closeFidelizacionDatabasePool: async () => { fidelizacionClosed = true; },
      closeDatabasePool: async () => { mainClosed = true; },
      runtimeProcess: { exit: (code) => { exitCode = code; } }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(fidelizacionClosed, true);
    assert.equal(mainClosed, true);
    assert.equal(exitCode, 1, 'un shutdown incompleto por timeout debe salir con codigo distinto de 0');
  });

  it('no corta una acumulacion en ejecucion: espera waitForFidelizacionQueue antes de continuar', async () => {
    let queueWaited = false;
    let fidelizacionClosedAfterQueue = false;

    const runtime = buildRuntime({
      waitForFidelizacionQueue: async () => {
        await wait(15);
        queueWaited = true;
      },
      closeFidelizacionDatabasePool: async () => {
        fidelizacionClosedAfterQueue = queueWaited;
      }
    });

    await runtime.shutdown('SIGTERM');

    assert.equal(fidelizacionClosedAfterQueue, true, 'no debe cerrar el pool antes de que la cola termine de vaciarse');
  });
});
