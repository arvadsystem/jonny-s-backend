import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveReversionIdempotencyGate } from '../../routers/ventas/services/ventasReversionIdempotencyGateService.js';

const scope = {
  idFactura: 244,
  idSucursal: 1,
  idSesionCaja: 19
};

const closedSessionError = () => Object.assign(new Error('La sesion original de caja ya fue cerrada.'), {
  httpStatus: 409,
  code: 'VENTAS_REVERSION_SESION_CERRADA'
});

describe('puerta idempotente de reversion antes de validar sesion', () => {
  it('replay SUCCESS conserva HTTP/respuesta/id_reversion aunque la sesion ya este cerrada', async () => {
    const originalResponse = {
      success: true,
      data: { id_reversion: 23, codigo_reversion: 'REV-000023' }
    };
    let sessionValidationCalls = 0;

    const result = await resolveReversionIdempotencyGate({
      client: {},
      idempotency: {
        reserve: async (_client, receivedScope) => {
          assert.deepEqual(receivedScope, scope);
          return { replay: true, httpStatus: 201, responseBody: originalResponse };
        }
      },
      ...scope,
      validateSession: async () => {
        sessionValidationCalls += 1;
        throw closedSessionError();
      }
    });

    assert.equal(result.terminal, true);
    assert.equal(result.sessionContext, null);
    assert.equal(result.reservation.httpStatus, 201);
    assert.equal(result.reservation.responseBody, originalResponse);
    assert.equal(result.reservation.responseBody.data.id_reversion, 23);
    assert.equal(sessionValidationCalls, 0);
  });

  it('key nueva con sesion cerrada conserva el rechazo y no alcanza efectos posteriores', async () => {
    const client = {};
    let sessionValidationCalls = 0;
    await assert.rejects(
      resolveReversionIdempotencyGate({
        client,
        idempotency: {
          reserve: async (receivedClient) => {
            assert.equal(receivedClient, client);
            return { reserved: true, idempotencyKey: 'K2' };
          }
        },
        ...scope,
        validateSession: async () => {
          sessionValidationCalls += 1;
          throw closedSessionError();
        }
      }),
      (error) => error.code === 'VENTAS_REVERSION_SESION_CERRADA'
    );
    assert.equal(sessionValidationCalls, 1);
  });

  it('key nueva valida la sesion y devuelve el contexto para continuar', async () => {
    const sessionContext = { id_sesion_caja: 19, id_caja: 4, id_sucursal: 1 };
    const result = await resolveReversionIdempotencyGate({
      client: {},
      idempotency: { reserve: async () => ({ reserved: true, idempotencyKey: 'K2' }) },
      ...scope,
      validateSession: async (receivedScope) => {
        assert.deepEqual(receivedScope, { client: {}, idSesionCaja: 19, idSucursal: 1 });
        return sessionContext;
      }
    });
    assert.equal(result.terminal, false);
    assert.equal(result.sessionContext, sessionContext);
  });

  for (const [name, conflict] of [
    ['payload distinto', { conflict: true, code: 'IDEMPOTENCY_KEY_REUSED' }],
    ['factura distinta', { conflict: true, code: 'IDEMPOTENCY_SCOPE_MISMATCH' }],
    ['sesion distinta', { conflict: true, code: 'IDEMPOTENCY_SCOPE_MISMATCH' }],
    ['usuario distinto', { conflict: true, code: 'IDEMPOTENCY_SCOPE_MISMATCH' }],
    ['estado IN_PROGRESS', { conflict: true, code: 'REQUEST_ALREADY_IN_PROGRESS' }]
  ]) {
    it(`rechaza ${name} sin validar sesion ni ejecutar una operacion nueva`, async () => {
      let sessionValidationCalls = 0;
      const result = await resolveReversionIdempotencyGate({
        client: {},
        idempotency: { reserve: async () => conflict },
        ...scope,
        validateSession: async () => {
          sessionValidationCalls += 1;
          return {};
        }
      });
      assert.equal(result.terminal, true);
      assert.equal(result.reservation.code, conflict.code);
      assert.equal(sessionValidationCalls, 0);
    });
  }
});
