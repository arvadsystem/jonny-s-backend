import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { buildAccessTokenCookieOptions } from '../authCookieOptions.js';
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS,
  issueAccessToken
} from '../accessTokenPolicy.js';

const TEST_SECRET = 'kitchen-display-session-test-secret-2026';

const issueForRoles = (roles) => issueAccessToken({
  id_usuario: 43,
  nombre_usuario: 'display-user',
  id_sucursal: 1,
  sid: 'session-43',
  rol: roles[0],
  nombre_rol: roles[0],
  roles,
  must_change_password: false
}, {
  roles,
  secret: TEST_SECRET,
  issuedAtSeconds: 1_800_000_000
});

describe('access token lifetime policy', () => {
  it('emite JWT y cookie de 24 horas para P_COCINA normalizado', () => {
    const issued = issueForRoles(['p cocina']);
    const payload = jwt.verify(issued.token, TEST_SECRET);
    const cookie = buildAccessTokenCookieOptions({ maxAgeMs: issued.cookieMaxAgeMs });

    assert.equal(payload.exp - payload.iat, KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(issued.cookieMaxAgeMs, 24 * 60 * 60 * 1000);
    assert.equal(cookie.maxAge, 24 * 60 * 60 * 1000);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.path, '/');
  });

  it('conserva JWT y cookie de 8 horas para usuarios normales', () => {
    const issued = issueForRoles(['CAJERO']);
    const payload = jwt.verify(issued.token, TEST_SECRET);
    const cookie = buildAccessTokenCookieOptions({ maxAgeMs: issued.cookieMaxAgeMs });

    assert.equal(payload.exp - payload.iat, DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
    assert.equal(issued.cookieMaxAgeMs, 8 * 60 * 60 * 1000);
    assert.equal(cookie.maxAge, 8 * 60 * 60 * 1000);
  });

  it('conserva secure, sameSite, domain, path y httpOnly de la cookie actual', () => {
    const previous = {
      NODE_ENV: process.env.NODE_ENV,
      AUTH_COOKIE_SECURE: process.env.AUTH_COOKIE_SECURE,
      AUTH_COOKIE_SAMESITE: process.env.AUTH_COOKIE_SAMESITE,
      AUTH_COOKIE_DOMAIN: process.env.AUTH_COOKIE_DOMAIN
    };

    try {
      process.env.NODE_ENV = 'production';
      process.env.AUTH_COOKIE_SECURE = 'false';
      process.env.AUTH_COOKIE_SAMESITE = 'strict';
      process.env.AUTH_COOKIE_DOMAIN = '.example.test';

      const cookie = buildAccessTokenCookieOptions({ maxAgeMs: 24 * 60 * 60 * 1000 });
      assert.deepEqual(cookie, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        domain: '.example.test',
        path: '/',
        maxAge: 24 * 60 * 60 * 1000
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('conecta la politica de duracion con login y su cookie HTTP-only', async () => {
    const loginSource = await readFile(new URL('../../../routers/login.js', import.meta.url), 'utf8');

    assert.match(loginSource, /issueAccessToken\(payload, \{ roles: authz\.roles \}\)/);
    assert.match(loginSource, /maxAgeMs: accessToken\.cookieMaxAgeMs/);
    assert.match(loginSource, /refreshKitchenDisplaySession, requireSessionTouchMiddleware/);
    assert.doesNotMatch(loginSource, /jwt\.sign\(payload, JWT_SECRET, \{ expiresIn: '8h' \}\)/);
  });
});
