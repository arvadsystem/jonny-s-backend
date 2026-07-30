// Cola interna FIFO con concurrencia maxima de 1: nunca hay dos acumulaciones
// de fidelizacion corriendo al mismo tiempo (ni entre notificaciones normales
// ni entre estas y la reconciliacion del scheduler), sin bloquear a quien
// llama a notifyPaidInvoice (el encolado es sincrono; el procesamiento es
// diferido).
//
// Ademas deduplica por id_factura (una factura pendiente o en proceso nunca
// se vuelve a encolar; quien la pide de nuevo recibe el mismo resultado que
// el intento ya en curso) y aplica un limite maximo configurable, rechazando
// sin lanzar cuando la cola esta llena.
const DEFAULT_MAX_SIZE = 500;

const queue = [];
const inFlight = new Map(); // idFactura -> Promise<{status, result?, error?}>
let draining = false;
let idleWaiters = [];

const parsePositiveIntEnv = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getFidelizacionQueueMaxSize = () =>
  parsePositiveIntEnv(process.env.FIDELIZACION_QUEUE_MAX_SIZE, DEFAULT_MAX_SIZE);

const extractDedupeKey = (job) => {
  const idFactura = job?.idFactura;
  const parsed = Number.parseInt(String(idFactura ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const notifyIdleWaiters = () => {
  if (queue.length > 0 || draining) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  waiters.forEach((resolve) => resolve());
};

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const entry = queue.shift();
      try {
        const result = await entry.handler(entry.job);
        entry.resolve({ status: 'processed', result });
      } catch (error) {
        entry.resolve({ status: 'failed', error });
      } finally {
        if (entry.dedupeKey !== null) inFlight.delete(entry.dedupeKey);
      }
    }
  } finally {
    draining = false;
    notifyIdleWaiters();
  }
};

// Encola un job y devuelve una promesa que resuelve cuando termina de
// procesarse (nunca rechaza: el resultado del handler, exitoso o fallido,
// viaja dentro de { status, result | error }). Nunca bloquea al llamador
// mas alla del propio await de esta promesa; notifyPaidInvoice no la espera.
export const enqueueInvoiceAccumulation = (job, handler) => {
  const dedupeKey = extractDedupeKey(job);

  if (dedupeKey !== null && inFlight.has(dedupeKey)) {
    return inFlight.get(dedupeKey);
  }

  if (queue.length >= getFidelizacionQueueMaxSize()) {
    console.error('[fidelizacion:queue] rechazado por cola llena', {
      id_factura: dedupeKey,
      queue_size: queue.length,
      max_size: getFidelizacionQueueMaxSize()
    });
    return Promise.resolve({ status: 'rejected', reason: 'QUEUE_FULL' });
  }

  const promise = new Promise((resolve) => {
    queue.push({ job, handler, resolve, dedupeKey });
  });

  if (dedupeKey !== null) inFlight.set(dedupeKey, promise);

  void drain();
  return promise;
};

// Para el worker de reconciliacion: encola un lote y espera el resultado
// real de cada uno (procesado, fallido o rechazado), nunca solo el hecho de
// haberlos encolado.
export const enqueueInvoiceAccumulationBatch = (jobs, handler) =>
  Promise.all(jobs.map((job) => enqueueInvoiceAccumulation(job, handler)));

// Solo para pruebas/observabilidad: esperar a que la cola termine de
// procesar todo lo encolado hasta el momento.
export const waitForFidelizacionQueueIdle = () =>
  new Promise((resolve) => {
    if (queue.length === 0 && !draining) {
      resolve();
      return;
    }
    idleWaiters.push(resolve);
  });

export const getFidelizacionQueueDepthForTests = () => queue.length;
export const isFidelizacionQueueDrainingForTests = () => draining;
export const isFidelizacionInvoiceInFlightForTests = (idFactura) => inFlight.has(Number(idFactura));
