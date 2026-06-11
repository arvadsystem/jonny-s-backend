const STREAM_RETRY_MS = 5000;
const STREAM_HEARTBEAT_MS = 25000;

let nextClientId = 1;
const notificationClients = new Map();

const writeSseEvent = (res, eventName, payload) => {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const cleanupClient = (clientId) => {
  const current = notificationClients.get(clientId);
  if (!current) return;

  notificationClients.delete(clientId);
  if (current.heartbeatId) {
    clearInterval(current.heartbeatId);
  }

  try {
    current.res.end();
  } catch {
    // Ignore closed stream errors.
  }
};

export const openSecurityNotificationsStream = (req, res) => {
  const clientId = `security-stream-${Date.now()}-${nextClientId++}`;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof req?.socket?.setKeepAlive === 'function') {
    req.socket.setKeepAlive(true);
  }

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  res.write(`retry: ${STREAM_RETRY_MS}\n\n`);
  writeSseEvent(res, 'connected', { ok: true, timestamp: new Date().toISOString() });

  const heartbeatId = setInterval(() => {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      cleanupClient(clientId);
    }
  }, STREAM_HEARTBEAT_MS);

  notificationClients.set(clientId, { res, heartbeatId });

  const closeStream = () => cleanupClient(clientId);
  req.on('close', closeStream);
  req.on('end', closeStream);
  res.on('close', closeStream);
  res.on('finish', closeStream);
};

export const broadcastSecurityNotification = (notification) => {
  if (!notification || typeof notification !== 'object') return 0;

  let delivered = 0;
  for (const [clientId, client] of notificationClients.entries()) {
    try {
      writeSseEvent(client.res, 'notification', { notification });
      delivered += 1;
    } catch {
      cleanupClient(clientId);
    }
  }

  return delivered;
};
