import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, normalizeQzHost, validateQzCaCertificate } from '../src/config.js';
import { createApiClient } from '../src/apiClient.js';
import { validateCanonicalPrintJobData } from '../src/documentRenderer.js';
import { assertQzHostResolvesLocally, createQzClient, createSecureWebSocketType } from '../src/qzClient.js';
import { createRunner } from '../src/runner.js';
import { createPrintStateStore } from '../src/stateStore.js';

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}'
});

const qzConfigEnv = (host) => ({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: host, QZ_SECURE_PORT: '8181', PRINTER_MAP_JSON: '{"factura":"QA Printer"}',
  QZ_CA_CERT_PATH: 'C:/ProgramData/qz/ssl/root-ca.crt'
});

const certificateFileSystem = {
  existsSync: () => true,
  statSync: () => ({ isFile: () => true }),
  readFileSync: () => 'certificate'
};

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

test('documento canonico usa el endpoint autenticado y exclusivo del trabajo', async () => {
  const expectedDocument = {
    type: 'pixel',
    format: 'pdf',
    flavor: 'base64',
    data: Buffer.from('%PDF-1.4\nagent endpoint\n%%EOF').toString('base64'),
    options: { altFontRendering: true, ignoreTransparency: true }
  };
  let capturedUrl;
  let capturedOptions;
  const api = createApiClient({
    config,
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true, json: async () => ({ document: expectedDocument }) };
    }
  });

  const document = await api.document(71);

  assert.equal(capturedUrl, `${config.apiBaseUrl}/api/print-agent/jobs/71/document`);
  assert.equal(capturedOptions.method, 'GET');
  assert.equal(capturedOptions.headers.Authorization, `Bearer ${config.token}`);
  assert.equal(capturedOptions.headers['X-Print-Agent-Id'], config.agentId);
  assert.equal(capturedOptions.body, undefined);
  assert.deepEqual(document, expectedDocument);
});

test('localhost queda permitido cuando el certificado coincide y DNS devuelve loopback', async () => {
  class LocalhostCertificate {
    checkHost(host) { return host === 'localhost' ? 'localhost' : undefined; }
  }
  const localhostConfig = loadConfig(qzConfigEnv('LOCALHOST'), {
    fileSystem: certificateFileSystem,
    X509CertificateImpl: LocalhostCertificate
  });
  assert.equal(localhostConfig.qzHost, 'localhost');
  await assertQzHostResolvesLocally({
    host: localhostConfig.qzHost,
    lookupImpl: async () => [{ address: '::1', family: 6 }],
    networkInterfacesImpl: () => ({})
  });
});

test('hostname QZ personalizado permite certificado coincidente y cualquier resultado DNS local', async () => {
  class CustomHostCertificate {
    checkHost(host) { return host === 'qz-elcarmen.jonnyshn.com' ? host : undefined; }
  }
  const customConfig = loadConfig(qzConfigEnv('QZ-ELCARMEN.JONNYSHN.COM'), {
    fileSystem: certificateFileSystem,
    X509CertificateImpl: CustomHostCertificate
  });
  assert.equal(customConfig.qzHost, 'qz-elcarmen.jonnyshn.com');

  let lookupHost;
  let lookupOptions;
  const resolved = await assertQzHostResolvesLocally({
    host: customConfig.qzHost,
    lookupImpl: async (host, options) => {
      lookupHost = host;
      lookupOptions = options;
      return [
        { address: '203.0.113.20', family: 4 },
        { address: '2001:0db8:0:0:0:0:0:1', family: 6 }
      ];
    },
    networkInterfacesImpl: () => ({
      'Wi-Fi': [{ address: '2001:db8::1', family: 'IPv6', internal: false }]
    })
  });
  assert.equal(lookupHost, 'qz-elcarmen.jonnyshn.com');
  assert.deepEqual(lookupOptions, { all: true, verbatim: true });
  assert.deepEqual(resolved, ['203.0.113.20', '2001:db8::1']);
});

test('hostname QZ se rechaza cuando el certificado no coincide', () => {
  class OtherHostCertificate {
    checkHost() { return undefined; }
  }
  assert.throws(
    () => loadConfig(qzConfigEnv('qz-elcarmen.jonnyshn.com'), {
      fileSystem: certificateFileSystem,
      X509CertificateImpl: OtherHostCertificate
    }),
    /QZ_CA_CERT_HOSTNAME/
  );
});

test('hostname QZ se rechaza cuando todas las IP resueltas son externas', async () => {
  await assert.rejects(
    assertQzHostResolvesLocally({
      host: 'qz-elcarmen.jonnyshn.com',
      lookupImpl: async () => [
        { address: '203.0.113.20', family: 4 },
        { address: '2001:db8:ffff::20', family: 6 }
      ],
      networkInterfacesImpl: () => ({
        'Wi-Fi': [{ address: '192.168.2.90', family: 'IPv4', internal: false }],
        Ethernet: [{ address: '2001:db8::1%12', family: 'IPv6', internal: false }]
      })
    }),
    /QZ_HOST_NOT_LOCAL/
  );
});

test('hostname QZ se rechaza cuando DNS falla', async () => {
  await assert.rejects(
    assertQzHostResolvesLocally({
      host: 'qz-elcarmen.jonnyshn.com',
      lookupImpl: async () => { throw new Error('ENOTFOUND'); },
      networkInterfacesImpl: () => ({})
    }),
    /QZ_HOST_DNS_LOOKUP_FAILED/
  );
});

test('configuracion QZ rechaza IP literales, hostnames invalidos y host personalizado sin CA', () => {
  assert.throws(() => normalizeQzHost('198.51.100.20'), /CONFIG_INVALID:QZ_HOST/);
  assert.throws(() => normalizeQzHost('host externo.example.com'), /CONFIG_INVALID:QZ_HOST/);
  assert.throws(
    () => loadConfig({ ...qzConfigEnv('externo.example.com'), QZ_CA_CERT_PATH: '' }),
    /CONFIG_REQUIRED:QZ_CA_CERT_PATH/
  );
});

test('certificado QZ rechaza claves privadas', () => {
  class LocalhostCertificate {
    checkHost(host) { return host === 'localhost' ? host : undefined; }
  }
  assert.throws(
    () => validateQzCaCertificate({ certificateText: 'PRIVATE KEY', host: 'localhost', X509CertificateImpl: LocalhostCertificate }),
    /QZ_CA_CERT_MUST_NOT_CONTAIN_PRIVATE_KEY/
  );
});

test('WebSocket QZ exige WSS, mantiene rejectUnauthorized=true y carga CA explicita', () => {
  let capturedOptions;
  function MockWebSocket(_address, options) { capturedOptions = options; }
  Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  const SecureWebSocket = createSecureWebSocketType({ WebSocketImpl: MockWebSocket, ca: Buffer.from('test-ca') });
  assert.throws(() => new SecureWebSocket('ws://localhost:8182'), /QZ_WSS_REQUIRED/);
  new SecureWebSocket('wss://qz-elcarmen.jonnyshn.com:8181');
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.ca.toString(), 'test-ca');
});

test('cliente QZ usa documentos canonicos v2 y conserva discovery, WSS, SHA512 y timestamps de print', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-qz-client-'));
  const caPath = path.join(tempDir, 'root-ca.crt');
  await fs.writeFile(caPath, 'explicit-test-ca', 'utf8');
  try {
    let active = false;
    let connectOptions;
    let SecureWebSocket;
    let signatureAlgorithm;
    let signaturePromise;
    let socketOptions;
    let availablePrinters = ['ZKP8008', 'Kitchen Printer'];
    const findCalls = [];
    const signCalls = [];
    const printCalls = [];
    const documentCalls = [];
    const canonicalPdf = Buffer.from('%PDF-1.4\ncanonical venta ticket\n%%EOF');
    const canonicalPdfBase64 = canonicalPdf.toString('base64');
    const canonicalHtml = '<!doctype html><html><body><h1>COMANDA COCINA</h1><p>VTA-00007</p></body></html>';
    const canonicalPdfDataItem = {
      type: 'pixel',
      format: 'pdf',
      flavor: 'base64',
      data: canonicalPdfBase64,
      options: { altFontRendering: true, ignoreTransparency: true }
    };
    const canonicalHtmlDataItem = {
      type: 'pixel',
      format: 'html',
      flavor: 'plain',
      data: canonicalHtml,
      options: { pageWidth: 58 }
    };
    function MockWebSocket(_address, options) { socketOptions = options; }
    Object.assign(MockWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const qz = {
      api: {
        setPromiseType: () => {},
        setWebSocketType: (value) => { SecureWebSocket = value; }
      },
      security: {
        setCertificatePromise: () => {},
        setSignatureAlgorithm: (value) => { signatureAlgorithm = value; },
        setSignaturePromise: (value) => { signaturePromise = value; }
      },
      websocket: {
        isActive: () => active,
        connect: async (options) => { connectOptions = options; active = true; },
        disconnect: async () => { active = false; }
      },
      printers: {
        find: async (...args) => {
          findCalls.push(args);
          await signaturePromise('find-digest');
          return availablePrinters;
        }
      },
      configs: {
        create: (printer, options) => ({
          getPrinter: () => printer,
          getOptions: () => options
        })
      },
      print: async (...args) => {
        printCalls.push(args);
        await signaturePromise('print-digest');
      }
    };
    const api = {
      document: async (jobId) => {
        documentCalls.push(jobId);
        if (jobId === 71) {
          return canonicalPdfDataItem;
        }
        if (jobId === 72) {
          return canonicalHtmlDataItem;
        }
        throw new Error('unexpected document request');
      },
      sign: async (jobId, request, digest) => {
        signCalls.push({ jobId, request, digest });
        return { signature: `signed:${digest}` };
      }
    };
    const client = createQzClient({
      config: {
        qzHost: 'qz-elcarmen.jonnyshn.com', qzSecurePort: 8181, qzCaCertPath: caPath,
        printerMap: { factura: 'ZKP8008', cocina: 'Kitchen Printer' }
      },
      api,
      qz,
      WebSocketImpl: MockWebSocket,
      lookupImpl: async () => [{ address: '192.168.2.90', family: 4 }],
      networkInterfacesImpl: () => ({
        'Wi-Fi': [{ address: '192.168.2.90', family: 'IPv4', internal: false }]
      })
    });
    const currentJob = {
      id_trabajo: 71,
      tipo_documento: 'factura',
      payload: {
        schema_version: 2,
        tipo_documento: 'factura',
        impresora_logica: 'factura',
        ancho_mm: 80,
        source: { id_factura: 7, id_pedido: null },
        documento_canonico: {
          kind: 'venta_ticket_pdf',
          format: 'pdf',
          flavor: 'base64',
          content_sha256: crypto.createHash('sha256').update(canonicalPdf).digest('hex'),
          content_bytes: canonicalPdf.length
        }
      }
    };
    const comandaJob = {
      id_trabajo: 72,
      tipo_documento: 'comanda',
      payload: {
        schema_version: 2,
        tipo_documento: 'comanda',
        impresora_logica: 'cocina',
        ancho_mm: 58,
        source: { id_factura: 7, id_pedido: 19 },
        documento_canonico: {
          kind: 'comanda_cocina_html',
          format: 'html',
          flavor: 'plain',
          content_sha256: crypto.createHash('sha256').update(canonicalHtml, 'utf8').digest('hex'),
          content_bytes: Buffer.byteLength(canonicalHtml, 'utf8')
        }
      }
    };

    for (const invalidPdfOptions of [
      { pageWidth: 80 },
      { altFontRendering: false, ignoreTransparency: true },
      { altFontRendering: true, ignoreTransparency: false },
      { altFontRendering: true, ignoreTransparency: true, extra: true }
    ]) {
      assert.throws(
        () => validateCanonicalPrintJobData(currentJob.payload, {
          ...canonicalPdfDataItem,
          options: invalidPdfOptions
        }),
        /PAYLOAD_V2_CANONICAL_INVALID/
      );
    }
    for (const invalidHtmlOptions of [
      { altFontRendering: true, ignoreTransparency: true },
      { pageWidth: 80 },
      { pageWidth: 58, extra: true }
    ]) {
      assert.throws(
        () => validateCanonicalPrintJobData(comandaJob.payload, {
          ...canonicalHtmlDataItem,
          options: invalidHtmlOptions
        }),
        /PAYLOAD_V2_CANONICAL_INVALID/
      );
    }

    const prepared = await client.prepare(currentJob);
    new SecureWebSocket('wss://qz-elcarmen.jonnyshn.com:8181');
    await client.dispatch(prepared);
    const preparedComanda = await client.prepare(comandaJob);
    await client.dispatch(preparedComanda);
    availablePrinters = ['Otra impresora'];
    await assert.rejects(
      client.prepare({ ...currentJob, id_trabajo: 73 }),
      /IMPRESORA_NO_ENCONTRADA:factura/
    );

    assert.deepEqual(connectOptions, {
      host: 'qz-elcarmen.jonnyshn.com',
      usingSecure: true,
      port: { secure: [8181] },
      retries: 1,
      delay: 1
    });
    assert.equal(socketOptions.rejectUnauthorized, true);
    assert.equal(socketOptions.ca.toString(), 'explicit-test-ca');
    assert.equal(signatureAlgorithm, 'SHA512');
    assert.equal(Object.prototype.hasOwnProperty.call(currentJob.payload, 'documento'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(comandaJob.payload, 'documento'), false);
    assert.equal(prepared.qzConfig.getPrinter(), 'ZKP8008');
    assert.equal(preparedComanda.qzConfig.getPrinter(), 'Kitchen Printer');
    assert.deepEqual(prepared.qzConfig.getOptions(), {
      copies: 1,
      jobName: 'Jonny-71',
      margins: 0,
      scaleContent: false,
      units: 'mm'
    });
    assert.deepEqual(preparedComanda.qzConfig.getOptions(), {
      copies: 1,
      jobName: 'Jonny-72',
      margins: 0,
      scaleContent: false,
      units: 'mm'
    });
    assert.deepEqual(documentCalls, [71, 72]);
    assert.deepEqual(prepared.data, [canonicalPdfDataItem]);
    assert.deepEqual(preparedComanda.data, [canonicalHtmlDataItem]);
    assert.equal(Object.hasOwn(prepared.data[0].options, 'pageWidth'), false);
    const preparedPdfContent = Buffer.from(prepared.data[0].data, 'base64');
    assert.equal(preparedPdfContent.length, currentJob.payload.documento_canonico.content_bytes);
    assert.equal(
      crypto.createHash('sha256').update(preparedPdfContent).digest('hex'),
      currentJob.payload.documento_canonico.content_sha256
    );
    assert.equal(Buffer.byteLength(preparedComanda.data[0].data, 'utf8'), comandaJob.payload.documento_canonico.content_bytes);
    assert.equal(
      crypto.createHash('sha256').update(preparedComanda.data[0].data, 'utf8').digest('hex'),
      comandaJob.payload.documento_canonico.content_sha256
    );
    assert.equal(findCalls.length, 3);
    assert.equal(findCalls[0][0], undefined);
    assert.equal(findCalls[0][1], undefined);
    assert.equal(findCalls[0][2], signCalls[0].request.timestamp);
    assert.equal(findCalls[1][0], undefined);
    assert.equal(findCalls[1][1], undefined);
    assert.equal(findCalls[1][2], signCalls[2].request.timestamp);
    assert.equal(findCalls[2][0], undefined);
    assert.equal(findCalls[2][1], undefined);
    assert.equal(findCalls[2][2], signCalls[4].request.timestamp);
    assert.deepEqual(signCalls[0].request.params, {});
    assert.deepEqual(signCalls[2].request.params, {});
    assert.deepEqual(signCalls[4].request.params, {});
    assert.deepEqual(signCalls.map(({ jobId, request, digest }) => ({ jobId, call: request.call, digest })), [
      { jobId: 71, call: 'printers.find', digest: 'find-digest' },
      { jobId: 71, call: 'print', digest: 'print-digest' },
      { jobId: 72, call: 'printers.find', digest: 'find-digest' },
      { jobId: 72, call: 'print', digest: 'print-digest' },
      { jobId: 73, call: 'printers.find', digest: 'find-digest' }
    ]);
    assert.equal(printCalls.length, 2);
    assert.deepEqual(signCalls[1].request.params.data, prepared.data);
    assert.deepEqual(signCalls[3].request.params.data, preparedComanda.data);
    assert.deepEqual(signCalls[1].request.params.options, prepared.qzConfig.getOptions());
    assert.deepEqual(signCalls[3].request.params.options, preparedComanda.qzConfig.getOptions());
    assert.deepEqual(printCalls[0][2], []);
    assert.deepEqual(printCalls[0][3], [signCalls[1].request.timestamp]);
    assert.equal(printCalls[0][3][0], signCalls[1].request.timestamp);
    assert.deepEqual(printCalls[1][2], []);
    assert.deepEqual(printCalls[1][3], [signCalls[3].request.timestamp]);
    assert.equal(printCalls[1][3][0], signCalls[3].request.timestamp);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
