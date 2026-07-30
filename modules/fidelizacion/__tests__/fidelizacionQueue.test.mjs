import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  enqueueInvoiceAccumulation,
  enqueueInvoiceAccumulationBatch,
  waitForFidelizacionQueueIdle,
  getFidelizacionQueueDepthForTests,
  isFidelizacionQueueDrainingForTests,
  isFidelizacionInvoiceInFlightForTests
} from '../infrastructure/fidelizacionQueue.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const originalMaxSize = process.env.FIDELIZACION_QUEUE_MAX_SIZE;

afterEach(() => {
  if (originalMaxSize === undefined) delete process.env.FIDELIZACION_QUEUE_MAX_SIZE;
  else process.env.FIDELIZACION_QUEUE_MAX_SIZE = originalMaxSize;
});

describe('fidelizacionQueue (concurrencia maxima de 1)', () => {
  it('nunca ejecuta dos jobs al mismo tiempo, sin importar cuantos se encolen juntos', async () => {
    let currentlyRunning = 0;
    let maxConcurrentObserved = 0;
    const executionOrder = [];

    const handler = async (job) => {
      currentlyRunning += 1;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, currentlyRunning);
      await wait(10);
      executionOrder.push(job.id);
      currentlyRunning -= 1;
    };

    for (let i = 1; i <= 5; i += 1) {
      enqueueInvoiceAccumulation({ id: i }, handler);
    }

    await waitForFidelizacionQueueIdle();

    assert.equal(maxConcurrentObserved, 1, 'no debe haber mas de un job corriendo a la vez');
    assert.deepEqual(executionOrder, [1, 2, 3, 4, 5], 'debe procesar en orden FIFO');
    assert.equal(getFidelizacionQueueDepthForTests(), 0);
    assert.equal(isFidelizacionQueueDrainingForTests(), false);
  });

  it('un job que falla no detiene el drenado del resto de la cola', async () => {
    const processed = [];
    const handler = async (job) => {
      if (job.id === 2) throw new Error('boom');
      processed.push(job.id);
    };

    enqueueInvoiceAccumulation({ id: 1 }, handler);
    enqueueInvoiceAccumulation({ id: 2 }, handler);
    enqueueInvoiceAccumulation({ id: 3 }, handler);

    await waitForFidelizacionQueueIdle();

    assert.deepEqual(processed, [1, 3]);
  });

  it('encolar nunca bloquea al llamador (no es una promesa que haya que esperar)', () => {
    let ran = false;
    enqueueInvoiceAccumulation({ id: 99 }, async () => {
      await wait(20);
      ran = true;
    });
    // Si enqueueInvoiceAccumulation bloqueara, ran ya seria true aqui.
    assert.equal(ran, false);
  });

  it('deduplica por id_factura: no vuelve a encolar una factura pendiente o en proceso', async () => {
    let executions = 0;
    const handler = async () => {
      executions += 1;
      await wait(15);
      return { created: true };
    };

    const first = enqueueInvoiceAccumulation({ idFactura: 555 }, handler);
    assert.equal(isFidelizacionInvoiceInFlightForTests(555), true);
    const second = enqueueInvoiceAccumulation({ idFactura: 555 }, handler);
    const third = enqueueInvoiceAccumulation({ idFactura: 555 }, handler);

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);

    assert.equal(executions, 1, 'solo debe ejecutarse una vez para la misma factura');
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(secondResult, thirdResult);
    assert.equal(isFidelizacionInvoiceInFlightForTests(555), false, 'debe limpiar la deduplicacion al terminar');
  });

  it('limpia la deduplicacion incluso cuando el job falla', async () => {
    let attempt = 0;
    const handler = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('boom');
      return { created: true };
    };

    const firstOutcome = await enqueueInvoiceAccumulation({ idFactura: 556 }, handler);
    assert.equal(firstOutcome.status, 'failed');
    assert.equal(isFidelizacionInvoiceInFlightForTests(556), false);

    const secondOutcome = await enqueueInvoiceAccumulation({ idFactura: 556 }, handler);
    assert.equal(secondOutcome.status, 'processed');
    assert.equal(attempt, 2, 'una vez limpia la deduplicacion, un reintento si vuelve a ejecutar el handler');
  });

  it('limite maximo configurable: rechaza sin lanzar cuando la cola esta llena, sin afectar al llamador', async () => {
    process.env.FIDELIZACION_QUEUE_MAX_SIZE = '2';
    const handler = async () => {
      await wait(15);
      return { created: true };
    };

    // El primero pasa a "procesando" de inmediato (cola en 0 al momento de encolar).
    const first = enqueueInvoiceAccumulation({ idFactura: 601 }, handler);
    // Estos dos si caben en la cola (tamano maximo 2).
    const second = enqueueInvoiceAccumulation({ idFactura: 602 }, handler);
    const third = enqueueInvoiceAccumulation({ idFactura: 603 }, handler);
    // La cola ya esta llena (2 en espera); este debe ser rechazado.
    const rejected = await enqueueInvoiceAccumulation({ idFactura: 604 }, handler);

    assert.deepEqual(rejected, { status: 'rejected', reason: 'QUEUE_FULL' });

    await Promise.all([first, second, third]);
    await waitForFidelizacionQueueIdle();
  });

  it('enqueueInvoiceAccumulationBatch espera el resultado real de todo el lote', async () => {
    const handler = async (job) => {
      if (job.idFactura === 702) throw new Error('boom');
      return { created: true, idFactura: job.idFactura };
    };

    const outcomes = await enqueueInvoiceAccumulationBatch(
      [{ idFactura: 701 }, { idFactura: 702 }, { idFactura: 703 }],
      handler
    );

    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0].status, 'processed');
    assert.equal(outcomes[1].status, 'failed');
    assert.equal(outcomes[2].status, 'processed');
  });
});
