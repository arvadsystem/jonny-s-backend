import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  buildVentaTicketPdfBuffer,
  buildVentaTicketPdfDefinition,
  mmToPt
} from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildComandaCocinaHtml } from '../services/comandaCocinaHtmlService.js';
import { buildVentaKitchenPrintPayload } from '../routers/ventas/handlers/ventasPrintHandlers.js';
import { buildPedidoKitchenPrintPayload } from '../routers/ventas/services/pedidoKitchenPrintPayloadService.js';
import {
  createCanonicalPrintJob,
  createCanonicalPrintJobPayload,
  getCanonicalPrintDocumentForAgent,
  HISTORICAL_V2_DOCUMENT_CANDIDATES,
  MAX_CANONICAL_PDF_BYTES,
  renderCanonicalPrintJobDocument,
  validateCanonicalPrintPayload
} from '../services/printJobDocumentService.js';
import { validateCanonicalPrintJobData } from '../print-agent/src/documentRenderer.js';
import { formatHondurasDateTime } from '../utils/hondurasDateTime.js';
import { normalizarDatosTicketDesdeSnapshot } from '../services/facturacionSnapshotService.js';

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

const pendingComandaFixture = {
  ...structuredClone(comandaFixture),
  id_factura: null
};

test('regeneracion canonica conserva configuracion historica sin consultar configuracion viva', async () => {
  let liveQueries = 0;
  const historical = await normalizarDatosTicketDesdeSnapshot({
    client: {
      query: async () => {
        liveQueries += 1;
        throw new Error('configuracion viva no debe consultarse');
      }
    },
    factura: {
      id_sucursal: 9,
      facturacion_snapshot: {
        id_sucursal: 9,
        emisor: {
          nombre_emisor: 'Emisor historico',
          logo_url: 'https://historico.invalid/logo.png'
        },
        ticket: {
          ancho_ticket_mm: 58,
          mostrar_logo_ticket: false,
          texto_pie_ticket: 'Pie historico'
        },
        fiscal: { habilitado: false }
      }
    },
    useHistoricalSnapshot: true
  });

  assert.equal(liveQueries, 0);
  assert.equal(historical.emisor.nombre_emisor, 'Emisor historico');
  assert.equal(historical.emisor.logo_url, 'https://historico.invalid/logo.png');
  assert.equal(historical.ticket.ancho_ticket_mm, 58);
  assert.equal(historical.ticket.texto_pie_ticket, 'Pie historico');
});

const COMANDA_RENDER_BASELINES = Object.freeze({
  58: Object.freeze({
    bytes: 7157,
    sha256: 'baeb2287eb5b90794e73112db5fd81de56d2ac2dc8bc563020c7749b8bd295c3'
  }),
  80: Object.freeze({
    bytes: 7160,
    sha256: '958c2fc558ea96770aebda8276e631b75a5c3fd32be6f975a97d266ece80caa5'
  })
});

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

const buildJob = ({ payload, state = 'imprimiendo', leaseActive = true, persisted = null }) => ({
  id_trabajo: 91,
  id_sucursal: agent.id_sucursal,
  id_agente_tomado: agent.id_agente,
  tipo_documento: payload.tipo_documento,
  estado: state,
  payload,
  id_factura: payload.source.id_factura,
  id_pedido: payload.source.id_pedido,
  lease_active: leaseActive,
  ...(persisted || {})
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

test('comanda prioriza modalidad persistida sin traducirla para todos los canales', () => {
  const cases = [
    ['POS', 'CONSUMO_LOCAL'],
    ['POS', 'RECOGER'],
    ['POS', 'DELIVERY'],
    ['WEB', 'CONSUMO_LOCAL'],
    ['TELEFONO', 'RECOGER'],
    ['WHATSAPP', 'DELIVERY']
  ];
  let referenceStyle = null;

  for (const [canal, modalidad] of cases) {
    const normalized = buildVentaKitchenPrintPayload({
      ...structuredClone(comandaFixture),
      modalidad: 'RECOGER',
      contexto: {
        ...comandaFixture.contexto,
        canal,
        modalidad
      }
    });
    assert.equal(normalized.modalidad, modalidad);
    const html = buildComandaCocinaHtml(normalized, { widthMm: 80 });
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert.ok(style);
    referenceStyle ??= style;
    assert.equal(style, referenceStyle);
    assert.match(style, /size:\s*80mm auto/);
    assert.match(style, /width:\s*61\.5mm/);
    assert.match(style, /margin-left:\s*7mm/);
    assert.match(style, /margin-right:\s*10mm/);
    assert.match(html, new RegExp(`<span>Modalidad</span>\\s*<span>${modalidad}</span>`));
    if (modalidad === 'CONSUMO_LOCAL') assert.doesNotMatch(html, /<span>RECOGER<\/span>/);
  }
});

test('cargador de pedido pendiente prioriza modalidad_contexto sobre tipo_entrega', async () => {
  let modalidadContexto = 'CONSUMO_LOCAL';
  let idFacturaPago = null;
  let idFacturaExistente = null;
  const queryRunner = {
    query: async (sql) => {
      if (sql.includes('information_schema.')) return { rowCount: 1, rows: [{ exists: 1 }] };
      return {
        rowCount: 1,
        rows: [{
          id_pedido: 107,
          id_sucursal: 9,
          tipo_entrega: 'RECOGER',
          modalidad_contexto: modalidadContexto,
          id_factura_pago: idFacturaPago,
          id_factura_existente: idFacturaExistente,
          canal_contexto: 'POS',
          items: [{
            id_detalle: 1,
            tipo_item: 'RECETA',
            cantidad: 1,
            nombre_item: 'Alitas QA',
            extras: [],
            configuracion_menu: null
          }]
        }]
      };
    }
  };

  for (const modalidad of ['CONSUMO_LOCAL', 'RECOGER', 'DELIVERY']) {
    modalidadContexto = modalidad;
    const pedido = await buildPedidoKitchenPrintPayload(queryRunner, 107);
    assert.equal(pedido.id_factura, null);
    assert.equal(pedido.id_pedido, 107);
    assert.equal(pedido.contexto.modalidad, modalidad);
    assert.equal(pedido.modalidad, modalidad);
    const html = buildComandaCocinaHtml(pedido, { widthMm: 80 });
    assert.match(html, new RegExp(`<span>Modalidad</span>\\s*<span>${modalidad}</span>`));
    if (modalidad === 'CONSUMO_LOCAL') assert.doesNotMatch(html, /<span>RECOGER<\/span>/);
  }

  idFacturaExistente = 77;
  const paidPedido = await buildPedidoKitchenPrintPayload(queryRunner, 107);
  assert.equal(paidPedido.id_factura, null);
  assert.equal(paidPedido.pago.id_factura, 77);

  idFacturaPago = 78;
  const paidControlPedido = await buildPedidoKitchenPrintPayload(queryRunner, 107);
  assert.equal(paidControlPedido.pago.id_factura, 78);
});

test('comanda pendiente por id_pedido conserva exactamente documento, hashes y metricas 58/80', async () => {
  for (const widthMm of [58, 80]) {
    const paidPayload = await createCanonicalPrintJobPayload({
      tipoDocumento: 'comanda',
      venta: comandaFixture,
      widthMm
    });
    const pendingPayload = await createCanonicalPrintJobPayload({
      tipoDocumento: 'comanda',
      venta: pendingComandaFixture,
      widthMm
    });
    assert.deepEqual(pendingPayload.source, { id_factura: null, id_pedido: comandaFixture.id_pedido });
    assert.deepEqual(pendingPayload.documento_canonico, paidPayload.documento_canonico);
    assert.equal(validateCanonicalPrintPayload(pendingPayload).ok, true);

    const paidDocument = await renderCanonicalPrintJobDocument({ payload: paidPayload, venta: comandaFixture });
    const pendingDocument = await renderCanonicalPrintJobDocument({ payload: pendingPayload, venta: pendingComandaFixture });
    assert.deepEqual(pendingDocument, paidDocument);
    assert.deepEqual(pendingDocument.options, { pageWidth: widthMm });
    assert.equal(Buffer.byteLength(pendingDocument.data, 'utf8'), COMANDA_RENDER_BASELINES[widthMm].bytes);
    assert.equal(sha256(Buffer.from(pendingDocument.data, 'utf8')), COMANDA_RENDER_BASELINES[widthMm].sha256);
  }
});

test('contrato canonico exige factura para PDF y al menos un origen para comanda', async () => {
  await assert.rejects(
    () => createCanonicalPrintJobPayload({ tipoDocumento: 'factura', venta: pendingComandaFixture, widthMm: 80 }),
    (error) => error.code === 'PRINT_DOCUMENT_FACTURA_INVALID'
  );
  await assert.rejects(
    () => createCanonicalPrintJobPayload({
      tipoDocumento: 'comanda',
      venta: { ...pendingComandaFixture, id_pedido: null },
      widthMm: 80
    }),
    (error) => error.code === 'PRINT_DOCUMENT_SOURCE_INVALID'
  );
});

test('schema 2 corregido usa PDF/base64 para factura y HTML/plain para comanda', async () => {
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
  assert.match(
    fixture.calls[0].sql,
    /ti\.id_trabajo=\$1 AND ti\.id_sucursal=\$2 AND ti\.id_agente_tomado=\$3/
  );
  assert.deepEqual(fixture.calls[0].params, [91, agent.id_sucursal, agent.id_agente]);
  assert.deepEqual(loadArgs, {
    idFactura: facturaFixture.id_factura,
    idSucursal: agent.id_sucursal,
    includePrintAssets: true,
    normalizeStandaloneExtras: true,
    useHistoricalFacturacionSnapshot: true
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

test('agente recupera comanda pendiente solo por id_pedido y sucursal autorizada', async () => {
  const payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'comanda',
    venta: pendingComandaFixture,
    widthMm: 80
  });
  let pedidoArgs;
  let ventaLoads = 0;
  const result = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload, state: 'confirmacion_pendiente', leaseActive: false })).db,
    loadVenta: async () => {
      ventaLoads += 1;
      return facturaFixture;
    },
    loadPedido: async (args) => {
      pedidoArgs = args;
      return pendingComandaFixture;
    }
  });

  assert.equal(ventaLoads, 0);
  assert.equal(pedidoArgs.idPedido, pendingComandaFixture.id_pedido);
  assert.equal(pedidoArgs.idSucursal, agent.id_sucursal);
  assert.equal(result.document.format, 'html');
  assert.match(result.document.data, /VTA-00007/);

  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(buildJob({ payload })).db,
      loadPedido: async () => ({ ...pendingComandaFixture, id_sucursal: 10 })
    }),
    (error) => error.code === 'PRINT_DOCUMENT_SOURCE_NOT_FOUND'
  );
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

// --- Compatibilidad v2 legacy / v2 corregido -------------------------------

// Descriptores byte-exactos del commit 911a9b3 (previo a 3eea227). Un trabajo v2
// encolado con estos hashes debe seguir regenerandose identico tras el cambio.
const LEGACY_V2_BASELINES = Object.freeze({
  factura: Object.freeze({
    bytes: 22791,
    sha256: '302cd89d1bc6afc40703b9f105c585c696d8fa8dcd1f2a14684680efff20349f'
  }),
  comanda58: Object.freeze({
    bytes: 7161,
    sha256: '3981b0a1d20b184ca403a52fa94b8b92baa835f6b38f6b48e495eafccce201c1'
  }),
  comanda80: Object.freeze({
    bytes: 7164,
    sha256: 'f5393514518e2c62b84b19b2eba53b9866a261c2ba0fe042e2b75d551493cdc8'
  })
});

const buildLegacyV2Payload = ({ tipoDocumento, descriptor, widthMm, source }) => ({
  schema_version: 2,
  tipo_documento: tipoDocumento,
  impresora_logica: tipoDocumento === 'factura' ? 'factura' : 'cocina',
  ancho_mm: widthMm,
  source,
  documento_canonico: {
    kind: tipoDocumento === 'factura' ? 'venta_ticket_pdf' : 'comanda_cocina_html',
    format: tipoDocumento === 'factura' ? 'pdf' : 'html',
    flavor: tipoDocumento === 'factura' ? 'base64' : 'plain',
    content_sha256: descriptor.sha256,
    content_bytes: descriptor.bytes
  }
});

test('el renderizador legacy reproduce byte a byte los documentos v2 previos a 3eea227', async () => {
  const facturaPdf = await buildVentaTicketPdfBuffer(facturaFixture, { legacy: true });
  assert.equal(facturaPdf.length, LEGACY_V2_BASELINES.factura.bytes);
  assert.equal(sha256(facturaPdf), LEGACY_V2_BASELINES.factura.sha256);

  for (const widthMm of [58, 80]) {
    const html = Buffer.from(buildComandaCocinaHtml(comandaFixture, { widthMm, legacy: true }), 'utf8');
    const baseline = LEGACY_V2_BASELINES[`comanda${widthMm}`];
    assert.equal(html.length, baseline.bytes);
    assert.equal(sha256(html), baseline.sha256);
  }
});

test('un trabajo v2 encolado antes del cambio NO dispara PRINT_DOCUMENT_CHANGED', async () => {
  const payload = buildLegacyV2Payload({
    tipoDocumento: 'factura',
    descriptor: LEGACY_V2_BASELINES.factura,
    widthMm: 80,
    source: { id_factura: facturaFixture.id_factura, id_pedido: null }
  });
  assert.equal(validateCanonicalPrintPayload(payload).ok, true);

  // Misma venta historica -> el backend regenera exactamente los bytes v2.
  const dataItem = await renderCanonicalPrintJobDocument({ payload, venta: facturaFixture });
  const bytes = Buffer.from(dataItem.data, 'base64');
  assert.equal(bytes.length, LEGACY_V2_BASELINES.factura.bytes);
  assert.equal(sha256(bytes), LEGACY_V2_BASELINES.factura.sha256);

  // El agente valida el documento v2 contra el descriptor almacenado sin re-render.
  const validated = validateCanonicalPrintJobData(payload, dataItem);
  assert.equal(validated.format, 'pdf');
});

test('agente prueba v2 corregido antes del fallback v2 legacy para trabajos sin contenido persistido', async () => {
  const payload = buildLegacyV2Payload({
    tipoDocumento: 'factura',
    descriptor: LEGACY_V2_BASELINES.factura,
    widthMm: 80,
    source: { id_factura: facturaFixture.id_factura, id_pedido: null }
  });
  const sourceAttempts = [];

  const result = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload })).db,
    loadVenta: async ({ normalizeStandaloneExtras, useHistoricalFacturacionSnapshot }) => {
      sourceAttempts.push({ normalizeStandaloneExtras, useHistoricalFacturacionSnapshot });
      return { status: 200, body: facturaFixture };
    }
  });

  assert.deepEqual(sourceAttempts, [
    { normalizeStandaloneExtras: true, useHistoricalFacturacionSnapshot: true },
    { normalizeStandaloneExtras: true, useHistoricalFacturacionSnapshot: false },
    { normalizeStandaloneExtras: false, useHistoricalFacturacionSnapshot: true }
  ]);
  const bytes = Buffer.from(result.document.data, 'base64');
  assert.equal(bytes.length, LEGACY_V2_BASELINES.factura.bytes);
  assert.equal(sha256(bytes), LEGACY_V2_BASELINES.factura.sha256);
});

test('fallback v2 usa orden explicito y detiene candidatos despues de la primera coincidencia', async () => {
  assert.deepEqual(HISTORICAL_V2_DOCUMENT_CANDIDATES.map((candidate) => candidate.name), [
    'current-historical-snapshot',
    'current-previous-loader',
    'legacy-historical-snapshot',
    'legacy-previous-loader'
  ]);

  const currentPayload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura', venta: facturaFixture, widthMm: 80
  });
  const alteredVenta = structuredClone(facturaFixture);
  alteredVenta.items[0].nombre_item = 'Fuente historica diferente';
  const currentAttempts = [];
  await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload: currentPayload })).db,
    loadVenta: async (args) => {
      currentAttempts.push({
        normalizeStandaloneExtras: args.normalizeStandaloneExtras,
        useHistoricalFacturacionSnapshot: args.useHistoricalFacturacionSnapshot
      });
      return {
        status: 200,
        body: args.useHistoricalFacturacionSnapshot ? alteredVenta : facturaFixture
      };
    }
  });
  assert.deepEqual(currentAttempts, [
    { normalizeStandaloneExtras: true, useHistoricalFacturacionSnapshot: true },
    { normalizeStandaloneExtras: true, useHistoricalFacturacionSnapshot: false }
  ]);

  const legacyPayload = buildLegacyV2Payload({
    tipoDocumento: 'factura',
    descriptor: LEGACY_V2_BASELINES.factura,
    widthMm: 80,
    source: { id_factura: facturaFixture.id_factura, id_pedido: null }
  });
  const legacyAttempts = [];
  const legacyResult = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload: legacyPayload })).db,
    loadVenta: async (args) => {
      legacyAttempts.push({
        normalizeStandaloneExtras: args.normalizeStandaloneExtras,
        useHistoricalFacturacionSnapshot: args.useHistoricalFacturacionSnapshot
      });
      const finalCandidate = args.normalizeStandaloneExtras === false
        && args.useHistoricalFacturacionSnapshot === false;
      return { status: 200, body: finalCandidate ? facturaFixture : alteredVenta };
    }
  });
  assert.deepEqual(legacyAttempts, HISTORICAL_V2_DOCUMENT_CANDIDATES.map((candidate) => ({
    normalizeStandaloneExtras: candidate.normalizeStandaloneExtras,
    useHistoricalFacturacionSnapshot: candidate.useHistoricalFacturacionSnapshot
  })));
  assert.equal(
    sha256(Buffer.from(legacyResult.document.data, 'base64')),
    LEGACY_V2_BASELINES.factura.sha256
  );
});

test('comanda v2 legacy regenera identico y es aceptada por el agente', async () => {
  for (const widthMm of [58, 80]) {
    const baseline = LEGACY_V2_BASELINES[`comanda${widthMm}`];
    const payload = buildLegacyV2Payload({
      tipoDocumento: 'comanda',
      descriptor: baseline,
      widthMm,
      source: { id_factura: comandaFixture.id_factura, id_pedido: comandaFixture.id_pedido }
    });
    const dataItem = await renderCanonicalPrintJobDocument({ payload, venta: comandaFixture });
    const bytes = Buffer.from(dataItem.data, 'utf8');
    assert.equal(bytes.length, baseline.bytes);
    assert.equal(sha256(bytes), baseline.sha256);
    assert.deepEqual(validateCanonicalPrintJobData(payload, dataItem).options, { pageWidth: widthMm });
  }
});

test('el agente acepta v2 corregido y legacy, pero rechaza schema v3', async () => {
  const currentV2Payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura',
    venta: facturaFixture,
    widthMm: 80
  });
  assert.equal(currentV2Payload.schema_version, 2);
  const currentV2DataItem = await renderCanonicalPrintJobDocument({ payload: currentV2Payload, venta: facturaFixture });
  assert.equal(validateCanonicalPrintJobData(currentV2Payload, currentV2DataItem).format, 'pdf');

  const v2Payload = buildLegacyV2Payload({
    tipoDocumento: 'factura',
    descriptor: LEGACY_V2_BASELINES.factura,
    widthMm: 80,
    source: { id_factura: facturaFixture.id_factura, id_pedido: null }
  });
  const v2DataItem = await renderCanonicalPrintJobDocument({ payload: v2Payload, venta: facturaFixture });
  assert.equal(validateCanonicalPrintJobData(v2Payload, v2DataItem).format, 'pdf');

  assert.notEqual(currentV2Payload.documento_canonico.content_sha256, v2Payload.documento_canonico.content_sha256);

  const unsupportedV3 = { ...currentV2Payload, schema_version: 3 };
  assert.equal(validateCanonicalPrintPayload(unsupportedV3).ok, false);
  assert.throws(
    () => validateCanonicalPrintJobData(unsupportedV3, currentV2DataItem),
    /PAYLOAD_V2_CANONICAL_INVALID/
  );
});

test('documento persistido conserva bytes aunque cambien logo y configuracion viva', async () => {
  const created = await createCanonicalPrintJob({
    tipoDocumento: 'factura',
    venta: facturaFixture,
    widthMm: 80
  });
  const content = Buffer.from(created.document.data, 'base64');
  const persisted = {
    persisted_document_id: 7001,
    persisted_job_id: 91,
    persisted_schema_version: 2,
    persisted_tipo_documento: 'factura',
    persisted_formato: 'pdf',
    persisted_flavor: 'base64',
    persisted_content: content,
    persisted_content_sha256: created.payload.documento_canonico.content_sha256,
    persisted_content_bytes: created.payload.documento_canonico.content_bytes
  };
  let renderSourceLoads = 0;
  const result = await getCanonicalPrintDocumentForAgent({
    agent,
    jobId: 91,
    db: createDocumentDb(buildJob({ payload: created.payload, persisted })).db,
    loadVenta: async () => {
      renderSourceLoads += 1;
      return {
        ...facturaFixture,
        facturacion: {
          ...facturaFixture.facturacion,
          ticket: { texto_pie_ticket: 'CAMBIO POSTERIOR' },
          logo_data_url: null
        }
      };
    }
  });

  assert.equal(renderSourceLoads, 0);
  assert.equal(result.document.data, created.document.data);
  assert.equal(sha256(Buffer.from(result.document.data, 'base64')), created.payload.documento_canonico.content_sha256);
});

test('documento persistido falla cerrado ante contenido, descriptor, tipo, schema o trabajo alterado', async () => {
  const created = await createCanonicalPrintJob({
    tipoDocumento: 'factura', venta: facturaFixture, widthMm: 80
  });
  const content = Buffer.from(created.document.data, 'base64');
  const persisted = {
    persisted_document_id: 7001,
    persisted_job_id: 91,
    persisted_schema_version: 2,
    persisted_tipo_documento: 'factura',
    persisted_formato: 'pdf',
    persisted_flavor: 'base64',
    persisted_content: content,
    persisted_content_sha256: created.payload.documento_canonico.content_sha256,
    persisted_content_bytes: created.payload.documento_canonico.content_bytes
  };
  const alteredContent = Buffer.from(content);
  alteredContent[alteredContent.length - 1] ^= 1;
  const mutations = [
    { name: 'contenido', value: { persisted_content: alteredContent } },
    { name: 'hash', value: { persisted_content_sha256: '0'.repeat(64) } },
    { name: 'bytes', value: { persisted_content_bytes: content.length + 1 } },
    { name: 'tipo', value: { persisted_tipo_documento: 'comanda' } },
    { name: 'formato', value: { persisted_formato: 'html' } },
    { name: 'flavor', value: { persisted_flavor: 'plain' } },
    { name: 'schema', value: { persisted_schema_version: 1 } },
    { name: 'otro trabajo', value: { persisted_job_id: 92 } }
  ];

  for (const mutation of mutations) {
    let sourceLoads = 0;
    await assert.rejects(
      () => getCanonicalPrintDocumentForAgent({
        agent,
        jobId: 91,
        db: createDocumentDb(buildJob({
          payload: created.payload,
          persisted: { ...persisted, ...mutation.value }
        })).db,
        loadVenta: async () => {
          sourceLoads += 1;
          return facturaFixture;
        }
      }),
      (error) => error.code === 'PRINT_DOCUMENT_STORED_INVALID',
      mutation.name
    );
    assert.equal(sourceLoads, 0, mutation.name);
  }

  const oversizedPayload = structuredClone(created.payload);
  oversizedPayload.documento_canonico.content_bytes = MAX_CANONICAL_PDF_BYTES + 1;
  await assert.rejects(
    () => getCanonicalPrintDocumentForAgent({
      agent,
      jobId: 91,
      db: createDocumentDb(buildJob({ payload: oversizedPayload, persisted })).db
    }),
    (error) => error.code === 'PRINT_DOCUMENT_JOB_MISMATCH'
  );
});

test('documento rechaza sucursal o agente inconsistentes aunque el adaptador devuelva una fila', async () => {
  const payload = await createCanonicalPrintJobPayload({
    tipoDocumento: 'factura', venta: facturaFixture, widthMm: 80
  });
  for (const mismatch of [
    { id_sucursal: agent.id_sucursal + 1 },
    { id_agente_tomado: '22222222-2222-2222-2222-222222222222' }
  ]) {
    await assert.rejects(
      () => getCanonicalPrintDocumentForAgent({
        agent,
        jobId: 91,
        db: createDocumentDb({ ...buildJob({ payload }), ...mismatch }).db
      }),
      (error) => error.code === 'PRINT_DOCUMENT_JOB_NOT_ACTIVE'
    );
  }
});
