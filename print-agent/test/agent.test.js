import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { loadConfig } from '../src/config.js';
import { createApiClient } from '../src/apiClient.js';
import { createSecureWebSocketType } from '../src/qzClient.js';
import { createRunner } from '../src/runner.js';
import { createPrintStateStore } from '../src/stateStore.js';

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}'
});

test('perdida de confirmacion despues de QZ persiste y reconcilia sin reimprimir', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-print-state-'));
  const stateFile = path.join(tempDir, 'state.json');
  try {
    const stateStore = createPrintStateStore({ filePath: stateFile });
    await stateStore.init();
    let dispatches = 0;
    let failures = 0;
    const job = { id_trabajo: 31, id_sucursal: 2, payload: {} };
    const runner = createRunner({
      config,
      stateStore,
      api: {
        claim: async () => ({ jobs: [job] }), printing: async () => {}, renew: async () => {},
        confirmationPending: async () => {}, complete: async () => { throw new Error('network lost'); },
        fail: async () => { failures += 1; }
      },
      qz: { prepare: async () => ({ job }), dispatch: async () => { dispatches += 1; } }
    });
    await runner.pollOnce();
    assert.equal(dispatches, 1);
    assert.equal(failures, 0);
    assert.equal(stateStore.list()[0].status, 'printed_unconfirmed');

    const restartedStore = createPrintStateStore({ filePath: stateFile });
    await restartedStore.init();
    let confirmations = 0;
    const restartedRunner = createRunner({
      config,
      stateStore: restartedStore,
      api: { complete: async () => { confirmations += 1; } },
      qz: { prepare: async () => { throw new Error('must not print'); }, dispatch: async () => { throw new Error('must not print'); } }
    });
    await restartedRunner.reconcileOnce();
    assert.equal(confirmations, 1);
    assert.equal(dispatches, 1);
    assert.deepEqual(restartedStore.list(), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('rechazo ambiguo de qz.print conserva dispatch_started y no reencola', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-print-uncertain-'));
  try {
    const stateStore = createPrintStateStore({ filePath: path.join(tempDir, 'state.json') });
    await stateStore.init();
    let failures = 0;
    const job = { id_trabajo: 32, id_sucursal: 2, payload: {} };
    const runner = createRunner({
      config,
      stateStore,
      api: {
        claim: async () => ({ jobs: [job] }), printing: async () => {}, renew: async () => {},
        confirmationPending: async () => {}, fail: async () => { failures += 1; }
      },
      qz: { prepare: async () => ({ job }), dispatch: async () => { throw new Error('QZ response lost'); } }
    });
    await runner.pollOnce();
    assert.equal(failures, 0);
    assert.equal(stateStore.list()[0].status, 'dispatch_started');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
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

test('CA local valida certificado y mantiene rejectUnauthorized activo', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-qz-ca-'));
  const caPath = path.join(tempDir, 'qz-local-ca.pem');
  try {
    await fs.writeFile(caPath, `${tls.rootCertificates[0]}\n`, 'utf8');
    const caConfig = loadConfig({
      API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
      BRANCH_ID: '2', PRINTER_MAP_JSON: '{"factura":"QA Printer"}', QZ_CA_CERT_PATH: caPath
    });
    assert.equal(caConfig.qzCaCertPath, path.resolve(caPath));
    let capturedOptions;
    function MockWebSocket(_address, options) { capturedOptions = options; }
    Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const SecureWebSocket = createSecureWebSocketType({ WebSocketImpl: MockWebSocket, ca: Buffer.from('test-ca') });
    new SecureWebSocket('wss://localhost:8181');
    assert.equal(capturedOptions.rejectUnauthorized, true);
    assert.equal(capturedOptions.ca.toString(), 'test-ca');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
