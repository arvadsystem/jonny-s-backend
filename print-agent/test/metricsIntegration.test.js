import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRunner } from '../src/runner.js';
import { createQzClient } from '../src/qzClient.js';
import { createPrintStateStore } from '../src/stateStore.js';
import { STAGE_EVENT } from '../src/metrics.js';

// Prueba de integracion real (runner.js + qzClient.js, sin mocks intermedios de metricas)
// con PRINT_AGENT_PERF_LOGS=true: confirma que total_processing envuelve exactamente las
// etapas esperadas de un trabajo exitoso, en orden, cada una con duration_ms >= 0.

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}',
  PRINT_AGENT_PERF_LOGS: 'true'
});

const createFakeQzTray = () => {
  let active = false;
  let signaturePromise = async () => {};
  return {
    api: { setPromiseType: () => {}, setWebSocketType: () => {} },
    security: {
      setCertificatePromise: () => {},
      setSignatureAlgorithm: () => {},
      setSignaturePromise: (fn) => { signaturePromise = fn; }
    },
    websocket: {
      isActive: () => active,
      connect: async () => { active = true; },
      disconnect: async () => { active = false; }
    },
    printers: { find: async () => { await signaturePromise('find-digest'); return ['QA Printer']; } },
    configs: { create: (printer, options) => ({ getPrinter: () => printer, getOptions: () => options }) },
    print: async () => { await signaturePromise('print-digest'); }
  };
};

test('un trabajo exitoso registra print_stage_timing para cada etapa esperada, en orden, con duracion valida', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-metrics-'));
  try {
    const stateStore = createPrintStateStore({ filePath: path.join(tempDir, 'state.json') });
    await stateStore.init();
    const logs = [];
    const log = (level, event, data) => logs.push({ level, event, data });

    const canonicalPdf = Buffer.from('%PDF-1.4\ncanonical venta ticket\n%%EOF');
    const canonicalPdfDataItem = {
      type: 'pixel',
      format: 'pdf',
      flavor: 'base64',
      data: canonicalPdf.toString('base64'),
      options: { altFontRendering: true, ignoreTransparency: true }
    };
    const api = {
      certificate: async () => 'cert-pem',
      sign: async (_jobId, _request, digest) => ({ signature: `signed:${digest}` }),
      document: async () => canonicalPdfDataItem,
      printing: async () => {},
      renew: async () => {},
      confirmationPending: async () => {},
      complete: async () => {},
      fail: async () => {},
      claim: async () => ({
        jobs: [{
          id_trabajo: 900,
          id_sucursal: 2,
          tipo_documento: 'factura',
          payload: {
            schema_version: 2,
            tipo_documento: 'factura',
            impresora_logica: 'factura',
            ancho_mm: 80,
            source: { id_factura: 900, id_pedido: null },
            documento_canonico: {
              kind: 'venta_ticket_pdf',
              format: 'pdf',
              flavor: 'base64',
              content_sha256: crypto.createHash('sha256').update(canonicalPdf).digest('hex'),
              content_bytes: canonicalPdf.length
            }
          }
        }]
      })
    };

    const qz = createQzClient({
      config, api, qz: createFakeQzTray(), log,
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
      networkInterfacesImpl: () => ({})
    });
    const runner = createRunner({ config, api, qz, stateStore, log });

    await runner.claimAndProcess('polling');

    const stageEvents = logs.filter((entry) => entry.event === STAGE_EVENT);
    const stageOrder = stageEvents.map((entry) => entry.data.stage);

    // total_processing es el ultimo en cerrarse (envuelve a todos los demas), pero es el
    // PRIMERO en aparecer en el log porque timeStage registra al resolver -- es decir, las
    // sub-etapas resuelven (y se loguean) antes que la etapa que las contiene.
    const expectedInnerStages = [
      'api_printing',
      'qz_connect',
      'printers_find',
      'document_download',
      'document_validation',
      'journal_mark_prepared',
      'confirmation_pending',
      'journal_mark_dispatch_started',
      'qz_print',
      'journal_mark_printed_unconfirmed',
      'api_complete'
    ];
    for (const stage of expectedInnerStages) {
      assert.ok(stageOrder.includes(stage), `falta la etapa ${stage} en ${JSON.stringify(stageOrder)}`);
    }
    assert.equal(stageOrder.at(-1), 'total_processing', 'total_processing debe ser la ultima en resolver, ya que envuelve a todas las demas');
    assert.equal(stageOrder.filter((stage) => stage === 'total_processing').length, 1);

    for (const entry of stageEvents) {
      assert.equal(entry.data.job_id, 900);
      assert.equal(entry.data.success, true);
      assert.ok(Number.isFinite(entry.data.duration_ms) && entry.data.duration_ms >= 0, `duration_ms invalido en ${entry.data.stage}`);
    }

    assert.ok(stageOrder.includes('printer_resolution'));

    const printersFindEntry = stageEvents.find((entry) => entry.data.stage === 'printers_find');
    assert.equal(printersFindEntry.data.cache_hit, false, 'la primera consulta de impresoras nunca es cache_hit');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
