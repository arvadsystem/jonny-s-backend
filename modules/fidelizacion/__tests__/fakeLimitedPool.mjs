// Pool falso que SI modela max:1 de verdad: una segunda llamada a connect()
// mientras la unica conexion esta ocupada queda esperando (no resuelve) hasta
// que alguien llama release(). A diferencia de un mock que siempre devuelve
// el mismo cliente de inmediato, esto permite detectar un deadlock real: si
// el codigo bajo prueba retiene su conexion mientras espera que OTRA
// operacion pida una conexion al mismo pool, esa segunda peticion se queda
// esperando para siempre.
export const createFakeLimitedPool = ({ max = 1, backendQuery, onRelease = null } = {}) => {
  let inUse = 0;
  const waiters = [];

  const buildClient = () => ({
    query: (...args) => backendQuery(...args),
    release: () => {
      inUse -= 1;
      if (onRelease) onRelease();
      const next = waiters.shift();
      if (next) next();
    }
  });

  const tryAcquire = (resolve) => {
    if (inUse < max) {
      inUse += 1;
      resolve(buildClient());
      return true;
    }
    return false;
  };

  const connect = () => new Promise((resolve) => {
    if (!tryAcquire(resolve)) {
      waiters.push(() => tryAcquire(resolve));
    }
  });

  return {
    connect,
    getInUse: () => inUse,
    getWaitingCount: () => waiters.length
  };
};

export const withTimeout = (promise, ms, message) => Promise.race([
  promise,
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  })
]);
