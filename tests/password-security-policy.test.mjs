import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluatePasswordExpiration } from '../utils/security/passwordExpiration.js';
import {
  closeAllUserSessions,
  closeOtherUserSessions,
} from '../utils/security/sessionService.js';

test('la antiguedad conserva la recomendacion pero no obliga a cambiar la contrasena', () => {
  const result = evaluatePasswordExpiration({
    roles: ['ADMINISTRADOR'],
    mustChangePassword: false,
    passwordChangedAt: '2025-01-01T00:00:00.000Z',
    now: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(result.ageDays, 365);
  assert.equal(result.mustChangePassword, false);
  assert.equal(Object.hasOwn(result, 'expiredByAge'), false);
});

test('el flag manual sigue forzando el cambio para roles no excluidos', () => {
  const result = evaluatePasswordExpiration({
    roles: ['ADMINISTRADOR'],
    mustChangePassword: true,
  });

  assert.equal(result.manualMustChange, true);
  assert.equal(result.mustChangePassword, true);
});

test('los roles de Cocina conservan su exclusion intencional', () => {
  for (const role of ['COCINA', 'P_COCINA', 'AUXILIAR_COCINA']) {
    const result = evaluatePasswordExpiration({ roles: [role], mustChangePassword: true });
    assert.equal(result.excludedByClienteRole, true, role);
    assert.equal(result.mustChangePassword, false, role);
  }
});

test('el cierre total usa el runner transaccional recibido', async () => {
  const calls = [];
  const queryRunner = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 3 };
    },
  };

  const closed = await closeAllUserSessions(41, 'password_reset', queryRunner);

  assert.equal(closed, 3);
  assert.deepEqual(calls[0].params, [41, 'password_reset']);
  assert.match(calls[0].sql, /WHERE id_usuario = \$1[\s\S]*AND activa = TRUE/);
});

test('el cambio voluntario cierra otras sesiones y conserva la actual', async () => {
  const calls = [];
  const queryRunner = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 2 };
    },
  };

  const closed = await closeOtherUserSessions(41, 'sid-actual', 'password_change', queryRunner);

  assert.equal(closed, 2);
  assert.deepEqual(calls[0].params, [41, 'sid-actual', 'password_change']);
  assert.match(calls[0].sql, /id_sesion <> \$2/);
});

test('la recuperacion publica revierte antes de confirmar cuando falla el correo', () => {
  const source = readFileSync(new URL('../routers/public_cliente.js', import.meta.url), 'utf8');
  const start = source.indexOf('const resetInternalUserPasswordFromPublicForgot');
  const end = source.indexOf("router.post('/api/public/forgot-password'", start);
  const flow = source.slice(start, end);

  const updateIndex = flow.indexOf('UPDATE usuarios');
  const closeIndex = flow.indexOf('closeAllUserSessions');
  const emailIndex = flow.indexOf('await enviarCorreo');
  const commitIndex = flow.indexOf("client.query('COMMIT')");

  assert.ok(updateIndex >= 0 && updateIndex < closeIndex);
  assert.ok(closeIndex < emailIndex);
  assert.ok(emailIndex < commitIndex);
  assert.match(flow, /catch \(emailError\)[\s\S]*throw recoveryError/);
  assert.match(flow, /catch \(error\)[\s\S]*client\.query\('ROLLBACK'\)/);
});

test('el reset administrativo confirma sesiones antes del correo y solo revela la temporal si falla', () => {
  const source = readFileSync(new URL('../routers/usuarios.js', import.meta.url), 'utf8');
  const start = source.indexOf("router.post('/usuarios/v2/reset-password/:id_usuario'");
  const flow = source.slice(start);

  const closeIndex = flow.indexOf('closeAllUserSessions');
  const commitIndex = flow.indexOf("client.query('COMMIT')");
  const emailIndex = flow.indexOf('v2SendTemporaryPasswordEmail');

  assert.ok(closeIndex >= 0 && closeIndex < commitIndex);
  assert.ok(commitIndex < emailIndex);
  assert.match(flow, /if \(!emailNotification\?\.sent\)[\s\S]*responsePayload\.temp_password = temporaryPassword/);
});
