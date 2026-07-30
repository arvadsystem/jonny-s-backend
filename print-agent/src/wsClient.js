import WebSocket from 'ws';

const PRINT_AGENT_WS_PATH = '/api/print-agent/ws';
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_BACKOFF_ATTEMPT = 5; // 1000 * 2^5 = 32000ms, recortado a MAX_BACKOFF_MS
const PING_INTERVAL_MS = 25000;
const PONG_TIMEOUT_MS = 10000;
// Cuanto debe permanecer abierta una conexion antes de confiar en ella. Un proxy que
// deja abrir el WebSocket pero lo cierra casi de inmediato (QA) no debe resetear el
// backoff ni disparar la reconciliacion por reconexion; ver createPrintAgentWebSocketClient.
const STABLE_CONNECTION_MS = 3000;

const sanitize = (error) => String(error?.code || error?.message || 'WS_ERROR').replace(/[\r\n\t]+/g, ' ').slice(0, 500);

export const buildPrintAgentWsUrl = (apiBaseUrl) =>
  `${String(apiBaseUrl).replace(/^https:\/\//i, 'wss://')}${PRINT_AGENT_WS_PATH}`;

export const backoffDelayMs = (attempt, randomImpl = Math.random) => {
  const base = Math.min(BASE_BACKOFF_MS * (2 ** Math.min(attempt, MAX_BACKOFF_ATTEMPT)), MAX_BACKOFF_MS);
  const withJitter = base + Math.round(base * 0.1 * randomImpl());
  // El jitter puede empujar la base (ya topada en MAX_BACKOFF_MS) por encima del tope
  // absoluto; se recorta de nuevo aqui para que ningun caller vea un delay > 30000ms.
  return Math.min(withJitter, MAX_BACKOFF_MS);
};

// Cliente WebSocket aditivo: solo dispara claimAndProcess(trigger) en el runner. Nunca
// imprime ni recibe el documento; ignora cualquier branch_id ajeno a su sucursal autenticada.
export const createPrintAgentWebSocketClient = ({
  config,
  onSignal,
  log = () => {},
  WebSocketImpl = WebSocket,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  randomImpl = Math.random,
  pingIntervalMs = PING_INTERVAL_MS,
  pongTimeoutMs = PONG_TIMEOUT_MS,
  stableConnectionMs = STABLE_CONNECTION_MS
}) => {
  let stopped = true;
  let socket = null;
  let attempt = 0;
  let pingTimer = null;
  let pongTimer = null;
  let stableTimer = null;
  // Handle del setTimeout de la reconexion pendiente (setTimeoutImpl/clearTimeoutImpl son
  // inyectables para pruebas). Mientras no sea null, scheduleReconnect() nunca programa una
  // segunda reconexion en paralelo, y stop() lo cancela con clearTimeoutImpl -- no solo lo
  // desreferencia -- para que un timer que ya vencio no dispare connect() tras un stop()
  // seguido de un start() nuevo.
  let reconnectTimer = null;
  // Por intento de conexion: evita que un pong tardio y el propio timer de estabilidad
  // reseteen el backoff/disparen la reconciliacion dos veces para la misma conexion.
  let stabilized = false;

  const emitSignal = (trigger) => {
    Promise.resolve()
      .then(() => onSignal(trigger))
      .catch((error) => log('error', 'ws_signal_failed', { trigger, code: sanitize(error) }));
  };

  const clearStableTimer = () => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  };

  const clearHeartbeatTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  };

  // Unica puerta hacia "esta conexion es confiable": una vez cruzada (por pong o por
  // tiempo), recien ahi se resetea el backoff exponencial y se dispara la reconciliacion
  // por reconexion. Una conexion que abre y cierra rapido nunca llega a este punto.
  const markStable = () => {
    if (stabilized) return;
    stabilized = true;
    clearStableTimer();
    attempt = 0;
    log('info', 'ws_stable', {});
    emitSignal('reconnect');
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
    if (reconnectTimer) return; // nunca mas de una reconexion programada al mismo tiempo
    const wait = backoffDelayMs(attempt, randomImpl);
    attempt += 1;
    log('info', 'ws_reconnect_scheduled', { delay_ms: wait, attempt });
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      if (!stopped) connect();
    }, wait);
  };

  const connect = () => {
    if (stopped) return;
    stabilized = false;
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
      log('info', 'ws_connected', {});
      startHeartbeat(ws);
      // No se resetea attempt ni se dispara la reconciliacion todavia: primero hay que
      // ver que la conexion aguante stableConnectionMs, o llegue un pong valido.
      clearStableTimer();
      stableTimer = setTimeout(markStable, stableConnectionMs);
    });

    ws.on('pong', () => {
      if (pongTimer) clearTimeout(pongTimer);
      pongTimer = null;
      markStable();
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
      clearStableTimer();
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
      clearStableTimer();
      // clearTimeoutImpl cancela el timer nativo -- no basta con desreferenciarlo --
      // porque si start() se vuelve a invocar despues, `stopped` vuelve a false y un
      // timer viejo no cancelado dispararia connect() igual, creando una conexion extra.
      if (reconnectTimer) clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
      try { socket?.terminate(); } catch { /* ya cerrado */ }
      socket = null;
    }
  };
};
