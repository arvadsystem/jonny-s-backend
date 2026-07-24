import WebSocket from 'ws';

const PRINT_AGENT_WS_PATH = '/api/print-agent/ws';
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_BACKOFF_ATTEMPT = 5; // 1000 * 2^5 = 32000ms, recortado a MAX_BACKOFF_MS
const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 10000;

const sanitize = (error) => String(error?.code || error?.message || 'WS_ERROR').replace(/[\r\n\t]+/g, ' ').slice(0, 500);

export const buildPrintAgentWsUrl = (apiBaseUrl) =>
  `${String(apiBaseUrl).replace(/^https:\/\//i, 'wss://')}${PRINT_AGENT_WS_PATH}`;

export const backoffDelayMs = (attempt, randomImpl = Math.random) => {
  const base = Math.min(BASE_BACKOFF_MS * (2 ** Math.min(attempt, MAX_BACKOFF_ATTEMPT)), MAX_BACKOFF_MS);
  return base + Math.round(base * 0.1 * randomImpl());
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cliente WebSocket aditivo: solo dispara claimAndProcess(trigger) en el runner. Nunca
// imprime ni recibe el documento; ignora cualquier branch_id ajeno a su sucursal autenticada.
export const createPrintAgentWebSocketClient = ({
  config,
  onSignal,
  log = () => {},
  WebSocketImpl = WebSocket,
  delayImpl = delay,
  randomImpl = Math.random,
  pingIntervalMs = PING_INTERVAL_MS,
  pongTimeoutMs = PONG_TIMEOUT_MS
}) => {
  let stopped = true;
  let socket = null;
  let attempt = 0;
  let pingTimer = null;
  let pongTimer = null;

  const emitSignal = (trigger) => {
    Promise.resolve()
      .then(() => onSignal(trigger))
      .catch((error) => log('error', 'ws_signal_failed', { trigger, code: sanitize(error) }));
  };

  const clearHeartbeatTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  };

  const startHeartbeat = (activeSocket) => {
    pingTimer = setInterval(() => {
      if (activeSocket.readyState !== WebSocketImpl.OPEN) return;
      // Cada ping reemplaza la expectativa de pong anterior; sin este clear, un pong
      // puntual solo cancela el timer mas reciente y deja "timers fantasma" de pings
      // previos que dispararian un terminate() espurio pese a la conexion sana.
      if (pongTimer) clearTimeout(pongTimer);
      try { activeSocket.ping(); } catch { /* el timeout de pong siguiente fuerza la reconexion */ }
      pongTimer = setTimeout(() => {
        log('warn', 'ws_pong_timeout', {});
        try { activeSocket.terminate(); } catch { /* ya cerrado */ }
      }, pongTimeoutMs);
    }, pingIntervalMs);
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const wait = backoffDelayMs(attempt, randomImpl);
    attempt += 1;
    log('info', 'ws_reconnect_scheduled', { delay_ms: wait, attempt });
    void delayImpl(wait).then(() => { if (!stopped) connect(); });
  };

  const connect = () => {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(buildPrintAgentWsUrl(config.apiBaseUrl), {
        headers: {
          Authorization: `Bearer ${config.token}`,
          'X-Print-Agent-Id': config.agentId
        }
      });
    } catch (error) {
      log('error', 'ws_connect_failed', { code: sanitize(error) });
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.on('open', () => {
      if (stopped) return;
      attempt = 0;
      log('info', 'ws_connected', {});
      startHeartbeat(ws);
      emitSignal('reconnect');
    });

    ws.on('pong', () => {
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = null;
    });

    ws.on('message', (raw) => {
      if (stopped) return;
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message || message.event !== 'job_available') return;
      if (Number(message.branch_id) !== config.branchId) return;
      emitSignal('websocket');
    });

    ws.on('close', () => {
      clearHeartbeatTimers();
      if (stopped) return;
      log('info', 'ws_disconnected', {});
      scheduleReconnect();
    });

    ws.on('error', (error) => {
      log('error', 'ws_error', { code: sanitize(error) });
    });
  };

  return {
    start: () => {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop: () => {
      stopped = true;
      clearHeartbeatTimers();
      try { socket?.terminate(); } catch { /* ya cerrado */ }
      socket = null;
    }
  };
};
