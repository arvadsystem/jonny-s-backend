import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluatePasswordExpiration } from '../utils/security/passwordExpiration.js';
import {
  closeAllUserSessions,
  closeOtherUserSessions,
} from '../utils/security/sessionService.js';
import {
  runInternalPasswordRecoveryTransaction,
  sendPasswordEmailBestEffort,
} from '../utils/security/passwordRecoveryFlow.js';
import { sendEmailWithLogging } from '../utils/emailService.js';

const silentLogger = { log() {}, warn() {}, error() {} };

const createMockClient = ({ failCommit = false } = {}) => {
  const commands = [];
  return {
    commands,
    async query(sql, params = []) {
      const normalized = String(sql).trim().replace(/\s+/g, ' ');
      commands.push({ sql: normalized, params });
      if (normalized === 'COMMIT' && failCommit) {
        throw new Error('COMMIT_FAILED');
      }
      if (normalized.startsWith('INSERT INTO log_correos_enviados')) {
        return { rows: [{ id_log: 77 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
};

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

test('la notificacion best effort controla fallo al resolver correo', async () => {
  const result = await sendPasswordEmailBestEffort({
    resolveEmail: async () => { throw new Error('EMAIL_QUERY_FAILED'); },
    sendEmail: async () => assert.fail('no debe intentar SMTP'),
  });

  assert.deepEqual(result, {
    sent: false,
    skipped: false,
    reason: 'EMAIL_RESOLUTION_FAILED',
    to: null,
  });
});

test('la notificacion best effort distingue correo ausente, SMTP fallido y envio correcto', async () => {
  const missing = await sendPasswordEmailBestEffort({
    resolveEmail: async () => null,
    sendEmail: async () => assert.fail('no debe intentar SMTP'),
  });
  assert.equal(missing.reason, 'EMAIL_NOT_AVAILABLE');
  assert.equal(missing.skipped, true);

  const smtpFailure = await sendPasswordEmailBestEffort({
    resolveEmail: async () => 'empleado@example.com',
    sendEmail: async () => { throw new Error('SMTP_DOWN'); },
  });
  assert.equal(smtpFailure.reason, 'SMTP_SEND_FAILED');
  assert.equal(smtpFailure.sent, false);

  const success = await sendPasswordEmailBestEffort({
    resolveEmail: async () => 'empleado@example.com',
    sendEmail: async () => {},
  });
  assert.deepEqual(success, {
    sent: true,
    skipped: false,
    to: 'empleado@example.com',
  });
});

test('la recuperacion interna confirma cambio, sesiones y correo en el camino exitoso', async () => {
  const client = createMockClient();
  const runners = [];

  const result = await runInternalPasswordRecoveryTransaction({
    client,
    updatePassword: async (runner) => { runners.push(runner); return true; },
    closeSessions: async (runner) => { runners.push(runner); return 4; },
    sendNotification: async (runner) => { runners.push(runner); },
  });

  assert.equal(result.completed, true);
  assert.equal(result.closedSessions, 4);
  assert.deepEqual(client.commands.map((entry) => entry.sql), ['BEGIN', 'COMMIT']);
  assert.ok(runners.every((runner) => runner === client));
});

test('un fallo SMTP revierte password y sesiones dentro de la transaccion', async () => {
  const client = createMockClient();

  await assert.rejects(
    runInternalPasswordRecoveryTransaction({
      client,
      updatePassword: async () => true,
      closeSessions: async () => 2,
      sendNotification: async () => { throw new Error('SMTP_DOWN'); },
    }),
    /SMTP_DOWN/
  );

  assert.deepEqual(client.commands.map((entry) => entry.sql), ['BEGIN', 'ROLLBACK']);
});

test('un error previo al envio revierte y no intenta SMTP', async () => {
  const client = createMockClient();
  let emailAttempts = 0;

  await assert.rejects(
    runInternalPasswordRecoveryTransaction({
      client,
      updatePassword: async () => { throw new Error('UPDATE_FAILED'); },
      closeSessions: async () => 0,
      sendNotification: async () => { emailAttempts += 1; },
    }),
    /UPDATE_FAILED/
  );

  assert.equal(emailAttempts, 0);
  assert.deepEqual(client.commands.map((entry) => entry.sql), ['BEGIN', 'ROLLBACK']);
});

test('si SMTP acepta y COMMIT falla, se intenta ROLLBACK y no se reporta exito', async () => {
  const client = createMockClient({ failCommit: true });
  let emailAccepted = false;

  await assert.rejects(
    runInternalPasswordRecoveryTransaction({
      client,
      updatePassword: async () => true,
      closeSessions: async () => 1,
      sendNotification: async () => { emailAccepted = true; },
    }),
    /COMMIT_FAILED/
  );

  assert.equal(emailAccepted, true);
  assert.deepEqual(client.commands.map((entry) => entry.sql), ['BEGIN', 'COMMIT', 'ROLLBACK']);
});

test('DB_POOL_MAX=1: correo y log usan el mismo queryRunner reservado', async () => {
  const client = createMockClient();
  const mailTransport = {
    sendMail: async () => ({ messageId: 'mock-message-id' }),
  };

  await runInternalPasswordRecoveryTransaction({
    client,
    updatePassword: async (runner) => {
      assert.equal(runner, client);
      return true;
    },
    closeSessions: async (runner) => {
      assert.equal(runner, client);
      return 2;
    },
    sendNotification: (runner) => sendEmailWithLogging({
      to: 'empleado@example.com',
      subject: 'Temporal',
      html: '<p>Temporal</p>',
      id_usuario: 41,
      tipo_correo: 'credenciales_temporales_reset',
      fromAddress: 'Jonnys <acceso@example.com>',
      queryRunner: runner,
      strictLogWrites: true,
      mailTransport,
      logger: silentLogger,
    }),
  });

  const sql = client.commands.map((entry) => entry.sql);
  assert.deepEqual(sql, [
    'BEGIN',
    "INSERT INTO log_correos_enviados (id_usuario, tipo_correo, email_destino, asunto, estado_envio, intentos) VALUES ($1, $2, $3, $4, 'enviando', 1) RETURNING id_log",
    "UPDATE log_correos_enviados SET estado_envio = 'enviado', enviado_en = NOW() WHERE id_log = $1",
    'COMMIT',
  ]);
});

test('recuperaciones simultaneas no comparten clientes ni estado mutable', async () => {
  const clients = [createMockClient(), createMockClient(), createMockClient(), createMockClient()];
  const users = [41, 41, 52, 63];

  const results = await Promise.all(clients.map((client, index) =>
    runInternalPasswordRecoveryTransaction({
      client,
      updatePassword: async (runner) => {
        assert.equal(runner, client);
        await Promise.resolve();
        return users[index] > 0;
      },
      closeSessions: async (runner) => {
        assert.equal(runner, client);
        return 1;
      },
      sendNotification: async (runner) => assert.equal(runner, client),
    })
  ));

  assert.ok(results.every((result) => result.completed));
  for (const client of clients) {
    assert.deepEqual(client.commands.map((entry) => entry.sql), ['BEGIN', 'COMMIT']);
  }
});

test('la integracion conserva fallback administrativo y respuesta publica antienumeracion', () => {
  const usuariosSource = readFileSync(new URL('../routers/usuarios.js', import.meta.url), 'utf8');
  const resetStart = usuariosSource.indexOf("router.post('/usuarios/v2/reset-password/:id_usuario'");
  const resetFlow = usuariosSource.slice(resetStart);
  assert.match(resetFlow, /if \(!emailNotification\?\.sent\)[\s\S]*responsePayload\.temp_password = temporaryPassword/);
  assert.match(resetFlow, /res\.set\('Cache-Control', 'no-store'\)/);

  const publicSource = readFileSync(new URL('../routers/public_cliente.js', import.meta.url), 'utf8');
  const forgotStart = publicSource.indexOf("router.post('/api/public/forgot-password'");
  const forgotEnd = publicSource.indexOf("router.post('/api/public/reset-password'", forgotStart);
  const forgotFlow = publicSource.slice(forgotStart, forgotEnd);
  const genericResponses = forgotFlow.match(/PUBLIC_FORGOT_PASSWORD_GENERIC_MESSAGE/g) || [];
  assert.ok(genericResponses.length >= 4);
});
