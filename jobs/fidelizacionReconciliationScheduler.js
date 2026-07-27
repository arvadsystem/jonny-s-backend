import { reconcileMissingPoints } from '../modules/fidelizacion/workers/reconcileMissingPoints.js';

const DEFAULT_INTERVAL_MS = 60000;
const MIN_INTERVAL_MS = 15000;
const MAX_INTERVAL_MS = 600000;
const DEFAULT_BATCH_LIMIT = 25;

const schedulerState = {
  started: false,
  acceptingTicks: false,
  running: false,
  timer: null,
  intervalMs: null,
  // Cursor keyset en memoria: avanza entre ticks para no reescanear siempre
  // las mismas primeras facturas. Sobrevive a start/stop dentro del mismo
  // proceso (solo un reinicio del proceso lo vuelve a 0), y solo se resetea
  // explicitamente en pruebas.
  cursor: 0,
  lastStartedAt: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  lastTickSucceededAt: null,
  lastTickFailedAt: null,
  lastError: null,
  lastResult: null,
  successfulTicks: 0,
  failedTicks: 0,
  runningPromise: null
};

const parseBoolEnv = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const parsePositiveIntEnv = (value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const isFidelizacionReconcileSchedulerEnabled = () =>
  parseBoolEnv(process.env.FIDELIZACION_RECONCILE_SCHEDULER_ENABLED, false);

const defaultDependencies = {
  reconcileMissingPoints,
  isFidelizacionReconcileSchedulerEnabled,
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  now: () => new Date(),
  log: console.log.bind(console),
  error: console.error.bind(console)
};

const dependencies = { ...defaultDependencies };

const isoNow = () => dependencies.now().toISOString();

const getSchedulerInterval = () =>
  parsePositiveIntEnv(process.env.FIDELIZACION_RECONCILE_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);

const getBatchLimit = () =>
  parsePositiveIntEnv(process.env.FIDELIZACION_RECONCILE_BATCH_LIMIT, DEFAULT_BATCH_LIMIT, 1, 200);

const publicState = () => ({
  started: schedulerState.started,
  running: schedulerState.running,
  interval_ms: schedulerState.intervalMs,
  cursor: schedulerState.cursor,
  last_started_at: schedulerState.lastStartedAt,
  last_tick_started_at: schedulerState.lastTickStartedAt,
  last_tick_completed_at: schedulerState.lastTickCompletedAt,
  last_tick_succeeded_at: schedulerState.lastTickSucceededAt,
  last_tick_failed_at: schedulerState.lastTickFailedAt,
  last_result: schedulerState.lastResult,
  successful_ticks: schedulerState.successfulTicks,
  failed_ticks: schedulerState.failedTicks,
  last_error_code: schedulerState.lastError?.code || null
});

export const getFidelizacionReconciliationSchedulerState = () => publicState();

const resetSchedulerState = ({ preserveCounters = false } = {}) => {
  schedulerState.started = false;
  schedulerState.acceptingTicks = false;
  schedulerState.running = false;
  schedulerState.timer = null;
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
    schedulerState.lastResult = null;
  }
};

export const configureFidelizacionReconciliationSchedulerForTests = (overrides = {}) => {
  Object.assign(dependencies, overrides);
};

export const resetFidelizacionReconciliationSchedulerForTests = () => {
  if (schedulerState.timer) dependencies.clearInterval(schedulerState.timer);
  resetSchedulerState();
  schedulerState.cursor = 0;
  Object.assign(dependencies, defaultDependencies);
};

// Idempotente: si ya hay un tick corriendo, este no arranca otro en paralelo.
export const fidelizacionReconciliationTick = async () => {
  if (!schedulerState.acceptingTicks || schedulerState.running) {
    return { skipped: true, reason: schedulerState.running ? 'ALREADY_RUNNING' : 'STOPPING' };
  }

  schedulerState.running = true;
  schedulerState.lastTickStartedAt = isoNow();

  schedulerState.runningPromise = Promise.resolve()
    .then(() => dependencies.reconcileMissingPoints({ cursor: schedulerState.cursor, limit: getBatchLimit() }))
    .then((result) => {
      // success/partial son los que decide reconcileMissingPoints (failed=0
      // y rejected=0 => success). result?.success !== false conserva
      // compatibilidad con resultados sin ese campo (se asume exito).
      const isSuccess = result?.success !== false;
      const isPartial = Boolean(result?.partial);

      if (isSuccess && !isPartial) {
        schedulerState.successfulTicks += 1;
        schedulerState.lastTickSucceededAt = isoNow();
        schedulerState.lastError = null;
      } else {
        // Un lote parcial (algo fallo o fue rechazado) NUNCA cuenta como
        // tick exitoso, aunque el propio tick no haya lanzado una excepcion:
        // ocultar eso seria reportar exito con datos incompletos.
        schedulerState.failedTicks += 1;
        schedulerState.lastTickFailedAt = isoNow();
        schedulerState.lastError = { code: 'FIDELIZACION_RECONCILE_PARTIAL_BATCH' };
      }
      schedulerState.lastResult = result;

      if (result?.reached_end) {
        // No quedar apuntando permanentemente al final del historico.
        schedulerState.cursor = 0;
      } else if (isPartial) {
        if (Number.isFinite(result?.retry_cursor)) {
          // No avanzar mas alla de la primera factura fallida/rechazada.
          schedulerState.cursor = result.retry_cursor;
        }
      } else if (Number.isFinite(result?.next_cursor)) {
        schedulerState.cursor = result.next_cursor;
      }

      dependencies.log('[fidelizacion_reconcile_scheduler] tick completed', {
        success: isSuccess && !isPartial,
        partial: isPartial,
        scanned: result?.scanned ?? 0,
        queued: result?.queued ?? 0,
        processed: result?.processed ?? 0,
        skipped: result?.skipped ?? 0,
        failed: result?.failed ?? 0,
        rejected: result?.rejected ?? 0,
        reached_end: Boolean(result?.reached_end),
        cursor: schedulerState.cursor
      });
      return { skipped: false, success: isSuccess && !isPartial, result };
    })
    .catch((error) => {
      schedulerState.failedTicks += 1;
      schedulerState.lastTickFailedAt = isoNow();
      schedulerState.lastError = { code: error?.code || 'TICK_ERROR' };
      dependencies.error('[fidelizacion_reconcile_scheduler] tick failed', {
        code: error?.code || 'TICK_ERROR'
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

export const startFidelizacionReconciliationScheduler = async () => {
  const intervalMs = getSchedulerInterval();
  if (schedulerState.started) {
    return { started: true, reason: 'ALREADY_STARTED', interval_ms: schedulerState.intervalMs || intervalMs };
  }

  const processRole = String(process.env.PROCESS_ROLE || 'web').trim().toLowerCase();
  if (processRole !== 'scheduler') {
    return { started: false, reason: 'INVALID_PROCESS_ROLE' };
  }
  if (!dependencies.isFidelizacionReconcileSchedulerEnabled()) {
    return { started: false, reason: 'DISABLED' };
  }

  schedulerState.acceptingTicks = true;
  schedulerState.intervalMs = intervalMs;

  await fidelizacionReconciliationTick();

  if (!schedulerState.acceptingTicks) {
    if (!schedulerState.running) resetSchedulerState({ preserveCounters: true });
    return { started: false, reason: 'STOPPING', interval_ms: intervalMs };
  }

  schedulerState.timer = dependencies.setInterval(() => {
    void fidelizacionReconciliationTick();
  }, intervalMs);
  schedulerState.started = true;
  schedulerState.lastStartedAt = isoNow();

  dependencies.log('[fidelizacion_reconcile_scheduler] activo', { interval_ms: intervalMs });

  return { started: true, reason: 'STARTED', interval_ms: intervalMs };
};

export const stopFidelizacionReconciliationScheduler = async () => {
  if (!schedulerState.started && !schedulerState.timer && !schedulerState.running) {
    resetSchedulerState({ preserveCounters: true });
    return { stopped: true, reason: 'ALREADY_STOPPED' };
  }

  schedulerState.acceptingTicks = false;
  if (schedulerState.timer) {
    dependencies.clearInterval(schedulerState.timer);
    schedulerState.timer = null;
  }

  if (schedulerState.runningPromise) {
    await schedulerState.runningPromise;
  }

  resetSchedulerState({ preserveCounters: true });
  return { stopped: true, reason: 'STOPPED' };
};
