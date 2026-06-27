import { isEmailSchedulerEnabled, processScheduledCampaigns } from '../services/emailCampaignService.js';
import { isSmtpConfigured } from '../services/smtpMailer.js';

const DEFAULT_INTERVAL_MS = 15000;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 300000;
const DEFAULT_IDLE_TIMEOUT_MS = 10000;
const DEFAULT_HEARTBEAT_MS = 60000;

const schedulerState = {
  started: false,
  acceptingTicks: false,
  running: false,
  timer: null,
  heartbeatTimer: null,
  intervalMs: null,
  lastStartedAt: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastTickSucceededAt: null,
  lastTickFailedAt: null,
  lastError: null,
  successfulTicks: 0,
  failedTicks: 0,
  runningPromise: null
};

const dependencies = {
  processScheduledCampaigns,
  isEmailSchedulerEnabled,
  isSmtpConfigured,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  now: () => new Date(),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const parsePositiveIntEnv = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const isoNow = () => dependencies.now().toISOString();

const getSchedulerInterval = () =>
  parsePositiveIntEnv(process.env.EMAIL_SCHEDULER_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);

const getHeartbeatInterval = () =>
  parsePositiveIntEnv(process.env.EMAIL_SCHEDULER_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 1000, MAX_INTERVAL_MS);

const publicState = () => ({
  started: schedulerState.started,
  running: schedulerState.running,
  interval_ms: schedulerState.intervalMs,
  last_started_at: schedulerState.lastStartedAt,
  last_tick_started_at: schedulerState.lastTickStartedAt,
  last_tick_completed_at: schedulerState.lastTickCompletedAt,
  last_tick_succeeded_at: schedulerState.lastTickSucceededAt,
  last_tick_failed_at: schedulerState.lastTickFailedAt,
  successful_ticks: schedulerState.successfulTicks,
  failed_ticks: schedulerState.failedTicks,
  last_error_code: schedulerState.lastError?.code || null
});

export const getEmailCampaignSchedulerState = () => publicState();

const resetSchedulerState = ({ preserveCounters = false } = {}) => {
  schedulerState.started = false;
  schedulerState.acceptingTicks = false;
  schedulerState.running = false;
  schedulerState.timer = null;
  schedulerState.heartbeatTimer = null;
  schedulerState.intervalMs = null;
  schedulerState.lastStartedAt = null;
  schedulerState.lastTickStartedAt = null;
  schedulerState.lastTickCompletedAt = null;
  schedulerState.lastTickSucceededAt = null;
  schedulerState.lastTickFailedAt = null;
  schedulerState.lastError = null;
  schedulerState.runningPromise = null;
  if (!preserveCounters) {
    schedulerState.successfulTicks = 0;
    schedulerState.failedTicks = 0;
  }
};

export const configureEmailCampaignSchedulerForTests = (overrides = {}) => {
  Object.assign(dependencies, overrides);
};

export const resetEmailCampaignSchedulerForTests = () => {
  if (schedulerState.timer) dependencies.clearInterval(schedulerState.timer);
  if (schedulerState.heartbeatTimer) dependencies.clearInterval(schedulerState.heartbeatTimer);
  resetSchedulerState();
};

export const schedulerTick = async () => {
  if (!schedulerState.acceptingTicks || schedulerState.running) {
    return { skipped: true, reason: schedulerState.running ? 'ALREADY_RUNNING' : 'STOPPING' };
  }

  schedulerState.running = true;
  schedulerState.lastTickStartedAt = isoNow();
  const startedMs = Date.now();

  schedulerState.runningPromise = Promise.resolve()
    .then(() => dependencies.processScheduledCampaigns())
    .then((result) => {
      schedulerState.successfulTicks += 1;
      schedulerState.lastTickSucceededAt = isoNow();
      schedulerState.lastError = null;
      const durationMs = Date.now() - startedMs;
      dependencies.log('[email_campaign_scheduler] tick completed', {
        success: true,
        duration_ms: durationMs,
        successful_ticks: schedulerState.successfulTicks,
        failed_ticks: schedulerState.failedTicks
      });
      return { skipped: false, success: true, result };
    })
    .catch((error) => {
      schedulerState.failedTicks += 1;
      schedulerState.lastTickFailedAt = isoNow();
      schedulerState.lastError = {
        code: error?.code || 'TICK_ERROR'
      };
      const durationMs = Date.now() - startedMs;
      dependencies.error('[email_campaign_scheduler] tick failed', {
        code: error?.code || 'TICK_ERROR',
        duration_ms: durationMs,
        successful_ticks: schedulerState.successfulTicks,
        failed_ticks: schedulerState.failedTicks
      });
      return { skipped: false, success: false, error };
    })
    .finally(() => {
      schedulerState.lastTickCompletedAt = isoNow();
      schedulerState.running = false;
      schedulerState.runningPromise = null;
    });

  return schedulerState.runningPromise;
};

const startHeartbeat = () => {
  const heartbeatMs = getHeartbeatInterval();
  schedulerState.heartbeatTimer = dependencies.setInterval(() => {
    const lastSuccessMs = schedulerState.lastTickSucceededAt
      ? Date.now() - new Date(schedulerState.lastTickSucceededAt).getTime()
      : null;
    dependencies.log('[email_campaign_scheduler] heartbeat', {
      started: schedulerState.started,
      running: schedulerState.running,
      successful_ticks: schedulerState.successfulTicks,
      failed_ticks: schedulerState.failedTicks,
      seconds_since_last_success: Number.isFinite(lastSuccessMs) ? Math.max(0, Math.floor(lastSuccessMs / 1000)) : null
    });
  }, heartbeatMs);
};

export const startEmailCampaignScheduler = async () => {
  const intervalMs = getSchedulerInterval();
  if (schedulerState.started) {
    return { started: true, reason: 'ALREADY_STARTED', interval_ms: schedulerState.intervalMs || intervalMs };
  }

  const processRole = String(process.env.PROCESS_ROLE || 'web').trim().toLowerCase();
  if (processRole !== 'scheduler') {
    return { started: false, reason: 'INVALID_PROCESS_ROLE' };
  }
  if (!dependencies.isEmailSchedulerEnabled()) {
    return { started: false, reason: 'DISABLED' };
  }
  if (!dependencies.isSmtpConfigured()) {
    return { started: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  schedulerState.acceptingTicks = true;
  schedulerState.intervalMs = intervalMs;

  await schedulerTick();

  schedulerState.timer = dependencies.setInterval(() => {
    void schedulerTick();
  }, intervalMs);
  schedulerState.started = true;
  schedulerState.lastStartedAt = isoNow();
  startHeartbeat();

  dependencies.warn('[email_campaign_scheduler] El despliegue debe mantener una sola replica scheduler.');
  dependencies.log('[email_campaign_scheduler] activo', { interval_ms: intervalMs });

  return { started: true, reason: 'STARTED', interval_ms: intervalMs };
};

export const waitForSchedulerIdle = async ({ timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) => {
  const boundedTimeout = parsePositiveIntEnv(timeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 100, 60000);
  if (!schedulerState.running || !schedulerState.runningPromise) {
    return { idle: true, reason: 'IDLE' };
  }

  const timeoutResult = new Promise((resolve) => {
    setTimeout(() => resolve({ idle: false, reason: 'TIMEOUT' }), boundedTimeout);
  });

  return Promise.race([
    schedulerState.runningPromise.then(() => ({ idle: true, reason: 'IDLE' })),
    timeoutResult
  ]);
};

export const stopEmailCampaignScheduler = async ({ timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) => {
  if (!schedulerState.started && !schedulerState.timer && !schedulerState.running) {
    resetSchedulerState({ preserveCounters: true });
    return { stopped: true, reason: 'ALREADY_STOPPED' };
  }

  schedulerState.acceptingTicks = false;
  if (schedulerState.timer) {
    dependencies.clearInterval(schedulerState.timer);
    schedulerState.timer = null;
  }
  if (schedulerState.heartbeatTimer) {
    dependencies.clearInterval(schedulerState.heartbeatTimer);
    schedulerState.heartbeatTimer = null;
  }

  const idle = await waitForSchedulerIdle({ timeoutMs });
  const reason = idle.idle ? 'STOPPED' : 'STOPPED_WITH_ACTIVE_TICK_TIMEOUT';
  resetSchedulerState({ preserveCounters: true });
  return { stopped: true, reason };
};
