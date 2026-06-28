import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enqueueCajaCloseNotification } from '../cajaCloseNotificationQueue.js';
import {
  processCajaCloseNotification,
  resolveCajaCloseEmailRecipient
} from '../cajaCloseNotificationService.js';

const cajasRouterSource = readFileSync(resolve('routers/cajas.js'), 'utf8');

const waitFor = async (predicate) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 1000) throw new Error('timeout waiting for queue');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const withCajaCloseEmailTo = async (value, fn) => {
  const previous = process.env.CAJA_CLOSE_EMAIL_TO;
  if (value === undefined) {
    delete process.env.CAJA_CLOSE_EMAIL_TO;
  } else {
    process.env.CAJA_CLOSE_EMAIL_TO = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CAJA_CLOSE_EMAIL_TO;
    } else {
      process.env.CAJA_CLOSE_EMAIL_TO = previous;
    }
  }
};

const runCloseNotification = async ({ to = 'fallback@example.com', sendEmail }) => processCajaCloseNotification({
  idCierreCaja: 'test-close-recipient',
  payload: { session: { id_usuario_responsable: 1 } },
  dependencies: {
    pool: {
      async connect() {
        return {
          release() {}
        };
      }
    },
    async buildPdf() {
      return Buffer.from('pdf');
    },
    buildPdfFilename() {
      return 'cierre.pdf';
    },
    sendEmail,
    buildHtml() {
      return '<p>ok</p>';
    },
    to,
    subject: 'Cierre'
  }
});

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

  it('resuelve destinatario de cierre por ambiente o fallback', async () => {
    await withCajaCloseEmailTo('arvadsystem@gmail.com', async () => {
      assert.equal(resolveCajaCloseEmailRecipient('fallback@example.com'), 'arvadsystem@gmail.com');
      const recipients = [];
      await runCloseNotification({
        to: 'fallback@example.com',
        async sendEmail(to) {
          recipients.push(to);
        }
      });
      assert.deepEqual(recipients, ['arvadsystem@gmail.com']);
    });

    await withCajaCloseEmailTo(undefined, async () => {
      assert.equal(resolveCajaCloseEmailRecipient(' fallback@example.com '), 'fallback@example.com');
      const recipients = [];
      await runCloseNotification({
        to: 'fallback@example.com',
        async sendEmail(to) {
          recipients.push(to);
        }
      });
      assert.deepEqual(recipients, ['fallback@example.com']);
    });
  });

  it('rechaza cierre sin destinatario y conserva apertura sin override CAJA_CLOSE_EMAIL_TO', async () => {
    await withCajaCloseEmailTo(undefined, async () => {
      await assert.rejects(
        () => runCloseNotification({
          to: '',
          async sendEmail() {
            throw new Error('sendEmail no debe ejecutarse sin destinatario');
          }
        }),
        /CAJA_CLOSE_EMAIL_TO no está configurado y no existe destinatario fallback\./
      );
    });

    const aperturaStart = cajasRouterSource.indexOf('const sendCajaAperturaEmail');
    const aperturaEnd = cajasRouterSource.indexOf('const fetchCajaCloseEmailActors', aperturaStart);
    const aperturaSource = cajasRouterSource.slice(aperturaStart, aperturaEnd);
    assert.match(cajasRouterSource, /const CAJA_APERTURA_EMAIL_TO = CAJA_ADMIN_EMAIL_TO/);
    assert.match(aperturaSource, /enviarCorreo\(\s*CAJA_APERTURA_EMAIL_TO/);
    assert.doesNotMatch(aperturaSource, /CAJA_CLOSE_EMAIL_TO/);
    assert.doesNotMatch(aperturaSource, /resolveCajaCloseEmailRecipient/);
  });
});
