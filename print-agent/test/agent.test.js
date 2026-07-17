import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateQzCaCertificate } from '../src/config.js';
import { createApiClient } from '../src/apiClient.js';
import { createSecureWebSocketType } from '../src/qzClient.js';
import { createRunner } from '../src/runner.js';
import { createPrintStateStore } from '../src/stateStore.js';

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}'
});

const createStoreFixture = async (prefix) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = createPrintStateStore({ filePath: path.join(tempDir, 'state.json') });
  await store.init();
  return { tempDir, store };
};

const job = (id) => ({ id_trabajo: id, id_sucursal: 2, tipo_documento: 'factura', payload: { schema_version: 1 } });

test('reinicio despues de prepared cruza barrera y despacha una sola vez', async () => {
  const fixture = await createStoreFixture('jonnys-prepared-');
  try {
    const currentJob = job(31);
    await fixture.store.markPrepared(currentJob);
    let barriers = 0;
    let dispatches = 0;
    const runner = createRunner({
      config,
      stateStore: fixture.store,
      api: {
        status: async () => ({ job: { estado: 'imprimiendo', assigned_to_agent: true, lease_active: true } }),
        confirmationPending: async () => { barriers += 1; }, complete: async () => {}, claim: async () => ({ jobs: [] }),
        fail: async () => {}
      },
      qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
    });
    await runner.pollOnce();
    assert.equal(barriers, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(fixture.store.list(), []);
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('reinicio despues de cruzar barrera usa prepared pero no repite la transicion', async () => {
  const fixture = await createStoreFixture('jonnys-barrier-');
  try {
    await fixture.store.markPrepared(job(32));
    let barriers = 0;
    let dispatches = 0;
    const runner = createRunner({
      config,
      stateStore: fixture.store,
      api: {
        status: async () => ({ job: { estado: 'confirmacion_pendiente', assigned_to_agent: true, lease_active: false } }),
        confirmationPending: async () => { barriers += 1; }, complete: async () => {}, claim: async () => ({ jobs: [] })
      },
      qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
    });
    await runner.pollOnce();
    assert.equal(barriers, 0);
    assert.equal(dispatches, 1);
    assert.deepEqual(fixture.store.list(), []);
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('dispatch_started queda en cuarentena sin bloquear el siguiente trabajo', async () => {
  const fixture = await createStoreFixture('jonnys-uncertain-');
  try {
    const ambiguous = job(40);
    const next = job(41);
    await fixture.store.markDispatchStarted(ambiguous);
    const dispatched = [];
    const logs = [];
    let claims = 0;
    const runner = createRunner({
      config,
      stateStore: fixture.store,
      api: {
        status: async () => ({ job: { estado: 'confirmacion_pendiente', assigned_to_agent: true, lease_active: false } }),
        claim: async () => ({ jobs: claims++ === 0 ? [next] : [] }), printing: async () => {}, renew: async () => {},
        confirmationPending: async () => {}, complete: async () => {}, fail: async () => {}
      },
      qz: { prepare: async (value) => ({ job: value }), dispatch: async ({ job: value }) => { dispatched.push(value.id_trabajo); } },
      log: (level, event, data) => logs.push({ level, event, data })
    });
    await runner.pollOnce();
    await runner.pollOnce();
    assert.deepEqual(dispatched, [41]);
    assert.equal(fixture.store.list()[0].job_id, 40);
    assert.equal(logs.filter((entry) => entry.event === 'print_outcome_uncertain' && entry.data.job_id === 40).length, 1);
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('respuesta QZ exitosa y fallo de complete persisten printed_unconfirmed; reinicio solo confirma', async () => {
  const fixture = await createStoreFixture('jonnys-printed-');
  try {
    const currentJob = job(50);
    let dispatches = 0;
    let failures = 0;
    const first = createRunner({
      config,
      stateStore: fixture.store,
      api: {
        claim: async () => ({ jobs: [currentJob] }), printing: async () => {}, renew: async () => {},
        confirmationPending: async () => {}, complete: async () => { throw new Error('network lost'); },
        status: async () => ({ job: { estado: 'confirmacion_pendiente', assigned_to_agent: true } }),
        fail: async () => { failures += 1; }
      },
      qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
    });
    await first.pollOnce();
    assert.equal(dispatches, 1);
    assert.equal(failures, 0);
    assert.equal(fixture.store.list()[0].status, 'printed_unconfirmed');

    let confirmations = 0;
    const restarted = createRunner({
      config,
      stateStore: fixture.store,
      api: { complete: async () => { confirmations += 1; }, claim: async () => ({ jobs: [] }) },
      qz: { prepare: async () => { throw new Error('must not prepare'); }, dispatch: async () => { throw new Error('must not print'); } }
    });
    await restarted.pollOnce();
    assert.equal(confirmations, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(fixture.store.list(), []);
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('resolucion administrativa final limpia dispatch_started del journal', async () => {
  const fixture = await createStoreFixture('jonnys-admin-resolved-');
  try {
    await fixture.store.markDispatchStarted(job(60));
    const runner = createRunner({
      config,
      stateStore: fixture.store,
      api: { status: async () => ({ job: { estado: 'impreso', assigned_to_agent: true } }), claim: async () => ({ jobs: [] }) },
      qz: { prepare: async () => { throw new Error('must not prepare'); }, dispatch: async () => { throw new Error('must not print'); } }
    });
    await runner.pollOnce();
    assert.deepEqual(fixture.store.list(), []);
  } finally {
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('claim del agente solicita exactamente un trabajo', async () => {
  let requestBody;
  const api = createApiClient({
    config,
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ jobs: [] }) };
    }
  });
  await api.claim();
  assert.equal(requestBody.limit, 1);
});

test('certificado QZ exige hostname localhost y rechaza clave privada', () => {
  class LocalhostCertificate {
    checkHost(host) { return host === 'localhost' ? 'localhost' : undefined; }
  }
  class OtherHostCertificate {
    checkHost() { return undefined; }
  }
  assert.ok(validateQzCaCertificate({ certificateText: 'certificate', host: 'localhost', X509CertificateImpl: LocalhostCertificate }));
  assert.throws(
    () => validateQzCaCertificate({ certificateText: 'certificate', host: 'localhost', X509CertificateImpl: OtherHostCertificate }),
    /QZ_CA_CERT_HOSTNAME/
  );
  assert.throws(
    () => validateQzCaCertificate({ certificateText: 'PRIVATE KEY', host: 'localhost', X509CertificateImpl: LocalhostCertificate }),
    /QZ_CA_CERT_MUST_NOT_CONTAIN_PRIVATE_KEY/
  );
  assert.throws(
    () => loadConfig({ API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'id', PRINT_AGENT_TOKEN: 'token', BRANCH_ID: '2', QZ_HOST: '127.0.0.1', PRINTER_MAP_JSON: '{"factura":"QA"}' }),
    /QZ_HOST_MUST_BE_LOCALHOST/
  );
});

test('WebSocket QZ mantiene rejectUnauthorized=true y CA explicita', () => {
  let capturedOptions;
  function MockWebSocket(_address, options) { capturedOptions = options; }
  Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const SecureWebSocket = createSecureWebSocketType({ WebSocketImpl: MockWebSocket, ca: Buffer.from('test-ca') });
  new SecureWebSocket('wss://localhost:8181');
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.ca.toString(), 'test-ca');
});
