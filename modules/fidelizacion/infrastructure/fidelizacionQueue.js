// Cola interna FIFO con concurrencia maxima de 1: nunca hay dos acumulaciones
// de fidelizacion corriendo al mismo tiempo (ni entre notificaciones normales
// ni entre estas y la reconciliacion del scheduler), sin bloquear a quien
// llama a notifyPaidInvoice (el encolado es sincrono; el procesamiento es
// diferido).
const queue = [];
let draining = false;
let idleWaiters = [];

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
      const { job, handler } = queue.shift();
      try {
        await handler(job);
      } catch (_) {
        // El handler (accumulateInvoicePoints) ya debe capturar sus propios
        // errores; esto es solo un cinturon de seguridad para que un fallo
        // inesperado nunca detenga el drenado del resto de la cola.
      }
    }
  } finally {
    draining = false;
    notifyIdleWaiters();
  }
};

export const enqueueInvoiceAccumulation = (job, handler) => {
  queue.push({ job, handler });
  void drain();
};

// Solo para pruebas: permite esperar a que la cola termine de procesar todo
// lo encolado hasta el momento, en vez de sondear con temporizadores.
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
