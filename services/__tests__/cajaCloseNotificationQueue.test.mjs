import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enqueueCajaCloseNotification } from '../cajaCloseNotificationQueue.js';
import { processCajaCloseNotification } from '../cajaCloseNotificationService.js';

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

  it('ejecuta la funcion real: connect, consultas, release, PDF, SMTP', async () => {
    const events = [];
    let checkedOut = false;

    await processCajaCloseNotification({
      idCierreCaja: 'test-close',
      payload: { session: { id_usuario_responsable: 1 } },
      dependencies: {
        pool: {
          async connect() {
            assert.equal(checkedOut, false);
            checkedOut = true;
            events.push('connect');
            return {
              release() {
                checkedOut = false;
                events.push('release');
              }
            };
          }
        },
        async fetchActors() {
          events.push('query actors');
          return {};
        },
        async fetchMovements() {
          events.push('query movements');
          return { ingresos: [], egresos: [] };
        },
        async buildPdf() {
          assert.equal(checkedOut, false);
          events.push('build pdf');
          return Buffer.from('pdf');
        },
        buildPdfFilename() {
          return 'cierre.pdf';
        },
        async sendEmail() {
          assert.equal(checkedOut, false);
          events.push('send smtp');
        },
        buildHtml() {
          return '<p>ok</p>';
        },
        to: 'admin@example.com',
        subject: 'Cierre'
      }
    });

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
