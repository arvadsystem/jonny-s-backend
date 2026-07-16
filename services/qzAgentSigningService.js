import crypto from 'node:crypto';
import pool from '../config/db-connection.js';
import { signQzMessage } from '../routers/ventas/services/qzTraySigningService.js';

const ALLOWED_CALLS = new Set(['printers.find', 'print']);
const REQUEST_MAX_AGE_MS = 30_000;

const qzRequestError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const validateFindParams = (params) => {
  if (!isPlainObject(params)) return false;
  const keys = Object.keys(params);
  return keys.length === 1 && keys[0] === 'query' && params.query === null;
};

const validatePrintParams = (params, jobId) => {
  if (!isPlainObject(params) || !isPlainObject(params.printer) || !isPlainObject(params.options)) return false;
  const printerKeys = Object.keys(params.printer);
  if (printerKeys.length !== 1 || printerKeys[0] !== 'name') return false;
  const printerName = String(params.printer.name || '').trim();
  if (!printerName || printerName.length > 160) return false;
  if (Number(params.options.copies) !== 1 || String(params.options.jobName || '') !== `Jonny-${jobId}`) return false;
  if (!Array.isArray(params.data) || params.data.length !== 1) return false;
  const item = params.data[0];
  if (!isPlainObject(item) || item.type !== 'pixel' || item.format !== 'html' || item.flavor !== 'plain') return false;
  if (typeof item.data !== 'string' || Buffer.byteLength(item.data, 'utf8') > 256 * 1024) return false;
  return Number(item.options?.pageWidth) === 58 || Number(item.options?.pageWidth) === 80;
};

export const validateAgentQzRequest = ({ request, job, now = Date.now() }) => {
  if (!isPlainObject(request) || Object.keys(request).some((key) => !['call', 'params', 'timestamp'].includes(key))) {
    throw qzRequestError('QZ_SIGN_REQUEST_INVALID', 'Estructura QZ invalida.');
  }
  const call = String(request.call || '');
  if (!ALLOWED_CALLS.has(call)) throw qzRequestError('QZ_SIGN_CALL_NOT_ALLOWED', 'Llamada QZ no permitida.', 403);
  if (!Number.isSafeInteger(request.timestamp) || Math.abs(now - request.timestamp) > REQUEST_MAX_AGE_MS) {
    throw qzRequestError('QZ_SIGN_REQUEST_EXPIRED', 'Solicitud QZ vencida.');
  }
  const state = String(job?.estado || '');
  if (call === 'printers.find') {
    if (!['imprimiendo', 'confirmacion_pendiente'].includes(state) || !validateFindParams(request.params)) {
      throw qzRequestError('QZ_SIGN_REQUEST_NOT_RELATED', 'Solicitud QZ no relacionada con el trabajo.', 403);
    }
  } else if (state !== 'confirmacion_pendiente' || !validatePrintParams(request.params, job.id_trabajo)) {
    throw qzRequestError('QZ_SIGN_REQUEST_NOT_RELATED', 'Solicitud QZ no relacionada con el trabajo.', 403);
  }
  return { call, canonical: JSON.stringify(request) };
};

export const authorizeAndSignAgentQzRequest = async ({
  agent, jobId, request, digest, db = pool, signer = signQzMessage, now = Date.now()
}) => {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const shouldRelease = client !== db && typeof client.release === 'function';
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT id_trabajo,id_sucursal,id_agente_tomado,estado,payload
       FROM public.trabajos_impresion
       WHERE id_trabajo=$1 AND id_sucursal=$2 AND id_agente_tomado=$3
       FOR SHARE`,
      [jobId, agent.id_sucursal, agent.id_agente]
    );
    const job = jobResult.rows[0];
    if (!job) throw qzRequestError('QZ_SIGN_JOB_NOT_ACTIVE', 'Trabajo de impresion no autorizado.', 403);
    const { call, canonical } = validateAgentQzRequest({ request, job, now });
    const requestHash = crypto.createHash('sha512').update(canonical, 'utf8').digest('hex');
    if (!/^[a-f0-9]{128}$/i.test(String(digest || ''))) {
      throw qzRequestError('QZ_SIGN_DIGEST_INVALID', 'Hash QZ invalido.');
    }
    const digestMatches = crypto.timingSafeEqual(
      Buffer.from(requestHash, 'hex'),
      Buffer.from(String(digest), 'hex')
    );
    if (!digestMatches) throw qzRequestError('QZ_SIGN_DIGEST_MISMATCH', 'Hash QZ no coincide con la operacion.', 403);
    await client.query(
      `INSERT INTO public.firmas_qz_agente_solicitudes
         (id_trabajo,id_sucursal,id_agente,llamada,request_hash,request_timestamp,expira_at)
       VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($6 / 1000.0) + interval '30 seconds')`,
      [jobId, agent.id_sucursal, agent.id_agente, call, requestHash, request.timestamp]
    );
    const signature = await signer(String(digest));
    await client.query('COMMIT');
    return { signature, timestamp: request.timestamp, call };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') {
      throw qzRequestError('QZ_SIGN_REQUEST_REPLAYED', 'Solicitud QZ ya utilizada.', 409);
    }
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
};

export const AGENT_QZ_ALLOWED_CALLS = Object.freeze([...ALLOWED_CALLS]);
