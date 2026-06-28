import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequireActiveSession } from '../requireActiveSession.js';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  clearedCookies: [],
  clearCookie(name) {
    this.clearedCookies.push(name);
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const runMiddleware = async ({ sessionRow }) => {
  const calls = [];
  const sessionPool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (calls.length === 1) return { rows: [sessionRow] };
      return { rows: [], rowCount: 1 };
    }
  };
  const middleware = createRequireActiveSession({ sessionPool });
  const req = { user: { id_usuario: 41, sid: 'session-client' } };
  const res = createResponse();
  let nextCalled = false;

  await middleware(req, res, () => {
    nextCalled = true;
  });

  return { calls, res, nextCalled };
};

describe('requireActiveSession inactivity policy', () => {
  it('mantiene acceso Cliente antes de alcanzar los 60 minutos', async () => {
    const result = await runMiddleware({
      sessionRow: { activa: true, expirada_por_inactividad: false }
    });

    assert.equal(result.nextCalled, true);
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].params[2], 20);
    assert.equal(result.calls[0].params[4], 60);
    assert.match(result.calls[0].sql, /THEN \$5\s+ELSE \$3/);
    assert.match(result.calls[0].sql, /END\)::integer/);
  });

  it('invalida y responde 401 al alcanzar el limite de inactividad', async () => {
    const result = await runMiddleware({
      sessionRow: { activa: true, expirada_por_inactividad: true }
    });

    assert.equal(result.nextCalled, false);
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.res.body.message, 'Sesion expirada por inactividad');
    assert.deepEqual(result.res.clearedCookies, ['access_token', 'csrf_token']);
    assert.equal(result.calls.length, 2);
    assert.match(result.calls[1].sql, /motivo_cierre = 'inactividad'/);
  });

  it('conserva las exclusiones operativas y el timeout interno existente', async () => {
    const result = await runMiddleware({
      sessionRow: { activa: true, expirada_por_inactividad: false }
    });

    assert.deepEqual(result.calls[0].params[3], [
      'COCINA',
      'MESERO',
      'AUXILIAR_COCINA',
      'P_COCINA'
    ]);
    assert.equal(result.calls[0].params[2], 20);
  });
});
