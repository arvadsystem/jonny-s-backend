import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildVentaTicketPdfBuffer,
  buildVentaTicketPdfDefinition,
  mmToPt
} from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import {
  createCanonicalPrintJobPayload,
  getCanonicalPrintDocumentForAgent,
  renderCanonicalPrintJobDocument
} from '../services/printJobDocumentService.js';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const agent = {
  id_agente: '11111111-1111-1111-1111-111111111111',
  id_sucursal: 9
};

const facturaFixture = {
  id_factura: 6,
  id_pedido: null,
  codigo_venta: 'VTA-00006',
  numero_venta: 'VTA-00006',
  fecha_hora_facturacion: '2026-07-17T18:34:00.000Z',
  id_sucursal: 9,
  nombre_sucursal: 'El Carmen',
  id_caja: 3,
  nombre_caja: 'Caja Principal',
  id_sesion_caja: 8006,
  nombre_usuario: 'Ana Cajera',
  cliente_nombre: 'Consumidor QA',
  cliente_rtn: '08011999123456',
  metodo_pago: 'Efectivo',
  sub_total: 245,
  descuento_total: 15,
  total: 230,
  efectivo_entregado: 300,
  cambio: 70,
  items: [
    {
      id_detalle: 61,
      cantidad: 2,
      nombre_item: 'Combo Jonny QA',
      precio_unitario: 122.5,
      sub_total: 245,
      total_linea: 230,
      extras: [{ nombre: 'Papas extra', cantidad: 1, precio_unitario: 10, subtotal: 10 }],
      complementos: [{ id_complemento: 4, nombre: 'BBQ' }],
      observacion: 'Sin cebolla'
    }
  ],
  facturacion: {
    emisor: {
      nombre_emisor: "JONNY'S WINGS QA",
      rtn_emisor: '08019000123456',
      direccion_emisor: 'Colonia El Carmen, Tegucigalpa',
      telefono_emisor: '2234-5678',
      correo_emisor: 'qa@jonnyshn.com',
      logo_data_url: ONE_PIXEL_PNG
    },
    ticket: {
      ancho_ticket_mm: 80,
      mostrar_logo_ticket: true,
      mostrar_rtn: true,
      mostrar_direccion: true,
      mostrar_telefono: true,
      mostrar_correo: false,
      mostrar_datos_fiscales: true,
      mostrar_cai_ticket: true,
      mostrar_numero_fiscal_ticket: true,
      mostrar_codigo_interno_ticket: true,
      mostrar_impuestos_ticket: false,
      mostrar_descuento_total: true,
      texto_encabezado_ticket: 'Factura QA',
      texto_pie_ticket: 'Gracias por su compra'
    },
    fiscal: {
      habilitado: true,
      modo_fiscal: 'INTEGRADO',
      cai: 'ABC123-DEF456-GHI789',
      numero_factura_fiscal: '000-001-01-00000006',
      id_rango_cai: 2
    }
  }
};

const comandaFixture = {
  id_factura: 7,
  id_pedido: 107,
  codigo_venta: 'VTA-00007',
  numero_venta: 'VTA-00007',
  numero_pedido: 'VTA-00007',
  fecha_hora_pedido: '2026-07-17T18:34:00.000Z',
  fecha_hora_facturacion: '2026-07-17T18:34:00.000Z',
  id_sucursal: 9,
  nombre_sucursal: 'El Carmen',
  nombre_usuario: 'Ana Cajera',
  modalidad: 'CONSUMO EN LOCAL',
  mesa_nombre: 'Mesa 4',
  cliente_nombre: 'Cliente Cocina QA',
  contacto: {
    nombre_contacto: 'Cliente Cocina QA',
    telefono_contacto: '9999-0007'
  },
  contexto: {
    mesa: 'Mesa 4',
    observacion_contexto: 'Entregar todo junto'
  },
  observaciones: 'Prioridad mesa infantil',
  items: [
    {
      id_detalle: 71,
      cantidad: 2,
      nombre_item: 'Alitas 12 piezas',
      extras: [{ id_extra: 3, nombre: 'Papas extra', cantidad: 1 }],
      complementos: [{ id_complemento: 4, nombre: 'BBQ' }],
      observacion: 'Una orden sin cebolla'
    }
  ]
};

const cloneForRequester = (venta, role, esReimpresion = false) => ({
  ...structuredClone(venta),
  solicitante: {
    role,
    es_reimpresion: esReimpresion
  }
});
const REQUESTER_ROLES = Object.freeze(['root', 'super_admin', 'admin', 'cajero']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const collectPdfDefinition = (value, result = { texts: [], images: [] }) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectPdfDefinition(entry, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  if (value.text !== undefined) result.texts.push(String(value.text));
  if (typeof value.image === 'string') result.images.push(value.image);
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'text' && key !== 'image') collectPdfDefinition(child, result);
  }
  return result;
};

const formatHondurasDateTime = (value) => new Intl.DateTimeFormat('es-HN', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'America/Tegucigalpa'
}).format(new Date(value));

const buildJob = ({ payload, state = 'imprimiendo', leaseActive = true }) => ({
  id_trabajo: 91,
  id_sucursal: agent.id_sucursal,
  id_agente_tomado: agent.id_agente,
  tipo_documento: payload.tipo_documento,
  estado: state,
  payload,
  id_factura: payload.source.id_factura,
  id_pedido: payload.source.id_pedido,
  lease_active: leaseActive
});

const createDocumentDb = (job) => {
  const calls = [];
  return {
    calls,
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: job ? [job] : [] };
      }
    }
  };
};

test('VTA-00006 conserva todos los campos del formato oficial en la definicion PDF', () => {
  const definition = buildVentaTicketPdfDefinition(facturaFixture);
  const content = collectPdfDefinition(definition);
  const text = content.texts.join('\n');

  assert.deepEqual(definition.pageMargins, [mmToPt(7), mmToPt(4), mmToPt(10), mmToPt(4)]);
  assert.equal(definition.pageSize.width, mmToPt(80));
  assert.equal(definition.info.creationDate.getTime(), new Date(facturaFixture.fecha_hora_facturacion).getTime());
  assert.equal(definition.info.modDate.getTime(), definition.info.creationDate.getTime());
  assert.deepEqual(content.images, [ONE_PIXEL_PNG]);

  for (const expected of [
    'RTN: 08019000123456',
    'Colonia El Carmen, Tegucigalpa',
    'Tel: 2234-5678',
    'ABC123-DEF456-GHI789',
    '000-001-01-00000006',
    'Caja Principal',
    '#8006',
    'Ana Cajera',
    'Consumidor QA',
    'Efectivo',
    'Combo Jonny QA',
    'Subtotal',
    'L 245.00',
    'TOTAL',
    'L 230.00',
    'L 300.00',
    'Cambio',
    'L 70.00'
  ]) {
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('VTA-00006 produce el mismo PDF y SHA-256 para root, super_admin, admin y cajero', async () => {
  const buffers = [];
  for (const role of REQUESTER_ROLES) {
    buffers.push(await buildVentaTicketPdfBuffer(cloneForRequester(facturaFixture, role)));
  }

  const reference = buffers[0];
  assert.equal(reference.subarray(0, 5).toString('ascii'), '%PDF-');
  for (const buffer of buffers.slice(1)) {
    assert.deepEqual(buffer, reference);
    assert.equal(sha256(buffer), sha256(reference));
  }
});

test('VTA-00007 genera la misma comanda para root, super_admin, admin y cajero sin totales', () => {
  const documents = REQUESTER_ROLES.map((role) => (
    buildComandaCocinaHtml(cloneForRequester(comandaFixture, role), { widthMm: 80 })
  ));
  const rootHtml = documents[0];

  for (const html of documents.slice(1)) assert.equal(html, rootHtml);
  assert.match(rootHtml, /<!doctype html>/i);
  assert.match(rootHtml, /size:\s*80mm auto/);
  assert.match(rootHtml, /width:\s*61\.5mm/);
  assert.match(rootHtml, /margin-left:\s*7mm/);
  assert.match(rootHtml, /margin-right:\s*10mm/);
  assert.match(rootHtml, new RegExp(formatHondurasDateTime(comandaFixture.fecha_hora_pedido).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const expected of [
    'VTA-00007',
    'CONSUMO EN LOCAL',
    'Mesa 4',
    'BBQ',
    'Papas extra',
    'Una orden sin cebolla',
    'Prioridad mesa infantil'
  ]) {
    assert.match(rootHtml, new RegExp(expected, 'i'));
  }
  assert.doesNotMatch(rootHtml, /\bTOTAL\b/i);
  assert.doesNotMatch(rootHtml, /L\s*0\.00/i);
});

test('schema 2 usa PDF/base64 para factura y HTML/plain para comanda', async () => {
  const initialFactura = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: cloneForRequester(facturaFixture, 'ROOT', false),
    widthMm: 80
  });
  const reprintFactura = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: cloneForRequester(facturaFixture, 'CAJERO', true),
    widthMm: 80
  });
  const initialComanda = await createCanonicalPrintJobPayload({
    tipoDocumento: 'comanda',
    venta: cloneForRequester(comandaFixture, 'ROOT', false),
    widthMm: 80
  });
  const reprintComanda = await createCanonicalPrintJobPayload({
    tipoDocumento: 'comanda',
    venta: cloneForRequester(comandaFixture, 'CAJERO', true),
    widthMm: 80
  });

  assert.equal(initialFactura.schema_version, 2);
  assert.equal(initialFactura.documento_canonico.format, 'pdf');
  assert.equal(initialFactura.documento_canonico.flavor, 'base64');
  assert.deepEqual(reprintFactura.documento_canonico, initialFactura.documento_canonico);
  assert.equal(initialComanda.schema_version, 2);
  assert.equal(initialComanda.documento_canonico.format, 'html');
  assert.equal(initialComanda.documento_canonico.flavor, 'plain');
  assert.deepEqual(reprintComanda.documento_canonico, initialComanda.documento_canonico);

  const pdfDocument = await renderCanonicalPrintJobDocument({
    payload: initialFactura,
    venta: facturaFixture
  });
  const htmlDocument = await renderCanonicalPrintJobDocument({
    payload: initialComanda,
    venta: comandaFixture
  });
  assert.deepEqual(
    { type: pdfDocument.type, format: pdfDocument.format, flavor: pdfDocument.flavor },
    { type: 'pixel', format: 'pdf', flavor: 'base64' }
  );
  assert.deepEqual(pdfDocument.options, {
    altFontRendering: true,
    ignoreTransparency: true
  });
  assert.equal(Object.hasOwn(pdfDocument.options, 'pageWidth'), false);
  const pdfBytes = Buffer.from(pdfDocument.data, 'base64');
  assert.equal(pdfBytes.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(pdfBytes.length, initialFactura.documento_canonico.content_bytes);
  assert.equal(sha256(pdfBytes), initialFactura.documento_canonico.content_sha256);
  assert.deepEqual(
    { type: htmlDocument.type, format: htmlDocument.format, flavor: htmlDocument.flavor },
    { type: 'pixel', format: 'html', flavor: 'plain' }
  );
  assert.deepEqual(htmlDocument.options, { pageWidth: 80 });
  assert.match(htmlDocument.data, /^<!doctype html>/i);
  const htmlBytes = Buffer.from(htmlDocument.data, 'utf8');
  assert.equal(htmlBytes.length, initialComanda.documento_canonico.content_bytes);
  assert.equal(sha256(htmlBytes), initialComanda.documento_canonico.content_sha256);
});

test('documento del agente exige trabajo asignado, sucursal y estado con lease activo', async () => {
  const payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: facturaFixture,
    widthMm: 80
  });
  const fixture = createDocumentDb(buildJob({ payload }));
  let loadArgs;
  const result = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: fixture.db,
    loadVenta: async (args) => {
      loadArgs = args;
      return { status: 200, body: cloneForRequester(facturaFixture, 'AGENT') };
    }
  });

  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.calls[0].sql, /id_trabajo=\$1 AND id_sucursal=\$2 AND id_agente_tomado=\$3/);
  assert.deepEqual(fixture.calls[0].params, [91, agent.id_sucursal, agent.id_agente]);
  assert.deepEqual(loadArgs, {
    idFactura: facturaFixture.id_factura,
    idSucursal: agent.id_sucursal,
    includePrintAssets: true
  });
  assert.equal(result.job.estado, 'imprimiendo');
  assert.equal(result.document.format, 'pdf');
  assert.equal(result.document.flavor, 'base64');

  const recovery = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload, state: 'confirmacion_pendiente', leaseActive: false })).db,
    loadVenta: async () => ({ status: 200, body: facturaFixture })
  });
  assert.equal(recovery.job.estado, 'confirmacion_pendiente');
  assert.equal(recovery.document.data, result.document.data);
});

test('documento del agente rechaza asignacion inexistente o lease invalido antes de cargar la venta', async () => {
  const payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: facturaFixture,
    widthMm: 80
  });
  let loadCalls = 0;
  const loadVenta = async () => {
    loadCalls += 1;
    return { status: 200, body: facturaFixture };
  };

  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(null).db,
      loadVenta
    }),
    (error) => error.code === 'PRINT_DOCUMENT_JOB_NOT_ACTIVE'
  );
  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(buildJob({ payload, state: 'imprimiendo', leaseActive: false })).db,
      loadVenta
    }),
    (error) => error.code === 'PRINT_DOCUMENT_JOB_NOT_ACTIVE'
  );
  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(buildJob({ payload, state: 'asignado', leaseActive: true })).db,
      loadVenta
    }),
    (error) => error.code === 'PRINT_DOCUMENT_JOB_NOT_ACTIVE'
  );
  assert.equal(loadCalls, 0);
});

test('documento del agente falla cerrado si el contenido regenerado fue alterado', async () => {
  const payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: facturaFixture,
    widthMm: 80
  });
  const alteredVenta = structuredClone(facturaFixture);
  alteredVenta.items[0].nombre_item = 'Contenido alterado';

  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(buildJob({ payload })).db,
      loadVenta: async () => ({ status: 200, body: alteredVenta })
    }),
    (error) => error.code === 'PRINT_DOCUMENT_CHANGED'
  );
});
