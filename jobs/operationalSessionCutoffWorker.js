import { closeOperationalSessionsAtDailyCutoff } from '../utils/security/sessionService.js';

export const OPERATIONAL_SESSION_CUTOFF_TIME_ZONE = 'America/Tegucigalpa';
export const OPERATIONAL_SESSION_CUTOFF_TIME = '23:59:00';

const DEFAULT_IDLE_TIMEOUT_MS = 10000;
const HONDURAS_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPERATIONAL_SESSION_CUTOFF_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const workerState = {
  started: false,
  acceptingTicks: false,
  running: false,
  timer: null,
  runningPromise: null,
  nextCutoffLocal: null,
  lastCutoffLocal: null,
  lastErrorCode: null
};

const defaultDependencies = {
  closeSessions: closeOperationalSessionsAtDailyCutoff,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  now: () => new Date(),
  log: console.log.bind(console),
  error: console.error.bind(console)
};

const dependencies = { ...defaultDependencies };

const toParts = (date) => Object.fromEntries(
  HONDURAS_FORMATTER
    .formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number.parseInt(part.value, 10)])
);

const formatDate = ({ year, month, day }) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const addCalendarDays = ({ year, month, day }, days) => {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
};

const buildCutoffLocal = (dateParts) => `${formatDate(dateParts)} ${OPERATIONAL_SESSION_CUTOFF_TIME}`;

const zonedLocalToDate = ({ year, month, day, hour, minute, second }) => {
  const desiredLocalMs = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidateMs = desiredLocalMs;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidateParts = toParts(new Date(candidateMs));
    const representedLocalMs = Date.UTC(
      candidateParts.year,
      candidateParts.month - 1,
      candidateParts.day,
      candidateParts.hour,
      candidateParts.minute,
      candidateParts.second
    );
    candidateMs += desiredLocalMs - representedLocalMs;
  }

  return new Date(candidateMs);
};

export const resolveLatestHondurasCutoff = (now = new Date()) => {
  const parts = toParts(now);
  const currentTime = parts.hour * 10000 + parts.minute * 100 + parts.second;
  const cutoffDate = currentTime >= 235900 ? parts : addCalendarDays(parts, -1);
  return buildCutoffLocal(cutoffDate);
};

export const resolveNextHondurasCutoff = (now = new Date()) => {
  const parts = toParts(now);
  const currentTime = parts.hour * 10000 + parts.minute * 100 + parts.second;
  const cutoffDate = currentTime < 235900 ? parts : addCalendarDays(parts, 1);
  const cutoffLocal = buildCutoffLocal(cutoffDate);
  const cutoffAt = zonedLocalToDate({
    ...cutoffDate,
    hour: 23,
    minute: 59,
    second: 0
  });

  return {
    cutoffLocal,
    cutoffAt,
    delayMs: Math.max(0, cutoffAt.getTime() - now.getTime())
  };
};

const scheduleNextCutoff = () => {
  if (!workerState.acceptingTicks) return;

  const next = resolveNextHondurasCutoff(dependencies.now());
  workerState.nextCutoffLocal = next.cutoffLocal;
  workerState.timer = dependencies.setTimeout(async () => {
    workerState.timer = null;
    await operationalSessionCutoffTick({ cutoffLocal: next.cutoffLocal });
    scheduleNextCutoff();
  }, next.delayMs);
};

export const configureOperationalSessionCutoffWorkerForTests = (overrides = {}) => {
  Object.assign(dependencies, overrides);
};

export const resetOperationalSessionCutoffWorkerForTests = () => {
  if (workerState.timer) dependencies.clearTimeout(workerState.timer);
  workerState.started = false;
  workerState.acceptingTicks = false;
  workerState.running = false;
  workerState.timer = null;
  workerState.runningPromise = null;
  workerState.nextCutoffLocal = null;
  workerState.lastCutoffLocal = null;
  workerState.lastErrorCode = null;
  Object.assign(dependencies, defaultDependencies);
};

export const getOperationalSessionCutoffWorkerState = () => ({
  started: workerState.started,
  running: workerState.running,
  next_cutoff_local: workerState.nextCutoffLocal,
  last_cutoff_local: workerState.lastCutoffLocal,
  last_error_code: workerState.lastErrorCode
});

export const operationalSessionCutoffTick = async ({ cutoffLocal = null } = {}) => {
  if (!workerState.acceptingTicks || workerState.running) {
    return { skipped: true, reason: workerState.running ? 'ALREADY_RUNNING' : 'STOPPING' };
  }

  const effectiveCutoff = cutoffLocal || resolveLatestHondurasCutoff(dependencies.now());
  workerState.running = true;
  workerState.lastCutoffLocal = effectiveCutoff;

  workerState.runningPromise = Promise.resolve()
    .then(() => dependencies.closeSessions({ cutoffLocal: effectiveCutoff }))
    .then((result) => {
      workerState.lastErrorCode = null;
      dependencies.log('[operational_session_cutoff_worker] tick completed', {
        cutoff_local: effectiveCutoff,
        executed: result?.executed === true,
        closed_sessions: result?.closedSessions || 0,
        reason: result?.reason || null
      });
      return { skipped: false, success: true, result };
    })
    .catch((error) => {
      workerState.lastErrorCode = error?.code || 'TICK_ERROR';
      dependencies.error('[operational_session_cutoff_worker] tick failed', {
        code: workerState.lastErrorCode,
        message: error?.message || 'Operational session cutoff error'
      });
      return { skipped: false, success: false, error };
    })
    .finally(() => {
      workerState.running = false;
      workerState.runningPromise = null;
    });

  return workerState.runningPromise;
};

export const startOperationalSessionCutoffWorker = async () => {
  if (workerState.started) {
    return { started: true, reason: 'ALREADY_STARTED' };
  }

  workerState.started = true;
  workerState.acceptingTicks = true;
  await operationalSessionCutoffTick();

  if (!workerState.acceptingTicks) {
    return { started: false, reason: 'STOPPING' };
  }

  scheduleNextCutoff();
  dependencies.log('[operational_session_cutoff_worker] activo', {
    time_zone: OPERATIONAL_SESSION_CUTOFF_TIME_ZONE,
    cutoff_time: OPERATIONAL_SESSION_CUTOFF_TIME,
    next_cutoff_local: workerState.nextCutoffLocal
  });
  return { started: true, reason: 'STARTED', next_cutoff_local: workerState.nextCutoffLocal };
};

export const stopOperationalSessionCutoffWorker = async ({ timeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) => {
  workerState.acceptingTicks = false;
  if (workerState.timer) {
    dependencies.clearTimeout(workerState.timer);
    workerState.timer = null;
  }

  if (workerState.runningPromise) {
    const boundedTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, 60000)
      : DEFAULT_IDLE_TIMEOUT_MS;
    const timeoutResult = new Promise((resolve) => {
      dependencies.setTimeout(() => resolve({ stopped: false, reason: 'ACTIVE_TICK_TIMEOUT' }), boundedTimeout);
    });
    const result = await Promise.race([
      workerState.runningPromise.then(() => ({ stopped: true, reason: 'STOPPED' })),
      timeoutResult
    ]);
    if (!result.stopped) return result;
  }

  workerState.started = false;
  workerState.nextCutoffLocal = null;
  return { stopped: true, reason: 'STOPPED' };
};
