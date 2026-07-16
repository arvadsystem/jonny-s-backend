import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createRunner } from '../src/runner.js';
import { createQzClient } from '../src/qzClient.js';

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}'
});

test('configuracion fuerza HTTPS y QZ localhost', () => {
  assert.throws(() => loadConfig({ API_BASE_URL: 'http://remote', PRINT_AGENT_ID: 'a', PRINT_AGENT_TOKEN: 'x', BRANCH_ID: '1', PRINTER_MAP_JSON: '{}' }), /HTTPS_REQUIRED/);
  assert.throws(() => loadConfig({ API_BASE_URL: 'https://qa', PRINT_AGENT_ID: 'a', PRINT_AGENT_TOKEN: 'x', BRANCH_ID: '1', QZ_HOST: '192.168.2.90', PRINTER_MAP_JSON: '{}' }), /QZ_HOST/);
});

test('heartbeat usa la API', async () => {
  let called = false;
  const runner = createRunner({ config, api: { heartbeat: async () => { called = true; } }, qz: {} });
  await runner.heartbeatOnce();
  assert.equal(called, true);
});

test('polling imprime y confirma un trabajo simulado', async () => {
  const events = [];
  const api = {
    claim: async () => ({ jobs: [{ id_trabajo: 3, id_sucursal: 2, payload: {} }] }),
    printing: async () => events.push('printing'), renew: async () => {},
    complete: async () => events.push('complete'), fail: async () => events.push('fail')
  };
  const runner = createRunner({ config, api, qz: { print: async () => events.push('qz') } });
  await runner.pollOnce();
  assert.deepEqual(events, ['printing', 'qz', 'complete']);
});

test('fallo QZ se reporta sin confirmar impresion', async () => {
  const events = [];
  const api = {
    claim: async () => ({ jobs: [{ id_trabajo: 4, id_sucursal: 2, payload: {} }] }),
    printing: async () => events.push('printing'), renew: async () => {}, complete: async () => events.push('complete'),
    fail: async () => events.push('fail')
  };
  const runner = createRunner({ config, api, qz: { print: async () => { throw new Error('offline'); } } });
  await runner.pollOnce();
  assert.deepEqual(events, ['printing', 'fail']);
});

test('QZ simulado conecta exclusivamente por WSS localhost 8181 e imprime', async () => {
  let connectionOptions;
  let printCalled = false;
  const mockQz = {
    api: { setPromiseType: () => {}, setWebSocketType: () => {} },
    security: { setCertificatePromise: () => {}, setSignatureAlgorithm: () => {}, setSignaturePromise: () => {} },
    websocket: { isActive: () => false, connect: async (options) => { connectionOptions = options; } },
    printers: { find: async () => ['QA Printer'] },
    configs: { create: () => ({}) },
    print: async () => { printCalled = true; }
  };
  const client = createQzClient({ config, api: { certificate: async () => 'cert', sign: async () => 'sig' }, qz: mockQz });
  await client.print({ id_trabajo: 8, tipo_documento: 'factura', payload: { schema_version: 1, tipo_documento: 'factura', impresora_logica: 'factura', documento: { items: [] } } });
  assert.deepEqual(connectionOptions, { host: 'localhost', usingSecure: true, port: { secure: [8181] }, retries: 1, delay: 1 });
  assert.equal(printCalled, true);
});
