import { isEmailSchedulerEnabled, processScheduledCampaigns } from '../services/emailCampaignService.js';
import { isSmtpConfigured } from '../services/smtpMailer.js';

const DEFAULT_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 300000;

const schedulerState = {
  started: false,
  running: false,
  timer: null
};

const parsePositiveIntEnv = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const getSchedulerInterval = () => {
  const parsed = parsePositiveIntEnv(process.env.EMAIL_SCHEDULER_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  return Math.min(parsed, MAX_INTERVAL_MS);
};

const schedulerTick = async () => {
  if (schedulerState.running) return;
  schedulerState.running = true;
  try {
    await processScheduledCampaigns();
  } catch (error) {
    console.error('[email_campaign_scheduler] tick error:', error);
  } finally {
    schedulerState.running = false;
  }
};

export const startEmailCampaignScheduler = () => {
  if (schedulerState.started) return;
  const processRole = String(process.env.PROCESS_ROLE || 'web').trim().toLowerCase();
  if (processRole !== 'scheduler') {
    schedulerState.started = true;
    console.log('[email_campaign_scheduler] deshabilitado: PROCESS_ROLE no es scheduler.');
    return;
  }
  if (!isEmailSchedulerEnabled()) {
    schedulerState.started = true;
    console.log('[email_campaign_scheduler] deshabilitado por EMAIL_SCHEDULER_ENABLED=false');
    return;
  }
  if (!isSmtpConfigured()) {
    schedulerState.started = true;
    console.log('[email_campaign_scheduler] deshabilitado: SMTP no configurado.');
    return;
  }

  const intervalMs = getSchedulerInterval();
  schedulerState.timer = setInterval(() => {
    void schedulerTick();
  }, intervalMs);

  if (typeof schedulerState.timer?.unref === 'function') {
    schedulerState.timer.unref();
  }

  schedulerState.started = true;
  console.log(`[email_campaign_scheduler] activo cada ${intervalMs}ms`);
};

export const stopEmailCampaignScheduler = () => {
  if (schedulerState.timer) {
    clearInterval(schedulerState.timer);
    schedulerState.timer = null;
  }
  schedulerState.started = false;
  schedulerState.running = false;
};
