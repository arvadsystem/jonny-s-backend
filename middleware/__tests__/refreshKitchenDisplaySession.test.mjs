import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { authRequired } from '../auth.js';
import { createRefreshKitchenDisplaySession } from '../refreshKitchenDisplaySession.js';

const TEST_SECRET = 'kitchen-display-refresh-test-secret-2026';
const NOW_SECONDS = 1_800_000_000;

const createResponse = () => ({
  statusCode: 200,
  body: null,
  cookies: [],
  clearedCookies: [],
  cookie(name, value, options) {
    this.cookies.push({ name, value, options });
    return this;
  },
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
const createSessionContext = (overrides = {}) => ({
  id_usuario: 43,
  nombre_usuario: 'display-user',
  usuario_activo: true,
  id_sucursal: 1,
  id_sesion: 'session-43',
  sesion_activa: true,
  roles: ['p_cocina'],
  ...overrides
});

const runRefresh = async ({
  ageSeconds = 6 * 60 * 60,
  tokenRoles = ['P_COCINA'],
  sessionRows = [createSessionContext()]
} = {}) => {
  const calls = [];
  const sessionPool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: sessionRows };
    }
  };
  const middleware = createRefreshKitchenDisplaySession({
    sessionPool,
    tokenSecret: TEST_SECRET,
    nowSeconds: () => NOW_SECONDS
  });
  const req = {
    user: {
      id_usuario: 43,
      nombre_usuario: 'display-user',
      id_sucursal: 1,
      sid: 'session-43',
      rol: tokenRoles[0],
      nombre_rol: tokenRoles[0],
      roles: tokenRoles,
      must_change_password: false,
      iat: NOW_SECONDS - ageSeconds,
      exp: NOW_SECONDS + 60
    }
  };
  const res = createResponse();
  let nextCalls = 0;

  await middleware(req, res, () => {
    nextCalls += 1;
  });

  return { calls, middleware, nextCalls, req, res };
};

describe('refreshKitchenDisplaySession', () => {
  it('no renueva P_COCINA antes de seis horas', async () => {
    const result = await runRefresh({ ageSeconds: (6 * 60 * 60) - 1 });

    assert.equal(result.nextCalls, 1);
    assert.equal(result.calls.length, 0);
    assert.equal(result.res.cookies.length, 0);
  });

  it('renueva a las seis horas, conserva identidad y no crea otra sesion', async () => {
    const result = await runRefresh();

    assert.equal(result.nextCalls, 1);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.calls[0].params, [43, 'session-43']);
    assert.match(result.calls[0].sql, /INNER JOIN sesiones_activas sa/);
    assert.match(result.calls[0].sql, /INNER JOIN roles_usuarios ru/);
    assert.doesNotMatch(result.calls[0].sql, /INSERT|UPDATE/i);
    assert.equal(result.res.cookies.length, 1);

    const renewedCookie = result.res.cookies[0];
    const payload = jwt.verify(renewedCookie.value, TEST_SECRET);
    assert.equal(renewedCookie.name, 'access_token');
    assert.equal(renewedCookie.options.maxAge, 24 * 60 * 60 * 1000);
    assert.equal(renewedCookie.options.httpOnly, true);
    assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
    assert.equal(payload.sid, 'session-43');
    assert.equal(payload.id_usuario, 43);
    assert.equal(payload.id_sucursal, 1);
    assert.deepEqual(payload.roles, ['p_cocina']);
    assert.equal(result.req.user.sid, 'session-43');
  });

  it('no renueva mas de una vez dentro del nuevo ciclo de seis horas', async () => {
    const result = await runRefresh();
    const req = result.req;
    const res = createResponse();

    await result.middleware(req, res, () => {});

    assert.equal(result.calls.length, 1);
    assert.equal(res.cookies.length, 0);
  });

  it('nunca aplica la renovacion especial a un usuario normal', async () => {
    const result = await runRefresh({ tokenRoles: ['CAJERO'] });

    assert.equal(result.nextCalls, 1);
    assert.equal(result.calls.length, 0);
    assert.equal(result.res.cookies.length, 0);
  });

  it('no renueva si usuario, sesion, rol o pertenencia del sid dejan de ser validos', async () => {
    const invalidContexts = [
      createSessionContext({ usuario_activo: false }),
      createSessionContext({ sesion_activa: false }),
      createSessionContext({ roles: ['COCINA'] }),
      createSessionContext({ id_usuario: 99 }),
      createSessionContext({ id_sesion: 'session-other-user' })
    ];

    for (const invalidContext of invalidContexts) {
      const result = await runRefresh({ sessionRows: [invalidContext] });
      assert.equal(result.nextCalls, 1);
      assert.equal(result.res.cookies.length, 0);
    }
  });

  it('no renueva cuando la consulta no encuentra sesion activa para el usuario', async () => {
    const result = await runRefresh({ sessionRows: [] });

    assert.equal(result.nextCalls, 1);
    assert.equal(result.res.cookies.length, 0);
  });

  it('authRequired rechaza un JWT manipulado antes de llegar a la renovacion', () => {
    const req = { cookies: { access_token: 'header.payload.invalid-signature' } };
    const res = createResponse();
    let nextCalled = false;

    authRequired(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.clearedCookies, ['access_token', 'csrf_token']);
  });
});
