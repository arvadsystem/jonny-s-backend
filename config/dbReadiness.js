import { checkDatabaseReady as defaultCheckDatabaseReady } from './db-connection.js';

// Secuencia de backoff para el reintento de arranque en segundo plano: 2s, 4s, 8s, 15s y
// desde el 5to intento se estabiliza en el tope de 30s. Con jitter (+0..20%) para evitar que
// varias replicas reintenten exactamente en el mismo instante contra el mismo Postgres.
const BACKOFF_SEQUENCE_MS = [2000, 4000, 8000, 15000, 30000];
const MAX_BACKOFF_MS = 30000;

const state = {
  ready: false,
  attempt: 0,
  retryTimer: null,
  inFlight: false,
  stopped: true,
  onReadyCalled: false
};

let onReadyCallback = null;

const defaultDependencies = {
  checkDatabaseReady: defaultCheckDatabaseReady,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  randomImpl: Math.random,
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

const dependencies = { ...defaultDependencies };

export const resolveDatabaseReadinessBackoffMs = (attempt, randomImpl = Math.random) => {
  const index = Math.min(Math.max(Number(attempt) || 1, 1), BACKOFF_SEQUENCE_MS.length) - 1;
  const base = BACKOFF_SEQUENCE_MS[index];
  const withJitter = base + Math.round(base * 0.2 * randomImpl());
  // El jitter puede empujar la base (ya topada en MAX_BACKOFF_MS) por encima del tope
  // absoluto; se recorta de nuevo aqui para que ningun caller vea un delay > 30000ms.
  return Math.min(withJitter, MAX_BACKOFF_MS);
};

export const isDatabaseReady = () => state.ready;

export const configureDatabaseReadinessForTests = ({ ready, ...overrides } = {}) => {
  Object.assign(dependencies, overrides);
  if (typeof ready === 'boolean') state.ready = ready;
};

export const resetDatabaseReadinessForTests = () => {
  if (state.retryTimer) dependencies.clearTimeout(state.retryTimer);
  state.ready = false;
  state.attempt = 0;
  state.retryTimer = null;
  state.inFlight = false;
  state.stopped = true;
  state.onReadyCalled = false;
  onReadyCallback = null;
  Object.assign(dependencies, defaultDependencies);
};

export const getDatabaseReadinessState = () => ({
  ready: state.ready,
  attempt: state.attempt,
  retrying: Boolean(state.retryTimer),
  in_flight: state.inFlight
});

const fireOnReadyOnce = () => {
  if (!onReadyCallback || state.onReadyCalled) return;
  state.onReadyCalled = true;
  Promise.resolve()
    .then(() => onReadyCallback())
    .catch((error) => {
      dependencies.error('[db_readiness] error iniciando dependencias tras recuperar PostgreSQL', {
        code: error?.code || 'DB_READINESS_ON_READY_ERROR',
        message: error?.message || 'Error desconocido'
      });
    });
};

const scheduleRetry = (delayMs) => {
  state.retryTimer = dependencies.setTimeout(() => {
    state.retryTimer = null;
    if (state.stopped) return;
    void runAttempt();
  }, delayMs);
};

const runAttempt = async () => {
  state.inFlight = true;
  try {
    await dependencies.checkDatabaseReady();
    state.inFlight = false;
    if (state.stopped) return;
    state.ready = true;
    state.attempt = 0;
    dependencies.log('[db_readiness] PostgreSQL disponible', {});
    fireOnReadyOnce();
  } catch (error) {
    state.inFlight = false;
    state.attempt += 1;
    const willRetryInMs = resolveDatabaseReadinessBackoffMs(state.attempt, dependencies.randomImpl);
    dependencies.warn('[db_readiness] PostgreSQL no disponible, reintentando en segundo plano', {
      code: error?.code || 'DB_NOT_READY',
      attempt: state.attempt,
      retry_in_ms: willRetryInMs
    });
    if (state.stopped) return;
    scheduleRetry(willRetryInMs);
  }
};

// Arranca (o reanuda) el ciclo de reconexion en segundo plano. Idempotente: nunca hay mas de
// un ciclo activo a la vez -- si ya hay un intento en vuelo o un retry pendiente, esta llamada
// no hace nada. Si la DB ya estaba lista, dispara onReady igual (una sola vez, ver
// fireOnReadyOnce) para que un caller que perdio la primera notificacion no se quede colgado.
export const startDatabaseReadinessLoop = ({ onReady } = {}) => {
  if (onReady) onReadyCallback = onReady;
  state.stopped = false;

  if (state.ready) {
    fireOnReadyOnce();
    return;
  }
  if (state.retryTimer || state.inFlight) return; // nunca mas de un ciclo de reconexion activo
  void runAttempt();
};

// Cancela el retry pendiente (si lo hay) y evita que uno en vuelo programe uno nuevo al
// terminar. No aborta una conexion ya en curso (pg no expone cancelacion), pero closePool()
// en el shutdown de server.js cierra el pool igual, por lo que ese intento termina solo.
export const stopDatabaseReadinessLoop = () => {
  state.stopped = true;
  if (state.retryTimer) {
    dependencies.clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
};
