const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const CONCURRENCY = Math.min(
  parsePositiveInt(process.env.CAJA_CLOSE_NOTIFICATION_CONCURRENCY, 1),
  2
);
const MAX_QUEUE_SIZE = Math.min(
  parsePositiveInt(process.env.CAJA_CLOSE_NOTIFICATION_QUEUE_MAX, 100),
  1000
);

const state = {
  active: 0,
  queue: [],
  pendingCloseIds: new Set(),
  drainResolvers: []
};

const notifyDrainers = () => {
  if (state.active !== 0 || state.queue.length !== 0) return;
  const resolvers = state.drainResolvers.splice(0);
  for (const resolve of resolvers) resolve();
};

const runNext = () => {
  while (state.active < CONCURRENCY && state.queue.length > 0) {
    const item = state.queue.shift();
    state.active += 1;

    Promise.resolve()
      .then(item.task)
      .catch((error) => {
        console.error('[caja_close_notification_queue] notification error', {
          id_cierre_caja: item.idCierreCaja,
          code: error?.code || null,
          message: error?.message || 'Notification error'
        });
      })
      .finally(() => {
        state.active -= 1;
        state.pendingCloseIds.delete(item.idCierreCaja);
        notifyDrainers();
        runNext();
      });
  }
};

export const enqueueCajaCloseNotification = ({ idCierreCaja, task }) => {
  const closeId = String(idCierreCaja ?? '').trim();
  if (!closeId || typeof task !== 'function') {
    return { enqueued: false, reason: 'INVALID_PAYLOAD' };
  }
  if (state.pendingCloseIds.has(closeId)) {
    return { enqueued: false, reason: 'DUPLICATE_IN_REPLICA' };
  }
  if (state.queue.length >= MAX_QUEUE_SIZE) {
    console.warn('[caja_close_notification_queue] queue full', {
      id_cierre_caja: closeId,
      queue_length: state.queue.length,
      max_queue_size: MAX_QUEUE_SIZE
    });
    return { enqueued: false, reason: 'QUEUE_FULL' };
  }

  state.pendingCloseIds.add(closeId);
  state.queue.push({ idCierreCaja: closeId, task });
  queueMicrotask(runNext);
  return { enqueued: true, reason: 'QUEUED' };
};

export const getCajaCloseNotificationQueueState = () => ({
  active: state.active,
  queued: state.queue.length,
  pending: state.pendingCloseIds.size,
  concurrency: CONCURRENCY,
  max_queue_size: MAX_QUEUE_SIZE
});

export const drainCajaCloseNotificationQueue = async ({ timeoutMs = 5000 } = {}) => {
  const parsedTimeout = parsePositiveInt(timeoutMs, 5000);
  const boundedTimeout = Math.min(parsedTimeout, 30000);
  if (state.active === 0 && state.queue.length === 0) {
    return { drained: true, active: 0, queued: 0 };
  }

  let timeout = null;
  const result = await Promise.race([
    new Promise((resolve) => {
      state.drainResolvers.push(() => resolve({ drained: true }));
    }),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ drained: false, reason: 'TIMEOUT' }), boundedTimeout);
    })
  ]);

  if (timeout) clearTimeout(timeout);
  return {
    ...result,
    active: state.active,
    queued: state.queue.length
  };
};
