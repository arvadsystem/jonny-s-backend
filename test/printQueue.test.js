import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { claimPrintJobs, transitionPrintJob } from '../services/printQueueService.js';
import { authorizeAndSignAgentQzRequest } from '../services/qzAgentSigningService.js';

const agent = { id_agente: '11111111-1111-1111-1111-111111111111', id_sucursal: 9 };
const digestFor = (request) => crypto.createHash('sha512').update(JSON.stringify(request), 'utf8').digest('hex');

const createTransactionalDb = (queryHandler) => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryHandler(sql, params, calls);
    },
    release: () => calls.push({ sql: 'RELEASE' })
  };
  return { db: { connect: async () => client }, calls };
};

test('claim backend fuerza limite uno y no toma otro lease mientras el agente imprime', async () => {
  let params;
  const db = { query: async (_sql, values) => { params = values; return { rows: [{ id_trabajo: 1 }] }; } };
  const jobs = await claimPrintJobs({ agentId: agent.id_agente, limit: 3, leaseSeconds: 90, db });
  assert.equal(jobs.length, 1);
  assert.equal(params[1], 1);
  const migration = fs.readFileSync(
    new URL('../sql/2026-07-16_cola_impresion_agentes_sucursal.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /FOR UPDATE;[\s\S]*IF EXISTS \([\s\S]*id_agente_tomado = p_id_agente[\s\S]*estado IN \('asignado', 'imprimiendo'\)[\s\S]*lease_expires_at > now\(\)[\s\S]*THEN[\s\S]*RETURN;/);
});

test('transaccion actualiza estado y evento con estado anterior y nuevo', async () => {
  const { db, calls } = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 4, estado: 'asignado', intentos: 1, max_intentos: 5, lease_activo: true }] };
    if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [{ id_trabajo: 4, estado: 'imprimiendo' }] };
    return { rows: [] };
  });
  await transitionPrintJob({ agent, jobId: 4, action: 'printing', db });
  assert.equal(calls[0].sql, 'BEGIN');
  const eventCall = calls.find((call) => call.sql.includes('INSERT INTO public.trabajos_impresion_eventos'));
  assert.equal(eventCall.params[4], 'asignado');
  assert.equal(eventCall.params[5], 'imprimiendo');
  assert.ok(calls.some((call) => call.sql === 'COMMIT'));
  assert.ok(!calls.some((call) => call.sql === 'ROLLBACK'));
});

test('transaccion hace rollback si falla el evento', async () => {
  const { db, calls } = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 4, estado: 'asignado', intentos: 1, max_intentos: 5, lease_activo: true }] };
    if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [{ id_trabajo: 4, estado: 'imprimiendo' }] };
    if (sql.includes('INSERT INTO public.trabajos_impresion_eventos')) throw new Error('event insert failed');
    return { rows: [] };
  });
  await assert.rejects(() => transitionPrintJob({ agent, jobId: 4, action: 'printing', db }), /event insert failed/);
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!calls.some((call) => call.sql === 'COMMIT'));
});

const allowedPrintRequest = (timestamp) => ({
  call: 'print',
  params: {
    printer: { name: 'QA Printer' },
    options: { copies: 1, jobName: 'Jonny-8' },
    data: [{ type: 'pixel', format: 'html', flavor: 'plain', data: '<p>ticket</p>', options: { pageWidth: 80 } }]
  },
  timestamp
});

test('firma QZ permite solo find y print vinculados al trabajo', async () => {
  const now = Date.now();
  for (const [estado, request] of [
    ['imprimiendo', { call: 'printers.find', params: { query: null }, timestamp: now }],
    ['confirmacion_pendiente', allowedPrintRequest(now + 1)]
  ]) {
    const { db, calls } = createTransactionalDb(async (sql) => {
      if (sql.includes('FROM public.trabajos_impresion')) return { rows: [{ id_trabajo: 8, id_sucursal: 9, id_agente_tomado: agent.id_agente, estado, payload: {} }] };
      return { rows: [] };
    });
    const result = await authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db, now, signer: async (hash) => `sig:${hash.length}` });
    assert.equal(result.signature, 'sig:128');
    assert.ok(calls.some((call) => call.sql.includes('INSERT INTO public.firmas_qz_agente_solicitudes')));
    assert.ok(calls.some((call) => call.sql === 'COMMIT'));
  }
});

test('firma QZ rechaza llamada arbitraria, vencida y reutilizada', async () => {
  const now = Date.now();
  const dbFor = (insertError = null) => createTransactionalDb(async (sql) => {
    if (sql.includes('FROM public.trabajos_impresion')) return { rows: [{ id_trabajo: 8, id_sucursal: 9, id_agente_tomado: agent.id_agente, estado: 'imprimiendo', payload: {} }] };
    if (insertError && sql.includes('INSERT INTO public.firmas_qz_agente_solicitudes')) throw insertError;
    return { rows: [] };
  }).db;
  await assert.rejects(
    () => {
      const request = { call: 'networking.device', params: {}, timestamp: now };
      return authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: dbFor(), now, signer: async () => 'sig' });
    },
    (error) => error.code === 'QZ_SIGN_CALL_NOT_ALLOWED'
  );
  await assert.rejects(
    () => {
      const request = { call: 'printers.find', params: { query: null }, timestamp: now - 60_000 };
      return authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: dbFor(), now, signer: async () => 'sig' });
    },
    (error) => error.code === 'QZ_SIGN_REQUEST_EXPIRED'
  );
  await assert.rejects(
    () => {
      const request = { call: 'printers.find', params: { query: null }, timestamp: now };
      return authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: '0'.repeat(128), db: dbFor(), now, signer: async () => 'sig' });
    },
    (error) => error.code === 'QZ_SIGN_DIGEST_MISMATCH'
  );
  const replayError = Object.assign(new Error('duplicate'), { code: '23505' });
  await assert.rejects(
    () => {
      const request = { call: 'printers.find', params: { query: null }, timestamp: now };
      return authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: dbFor(replayError), now, signer: async () => 'sig' });
    },
    (error) => error.code === 'QZ_SIGN_REQUEST_REPLAYED'
  );
});
