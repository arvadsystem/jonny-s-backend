import express from 'express';
import rateLimit from 'express-rate-limit';
import pool from '../config/db-connection.js';
import { authenticatePrintAgent } from '../services/printAgentAuthService.js';
import { claimPrintJobs, getPrintJobStatusForAgent, transitionPrintJob } from '../services/printQueueService.js';
import { authorizeAndSignAgentQzRequest } from '../services/qzAgentSigningService.js';
import {
  getCanonicalPrintDocumentForAgent,
  MAX_AGENT_QZ_SIGN_REQUEST_BYTES
} from '../services/printJobDocumentService.js';
import {
  getQzCertificateText,
  getQzPublicErrorMessage,
  isQzConfigurationError,
} from './ventas/services/qzTraySigningService.js';

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 180, standardHeaders: true, legacyHeaders: false });
const isPublicQzErrorCode = (code) => /^QZ_[A-Z0-9_]+$/.test(String(code || ''));

export const buildAgentQzSigningErrorResponse = ({
  error,
  agentId = null,
  jobId = null,
  log = console.error
}) => {
  if (isQzConfigurationError(error)) {
    return {
      status: 503,
      body: {
        ok: false,
        code: isPublicQzErrorCode(error?.code) ? error.code : 'QZ_SIGNING_NOT_CONFIGURED',
        message: getQzPublicErrorMessage()
      }
    };
  }
  if (error?.status) {
    return {
      status: error.status,
      body: {
        ok: false,
        code: isPublicQzErrorCode(error?.code) ? error.code : 'QZ_SIGNING_ERROR',
        message: error.message
      }
    };
  }
  const internalCode = String(error?.code || '').toUpperCase();
  log('[print-agent.qz.sign] fallo interno', {
    agent_id: agentId,
    job_id: jobId,
    sqlstate: /^[0-9A-Z]{5}$/.test(internalCode) ? internalCode : null
  });
  return {
    status: 500,
    body: {
      ok: false,
      code: 'QZ_SIGNING_ERROR',
      message: 'No se pudo firmar la solicitud.'
    }
  };
};

const requireHttps = (req, res, next) => {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production' || req.secure || forwardedProto === 'https') return next();
  return res.status(426).json({ ok: false, code: 'HTTPS_REQUIRED', message: 'Este endpoint requiere HTTPS.' });
};

const requireAgent = async (req, res, next) => {
  try {
    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const agentId = String(req.headers['x-print-agent-id'] || '').trim();
    const agent = await authenticatePrintAgent({ agentId, token });
    if (!agent) return res.status(401).json({ ok: false, code: 'PRINT_AGENT_UNAUTHORIZED', message: 'Credencial de agente invalida o revocada.' });
    req.printAgent = agent;
    return next();
  } catch (error) {
    console.error('[print-agent.auth] fallo de autenticacion', { code: error?.code || null });
    return res.status(503).json({ ok: false, code: 'PRINT_AGENT_AUTH_UNAVAILABLE', message: 'No se pudo validar el agente.' });
  }
};

router.use(requireHttps, limiter, requireAgent);

router.post('/heartbeat', async (req, res) => {
  const version = String(req.body?.version || '').trim().slice(0, 40) || null;
  await pool.query(
    `UPDATE public.agentes_impresion SET ultimo_heartbeat_at=now(), version=$2, fecha_actualizacion=now()
     WHERE id_agente=$1 AND estado='activo'`,
    [req.printAgent.id_agente, version]
  );
  return res.json({ ok: true, server_time: new Date().toISOString(), id_sucursal: req.printAgent.id_sucursal });
});

router.post('/jobs/claim', async (req, res) => {
  try {
    const jobs = await claimPrintJobs({
      agentId: req.printAgent.id_agente,
      leaseSeconds: req.body?.lease_seconds
    });
    return res.json({ ok: true, jobs });
  } catch (error) {
    console.error('[print-agent.claim] fallo', { agent_id: req.printAgent.id_agente, code: error?.code || null });
    return res.status(500).json({ ok: false, code: 'PRINT_CLAIM_FAILED', message: 'No se pudieron reclamar trabajos.' });
  }
});

router.get('/jobs/:id/status', async (req, res) => {
  const jobId = Number.parseInt(String(req.params.id || ''), 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ ok: false, code: 'PRINT_JOB_ID_INVALID', message: 'ID de trabajo invalido.' });
  }
  try {
    const job = await getPrintJobStatusForAgent({ agent: req.printAgent, jobId });
    if (!job) return res.status(404).json({ ok: false, code: 'PRINT_JOB_NOT_FOUND', message: 'Trabajo no encontrado.' });
    return res.json({ ok: true, job });
  } catch (error) {
    console.error('[print-agent.status] fallo', { agent_id: req.printAgent.id_agente, code: error?.code || null });
    return res.status(500).json({ ok: false, code: 'PRINT_JOB_STATUS_FAILED', message: 'No se pudo consultar el trabajo.' });
  }
});

const transitionHandler = (action) => async (req, res) => {
  try {
    const jobId = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isInteger(jobId) || jobId <= 0) return res.status(400).json({ ok: false, message: 'ID de trabajo invalido.' });
    const job = await transitionPrintJob({
      agent: req.printAgent,
      jobId,
      action,
      errorMessage: req.body?.error,
      leaseSeconds: req.body?.lease_seconds
    });
    return res.json({ ok: true, job });
  } catch (error) {
    return res.status(error?.status || 500).json({
      ok: false,
      code: error?.code || 'PRINT_JOB_UPDATE_FAILED',
      message: error?.status ? error.message : 'No se pudo actualizar el trabajo.'
    });
  }
};

router.post('/jobs/:id/printing', transitionHandler('printing'));
router.post('/jobs/:id/confirmation-pending', transitionHandler('confirmationPending'));
router.post('/jobs/:id/complete', transitionHandler('complete'));
router.post('/jobs/:id/fail', transitionHandler('fail'));
router.post('/jobs/:id/lease', transitionHandler('renew'));

router.get('/jobs/:id/document', async (req, res) => {
  const jobId = Number.parseInt(String(req.params.id || ''), 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return res.status(400).json({ ok: false, code: 'PRINT_JOB_ID_INVALID', message: 'ID de trabajo invalido.' });
  }
  try {
    const result = await getCanonicalPrintDocumentForAgent({
      agent: req.printAgent,
      jobId
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, document: result.document });
  } catch (error) {
    console.error('[print-agent.document] fallo', {
      agent_id: req.printAgent.id_agente,
      job_id: jobId,
      code: error?.code || null
    });
    return res.status(error?.status || 500).json({
      ok: false,
      code: error?.status ? error.code : 'PRINT_DOCUMENT_FAILED',
      message: error?.status ? error.message : 'No se pudo obtener el documento de impresion.'
    });
  }
});

router.get('/qz/certificate', async (req, res) => {
  try {
    return res.json({
      ok: true,
      certificate: await getQzCertificateText({
        idSucursal: req.printAgent.id_sucursal,
        allowGlobalWithoutSucursal: false
      })
    });
  } catch (error) {
    return res.status(isQzConfigurationError(error) ? 503 : 500).json({
      ok: false,
      code: error?.code || 'QZ_CERTIFICATE_ERROR',
      message: getQzPublicErrorMessage()
    });
  }
});

router.post('/qz/sign', async (req, res) => {
  const jobId = Number.parseInt(String(req.body?.job_id || ''), 10);
  const request = req.body?.request;
  const digest = String(req.body?.digest || '').trim();
  let requestSize = 0;
  try { requestSize = Buffer.byteLength(JSON.stringify(request), 'utf8'); } catch { requestSize = 0; }
  if (!Number.isInteger(jobId) || jobId <= 0 || !request || !digest || requestSize <= 0 || requestSize > MAX_AGENT_QZ_SIGN_REQUEST_BYTES) {
    return res.status(400).json({ ok: false, code: 'QZ_SIGN_REQUEST_INVALID', message: 'Solicitud de firma invalida.' });
  }
  try {
    const result = await authorizeAndSignAgentQzRequest({
      agent: req.printAgent,
      jobId,
      request,
      digest
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const response = buildAgentQzSigningErrorResponse({
      error,
      agentId: req.printAgent.id_agente,
      jobId
    });
    return res.status(response.status).json(response.body);
  }
});

export default router;
