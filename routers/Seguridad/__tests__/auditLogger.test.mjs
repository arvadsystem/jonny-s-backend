import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareAuditRecord,
  sanitizeAuditPayload,
  normalizeRoleName
} from '../auditLogger.js';

test('prepareAuditRecord construye payload completo sin nulls', () => {
  const record = prepareAuditRecord({
    actorId: 15,
    accion: 'ventas/post/facturar',
    objetivo: {},
    modulo: 'ventas',
    descripcion: '',
    detalle: {},
    datosAntes: null,
    datosDespues: null,
    ip_origen: ''
  });

  assert.equal(record.id_usuario, 15);
  assert.ok(typeof record.accion === 'string' && record.accion.length > 0);
  assert.ok(record.accion.length <= 50);
  assert.ok(typeof record.descripcion === 'string' && record.descripcion.length > 0);
  assert.ok(record.descripcion.length <= 100);
  assert.ok(typeof record.modulo === 'string' && record.modulo.length > 0);
  assert.ok(typeof record.tabla_afectada === 'string' && record.tabla_afectada.length > 0);
  assert.equal(record.id_registro, 0);
  assert.equal(record.ip_origen, '-');
  assert.deepEqual(record.datos_antes, {});
  assert.deepEqual(record.datos_despues, {});
});

test('prepareAuditRecord respeta longitudes accion<=50 y descripcion<=100', () => {
  const hugeAction = 'modulo_super_largo_con_muchos_segmentos_para_forzar_truncamiento_total';
  const hugeDesc = 'x'.repeat(300);

  const record = prepareAuditRecord({
    actorId: 2,
    accion: hugeAction,
    objetivo: { tabla_afectada: 'ventas', id_registro: 88 },
    modulo: 'ventas',
    descripcion: hugeDesc,
    datosAntes: {},
    datosDespues: {},
    ip_origen: '127.0.0.1'
  });

  assert.ok(record.accion.length <= 50);
  assert.ok(record.descripcion.length <= 100);
});

test('sanitizeAuditPayload redacted secretos y tokens', () => {
  const payload = {
    username: 'alex',
    password: '123456',
    nested: {
      access_token: 'abc',
      refreshToken: 'xyz',
      csrf_token: 'csrf',
      note: 'ok'
    }
  };

  const sanitized = sanitizeAuditPayload(payload);
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.nested.access_token, '[REDACTED]');
  assert.equal(sanitized.nested.refreshToken, '[REDACTED]');
  assert.equal(sanitized.nested.csrf_token, '[REDACTED]');
  assert.equal(sanitized.nested.note, 'ok');
});

test('role queda normalizado para metadata sin afectar campos no sensibles', () => {
  assert.equal(normalizeRoleName('Super Admin'), 'super_admin');
  assert.equal(normalizeRoleName('auxiliar de cocina'), 'auxiliar_de_cocina');
});

