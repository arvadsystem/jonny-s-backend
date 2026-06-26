import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enqueueCajaCloseNotification } from '../cajaCloseNotificationQueue.js';

const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timeout waiting for queue');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('cajaCloseNotificationQueue', () => {
  it('ejecuta una tarea y no deja promesas sin manejo', async () => {
    const events = [];
    const result = enqueueCajaCloseNotification({
      idCierreCaja: `test-${Date.now()}-1`,
      task: async () => {
        events.push('task');
      }
    });

    assert.equal(result.enqueued, true);
    await waitFor(() => events.includes('task'));
  });

  it('permite comprobar orden: connect, queries, release, pdf, smtp', async () => {
    const events = [];
    const task = async () => {
      events.push('connect');
      events.push('query actors');
      events.push('query movements');
      events.push('release');
      events.push('build pdf');
      events.push('send smtp');
    };

    enqueueCajaCloseNotification({
      idCierreCaja: `test-${Date.now()}-2`,
      task
    });

    await waitFor(() => events.includes('send smtp'));
    assert.deepEqual(events, [
      'connect',
      'query actors',
      'query movements',
      'release',
      'build pdf',
      'send smtp'
    ]);
  });
});
