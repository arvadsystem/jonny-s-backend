import { processCajaCloseEmailOutboxBatch } from '../services/cajaCloseEmailOutboxService.js';

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 300000;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 10000;
const DEFAULT_SUMMARY_INTERVAL_MS = 300000;
const DEFAULT_SLOW_TICK_MS = 5000;
// Backoff ante fallos consecutivos del tick (DB degradada, timeout de claim, etc.):
// 15s, 30s, 60s, 120s, y desde el 5to fallo se estabiliza en el tope de 300s. Un exito
// reinicia la secuencia y vuelve al intervalo normal en el siguiente tick.
const BACKOFF_SEQUENCE_MS = [15000, 30000, 60000, 120000, 300000];

const workerState = {
  started: false,
  acceptingTicks: false,
  running: false,
  timer: null,
  summaryTimer: null,
  intervalMs: null,
  consecutiveFailures: 0,
  totalProcessed: 0,
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
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  slowTickMs: DEFAULT_SLOW_TICK_MS,
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

export const isCajaCloseEmailOutboxEnabled = () =>
  String(process.env.CAJA_CLOSE_EMAIL_OUTBOX_ENABLED ?? 'true').trim().toLowerCase() !== 'false';

const getIntervalMs = () =>
  parsePositiveIntEnv(process.env.CAJA_CLOSE_EMAIL_OUTBOX_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);

const getBatchSize = () =>
  parsePositiveIntEnv(process.env.CAJA_CLOSE_EMAIL_OUTBOX_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 20);

const getSummaryIntervalMs = () =>
  parsePositiveIntEnv(process.env.CAJA_CLOSE_EMAIL_OUTBOX_SUMMARY_MS, DEFAULT_SUMMARY_INTERVAL_MS, 60000, 3600000);

export const resolveCajaCloseEmailOutboxBackoffMs = (consecutiveFailures) => {
  const index = Math.min(Math.max(Number(consecutiveFailures) || 1, 1), BACKOFF_SEQUENCE_MS.length) - 1;
  return BACKOFF_SEQUENCE_MS[index];
};

const publicState = () => ({
  started: workerState.started,
  running: workerState.running,
  enabled: isCajaCloseEmailOutboxEnabled(),
  interval_ms: workerState.intervalMs,
  consecutive_failures: workerState.consecutiveFailures,
  total_processed: workerState.totalProcessed,
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
  workerState.summaryTimer = null;
  workerState.intervalMs = null;
  workerState.consecutiveFailures = 0;
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
    workerState.totalProcessed = 0;
  }
};

export const configureCajaCloseEmailOutboxWorkerForTests = (overrides = {}) => {
  Object.assign(dependencies, overrides);
};

export const resetCajaCloseEmailOutboxWorkerForTests = () => {
  if (workerState.timer) dependencies.clearTimeout(workerState.timer);
  if (workerState.summaryTimer) dependencies.clearInterval(workerState.summaryTimer);
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
      const durationMs = Date.now() - startedMs;
      const processed = result?.processed || 0;
      workerState.totalProcessed += processed;
      // No se registra cada tick vacio (sin correos ni error): solo correos procesados,
      // ticks lentos y errores generan una linea de log; el resumen periodico cubre el resto.
      if (processed > 0) {
        dependencies.log('[caja_close_email_outbox_worker] correos procesados', {
          duration_ms: durationMs,
          claimed: result?.claimed || 0,
          processed
        });
      }
      if (durationMs >= dependencies.slowTickMs) {
        dependencies.warn('[caja_close_email_outbox_worker] tick lento', {
          duration_ms: durationMs,
          claimed: result?.claimed || 0,
          processed
        });
      }
      return { skipped: false, success: true, result, durationMs };
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

const scheduleNextTick = (delayMs) => {
  workerState.timer = dependencies.setTimeout(() => {
    workerState.timer = null;
    void runTickCycle();
  }, delayMs);
};

// Bucle auto-programado (setTimeout, no setInterval): el siguiente tick solo se agenda
// despues de que el actual termina, por lo que nunca hay dos ticks superpuestos. Un
// fallo agranda el siguiente delay via resolveCajaCloseEmailOutboxBackoffMs; un exito
// lo reinicia al intervalo normal.
const runTickCycle = async () => {
  const result = await cajaCloseEmailOutboxTick();
  if (!workerState.acceptingTicks) return result;

  if (result?.success === true) {
    workerState.consecutiveFailures = 0;
  } else if (result?.success === false) {
    workerState.consecutiveFailures += 1;
  }

  const nextDelayMs = workerState.consecutiveFailures > 0
    ? resolveCajaCloseEmailOutboxBackoffMs(workerState.consecutiveFailures)
    : workerState.intervalMs;

  scheduleNextTick(nextDelayMs);
  return result;
};

const startSummaryTimer = () => {
  const summaryMs = getSummaryIntervalMs();
  workerState.summaryTimer = dependencies.setInterval(() => {
    dependencies.log('[caja_close_email_outbox_worker] resumen', {
      successful_ticks: workerState.successfulTicks,
      failed_ticks: workerState.failedTicks,
      total_processed: workerState.totalProcessed,
      consecutive_failures: workerState.consecutiveFailures,
      last_tick_succeeded_at: workerState.lastTickSucceededAt,
      last_tick_failed_at: workerState.lastTickFailedAt
    });
  }, summaryMs);
};

export const startCajaCloseEmailOutboxWorker = async () => {
  if (workerState.started) {
    return { started: true, reason: 'ALREADY_STARTED', interval_ms: workerState.intervalMs || getIntervalMs() };
  }

  if (!isCajaCloseEmailOutboxEnabled()) {
    dependencies.log('[caja_close_email_outbox_worker] deshabilitado', { env: 'CAJA_CLOSE_EMAIL_OUTBOX_ENABLED=false' });
    return { started: false, reason: 'DISABLED' };
  }

  const intervalMs = getIntervalMs();
  workerState.acceptingTicks = true;
  workerState.intervalMs = intervalMs;
  workerState.consecutiveFailures = 0;

  await runTickCycle();

  if (!workerState.acceptingTicks) {
    if (!workerState.running) resetWorkerState({ preserveCounters: true });
    return { started: false, reason: 'STOPPING', interval_ms: intervalMs };
  }

  workerState.started = true;
  workerState.lastStartedAt = isoNow();
  startSummaryTimer();
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
    dependencies.clearTimeout(workerState.timer);
    workerState.timer = null;
  }
  if (workerState.summaryTimer) {
    dependencies.clearInterval(workerState.summaryTimer);
    workerState.summaryTimer = null;
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
