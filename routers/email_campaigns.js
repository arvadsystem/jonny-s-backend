import express from 'express';
import { checkPermission } from '../middleware/checkPermission.js';
import {
  createCampaign,
  getCampaignById,
  getCampaignRecipients,
  listCampaigns,
  normalizeCampaignError,
  sendCampaignNow,
  retryFailedRecipients,
  updateCampaign,
  cancelScheduledCampaign
} from '../services/emailCampaignService.js';
import { runSmtpDiagnostic } from '../services/smtpMailer.js';

const router = express.Router();

const VIEW_PERMISSIONS = ['CONFIGURACION_EMAIL_CAMPAIGNS_VER', 'CONFIGURACION_EMAIL_CAMPAIGNS_GESTIONAR'];
const MANAGE_PERMISSIONS = ['CONFIGURACION_EMAIL_CAMPAIGNS_GESTIONAR'];

const parseCampaignId = (rawId) => {
  const parsed = Number.parseInt(String(rawId ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const sendError = (res, error) => {
  const normalized = normalizeCampaignError(error);
  return res.status(normalized.status).json({
    ok: false,
    error: true,
    code: normalized.code,
    message: normalized.message,
    ...(normalized.details ? { details: normalized.details } : {})
  });
};

router.get('/email-campaigns', checkPermission(VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await listCampaigns(req.query || {});
    return res.status(200).json({
      ok: true,
      data: result.rows,
      pagination: result.pagination
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/email-campaigns/smtp-diagnostic', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const result = await runSmtpDiagnostic();
    if (result.ok) {
      return res.status(200).json({
        ok: true,
        data: result.data
      });
    }
    return res.status(result.status || 500).json({
      ok: false,
      error: true,
      code: result.code || 'SMTP_DIAGNOSTIC_ERROR',
      message: result.message || 'No se pudo verificar SMTP.',
      data: result.data || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: true,
      code: 'SMTP_DIAGNOSTIC_ERROR',
      message: 'No se pudo verificar SMTP.'
    });
  }
});

router.get('/email-campaigns/:id', checkPermission(VIEW_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const campaign = await getCampaignById(idCampaign);
    return res.status(200).json({ ok: true, data: campaign });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/email-campaigns/:id/recipients', checkPermission(VIEW_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const result = await getCampaignRecipients(idCampaign, req.query || {});
    return res.status(200).json({
      ok: true,
      data: result.rows,
      pagination: result.pagination
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/email-campaigns', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const campaign = await createCampaign({
      payload: req.body || {},
      idUsuario: req.user?.id_usuario
    });
    return res.status(201).json({ ok: true, data: campaign });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/email-campaigns/:id', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const campaign = await updateCampaign({
      idCampaign,
      payload: req.body || {}
    });
    return res.status(200).json({ ok: true, data: campaign });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/email-campaigns/:id/send-now', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const result = await sendCampaignNow({ idCampaign });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/email-campaigns/:id/retry-failed', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const result = await retryFailedRecipients({ idCampaign });
    return res.status(200).json({ ok: true, data: result });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/email-campaigns/:id/cancel', checkPermission(MANAGE_PERMISSIONS), async (req, res) => {
  const idCampaign = parseCampaignId(req.params?.id);
  if (!idCampaign) {
    return res.status(400).json({
      ok: false,
      error: true,
      code: 'VALIDATION_ERROR',
      message: 'id de campana invalido.'
    });
  }

  try {
    const campaign = await cancelScheduledCampaign({ idCampaign });
    return res.status(200).json({ ok: true, data: campaign });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;
