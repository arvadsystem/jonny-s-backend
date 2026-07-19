import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { renderPrintJobHtml } from '../print-agent/src/documentRenderer.js';
import { claimPrintJobs, transitionPrintJob, validatePrintPayload } from '../services/printQueueService.js';
import {
  authorizeAndSignAgentQzRequest,
  canonicalizeAgentQzRequest,
  validateAgentQzRequest
} from '../services/qzAgentSigningService.js';
import { buildAgentQzSigningErrorResponse } from '../routers/printAgent.js';
import {
  buildPedidoPrintEnqueueErrorResponse,
  enqueuePedidoComandaPrintJob
} from '../routers/printing.js';

const agent = { id_agente: '11111111-1111-1111-1111-111111111111', id_sucursal: 9 };
const payload = {
  schema_version: 1,
  tipo_documento: 'factura',
  ancho_mm: 80,
  documento: { titulo: 'QA', items: [{ cantidad: 1, descripcion: 'Combo', total: 99 }], total: 99 }
};
const digestFor = (request) => crypto.createHash('sha256').update(canonicalizeAgentQzRequest(request), 'utf8').digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const qzOptions = (jobId) => ({
  copies: 1,
  jobName: `Jonny-${jobId}`,
  margins: 0,
  scaleContent: false,
  units: 'mm'
});
const clone = (value) => JSON.parse(JSON.stringify(value));

const facturaPdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');
const facturaPayloadV2 = {
  schema_version: 2,
  tipo_documento: 'factura',
  impresora_logica: 'factura',
  ancho_mm: 80,
  source: { id_factura: 6, id_pedido: 7 },
  documento_canonico: {
    kind: 'venta_ticket_pdf',
    format: 'pdf',
    flavor: 'base64',
    content_sha256: sha256(facturaPdfBytes),
    content_bytes: facturaPdfBytes.length
  }
};
const facturaDataV2 = {
  type: 'pixel',
  format: 'pdf',
  flavor: 'base64',
  data: facturaPdfBytes.toString('base64'),
  options: { altFontRendering: true, ignoreTransparency: true }
};

const comandaHtml = '<!doctype html><html><body><h1>COMANDA COCINA</h1><p>2 Alitas</p></body></html>';
const comandaHtmlBytes = Buffer.from(comandaHtml, 'utf8');
const comandaPayloadV2 = {
  schema_version: 2,
  tipo_documento: 'comanda',
  impresora_logica: 'cocina',
  ancho_mm: 58,
  source: { id_factura: 7, id_pedido: 8 },
  documento_canonico: {
    kind: 'comanda_cocina_html',
    format: 'html',
    flavor: 'plain',
    content_sha256: sha256(comandaHtmlBytes),
    content_bytes: comandaHtmlBytes.length
  }
};
const pendingComandaPayloadV2 = {
  ...clone(comandaPayloadV2),
  source: { id_factura: null, id_pedido: 8 }
};
const comandaDataV2 = {
  type: 'pixel',
  format: 'html',
  flavor: 'plain',
  data: comandaHtml,
  options: { pageWidth: 58 }
};

const canonicalJob = ({ id = 8, currentPayload = facturaPayloadV2 } = {}) => ({
  id_trabajo: id,
  id_sucursal: agent.id_sucursal,
  id_agente_tomado: agent.id_agente,
  tipo_documento: currentPayload.tipo_documento,
  estado: 'confirmacion_pendiente',
  payload: currentPayload,
  id_factura: currentPayload.source.id_factura,
  id_pedido: currentPayload.source.id_pedido,
  lease_active: false
});

const canonicalPrintRequest = ({ timestamp, jobId = 8, dataItem = facturaDataV2 } = {}) => ({
  call: 'print',
  params: {
    printer: { name: 'QA Printer' },
    options: qzOptions(jobId),
    data: [dataItem]
  },
  timestamp
});

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
    options: qzOptions(jobId),
    data: [{ type: 'pixel', format: 'html', flavor: 'plain', data: html, options: { pageWidth: 80 } }]
  },
  timestamp
});

const createSigningDb = ({
  jobState = 'confirmacion_pendiente',
  existing = null,
  priorPrint = false,
  findCount = 0,
  job = null
} = {}) => (
  createTransactionalDb(async (sql) => {
    if (sql.includes('FROM public.trabajos_impresion')) {
      return {
        rows: [{
          id_trabajo: 8,
          id_sucursal: 9,
          id_agente_tomado: agent.id_agente,
          estado: jobState,
          payload,
          ...job
        }]
      };
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

test('endpoint de pedido encola comanda inicial idempotente y reimpresion separada sin factura', async () => {
  const pedido = {
    id_factura: null,
    id_pedido: 501,
    id_sucursal: agent.id_sucursal,
    id_caja: 3,
    modalidad: 'CONSUMO_LOCAL',
    contexto: { modalidad: 'CONSUMO_LOCAL', canal: 'POS' },
    items: []
  };
  const enqueueCalls = [];
  const jobsByKey = new Map();
  const enqueue = async (args) => {
    enqueueCalls.push(args);
    const key = `${args.idSucursal}:${args.tipoDocumento}:${args.idempotencyKey}`;
    if (!jobsByKey.has(key)) jobsByKey.set(key, { id_trabajo: jobsByKey.size + 100, ...args });
    return jobsByKey.get(key);
  };
  const baseArgs = {
    req: { user: { id_usuario: 44 } },
    idPedido: 501,
    tipoDocumento: 'comanda',
    queryRunner: {},
    loadPedido: async () => pedido,
    resolveScope: async () => ({ isSuperAdmin: false, allowedSucursalIds: [agent.id_sucursal] }),
    loadPrinterConfig: async () => ({ impresoras: [{ tipo_impresora: 'COCINA', ancho_mm: 58 }] }),
    createPayload: async ({ tipoDocumento, venta, widthMm }) => ({
      ...clone(comandaPayloadV2),
      tipo_documento: tipoDocumento,
      ancho_mm: widthMm,
      source: { id_factura: venta.id_factura, id_pedido: venta.id_pedido }
    }),
    enqueue
  };

  const first = await enqueuePedidoComandaPrintJob(baseArgs);
  const replay = await enqueuePedidoComandaPrintJob({
    ...baseArgs,
    idempotencyKey: 'comanda:pedido:501:inicial'
  });
  const reprint = await enqueuePedidoComandaPrintJob({
    ...baseArgs,
    esReimpresion: true,
    idempotencyKey: 'comanda:pedido-reprint:501:qa-1'
  });

  assert.equal(first.id_trabajo, replay.id_trabajo);
  assert.notEqual(reprint.id_trabajo, first.id_trabajo);
  assert.deepEqual(enqueueCalls[0], {
    idSucursal: agent.id_sucursal,
    tipoDocumento: 'comanda',
    idempotencyKey: 'comanda:pedido:501:inicial',
    idFactura: null,
    idPedido: 501,
    idUsuario: 44,
    esReimpresion: false,
    payload: enqueueCalls[0].payload
  });
  assert.deepEqual(enqueueCalls[0].payload.source, { id_factura: null, id_pedido: 501 });
  assert.equal(enqueueCalls[2].esReimpresion, true);
  assert.equal(enqueueCalls[2].idempotencyKey, 'comanda:pedido-reprint:501:qa-1');

  const routerSource = fs.readFileSync(new URL('../routers/printing.js', import.meta.url), 'utf8');
  assert.match(routerSource, /router\.post\('\/ventas\/pedidos\/:idPedido\/print-jobs', checkPermission\(\['VENTAS_IMPRIMIR', 'VENTAS_CREAR'\]\)/);
  assert.match(routerSource, /router\.post\('\/ventas\/pedidos\/:idPedido\/print-jobs'[\s\S]*return res\.status\(202\)/);
  assert.match(routerSource, /router\.post\('\/ventas\/:id\/print-jobs'[\s\S]*buildVentaDetailPayload/);
  const queueSource = fs.readFileSync(new URL('../services/printQueueService.js', import.meta.url), 'utf8');
  assert.match(queueSource, /ON CONFLICT \(id_sucursal,\s*idempotency_key,\s*tipo_documento\)/);
});

test('endpoint de pedido falla cerrado para clave, sucursal, factura o tipo incorrectos', async () => {
  const pedido = { id_factura: null, id_pedido: 501, id_sucursal: agent.id_sucursal, items: [] };
  const baseArgs = {
    req: { user: { id_usuario: 44 } },
    idPedido: 501,
    tipoDocumento: 'comanda',
    queryRunner: {},
    loadPedido: async () => pedido,
    resolveScope: async () => ({ isSuperAdmin: false, allowedSucursalIds: [agent.id_sucursal] }),
    loadPrinterConfig: async () => null,
    createPayload: async () => comandaPayloadV2,
    enqueue: async () => ({ id_trabajo: 1 })
  };

  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      ...baseArgs,
      esReimpresion: true,
      idempotencyKey: 'comanda:pedido-reprint:999:qa-1'
    }),
    (error) => error.code === 'PRINT_IDEMPOTENCY_INVALID'
  );
  for (const invalidId of ['501-externo', '1e2', ' 501 ', '+501']) {
    await assert.rejects(
      () => enqueuePedidoComandaPrintJob({ ...baseArgs, idPedido: invalidId }),
      (error) => error.code === 'PRINT_PEDIDO_INVALID'
    );
  }
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({ ...baseArgs, loadPedido: async () => null }),
    (error) => error.code === 'PRINT_PEDIDO_NOT_FOUND' && error.status === 404
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({ ...baseArgs, idempotencyKey: 'arbitraria-externa' }),
    (error) => error.code === 'PRINT_IDEMPOTENCY_INVALID'
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({ ...baseArgs, esReimpresion: true }),
    (error) => error.code === 'PRINT_IDEMPOTENCY_REQUIRED'
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      ...baseArgs,
      resolveScope: async () => ({ isSuperAdmin: false, allowedSucursalIds: [10] })
    }),
    (error) => error.code === 'PRINT_SUCURSAL_FORBIDDEN'
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      ...baseArgs,
      loadPedido: async () => ({ ...pedido, id_factura: 77 })
    }),
    (error) => error.code === 'PRINT_PEDIDO_SOURCE_INVALID'
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({
      ...baseArgs,
      loadPedido: async () => ({ ...pedido, pago: { id_factura: 77 } })
    }),
    (error) => error.code === 'PRINT_PEDIDO_SOURCE_INVALID'
  );
  await assert.rejects(
    () => enqueuePedidoComandaPrintJob({ ...baseArgs, tipoDocumento: 'factura' }),
    (error) => error.code === 'PRINT_DOCUMENT_TYPE_INVALID'
  );

  const databaseError = buildPedidoPrintEnqueueErrorResponse(Object.assign(new Error('SQL sensible'), {
    code: '42P08'
  }));
  assert.deepEqual(databaseError, {
    status: 500,
    body: {
      ok: false,
      code: 'PRINT_ENQUEUE_FAILED',
      message: 'No se pudo enviar el trabajo de impresion.'
    }
  });
  const controlledError = buildPedidoPrintEnqueueErrorResponse(Object.assign(new Error('Pedido no encontrado.'), {
    status: 404,
    code: 'PRINT_PEDIDO_NOT_FOUND'
  }));
  assert.equal(controlledError.body.code, 'PRINT_PEDIDO_NOT_FOUND');
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
  assert.match(insert.sql, /\$6::bigint/);
  assert.match(insert.sql, /\$9::timestamptz/);
  assert.doesNotMatch(insert.sql, /to_timestamp\s*\(\s*\$6/);
  assert.equal(insert.params.length, 9);
  assert.equal(insert.params[5], request.timestamp);
  assert.equal(insert.params[6], 'QA Printer');
  assert.ok(insert.params[8] instanceof Date);
  assert.equal(insert.params[8].getTime(), request.timestamp + 30_000);

  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({
      agent, jobId: 8, request, digest: 'a'.repeat(128), db: createSigningDb().db, now, signer: async () => 'sig'
    }),
    (error) => error.code === 'QZ_SIGN_DIGEST_INVALID'
  );
});

test('router QZ oculta SQLSTATE y conserva errores funcionales y de configuracion', () => {
  const logs = [];
  const databaseError = Object.assign(new Error('detalle SQL sensible'), {
    code: '42P08',
    signature: 'firma-no-registrar',
    requestHash: 'hash-no-registrar',
    certificate: 'certificado-no-registrar'
  });
  const databaseResponse = buildAgentQzSigningErrorResponse({
    error: databaseError,
    agentId: agent.id_agente,
    jobId: 25,
    log: (...args) => logs.push(args)
  });
  assert.equal(databaseResponse.status, 500);
  assert.equal(databaseResponse.body.code, 'QZ_SIGNING_ERROR');
  assert.doesNotMatch(JSON.stringify(databaseResponse), /42P08/);
  assert.deepEqual(logs[0][1], {
    agent_id: agent.id_agente,
    job_id: 25,
    sqlstate: '42P08'
  });
  assert.doesNotMatch(
    JSON.stringify(logs),
    /detalle SQL sensible|firma-no-registrar|hash-no-registrar|certificado-no-registrar/
  );

  const functionalResponse = buildAgentQzSigningErrorResponse({
    error: Object.assign(new Error('Solicitud QZ vencida.'), {
      code: 'QZ_SIGN_REQUEST_EXPIRED',
      status: 400
    }),
    log: (...args) => logs.push(args)
  });
  assert.equal(functionalResponse.status, 400);
  assert.equal(functionalResponse.body.code, 'QZ_SIGN_REQUEST_EXPIRED');
  assert.equal(functionalResponse.body.message, 'Solicitud QZ vencida.');

  const configurationResponse = buildAgentQzSigningErrorResponse({
    error: Object.assign(new Error('internal configuration detail'), {
      code: 'QZ_CERTIFICATE_INVALID',
      httpStatus: 503
    }),
    log: (...args) => logs.push(args)
  });
  assert.equal(configurationResponse.status, 503);
  assert.equal(configurationResponse.body.code, 'QZ_CERTIFICATE_INVALID');
  assert.equal(logs.length, 1);
});

test('dependencia qz-tray 2.2.6 aplica SHA-256 al objeto canonico antes de firmar', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../print-agent/node_modules/qz-tray/package.json', import.meta.url), 'utf8'));
  const source = fs.readFileSync(new URL('../print-agent/node_modules/qz-tray/qz-tray.js', import.meta.url), 'utf8');
  assert.equal(packageJson.version, '2.2.6');
  assert.match(source, /var signObj = \{[\s\S]*call: obj\.call,[\s\S]*params: obj\.params,[\s\S]*timestamp: obj\.timestamp/);
  assert.match(source, /var hashing = _qz\.tools\.hash\(_qz\.tools\.stringify\(signObj\)\)/);
  assert.match(source, /Change the SHA-256 hashing function used by QZ API/);

  const timestamp = 1_723_456_789_012;
  const qzCanonical = JSON.stringify({
    call: 'printers.find',
    params: { query: undefined },
    timestamp
  });
  const backendRequest = { call: 'printers.find', params: {}, timestamp };
  assert.equal(qzCanonical, `{"call":"printers.find","params":{},"timestamp":${timestamp}}`);
  assert.equal(canonicalizeAgentQzRequest(backendRequest), qzCanonical);
  assert.equal(
    digestFor(backendRequest),
    crypto.createHash('sha256').update(qzCanonical, 'utf8').digest('hex')
  );
});

test('backend QZ acepta params vacio y rechaza query null o claves adicionales en printers.find', () => {
  const now = Date.now();
  const activeJob = { estado: 'imprimiendo', lease_active: true, payload };
  const accepted = validateAgentQzRequest({
    request: { call: 'printers.find', params: {}, timestamp: now },
    job: activeJob,
    now
  });
  assert.equal(accepted.call, 'printers.find');
  assert.deepEqual(JSON.parse(accepted.canonical).params, {});

  for (const params of [{ query: null }, { extra: true }, { query: undefined }]) {
    assert.throws(
      () => validateAgentQzRequest({
        request: { call: 'printers.find', params, timestamp: now },
        job: activeJob,
        now
      }),
      (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
    );
  }
});

test('firma QZ exige el HTML determinista almacenado en el trabajo', async () => {
  const now = Date.now();
  const request = allowedPrintRequest(now, 8, '<p>documento alterado</p>');
  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({ agent, jobId: 8, request, digest: digestFor(request), db: createSigningDb().db, now, signer: async () => 'sig' }),
    (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
  );
});

test('payload canonico v2 exige contrato y referencias exactas', () => {
  assert.equal(validatePrintPayload(facturaPayloadV2).ok, true);
  assert.equal(validatePrintPayload(comandaPayloadV2).ok, true);
  assert.equal(validatePrintPayload(pendingComandaPayloadV2).ok, true);

  const invalidPayloads = [
    { ...clone(facturaPayloadV2), extra: true },
    { ...clone(facturaPayloadV2), schema_version: '2' },
    { ...clone(facturaPayloadV2), ancho_mm: '80' },
    { ...clone(facturaPayloadV2), impresora_logica: 'cocina' },
    { ...clone(facturaPayloadV2), source: { ...facturaPayloadV2.source, extra: true } },
    { ...clone(facturaPayloadV2), source: { id_factura: '6', id_pedido: 7 } },
    { ...clone(facturaPayloadV2), source: { id_factura: null, id_pedido: 7 } },
    { ...clone(pendingComandaPayloadV2), source: { id_factura: null, id_pedido: null } },
    {
      ...clone(facturaPayloadV2),
      documento_canonico: { ...facturaPayloadV2.documento_canonico, extra: true }
    },
    {
      ...clone(facturaPayloadV2),
      documento_canonico: { ...facturaPayloadV2.documento_canonico, content_bytes: (2 * 1024 * 1024) + 1 }
    }
  ];
  for (const invalidPayload of invalidPayloads) assert.equal(validatePrintPayload(invalidPayload).ok, false);
});

test('firmador QZ acepta exactamente factura PDF oficial y comanda HTML canonica', async () => {
  assert.deepEqual(facturaDataV2.options, {
    altFontRendering: true,
    ignoreTransparency: true
  });
  assert.deepEqual(comandaDataV2.options, { pageWidth: 58 });
  const fixtures = [
    { id: 8, currentPayload: facturaPayloadV2, dataItem: facturaDataV2 },
    { id: 9, currentPayload: comandaPayloadV2, dataItem: comandaDataV2 },
    { id: 10, currentPayload: pendingComandaPayloadV2, dataItem: comandaDataV2 }
  ];

  for (const fixture of fixtures) {
    const now = Date.now();
    const job = canonicalJob(fixture);
    const request = canonicalPrintRequest({ timestamp: now, jobId: fixture.id, dataItem: fixture.dataItem });
    assert.equal(request.params.options.scaleContent, false);
    const scopedDb = createSigningDb({ job });
    const result = await authorizeAndSignAgentQzRequest({
      agent,
      jobId: fixture.id,
      request,
      digest: digestFor(request),
      db: scopedDb.db,
      now,
      signer: async () => `sig-${fixture.currentPayload.tipo_documento}`
    });
    assert.equal(result.signature, `sig-${fixture.currentPayload.tipo_documento}`);
    assert.equal(result.idempotent, false);
    const jobSelect = scopedDb.calls.find((call) => call.sql.includes('FROM public.trabajos_impresion'));
    assert.deepEqual(jobSelect.params, [fixture.id, agent.id_sucursal, agent.id_agente]);
    assert.equal(scopedDb.calls.filter((call) => call.sql.includes('INSERT INTO public.firmas_qz_agente_solicitudes')).length, 1);
  }
});

test('firmador QZ rechaza contenido canonico v2 alterado', () => {
  const now = Date.now();
  const facturaJob = canonicalJob();
  const alteredPdf = {
    ...facturaDataV2,
    data: Buffer.from('%PDF-1.4\ncontenido alterado\n%%EOF\n', 'utf8').toString('base64')
  };
  const alteredInvoiceRequest = canonicalPrintRequest({ timestamp: now, dataItem: alteredPdf });
  assert.throws(
    () => validateAgentQzRequest({ request: alteredInvoiceRequest, job: facturaJob, now }),
    (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
  );

  const comandaJob = canonicalJob({ id: 9, currentPayload: comandaPayloadV2 });
  const alteredHtmlRequest = canonicalPrintRequest({
    timestamp: now,
    jobId: 9,
    dataItem: { ...comandaDataV2, data: `${comandaHtml}<p>ALTERADO</p>` }
  });
  assert.throws(
    () => validateAgentQzRequest({ request: alteredHtmlRequest, job: comandaJob, now }),
    (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
  );
});

test('firmador QZ v2 rechaza formato, flavor, ancho, copias, jobName y opciones inseguras', () => {
  const now = Date.now();
  const job = canonicalJob();
  const invalidMutations = [
    (request) => { request.params.data[0].format = 'html'; },
    (request) => { request.params.data[0].flavor = 'plain'; },
    (request) => { request.params.data[0].options.pageWidth = 58; },
    (request) => { request.params.data[0].options.pageWidth = '80'; },
    (request) => { request.params.data[0].options.extra = true; },
    (request) => { request.params.data[0].options.altFontRendering = false; },
    (request) => { request.params.data[0].options.ignoreTransparency = false; },
    (request) => { delete request.params.data[0].options.altFontRendering; },
    (request) => { delete request.params.data[0].options.ignoreTransparency; },
    (request) => { request.params.options.copies = 2; },
    (request) => { request.params.options.copies = '1'; },
    (request) => { request.params.options.jobName = 'Jonny-otro'; },
    (request) => { request.params.options.margins = 1; },
    (request) => { request.params.options.margins = '0'; },
    (request) => { request.params.options.scaleContent = true; },
    (request) => { delete request.params.options.scaleContent; },
    (request) => { request.params.options.units = 'in'; },
    (request) => { request.params.options.duplex = true; },
    (request) => { request.params.options.command = 'arbitrario'; }
  ];

  for (const mutate of invalidMutations) {
    const request = canonicalPrintRequest({ timestamp: now, dataItem: clone(facturaDataV2) });
    mutate(request);
    assert.throws(
      () => validateAgentQzRequest({ request, job, now }),
      (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
    );
  }
});

test('firmador QZ v2 exige solo pageWidth para comanda', () => {
  const now = Date.now();
  const job = canonicalJob({ id: 9, currentPayload: comandaPayloadV2 });
  const accepted = canonicalPrintRequest({ timestamp: now, jobId: 9, dataItem: clone(comandaDataV2) });
  assert.deepEqual(accepted.params.data[0].options, { pageWidth: 58 });
  assert.equal(validateAgentQzRequest({ request: accepted, job, now }).call, 'print');

  for (const invalidOptions of [
    { altFontRendering: true, ignoreTransparency: true },
    { pageWidth: 58, altFontRendering: true },
    { pageWidth: 58, ignoreTransparency: true },
    { pageWidth: 58, extra: true }
  ]) {
    const request = canonicalPrintRequest({ timestamp: now, jobId: 9, dataItem: clone(comandaDataV2) });
    request.params.data[0].options = invalidOptions;
    assert.throws(
      () => validateAgentQzRequest({ request, job, now }),
      (error) => error.code === 'QZ_SIGN_REQUEST_NOT_RELATED'
    );
  }
});

test('v2 conserva idempotencia, maximo una firma print y aislamiento por sucursal', async () => {
  const now = Date.now();
  const job = canonicalJob();
  const request = canonicalPrintRequest({ timestamp: now });
  let signerCalls = 0;
  const idempotentDb = createSigningDb({ job, existing: 'stored-v2-signature' });
  const idempotent = await authorizeAndSignAgentQzRequest({
    agent,
    jobId: job.id_trabajo,
    request,
    digest: digestFor(request),
    db: idempotentDb.db,
    now,
    signer: async () => { signerCalls += 1; return 'new-signature'; }
  });
  assert.equal(idempotent.signature, 'stored-v2-signature');
  assert.equal(idempotent.idempotent, true);
  assert.equal(signerCalls, 0);

  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({
      agent,
      jobId: job.id_trabajo,
      request,
      digest: digestFor(request),
      db: createSigningDb({ job, priorPrint: true }).db,
      now,
      signer: async () => 'must-not-sign'
    }),
    (error) => error.code === 'QZ_SIGN_PRINT_ALREADY_AUTHORIZED'
  );

  const wrongBranchAgent = { ...agent, id_sucursal: 10 };
  const branchDb = createTransactionalDb(async (sql, params) => {
    if (sql.includes('FROM public.trabajos_impresion')) {
      return { rows: params[1] === agent.id_sucursal ? [job] : [] };
    }
    return { rows: [] };
  });
  await assert.rejects(
    () => authorizeAndSignAgentQzRequest({
      agent: wrongBranchAgent,
      jobId: job.id_trabajo,
      request,
      digest: digestFor(request),
      db: branchDb.db,
      now,
      signer: async () => 'must-not-sign'
    }),
    (error) => error.code === 'QZ_SIGN_JOB_NOT_ACTIVE'
  );
  const scopedSelect = branchDb.calls.find((call) => call.sql.includes('FROM public.trabajos_impresion'));
  assert.deepEqual(scopedSelect.params, [job.id_trabajo, wrongBranchAgent.id_sucursal, wrongBranchAgent.id_agente]);
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
  const request = { call: 'printers.find', params: {}, timestamp: now };
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
    [{ call: 'printers.find', params: {}, timestamp: now - 60_000 }, 'QZ_SIGN_REQUEST_EXPIRED'],
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
