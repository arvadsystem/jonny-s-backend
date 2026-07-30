import { checkDatabaseReady as defaultCheckDatabaseReady } from './db-connection.js';

// Secuencia de backoff para reconectar mientras la DB no responde: 2s, 4s, 8s, 15s y desde
// el 5to intento se estabiliza en el tope de 30s. Con jitter (+0..20%) para evitar que varias
// replicas reintenten exactamente en el mismo instante contra el mismo Postgres.
const BACKOFF_SEQUENCE_MS = [2000, 4000, 8000, 15000, 30000];
const MAX_BACKOFF_MS = 30000;
const DEFAULT_HEALTHY_CHECK_INTERVAL_MS = 5000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;

// Unico estado compartido de readiness: lo leen /health/ready, el middleware de rutas y el
// arranque de workers (ver app.js y server.js). `ready` refleja el resultado del ULTIMO
// chequeo, no "estuvo listo alguna vez" -- por eso puede volver a false si Postgres cae
// despues del primer exito (a diferencia del disparo de onReady, que es de una sola vez).
const state = {
  ready: false,
  attempt: 0,
  timer: null, // unico timer activo, ya sea de retry (no listo) o de chequeo periodico (listo)
  inFlight: false,
  inFlightPromise: null,
  stopped: true,
  onReadyCalled: false
};

let onReadyCallback = null;

const parsePositiveIntEnv = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const getHealthyCheckIntervalMsFromEnv = () =>
  parsePositiveIntEnv(process.env.DB_READINESS_CHECK_INTERVAL_MS, DEFAULT_HEALTHY_CHECK_INTERVAL_MS, 1000, 60000);

const defaultDependencies = {
  checkDatabaseReady: defaultCheckDatabaseReady,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  randomImpl: Math.random,
  getHealthyCheckIntervalMs: getHealthyCheckIntervalMsFromEnv,
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

// Fuente unica de verdad para /health/ready, el middleware de rutas y el arranque de
// workers: nunca dispara una consulta nueva, solo lee el resultado del ultimo chequeo en
// segundo plano (ver runCheck).
export const isDatabaseReady = () => state.ready;

export const configureDatabaseReadinessForTests = ({ ready, ...overrides } = {}) => {
  Object.assign(dependencies, overrides);
  if (typeof ready === 'boolean') state.ready = ready;
};

export const resetDatabaseReadinessForTests = () => {
  if (state.timer) dependencies.clearTimeout(state.timer);
  state.ready = false;
  state.attempt = 0;
  state.timer = null;
  state.inFlight = false;
  state.inFlightPromise = null;
  state.stopped = true;
  state.onReadyCalled = false;
  onReadyCallback = null;
  Object.assign(dependencies, defaultDependencies);
};

export const getDatabaseReadinessState = () => ({
  ready: state.ready,
  attempt: state.attempt,
  retrying: Boolean(state.timer) && !state.ready,
  monitoring: Boolean(state.timer) && state.ready,
  in_flight: state.inFlight
});

// Dispara el arranque de workers exactamente una vez, en la PRIMERA vez que la DB confirma
// estar lista -- nunca de nuevo, ni siquiera si readiness cae y se recupera despues (item 5:
// los workers no deben duplicarse tras una caida y recuperacion; siguen funcionando con su
// propia logica si la DB vuelve a caer).
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

const scheduleNext = (delayMs) => {
  state.timer = dependencies.setTimeout(() => {
    state.timer = null;
    if (state.stopped) return;
    state.inFlightPromise = runCheck();
  }, delayMs);
};

// Bucle unico y continuo (nunca dos chequeos en vuelo, nunca dos timers): mientras la DB
// responde, vuelve a comprobar cada getHealthyCheckIntervalMs(); en cuanto un chequeo falla,
// marca ready=false y retoma el backoff desde el primer escalon. El siguiente chequeo -- ya
// sea el periodico o un retry -- solo se programa despues de que este termina, por lo que
// jamas hay checks superpuestos ni retries en paralelo.
const runCheck = async () => {
  state.inFlight = true;
  try {
    await dependencies.checkDatabaseReady();
    state.inFlight = false;
    state.inFlightPromise = null;
    if (state.stopped) return;
    const wasReady = state.ready;
    state.ready = true;
    state.attempt = 0;
    if (!wasReady) {
      dependencies.log('[db_readiness] PostgreSQL disponible', {});
      fireOnReadyOnce();
    }
    scheduleNext(dependencies.getHealthyCheckIntervalMs());
  } catch (error) {
    state.inFlight = false;
    state.inFlightPromise = null;
    const wasReady = state.ready;
    state.ready = false;
    state.attempt += 1;
    const willRetryInMs = resolveDatabaseReadinessBackoffMs(state.attempt, dependencies.randomImpl);
    if (wasReady) {
      dependencies.error('[db_readiness] PostgreSQL dejo de responder, readiness=false', {
        code: error?.code || 'DB_NOT_READY',
        retry_in_ms: willRetryInMs
      });
    } else {
      dependencies.warn('[db_readiness] PostgreSQL no disponible, reintentando en segundo plano', {
        code: error?.code || 'DB_NOT_READY',
        attempt: state.attempt,
        retry_in_ms: willRetryInMs
      });
    }
    if (state.stopped) return;
    scheduleNext(willRetryInMs);
  }
};

// Arranca (o reanuda) el monitor. Idempotente: nunca hay mas de un ciclo activo a la vez --
// si ya hay un chequeo en vuelo o un timer pendiente (de retry o de chequeo periodico), esta
// llamada no hace nada. Si la DB ya estaba lista, dispara onReady igual (una sola vez, ver
// fireOnReadyOnce) para que un caller que perdio la primera notificacion no se quede colgado.
export const startDatabaseReadinessLoop = ({ onReady } = {}) => {
  if (onReady) onReadyCallback = onReady;
  state.stopped = false;

  if (state.ready) {
    fireOnReadyOnce();
    return;
  }
  if (state.timer || state.inFlight) return; // nunca mas de un ciclo de reconexion activo
  state.inFlightPromise = runCheck();
};

// Detiene el monitor: cancela el timer pendiente (retry o chequeo periodico) y espera a que
// el chequeo en vuelo, si lo hay, termine (acotado por timeoutMs) antes de resolver -- para
// que el shutdown pueda cerrar el pool sin dejar un chequeo colgando a mitad de camino. No
// aborta la conexion en curso (pg no expone cancelacion), pero closePool() en server.js
// cierra el pool igual, asi que ese intento termina solo si el timeout se agota primero.
export const stopDatabaseReadinessLoop = async ({ timeoutMs = DEFAULT_STOP_TIMEOUT_MS } = {}) => {
  state.stopped = true;
  if (state.timer) {
    dependencies.clearTimeout(state.timer);
    state.timer = null;
  }

  if (!state.inFlightPromise) {
    return { stopped: true, reason: 'STOPPED' };
  }

  const boundedTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_STOP_TIMEOUT_MS;
  const pendingCheck = state.inFlightPromise;
  const timeoutResult = new Promise((resolve) => {
    dependencies.setTimeout(() => resolve({ stopped: false, reason: 'IN_FLIGHT_CHECK_TIMEOUT' }), boundedTimeoutMs);
  });

  return Promise.race([
    pendingCheck.then(() => ({ stopped: true, reason: 'STOPPED' })),
    timeoutResult
  ]);
};
