import crypto from 'node:crypto';
import pool from '../config/db-connection.js';
import { buildVentaDetailPayloadForScope } from '../routers/ventas/handlers/ventasReadHandlers.js';
import { buildPedidoKitchenPrintPayload } from '../routers/ventas/services/pedidoKitchenPrintPayloadService.js';
import {
  assertKitchenPrintPayload
} from '../routers/ventas/services/kitchenPrintRoutingService.js';
import { buildVentaTicketPdfBuffer } from '../routers/ventas/services/ventaTicketPdfService.js';
import { buildComandaCocinaHtml } from './comandaCocinaHtmlService.js';

export const LEGACY_CANONICAL_PRINT_SCHEMA_VERSION = 2;
export const CANONICAL_PRINT_SCHEMA_VERSION = 2;
export const SUPPORTED_CANONICAL_SCHEMA_VERSIONS = Object.freeze([CANONICAL_PRINT_SCHEMA_VERSION]);
export const MAX_CANONICAL_PDF_BYTES = 2 * 1024 * 1024;
export const MAX_CANONICAL_HTML_BYTES = 256 * 1024;
export const MAX_AGENT_QZ_SIGN_REQUEST_BYTES = 3 * 1024 * 1024;
// Los trabajos nuevos retornan primero sus bytes persistidos. Esta lista solo
// intenta recuperar, de forma best-effort, trabajos v2 historicos sin contenido;
// ningun candidato modifica el descriptor ni persiste el resultado regenerado.
export const HISTORICAL_V2_DOCUMENT_CANDIDATES = Object.freeze([
  Object.freeze({
    name: 'current-historical-snapshot',
    renderVariant: 'current',
    normalizeStandaloneExtras: true,
    useHistoricalFacturacionSnapshot: true
  }),
  Object.freeze({
    name: 'current-previous-loader',
    renderVariant: 'current',
    normalizeStandaloneExtras: true,
    useHistoricalFacturacionSnapshot: false
  }),
  Object.freeze({
    name: 'pre-routing-historical-snapshot',
    renderVariant: 'pre-routing',
    normalizeStandaloneExtras: true,
    applyOperationalRouting: false,
    useHistoricalFacturacionSnapshot: true
  }),
  Object.freeze({
    name: 'pre-routing-previous-loader',
    renderVariant: 'pre-routing',
    normalizeStandaloneExtras: true,
    applyOperationalRouting: false,
    useHistoricalFacturacionSnapshot: false
  }),
  Object.freeze({
    name: 'legacy-historical-snapshot',
    renderVariant: 'legacy',
    normalizeStandaloneExtras: false,
    useHistoricalFacturacionSnapshot: true
  }),
  Object.freeze({
    name: 'legacy-previous-loader',
    renderVariant: 'legacy',
    normalizeStandaloneExtras: false,
    useHistoricalFacturacionSnapshot: false
  })
]);

const PAYLOAD_KEYS = Object.freeze([
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
  && expectedKeys.every((key) => Object.hasOwn(value, key))
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
const parsePositiveId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const resolveWidth = (value) => Number(value) === 58 ? 58 : 80;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const printDocumentError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

const getDocumentContract = (tipoDocumento) => {
  if (tipoDocumento === 'factura') {
    return {
      logicalPrinter: 'factura',
      kind: 'venta_ticket_pdf',
      format: 'pdf',
      flavor: 'base64',
      maxBytes: MAX_CANONICAL_PDF_BYTES
    };
  }
  if (tipoDocumento === 'comanda') {
    return {
      logicalPrinter: 'cocina',
      kind: 'comanda_cocina_html',
      format: 'html',
      flavor: 'plain',
      maxBytes: MAX_CANONICAL_HTML_BYTES
    };
  }
  return null;
};

export const resolveCanonicalPrintWidth = ({ tipoDocumento, venta = {}, printerConfig = null }) => {
  if (String(tipoDocumento || '').toLowerCase() === 'factura') {
    return resolveWidth(venta?.facturacion?.ticket?.ancho_ticket_mm || venta?.ancho_ticket_mm);
  }
  const cocina = (Array.isArray(printerConfig?.impresoras) ? printerConfig.impresoras : [])
    .find((entry) => String(entry?.tipo_impresora || '').trim().toUpperCase() === 'COCINA');
  return resolveWidth(cocina?.ancho_mm);
};

export const validateCanonicalPrintPayload = (payload) => {
  if (!hasExactKeys(payload, PAYLOAD_KEYS)
    || !SUPPORTED_CANONICAL_SCHEMA_VERSIONS.includes(payload.schema_version)) {
    return { ok: false, message: 'Payload canonico de impresion no soportado.' };
  }

  const tipoDocumento = String(payload.tipo_documento || '').trim().toLowerCase();
  const contract = getDocumentContract(tipoDocumento);
  const widthMm = payload.ancho_mm;
  if (!contract
    || payload.tipo_documento !== tipoDocumento
    || payload.impresora_logica !== contract.logicalPrinter
    || ![58, 80].includes(widthMm)
    || !hasExactKeys(payload.source, SOURCE_KEYS)
    || !hasExactKeys(payload.documento_canonico, DOCUMENT_KEYS)) {
    return { ok: false, message: 'Contrato canonico de impresion invalido.' };
  }

  const rawIdFactura = payload.source.id_factura;
  const rawIdPedido = payload.source.id_pedido;
  const idFactura = Number.isSafeInteger(rawIdFactura) && rawIdFactura > 0
    ? rawIdFactura
    : null;
  const idPedido = rawIdPedido === null
    ? null
    : (Number.isSafeInteger(rawIdPedido) && rawIdPedido > 0
      ? rawIdPedido
      : null);
  const facturaFieldValid = rawIdFactura === null || idFactura !== null;
  const pedidoFieldValid = rawIdPedido === null || idPedido !== null;
  const sourceValid = tipoDocumento === 'factura'
    ? idFactura !== null
    : idFactura !== null || idPedido !== null;
  const document = payload.documento_canonico;
  if (!facturaFieldValid
    || !pedidoFieldValid
    || !sourceValid
    || document.kind !== contract.kind
    || document.format !== contract.format
    || document.flavor !== contract.flavor
    || !/^[a-f0-9]{64}$/.test(String(document.content_sha256 || ''))
    || !Number.isSafeInteger(document.content_bytes)
    || document.content_bytes <= 0
    || document.content_bytes > contract.maxBytes) {
    return { ok: false, message: 'Documento canonico de impresion invalido.' };
  }

  return {
    ok: true,
    value: payload,
    contract,
    idFactura,
    idPedido,
    widthMm,
    schemaVersion: payload.schema_version
  };
};

const decodeCanonicalBase64 = (value) => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
};

export const validateCanonicalPrintDataItem = (payload, item) => {
  const validation = validateCanonicalPrintPayload(payload);
  const expectedOptions = validation.ok ? buildCanonicalDataOptions(validation) : null;
  if (!validation.ok
    || !hasExactKeys(item, DATA_ITEM_KEYS)
    || item.type !== 'pixel'
    || item.format !== validation.contract.format
    || item.flavor !== validation.contract.flavor
    || !hasExactOptionValues(item.options, expectedOptions)) {
    return null;
  }

  let contentBytes;
  if (validation.contract.format === 'pdf') {
    contentBytes = decodeCanonicalBase64(item.data);
    if (!contentBytes || contentBytes.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  } else {
    if (typeof item.data !== 'string' || !/^<!doctype html>/i.test(item.data)) return null;
    contentBytes = Buffer.from(item.data, 'utf8');
  }

  const descriptor = payload.documento_canonico;
  if (contentBytes.length !== descriptor.content_bytes
    || contentBytes.length > validation.contract.maxBytes
    || sha256(contentBytes) !== descriptor.content_sha256) {
    return null;
  }
  return { contentBytes, validation };
};

const renderCanonicalDocument = async ({
  tipoDocumento,
  venta,
  widthMm,
  renderVariant = 'current'
}) => {
  const contract = getDocumentContract(tipoDocumento);
  if (!contract) throw printDocumentError('PRINT_DOCUMENT_TYPE_INVALID', 'Tipo de documento canonico invalido.', 400);

  const legacy = renderVariant === 'legacy';
  const applyOperationalRouting = renderVariant === 'current';
  const renderSource = tipoDocumento === 'comanda' && applyOperationalRouting
    ? {
        ...venta,
        requiere_cocina: true,
        items: assertKitchenPrintPayload(venta)
      }
    : venta;
  let contentBytes;
  let data;
  if (tipoDocumento === 'factura') {
    contentBytes = await buildVentaTicketPdfBuffer(renderSource, { legacy });
    if (!Buffer.isBuffer(contentBytes) || contentBytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw printDocumentError('PRINT_DOCUMENT_PDF_INVALID', 'El PDF canonico no es valido.');
    }
    data = contentBytes.toString('base64');
  } else {
    data = buildComandaCocinaHtml(renderSource, {
      widthMm,
      legacy,
      operationalSections: applyOperationalRouting
    });
    contentBytes = Buffer.from(data, 'utf8');
  }

  if (contentBytes.length <= 0 || contentBytes.length > contract.maxBytes) {
    throw printDocumentError('PRINT_DOCUMENT_TOO_LARGE', 'El documento canonico excede el tamano permitido.', 413);
  }

  return {
    descriptor: {
      kind: contract.kind,
      format: contract.format,
      flavor: contract.flavor,
      content_sha256: sha256(contentBytes),
      content_bytes: contentBytes.length
    },
    dataItem: {
      type: 'pixel',
      format: contract.format,
      flavor: contract.flavor,
      data,
      options: buildCanonicalDataOptions({ contract, widthMm })
    }
  };
};

export const createCanonicalPrintJob = async ({ tipoDocumento, venta, widthMm }) => {
  const normalizedType = String(tipoDocumento || '').trim().toLowerCase();
  const normalizedWidth = resolveWidth(widthMm);
  const idFactura = parsePositiveId(venta?.id_factura);
  const idPedido = parsePositiveId(venta?.id_pedido);
  const contract = getDocumentContract(normalizedType);
  if (!contract) {
    throw printDocumentError('PRINT_DOCUMENT_TYPE_INVALID', 'Tipo de documento canonico invalido.', 400);
  }
  if (normalizedType === 'factura' && !idFactura) {
    throw printDocumentError('PRINT_DOCUMENT_FACTURA_INVALID', 'La factura del documento es invalida.', 400);
  }
  if (normalizedType === 'comanda' && !idFactura && !idPedido) {
    throw printDocumentError('PRINT_DOCUMENT_SOURCE_INVALID', 'El origen de la comanda es invalido.', 400);
  }

  const rendered = await renderCanonicalDocument({
    tipoDocumento: normalizedType,
    venta,
    widthMm: normalizedWidth,
    renderVariant: 'current'
  });
  const payload = {
    schema_version: CANONICAL_PRINT_SCHEMA_VERSION,
    tipo_documento: normalizedType,
    impresora_logica: contract.logicalPrinter,
    ancho_mm: normalizedWidth,
    source: {
      id_factura: idFactura,
      id_pedido: idPedido
    },
    documento_canonico: rendered.descriptor
  };
  return { payload, document: rendered.dataItem };
};

export const createCanonicalPrintJobPayload = async (params) => (
  await createCanonicalPrintJob(params)
).payload;

export const renderCanonicalPrintJobDocument = async ({
  payload,
  venta,
  renderVariants = ['current', 'legacy']
}) => {
  const validation = validateCanonicalPrintPayload(payload);
  if (!validation.ok) {
    throw printDocumentError('PRINT_DOCUMENT_PAYLOAD_INVALID', validation.message, 400);
  }
  if (parsePositiveId(venta?.id_factura) !== validation.idFactura
    || parsePositiveId(venta?.id_pedido) !== validation.idPedido) {
    throw printDocumentError('PRINT_DOCUMENT_SOURCE_MISMATCH', 'La fuente del documento no coincide con el trabajo.', 409);
  }

  const variants = Array.isArray(renderVariants) ? renderVariants : [];
  for (const renderVariant of variants) {
    if (!['current', 'pre-routing', 'legacy'].includes(renderVariant)) continue;
    const rendered = await renderCanonicalDocument({
      tipoDocumento: payload.tipo_documento,
      venta,
      widthMm: validation.widthMm,
      renderVariant
    });
    if (rendered.descriptor.content_sha256 === payload.documento_canonico.content_sha256
      && rendered.descriptor.content_bytes === payload.documento_canonico.content_bytes) {
      return rendered.dataItem;
    }
  }
  throw printDocumentError('PRINT_DOCUMENT_CHANGED', 'El documento canonico cambio desde que se creo el trabajo.', 409);
};

const buildPersistedCanonicalDataItem = ({ job, validation }) => {
  if (job.persisted_document_id === null || job.persisted_document_id === undefined) return null;
  const contentBytes = Buffer.isBuffer(job.persisted_content)
    ? job.persisted_content
    : Buffer.from(job.persisted_content || []);
  const descriptor = job.payload.documento_canonico;
  if (Number(job.persisted_job_id) !== Number(job.id_trabajo)
    || Number(job.persisted_schema_version) !== validation.schemaVersion
    || job.persisted_tipo_documento !== job.tipo_documento
    || job.persisted_formato !== validation.contract.format
    || job.persisted_flavor !== validation.contract.flavor
    || job.persisted_content_sha256 !== descriptor.content_sha256
    || Number(job.persisted_content_bytes) !== descriptor.content_bytes
    || contentBytes.length !== descriptor.content_bytes
    || sha256(contentBytes) !== descriptor.content_sha256) {
    throw printDocumentError('PRINT_DOCUMENT_STORED_INVALID', 'El documento canonico persistido no es valido.', 409);
  }
  const dataItem = {
    type: 'pixel',
    format: validation.contract.format,
    flavor: validation.contract.flavor,
    data: validation.contract.format === 'pdf'
      ? contentBytes.toString('base64')
      : contentBytes.toString('utf8'),
    options: buildCanonicalDataOptions({ contract: validation.contract, widthMm: validation.widthMm })
  };
  if (!validateCanonicalPrintDataItem(job.payload, dataItem)) {
    throw printDocumentError('PRINT_DOCUMENT_STORED_INVALID', 'El documento canonico persistido no es valido.', 409);
  }
  return dataItem;
};

export const getCanonicalPrintDocumentForAgent = async ({
  agent,
  jobId,
  db = pool,
  loadVenta = null,
  loadPedido = null
}) => {
  const result = await db.query(
    `SELECT ti.id_trabajo,ti.id_sucursal,ti.id_agente_tomado,ti.tipo_documento,ti.estado,
            ti.payload,ti.id_factura,ti.id_pedido,
            (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
            ,tid.id_documento AS persisted_document_id
            ,tid.id_trabajo AS persisted_job_id
            ,tid.schema_version AS persisted_schema_version
            ,tid.tipo_documento AS persisted_tipo_documento
            ,tid.formato AS persisted_formato
            ,tid.flavor AS persisted_flavor
            ,tid.contenido AS persisted_content
            ,tid.content_sha256 AS persisted_content_sha256
            ,tid.content_bytes AS persisted_content_bytes
     FROM public.trabajos_impresion ti
     LEFT JOIN public.trabajos_impresion_documentos tid ON tid.id_trabajo=ti.id_trabajo
     WHERE ti.id_trabajo=$1 AND ti.id_sucursal=$2 AND ti.id_agente_tomado=$3
     LIMIT 1`,
    [jobId, agent.id_sucursal, agent.id_agente]
  );
  const job = result.rows[0];
  if (!job
    || Number(job.id_sucursal) !== Number(agent.id_sucursal)
    || String(job.id_agente_tomado || '') !== String(agent.id_agente || '')) {
    throw printDocumentError('PRINT_DOCUMENT_JOB_NOT_ACTIVE', 'Trabajo de impresion no autorizado.', 404);
  }

  const state = String(job.estado || '');
  const allowedState = state === 'confirmacion_pendiente'
    || (state === 'imprimiendo' && job.lease_active === true);
  if (!allowedState) {
    throw printDocumentError('PRINT_DOCUMENT_JOB_NOT_ACTIVE', 'El trabajo no esta activo para obtener su documento.', 409);
  }

  const validation = validateCanonicalPrintPayload(job.payload);
  if (!validation.ok
    || job.tipo_documento !== job.payload?.tipo_documento
    || parsePositiveId(job.id_factura) !== validation.idFactura
    || parsePositiveId(job.id_pedido) !== validation.idPedido) {
    throw printDocumentError('PRINT_DOCUMENT_JOB_MISMATCH', 'El documento no coincide con el trabajo reclamado.', 409);
  }

  const persistedDocument = buildPersistedCanonicalDataItem({ job, validation });
  if (persistedDocument) return { job, document: persistedDocument };

  const sourceCache = new Map();
  const loadSource = async ({
    normalizeStandaloneExtras,
    applyOperationalRouting = true,
    useHistoricalFacturacionSnapshot
  }) => {
    const cacheKey = validation.idFactura
      ? `factura:${normalizeStandaloneExtras}:${useHistoricalFacturacionSnapshot}`
      : `pedido:${normalizeStandaloneExtras}:${applyOperationalRouting}`;
    if (sourceCache.has(cacheKey)) return { cacheKey, venta: await sourceCache.get(cacheKey) };

    const sourcePromise = (async () => {
      let detailResult;
      if (validation.idFactura) {
        detailResult = loadVenta
          ? await loadVenta({
            idFactura: validation.idFactura,
            idSucursal: Number(agent.id_sucursal),
            includePrintAssets: job.tipo_documento === 'factura',
            normalizeStandaloneExtras,
            useHistoricalFacturacionSnapshot
          })
          : await buildVentaDetailPayloadForScope({
            idFactura: validation.idFactura,
            includePrintAssets: job.tipo_documento === 'factura',
            allowedSucursalIds: [Number(agent.id_sucursal)],
            limitedToLast72Hours: false,
            idUsuarioDetalle: null,
            normalizeStandaloneExtras,
            useHistoricalFacturacionSnapshot,
            queryRunner: db
          });
      } else if (job.tipo_documento === 'comanda' && validation.idPedido) {
        detailResult = loadPedido
          ? await loadPedido({
            idPedido: validation.idPedido,
            idSucursal: Number(agent.id_sucursal),
            normalizeStandaloneExtras,
            applyOperationalRouting,
            queryRunner: db
          })
          : await buildPedidoKitchenPrintPayload(db, validation.idPedido, {
            normalizeStandaloneExtras,
            applyOperationalRouting
          });
      }
      const venta = detailResult?.status === 200 ? detailResult.body : detailResult;
      if (!venta
        || parsePositiveId(venta.id_factura) !== validation.idFactura
        || parsePositiveId(venta.id_pedido) !== validation.idPedido
        || Number(venta.id_sucursal) !== Number(agent.id_sucursal)) {
        throw printDocumentError('PRINT_DOCUMENT_SOURCE_NOT_FOUND', 'No se encontro la fuente autorizada del documento.', 404);
      }
      return venta;
    })();
    sourceCache.set(cacheKey, sourcePromise);
    return { cacheKey, venta: await sourcePromise };
  };

  const attemptedRenders = new Set();
  let mismatchError = null;
  for (const candidate of HISTORICAL_V2_DOCUMENT_CANDIDATES) {
    const { cacheKey, venta } = await loadSource(candidate);
    const renderKey = `${candidate.renderVariant}:${cacheKey}`;
    if (attemptedRenders.has(renderKey)) continue;
    attemptedRenders.add(renderKey);
    try {
      return {
        job,
        document: await renderCanonicalPrintJobDocument({
          payload: job.payload,
          venta,
          renderVariants: [candidate.renderVariant]
        })
      };
    } catch (error) {
      if (error?.code !== 'PRINT_DOCUMENT_CHANGED') throw error;
      mismatchError = error;
    }
  }
  throw mismatchError || printDocumentError(
    'PRINT_DOCUMENT_CHANGED',
    'El documento canonico cambio desde que se creo el trabajo.',
    409
  );
};
