import crypto from 'node:crypto';
import pool from '../config/db-connection.js';
import { renderPrintJobHtml } from '../print-agent/src/documentRenderer.js';
import { signQzMessage } from '../routers/ventas/services/qzTraySigningService.js';
import { validateCanonicalPrintDataItem, validateCanonicalPrintPayload } from './printJobDocumentService.js';

const ALLOWED_CALLS = new Set(['printers.find', 'print']);
const REQUEST_MAX_AGE_MS = 30_000;
const MAX_FIND_AUTHORIZATIONS_PER_MINUTE = 5;

const qzRequestError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const validateFindParams = (params) => isPlainObject(params) && Object.keys(params).length === 0;

const SAFE_QZ_OPTION_VALUES = Object.freeze({
  bounds: null,
  colorType: 'color',
  density: 0,
  duplex: false,
  fallbackDensity: null,
  interpolation: 'bicubic',
  legacy: false,
  orientation: null,
  paperThickness: null,
  printerTray: null,
  rasterize: false,
  rotation: 0,
  scaleContent: false,
  size: null,
  forceRaw: false,
  encoding: null,
  spool: null
});
const QZ_PRINT_OPTION_KEYS = new Set([
  ...Object.keys(SAFE_QZ_OPTION_VALUES),
  'copies',
  'jobName',
  'margins',
  'units'
]);

const validatePrintTarget = (params, job) => {
  if (!isPlainObject(params)
    || Object.keys(params).length !== 3
    || !['printer', 'options', 'data'].every((key) => Object.hasOwn(params, key))
    || !isPlainObject(params.printer)
    || !isPlainObject(params.options)) return null;
  const printerKeys = Object.keys(params.printer);
  if (printerKeys.length !== 1 || printerKeys[0] !== 'name') return null;
  const printerName = String(params.printer.name || '').trim();
  if (!printerName || printerName.length > 160) return null;

  const optionKeys = Object.keys(params.options);
  if (optionKeys.some((key) => !QZ_PRINT_OPTION_KEYS.has(key))
    || params.options.copies !== 1
    || String(params.options.jobName || '') !== `Jonny-${job.id_trabajo}`
    || params.options.margins !== 0
    || params.options.scaleContent !== false
    || params.options.units !== 'mm') return null;
  for (const [key, expected] of Object.entries(SAFE_QZ_OPTION_VALUES)) {
    if (Object.hasOwn(params.options, key) && params.options[key] !== expected) return null;
  }
  if (!Array.isArray(params.data) || params.data.length !== 1) return null;
  return { printerName, item: params.data[0] };
};

const validatePrintParams = (params, job) => {
  const target = validatePrintTarget(params, job);
  if (!target) return null;
  const { printerName, item } = target;

  if (Number(job.payload?.schema_version) === 2) {
    const payloadValidation = validateCanonicalPrintPayload(job.payload);
    if (!payloadValidation.ok
      || job.tipo_documento !== job.payload.tipo_documento
      || Number(job.id_factura) !== payloadValidation.idFactura
      || (job.id_pedido === null ? null : Number(job.id_pedido)) !== payloadValidation.idPedido
      || !validateCanonicalPrintDataItem(job.payload, item)) return null;
    return { printerName };
  }

  if (!isPlainObject(item) || item.type !== 'pixel' || item.format !== 'html' || item.flavor !== 'plain') return null;
  if (typeof item.data !== 'string' || Buffer.byteLength(item.data, 'utf8') > 256 * 1024) return null;
  const expectedWidth = Number(job.payload?.ancho_mm) === 58 ? 58 : 80;
  if (Number(item.options?.pageWidth) !== expectedWidth) return null;
  let expectedHtml;
  try { expectedHtml = renderPrintJobHtml(job.payload); } catch { return null; }
  if (item.data !== expectedHtml) return null;
  return { printerName };
};

export const canonicalizeAgentQzRequest = (request) => JSON.stringify({
  call: request.call,
  params: request.params,
  timestamp: request.timestamp
});

export const validateAgentQzRequest = ({ request, job, now = Date.now() }) => {
  if (!isPlainObject(request)
    || Object.keys(request).length !== 3
    || Object.keys(request).some((key) => !['call', 'params', 'timestamp'].includes(key))) {
    throw qzRequestError('QZ_SIGN_REQUEST_INVALID', 'Estructura QZ invalida.');
  }
  const call = String(request.call || '');
  if (!ALLOWED_CALLS.has(call)) throw qzRequestError('QZ_SIGN_CALL_NOT_ALLOWED', 'Llamada QZ no permitida.', 403);
  if (!Number.isSafeInteger(request.timestamp) || Math.abs(now - request.timestamp) > REQUEST_MAX_AGE_MS) {
    throw qzRequestError('QZ_SIGN_REQUEST_EXPIRED', 'Solicitud QZ vencida.');
  }
  const state = String(job?.estado || '');
  let printerName = null;
  if (call === 'printers.find') {
    const activeState = state === 'confirmacion_pendiente' || (state === 'imprimiendo' && job.lease_active === true);
    if (!activeState || !validateFindParams(request.params)) {
      throw qzRequestError('QZ_SIGN_REQUEST_NOT_RELATED', 'Solicitud QZ no relacionada con el trabajo.', 403);
    }
  } else {
    const validatedPrint = state === 'confirmacion_pendiente' ? validatePrintParams(request.params, job) : null;
    if (!validatedPrint) {
      throw qzRequestError('QZ_SIGN_REQUEST_NOT_RELATED', 'Documento QZ no coincide con el trabajo reclamado.', 403);
    }
    printerName = validatedPrint.printerName;
  }
  return { call, printerName, canonical: canonicalizeAgentQzRequest(request) };
};

export const authorizeAndSignAgentQzRequest = async ({
  agent, jobId, request, digest, db = pool, signer = signQzMessage, now = Date.now()
}) => {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const shouldRelease = client !== db && typeof client.release === 'function';
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT id_trabajo,id_sucursal,id_agente_tomado,tipo_documento,estado,payload,id_factura,id_pedido,
              (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
       FROM public.trabajos_impresion
       WHERE id_trabajo=$1 AND id_sucursal=$2 AND id_agente_tomado=$3
       FOR UPDATE`,
      [jobId, agent.id_sucursal, agent.id_agente]
    );
    const job = jobResult.rows[0];
    if (!job) throw qzRequestError('QZ_SIGN_JOB_NOT_ACTIVE', 'Trabajo de impresion no autorizado.', 403);
    const { call, printerName, canonical } = validateAgentQzRequest({ request, job, now });
    const requestHash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    const normalizedDigest = String(digest || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) {
      throw qzRequestError('QZ_SIGN_DIGEST_INVALID', 'Hash QZ invalido.');
    }
    const digestMatches = crypto.timingSafeEqual(
      Buffer.from(requestHash, 'hex'),
      Buffer.from(normalizedDigest, 'hex')
    );
    if (!digestMatches) throw qzRequestError('QZ_SIGN_DIGEST_MISMATCH', 'Hash QZ no coincide con la operacion.', 403);

    const existingResult = await client.query(
      `SELECT signature
       FROM public.firmas_qz_agente_solicitudes
       WHERE id_agente=$1 AND id_trabajo=$2 AND llamada=$3 AND request_hash=$4
       LIMIT 1`,
      [agent.id_agente, jobId, call, requestHash]
    );
    if (existingResult.rows[0]?.signature) {
      await client.query('COMMIT');
      return { signature: existingResult.rows[0].signature, timestamp: request.timestamp, call, idempotent: true };
    }

    if (call === 'print') {
      const priorPrint = await client.query(
        `SELECT 1 FROM public.firmas_qz_agente_solicitudes
         WHERE id_agente=$1 AND id_trabajo=$2 AND llamada='print'
         LIMIT 1`,
        [agent.id_agente, jobId]
      );
      if (priorPrint.rows[0]) {
        throw qzRequestError('QZ_SIGN_PRINT_ALREADY_AUTHORIZED', 'El trabajo ya tiene otra autorizacion de impresion.', 409);
      }
    } else {
      const findCount = await client.query(
        `SELECT COUNT(*)::integer AS total
         FROM public.firmas_qz_agente_solicitudes
         WHERE id_agente=$1 AND id_trabajo=$2 AND llamada='printers.find'
           AND fecha_creacion > now() - interval '1 minute'`,
        [agent.id_agente, jobId]
      );
      if (Number(findCount.rows[0]?.total || 0) >= MAX_FIND_AUTHORIZATIONS_PER_MINUTE) {
        throw qzRequestError('QZ_SIGN_FIND_RATE_LIMITED', 'Limite de busquedas de impresora alcanzado.', 429);
      }
    }

    const expiresAt = new Date(request.timestamp + REQUEST_MAX_AGE_MS);
    if (Number.isNaN(expiresAt.getTime())) {
      throw qzRequestError('QZ_SIGN_REQUEST_INVALID', 'Timestamp QZ invalido.');
    }
    const signature = await signer(normalizedDigest, {
      idSucursal: job.id_sucursal,
      allowGlobalWithoutSucursal: false
    });
    await client.query(
      `INSERT INTO public.firmas_qz_agente_solicitudes
         (id_trabajo,id_sucursal,id_agente,llamada,request_hash,request_timestamp,
          printer_name,signature,expira_at)
       VALUES ($1,$2,$3,$4,$5,$6::bigint,$7,$8,$9::timestamptz)`,
      [jobId, agent.id_sucursal, agent.id_agente, call, requestHash, request.timestamp,
        printerName, signature, expiresAt]
    );
    await client.query('COMMIT');
    return { signature, timestamp: request.timestamp, call, idempotent: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') {
      throw qzRequestError('QZ_SIGN_CONFLICT', 'La autorizacion QZ entra en conflicto con otra solicitud.', 409);
    }
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
};

export const AGENT_QZ_ALLOWED_CALLS = Object.freeze([...ALLOWED_CALLS]);
