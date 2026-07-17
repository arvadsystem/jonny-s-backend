import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { renderPrintJobHtml } from '../print-agent/src/documentRenderer.js';
import { claimPrintJobs, transitionPrintJob } from '../services/printQueueService.js';
import {
  authorizeAndSignAgentQzRequest,
  canonicalizeAgentQzRequest
} from '../services/qzAgentSigningService.js';

const agent = { id_agente: '11111111-1111-1111-1111-111111111111', id_sucursal: 9 };
const payload = {
  schema_version: 1,
  tipo_documento: 'factura',
  ancho_mm: 80,
  documento: { titulo: 'QA', items: [{ cantidad: 1, descripcion: 'Combo', total: 99 }], total: 99 }
};
const digestFor = (request) => crypto.createHash('sha256').update(canonicalizeAgentQzRequest(request), 'utf8').digest('hex');

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

const allowedPrintRequest = (timestamp, jobId = 8, html = renderPrintJobHtml(payload)) => ({
  call: 'print',
  params: {
    printer: { name: 'QA Printer' },
    options: { copies: 1, jobName: `Jonny-${jobId}` },
    data: [{ type: 'pixel', format: 'html', flavor: 'plain', data: html, options: { pageWidth: 80 } }]
  },
  timestamp
});

const createSigningDb = ({ jobState = 'confirmacion_pendiente', existing = null, priorPrint = false, findCount = 0 } = {}) => (
  createTransactionalDb(async (sql) => {
    if (sql.includes('FROM public.trabajos_impresion')) {
      return { rows: [{ id_trabajo: 8, id_sucursal: 9, id_agente_tomado: agent.id_agente, estado: jobState, payload }] };
    }
    if (sql.includes('SELECT signature')) return { rows: existing ? [{ signature: existing }] : [] };
    if (sql.includes("llamada='print'")) return { rows: priorPrint ? [{ exists: 1 }] : [] };
    if (sql.includes('COUNT(*)::integer')) return { rows: [{ total: findCount }] };
    return { rows: [] };
  })
);

test('claim backend fuerza limite uno y no toma otro lease mientras el agente imprime', async () => {
  let params;
  const db = { query: async (_sql, values) => { params = values; return { rows: [{ id_trabajo: 1 }] }; } };
  const jobs = await claimPrintJobs({ agentId: agent.id_agente, limit: 3, leaseSeconds: 90, db });
  assert.equal(jobs.length, 1);
  assert.equal(params[1], 1);
  const migration = fs.readFileSync(new URL('../sql/2026-07-16_cola_impresion_agentes_sucursal.sql', import.meta.url), 'utf8');
  assert.match(migration, /FOR UPDATE;[\s\S]*IF EXISTS \([\s\S]*id_agente_tomado = p_id_agente[\s\S]*estado IN \('asignado', 'imprimiendo'\)[\s\S]*RETURN;/);
});

test('transicion y evento son atomicos y rollback revierte si falla el evento', async () => {
  const success = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 4, estado: 'asignado', intentos: 1, max_intentos: 5, lease_activo: true }] };
    if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [{ id_trabajo: 4, estado: 'imprimiendo' }] };
    return { rows: [] };
  });
  await transitionPrintJob({ agent, jobId: 4, action: 'printing', db: success.db });
  const eventCall = success.calls.find((call) => call.sql.includes('INSERT INTO public.trabajos_impresion_eventos'));
  assert.equal(eventCall.params[4], 'asignado');
  assert.equal(eventCall.params[5], 'imprimiendo');
  assert.ok(success.calls.some((call) => call.sql === 'COMMIT'));

  const failure = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 4, estado: 'asignado', intentos: 1, max_intentos: 5, lease_activo: true }] };
    if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [{ id_trabajo: 4, estado: 'imprimiendo' }] };
    if (sql.includes('INSERT INTO public.trabajos_impresion_eventos')) throw new Error('event insert failed');
    return { rows: [] };
  });
  await assert.rejects(() => transitionPrintJob({ agent, jobId: 4, action: 'printing', db: failure.db }), /event insert failed/);
  assert.ok(failure.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!failure.calls.some((call) => call.sql === 'COMMIT'));
});

test('fail antes de barrera puede reintentar pero confirmacion_pendiente lo rechaza', async () => {
  const beforeBarrier = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 5, estado: 'imprimiendo', intentos: 1, max_intentos: 5, lease_activo: true }] };
    if (sql.includes('UPDATE public.trabajos_impresion')) return { rows: [{ id_trabajo: 5, estado: 'pendiente' }] };
    return { rows: [] };
  });
  const retried = await transitionPrintJob({ agent, jobId: 5, action: 'fail', errorMessage: 'pre-dispatch', db: beforeBarrier.db });
  assert.equal(retried.estado, 'pendiente');

  const pastBarrier = createTransactionalDb(async (sql) => {
    if (sql.includes('SELECT id_trabajo')) return { rows: [{ id_trabajo: 5, estado: 'confirmacion_pendiente', intentos: 1, max_intentos: 5, lease_activo: false }] };
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  });
  await assert.rejects(
    () => transitionPrintJob({ agent, jobId: 5, action: 'fail', db: pastBarrier.db }),
    (error) => error.code === 'PRINT_JOB_STATE_CONFLICT'
  );
  assert.ok(!pastBarrier.calls.some((call) => call.sql.includes('UPDATE public.trabajos_impresion')));
  assert.ok(pastBarrier.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('QZ acepta digest SHA-256 real y rechaza digest hexadecimal de 128 caracteres', async () => {
  const now = Date.now();
  const request = allowedPrintRequest(now);
  const accepted = createSigningDb();
  const result = await authorizeAndSignAgentQzRequest({
    agent, jobId: 8, request, digest: digestFor(request), db: accepted.db, now,
    signer: async (digest) => `sig:${digest.length}`
  });
  assert.equal(result.signature, 'sig:64');
  assert.equal(result.idempotent, false);
  const insert = accepted.calls.find((call) => call.sql.includes('INSERT INTO public.firmas_qz_agente_solicitudes'));
  assert.equal(insert.params[6], 'QA Printer');

  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({
      agent, jobId: 8, request, digest: 'a'.repeat(128), db: createSigningDb().db, now, signer: async () => 'sig'
    }),
    (error) => error.code === 'QZ_SIGN_DIGEST_INVALID'
  );
});

test('dependencia qz-tray 2.2.6 aplica SHA-256 al objeto canonico antes de firmar', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../print-agent/node_modules/qz-tray/package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../print-agent/node_modules/qz-tray/qz-tray.js', import.meta.url), 'utf8');
  assert.equal(packageJson.version, '2.2.6');
  assert.match(source, /var signObj = \{[\s\S]*call: obj\.call,[\s\S]*params: obj\.params,[\s\S]*timestamp: obj\.timestamp/);
  assert.match(source, /var hashing = _qz\.tools\.hash\(_qz\.tools\.stringify\(signObj\)\)/);
  assert.match(source, /Change the SHA-256 hashing function used by QZ API/);
});

test('firma QZ exige el HTML determinista almacenado en el trabajo', async () => {
  const now = Date.now();
  const request = allowedPrintRequest(now, 8, '<p>documento alterado</p>');
  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: createSigningDb().db, now, signer: async () => 'sig' }),
    (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
  );
});

test('reintento identico devuelve firma almacenada sin volver a firmar', async () => {
  const now = Date.now();
  const request = allowedPrintRequest(now);
  let signerCalls = 0;
  const result = await authorizeAndSignAgentQzRequest({
    agent, jobId: 8, request, digest: digestFor(request), db: createSigningDb({ existing: 'stored-signature' }).db, now,
    signer: async () => { signerCalls += 1; return 'new-signature'; }
  });
  assert.equal(result.signature, 'stored-signature');
  assert.equal(result.idempotent, true);
  assert.equal(signerCalls, 0);
});

test('print diferente para trabajo ya autorizado es rechazado', async () => {
  const now = Date.now();
  const request = allowedPrintRequest(now);
  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: createSigningDb({ priorPrint: true }).db, now, signer: async () => 'sig' }),
    (error) => error.code === 'QZ_SIGN_PRINT_ALREADY_AUTHORIZED'
  );
});

test('printers.find no colisiona globalmente entre agentes en el mismo milisegundo', async () => {
  const now = Date.now();
  const request = { call: 'printers.find', params: { query: null }, timestamp: now };
  const run = async (currentAgent, jobId) => {
    const db = createTransactionalDb(async (sql) => {
      if (sql.includes('FROM public.trabajos_impresion')) return { rows: [{ id_trabajo: jobId, id_sucursal: currentAgent.id_sucursal, id_agente_tomado: currentAgent.id_agente, estado: 'imprimiendo', payload, lease_active: true }] };
      if (sql.includes('SELECT signature')) return { rows: [] };
      if (sql.includes('COUNT(*)::integer')) return { rows: [{ total: 0 }] };
      return { rows: [] };
    }).db;
    return authorizeAndSignAgentQzRequest({ currentAgent, agent: currentAgent, jobId, request, digest: digestFor(request), db, now, signer: async () => `sig-${jobId}` });
  };
  const secondAgent = { id_agente: '22222222-2222-2222-2222-222222222222', id_sucursal: 10 };
  const [one, two] = await Promise.all([run(agent, 8), run(secondAgent, 9)]);
  assert.equal(one.signature, 'sig-8');
  assert.equal(two.signature, 'sig-9');
});

test('firma QZ rechaza solicitud vencida y llamada no permitida', async () => {
  const now = Date.now();
  for (const [request, code] of [
    [{ call: 'printers.find', params: { query: null }, timestamp: now - 60_000 }, 'QZ_SIGN_REQUEST_EXPIRED'],
    [{ call: 'networking.device', params: {}, timestamp: now }, 'QZ_SIGN_CALL_NOT_ALLOWED']
  ]) {
    await assert.rejects(
      () => authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: createSigningDb({ jobState: 'imprimiendo' }).db, now, signer: async () => 'sig' }),
      (error) => error.code === code
    );
  }
});

test('migracion protege Data API, funcion y hash SHA-256 sin ejecutarse', () => {
  const migration = fs.readFileSync(new URL('../sql/2026-07-16_cola_impresion_agentes_sucursal.sql', import.meta.url), 'utf8');
  assert.match(migration, /request_hash CHAR\(64\)/);
  assert.doesNotMatch(migration, /request_hash CHAR\(128\)/);
  for (const table of ['agentes_impresion', 'trabajos_impresion', 'trabajos_impresion_eventos', 'firmas_qz_agente_solicitudes']) {
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon, authenticated, service_role`));
  }
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION public\.reclamar_trabajos_impresion[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /REVOKE ALL ON SEQUENCE public\.trabajos_impresion_id_trabajo_seq/);
});
