import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatePrintAgent, hashPrintAgentToken } from '../services/printAgentAuthService.js';
import { claimPrintJobs, transitionPrintJob, validatePrintPayload } from '../services/printQueueService.js';

test('autentica credencial con hash y rechaza token incorrecto', async () => {
  const token = 'a'.repeat(48);
  const db = { query: async () => ({ rows: [{ id_agente: '11111111-1111-1111-1111-111111111111', id_sucursal: 7, nombre: 'QA', estado: 'activo', token_hash: hashPrintAgentToken(token) }] }) };
  assert.equal((await authenticatePrintAgent({ agentId: '11111111-1111-1111-1111-111111111111', token, db })).id_sucursal, 7);
  assert.equal(await authenticatePrintAgent({ agentId: '11111111-1111-1111-1111-111111111111', token: 'b'.repeat(48), db }), null);
});
test('valida tipo, estructura y limite del payload', () => {
  assert.equal(validatePrintPayload({ schema_version: 1, tipo_documento: 'factura', documento: {} }).ok, true);
  assert.equal(validatePrintPayload({ schema_version: 1, tipo_documento: 'arbitrario', documento: {} }).ok, false);
  assert.equal(validatePrintPayload({ schema_version: 1, tipo_documento: 'factura', documento: { text: 'x'.repeat(300000) } }).ok, false);
});

test('claim usa la funcion transaccional atomica con limite acotado', async () => {
  let captured;
  const db = { query: async (...args) => { captured = args; return { rows: [{ id_trabajo: 1 }] }; } };
  const rows = await claimPrintJobs({ agentId: '11111111-1111-1111-1111-111111111111', limit: 99, leaseSeconds: 1, db });
  assert.equal(rows.length, 1);
  assert.match(captured[0], /reclamar_trabajos_impresion/);
  assert.deepEqual(captured[1].slice(1), [10, 30]);
});

test('transicion restringe agente y sucursal y sanitiza fallo', async () => {
  const calls = [];
  const db = { query: async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { rows: [{ id_trabajo: 4, estado: 'fallido' }] };
    return { rows: [] };
  } };
  await transitionPrintJob({ agent: { id_agente: 'agent', id_sucursal: 9 }, jobId: 4, action: 'fail', errorMessage: 'bad\nsecret', db });
  assert.equal(calls[0][1][1], 9);
  assert.equal(calls[0][1][2], 'agent');
  assert.equal(calls[0][1][7], 'bad secret');
});
