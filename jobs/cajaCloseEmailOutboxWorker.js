import { processCajaCloseEmailOutboxBatch } from '../services/cajaCloseEmailOutboxService.js';

const DEFAULT_INTERVAL_MS = 15000;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 300000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 10000;

const workerState = {
  started: false,
  acceptingTicks: false,
  running: false,
  timer: null,
  intervalMs: null,
  lastStartedAt: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastTickSucceededAt: null,
  lastTickFailedAt: null,
  lastError: null,
  runningPromise: null,
  successfulTicks: 0,
  failedTicks: 0
};

const defaultDependencies = {
  processBatch: processCajaCloseEmailOutboxBatch,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  now: () => new Date(),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const dependencies = { ...defaultDependencies };

const parsePositiveIntEnv = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const isoNow = () => dependencies.now().toISOString();

const getIntervalMs = () =>
  parsePositiveIntEnv(process.env.CAJA_CLOSE_EMAIL_OUTBOX_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);

const getBatchSize = () =>
  parsePositiveIntEnv(process.env.CAJA_CLOSE_EMAIL_OUTBOX_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 20);

const publicState = () => ({
  started: workerState.started,
  running: workerState.running,
  interval_ms: workerState.intervalMs,
  last_started_at: workerState.lastStartedAt,
  last_tick_started_at: workerState.lastTickStartedAt,
  last_tick_completed_at: workerState.lastTickCompletedAt,
  last_tick_succeeded_at: workerState.lastTickSucceededAt,
  last_tick_failed_at: workerState.lastTickFailedAt,
  successful_ticks: workerState.successfulTicks,
  failed_ticks: workerState.failedTicks,
  last_error_code: workerState.lastError?.code || null
});

const resetWorkerState = ({ preserveCounters = false } = {}) => {
  workerState.started = false;
  workerState.acceptingTicks = false;
  workerState.running = false;
  workerState.timer = null;
  workerState.intervalMs = null;
  workerState.lastStartedAt = null;
  workerState.lastTickStartedAt = null;
  workerState.lastTickCompletedAt = null;
  workerState.lastTickSucceededAt = null;
  workerState.lastTickFailedAt = null;
  workerState.lastError = null;
  workerState.runningPromise = null;
  if (!preserveCounters) {
    workerState.successfulTicks = 0;
    workerState.failedTicks = 0;
  }
};

export const configureCajaCloseEmailOutboxWorkerForTests = (overrides = {}) => {
  Object.assign(dependencies, overrides);
};

export const resetCajaCloseEmailOutboxWorkerForTests = () => {
  if (workerState.timer) dependencies.clearInterval(workerState.timer);
  resetWorkerState();
  Object.assign(dependencies, defaultDependencies);
};

export const getCajaCloseEmailOutboxWorkerState = () => publicState();

export const cajaCloseEmailOutboxTick = async () => {
  if (!workerState.acceptingTicks || workerState.running) {
    return { skipped: true, reason: workerState.running ? 'ALREADY_RUNNING' : 'STOPPING' };
  }

  workerState.running = true;
  workerState.lastTickStartedAt = isoNow();
  const startedMs = Date.now();

  workerState.runningPromise = Promise.resolve()
    .then(() => dependencies.processBatch({ batchSize: getBatchSize() }))
    .then((result) => {
      workerState.successfulTicks += 1;
      workerState.lastTickSucceededAt = isoNow();
      workerState.lastError = null;
      dependencies.log('[caja_close_email_outbox_worker] tick completed', {
        duration_ms: Date.now() - startedMs,
        claimed: result?.claimed || 0,
        processed: result?.processed || 0
      });
      return { skipped: false, success: true, result };
    })
    .catch((error) => {
      workerState.failedTicks += 1;
      workerState.lastTickFailedAt = isoNow();
      workerState.lastError = { code: error?.code || 'TICK_ERROR' };
      dependencies.error('[caja_close_email_outbox_worker] tick failed', {
        code: error?.code || 'TICK_ERROR',
        message: error?.message || 'Outbox tick error'
      });
      return { skipped: false, success: false, error };
    })
    .finally(() => {
      workerState.lastTickCompletedAt = isoNow();
      workerState.running = false;
      workerState.runningPromise = null;
      if (!workerState.acceptingTicks && !workerState.timer) {
        workerState.started = false;
      }
    });

  return workerState.runningPromise;
};

export const startCajaCloseEmailOutboxWorker = async () => {
  const intervalMs = getIntervalMs();
  if (workerState.started) {
    return { started: true, reason: 'ALREADY_STARTED', interval_ms: workerState.intervalMs || intervalMs };
  }

  workerState.acceptingTicks = true;
  workerState.intervalMs = intervalMs;

  await cajaCloseEmailOutboxTick();

  if (!workerState.acceptingTicks) {
    if (!workerState.running) resetWorkerState({ preserveCounters: true });
    return { started: false, reason: 'STOPPING', interval_ms: intervalMs };
  }

  workerState.timer = dependencies.setInterval(() => {
    void cajaCloseEmailOutboxTick();
  }, intervalMs);
  workerState.started = true;
  workerState.lastStartedAt = isoNow();
  dependencies.log('[caja_close_email_outbox_worker] activo', { interval_ms: intervalMs });
  return { started: true, reason: 'STARTED', interval_ms: intervalMs };
};

export const waitForCajaCloseEmailOutboxWorkerIdle = async ({ timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) => {
  const boundedTimeout = parsePositiveIntEnv(timeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 100, 60000);
  if (!workerState.running || !workerState.runningPromise) {
    return { idle: true, reason: 'IDLE' };
  }

  const timeoutResult = new Promise((resolve) => {
    setTimeout(() => resolve({ idle: false, reason: 'TIMEOUT' }), boundedTimeout);
  });

  return Promise.race([
    workerState.runningPromise.then(() => ({ idle: true, reason: 'IDLE' })),
    timeoutResult
  ]);
};

export const stopCajaCloseEmailOutboxWorker = async ({ timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) => {
  if (!workerState.started && !workerState.timer && !workerState.running) {
    resetWorkerState({ preserveCounters: true });
    return { stopped: true, reason: 'ALREADY_STOPPED' };
  }

  workerState.acceptingTicks = false;
  if (workerState.timer) {
    dependencies.clearInterval(workerState.timer);
    workerState.timer = null;
  }

  const idle = await waitForCajaCloseEmailOutboxWorkerIdle({ timeoutMs });
  if (!idle.idle) {
    return {
      stopped: false,
      reason: 'ACTIVE_TICK_TIMEOUT',
      running: workerState.running
    };
  }

  resetWorkerState({ preserveCounters: true });
  return { stopped: true, reason: 'STOPPED' };
};
