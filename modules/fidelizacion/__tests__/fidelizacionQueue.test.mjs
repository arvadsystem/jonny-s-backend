import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enqueueInvoiceAccumulation,
  waitForFidelizacionQueueIdle,
  getFidelizacionQueueDepthForTests,
  isFidelizacionQueueDrainingForTests
} from '../infrastructure/fidelizacionQueue.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
});
