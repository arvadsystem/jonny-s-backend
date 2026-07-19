import crypto from 'node:crypto';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = (value) => `L ${Number(value || 0).toFixed(2)}`;

const PDF_MAX_BYTES = 2 * 1024 * 1024;
const HTML_MAX_BYTES = 256 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PAYLOAD_V2_KEYS = Object.freeze([
  'schema_version',
  'tipo_documento',
  'impresora_logica',
  'ancho_mm',
  'source',
  'documento_canonico'
]);
const SOURCE_KEYS = Object.freeze(['id_factura', 'id_pedido']);
const DOCUMENT_KEYS = Object.freeze(['kind', 'format', 'flavor', 'content_sha256', 'content_bytes']);
const DATA_ITEM_KEYS = Object.freeze(['type', 'format', 'flavor', 'data', 'options']);

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hasExactKeys = (value, expectedKeys) => (
  isPlainObject(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);
const buildCanonicalDataOptions = ({ contract, widthMm }) => (
  contract.format === 'pdf'
    ? { altFontRendering: true, ignoreTransparency: true }
    : { pageWidth: widthMm }
);
const hasExactOptionValues = (options, expected) => (
  hasExactKeys(options, Object.keys(expected))
  && Object.entries(expected).every(([key, value]) => options[key] === value)
);
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;
const invalidCanonicalDocument = () => {
  throw new Error('PAYLOAD_V2_CANONICAL_INVALID');
};

const validatePayloadV2 = (payload) => {
  if (!hasExactKeys(payload, PAYLOAD_V2_KEYS) || payload.schema_version !== 2) invalidCanonicalDocument();
  if (![58, 80].includes(payload.ancho_mm)) invalidCanonicalDocument();
  const facturaSourceValid = payload.source?.id_factura === null
    || isPositiveSafeInteger(payload.source?.id_factura);
  const pedidoSourceValid = payload.source?.id_pedido === null
    || isPositiveSafeInteger(payload.source?.id_pedido);
  const requiredSourcePresent = payload.tipo_documento === 'factura'
    ? isPositiveSafeInteger(payload.source?.id_factura)
    : payload.tipo_documento === 'comanda'
      && (isPositiveSafeInteger(payload.source?.id_factura) || isPositiveSafeInteger(payload.source?.id_pedido));
  if (!hasExactKeys(payload.source, SOURCE_KEYS)
    || !facturaSourceValid
    || !pedidoSourceValid
    || !requiredSourcePresent) {
    invalidCanonicalDocument();
  }
  if (!hasExactKeys(payload.documento_canonico, DOCUMENT_KEYS)) invalidCanonicalDocument();

  const contracts = {
    factura: {
      impresoraLogica: 'factura',
      kind: 'venta_ticket_pdf',
      format: 'pdf',
      flavor: 'base64',
      maxBytes: PDF_MAX_BYTES
    },
    comanda: {
      impresoraLogica: 'cocina',
      kind: 'comanda_cocina_html',
      format: 'html',
      flavor: 'plain',
      maxBytes: HTML_MAX_BYTES
    }
  };
  const contract = contracts[payload.tipo_documento];
  if (!contract
    || payload.impresora_logica !== contract.impresoraLogica
    || payload.documento_canonico.kind !== contract.kind
    || payload.documento_canonico.format !== contract.format
    || payload.documento_canonico.flavor !== contract.flavor
    || !/^[a-f0-9]{64}$/.test(payload.documento_canonico.content_sha256)
    || !isPositiveSafeInteger(payload.documento_canonico.content_bytes)
    || payload.documento_canonico.content_bytes > contract.maxBytes) {
    invalidCanonicalDocument();
  }
  return contract;
};

const decodeCanonicalContent = ({ contract, data }) => {
  if (typeof data !== 'string' || data.length === 0) invalidCanonicalDocument();
  if (contract.format === 'html') {
    if (Buffer.byteLength(data, 'utf8') > contract.maxBytes) invalidCanonicalDocument();
    return Buffer.from(data, 'utf8');
  }
  if (data.length > Math.ceil(contract.maxBytes / 3) * 4 || !BASE64_PATTERN.test(data)) {
    invalidCanonicalDocument();
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data || decoded.subarray(0, 5).toString('ascii') !== '%PDF-') {
    invalidCanonicalDocument();
  }
  return decoded;
};

export const validateCanonicalPrintJobData = (payload, dataItem) => {
  const contract = validatePayloadV2(payload);
  const expectedOptions = buildCanonicalDataOptions({ contract, widthMm: payload.ancho_mm });
  if (!hasExactKeys(dataItem, DATA_ITEM_KEYS)
    || dataItem.type !== 'pixel'
    || dataItem.format !== contract.format
    || dataItem.flavor !== contract.flavor
    || !hasExactOptionValues(dataItem.options, expectedOptions)) {
    invalidCanonicalDocument();
  }

  const content = decodeCanonicalContent({ contract, data: dataItem.data });
  if (content.length !== payload.documento_canonico.content_bytes || content.length > contract.maxBytes) {
    invalidCanonicalDocument();
  }
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');
  if (contentHash !== payload.documento_canonico.content_sha256) invalidCanonicalDocument();

  return Object.freeze({
    type: 'pixel',
    format: contract.format,
    flavor: contract.flavor,
    data: dataItem.data,
    options: Object.freeze({ ...expectedOptions })
  });
};

export const renderPrintJobHtml = (payload) => {
  if (Number(payload?.schema_version) !== 1 || !payload?.documento) throw new Error('PAYLOAD_NO_SOPORTADO');
  const doc = payload.documento;
  const rows = (Array.isArray(doc.items) ? doc.items : []).map((item) =>
    `<tr><td>${escapeHtml(item.cantidad)}</td><td>${escapeHtml(item.descripcion)}</td><td>${money(item.total)}</td></tr>`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;font-size:11px;margin:0;padding:2mm;color:#000}h1{text-align:center;font-size:16px;margin:0 0 4px}
    p{margin:2px 0}table{width:100%;border-collapse:collapse}td{vertical-align:top;padding:2px 0}td:last-child{text-align:right}
    .total{font-size:14px;font-weight:bold;border-top:1px dashed #000;margin-top:5px;padding-top:5px}.center{text-align:center}
  </style></head><body><h1>${escapeHtml(doc.titulo || "JONNY'S WINGS")}</h1>
  <p class="center">${escapeHtml(doc.sucursal || '')}</p><p>${escapeHtml(doc.numero || '')}</p><p>${escapeHtml(doc.fecha || '')}</p>
  <p>Cliente: ${escapeHtml(doc.cliente || 'Consumidor final')}</p><table>${rows}</table>
  ${Number(doc.descuento || 0) ? `<p>Descuento: ${money(doc.descuento)}</p>` : ''}<p class="total">TOTAL: ${money(doc.total)}</p>
  <p class="center">${escapeHtml(doc.pie || '')}</p></body></html>`;
};
