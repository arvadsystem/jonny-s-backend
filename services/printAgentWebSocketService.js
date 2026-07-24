import { WebSocketServer } from 'ws';
import { authenticatePrintAgent } from './printAgentAuthService.js';

export const PRINT_AGENT_WS_PATH = '/api/print-agent/ws';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;
// Cota defensiva para no dejar un upgrade colgado indefinidamente si la autenticacion
// (consulta a PostgreSQL) tarda o se cuelga; ver hasValidCredentialShape mas abajo.
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
// Autenticaciones en vuelo simultaneas: cada una dispara una consulta a la base de datos,
// asi que se limita para no permitir que una rafaga de intentos de conexion agote el pool.
const DEFAULT_MAX_PENDING_UPGRADES = 20;
// Techo de sockets autenticados simultaneos; muy por encima de cualquier despliegue real
// de agentes de sucursal, solo como limite defensivo ante un cliente descontrolado.
const DEFAULT_MAX_CONNECTIONS = 200;
// Misma forma que valida authenticatePrintAgent internamente (printAgentAuthService.js).
// Repetirla aqui permite rechazar encabezados invalidos antes de siquiera invocar
// authenticate(), sin depender de que la implementacion inyectada tenga ese atajo.
const AGENT_ID_PATTERN = /^[0-9a-f-]{36}$/i;
const MIN_TOKEN_LENGTH = 32;

const parseBearerToken = (headers) => {
  const authorization = String(headers?.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
};

const hasValidCredentialShape = (agentId, token) =>
  AGENT_ID_PATTERN.test(agentId) && token.length >= MIN_TOKEN_LENGTH;

export const isPrintAgentWebSocketEnabled = (env = process.env) =>
  String(env.PRINT_AGENT_WEBSOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// Servidor WebSocket aditivo: solo notifica "job_available" a agentes ya autenticados
// con la misma credencial HTTP existente. Nunca envia el documento ni ordena imprimir;
// el agente sigue reclamando por la RPC actual (unica autoridad de asignacion).
export const createPrintAgentWebSocketServer = ({
  authenticate = authenticatePrintAgent,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  maxPendingUpgrades = DEFAULT_MAX_PENDING_UPGRADES,
  maxConnections = DEFAULT_MAX_CONNECTIONS,
  log = console
} = {}) => {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByBranch = new Map();
  let pendingUpgrades = 0;
  let openConnections = 0;

  const rejectUpgrade = (socket, statusLine) => {
    try {
      socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
    } catch { /* el socket ya pudo haberse cerrado */ }
    socket.destroy();
  };

  // Mismo patron que app.js usa para /health/ready: Promise.race contra un timeout que
  // nunca deja abierta la conexion mientras espera una autenticacion lenta o colgada.
  const withAuthTimeout = (promise) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('PRINT_AGENT_WS_AUTH_TIMEOUT'), { code: 'PRINT_AGENT_WS_AUTH_TIMEOUT' }));
      }, authTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const registerSocket = (ws, agent) => {
    const branchId = Number(agent.id_sucursal);
    if (!socketsByBranch.has(branchId)) socketsByBranch.set(branchId, new Set());
    socketsByBranch.get(branchId).add(ws);
    openConnections += 1;
    ws.on('close', () => {
      openConnections = Math.max(0, openConnections - 1);
      const sockets = socketsByBranch.get(branchId);
      if (!sockets) return;
      sockets.delete(ws);
      if (sockets.size === 0) socketsByBranch.delete(branchId);
    });
  };

  wss.on('connection', (ws, _request, agent) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (error) => {
      log.error?.('[print-agent.ws] error de socket', { agent_id: agent.id_agente, code: error?.code || error?.message || null });
    });
    registerSocket(ws, agent);
    log.info?.('[print-agent.ws] agente conectado', { agent_id: agent.id_agente, id_sucursal: agent.id_sucursal });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* un fallo de ping se resuelve en el siguiente ciclo de heartbeat */ }
    }
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const handleUpgrade = (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, 'http://print-agent-ws.internal').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== PRINT_AGENT_WS_PATH) {
      socket.destroy();
      return;
    }

    const agentId = String(request.headers['x-print-agent-id'] || '').trim();
    const token = parseBearerToken(request.headers);
    // Rechazo inmediato: encabezados con forma invalida ni siquiera llegan a authenticate()
    // (sin consulta a la base de datos), igual que un intento de conexion con credenciales
    // vacias o corruptas.
    if (!hasValidCredentialShape(agentId, token)) {
      rejectUpgrade(socket, '400 Bad Request');
      return;
    }

    if (openConnections >= maxConnections) {
      log.warn?.('[print-agent.ws] limite de conexiones alcanzado', { open_connections: openConnections });
      rejectUpgrade(socket, '503 Service Unavailable');
      return;
    }
    if (pendingUpgrades >= maxPendingUpgrades) {
      log.warn?.('[print-agent.ws] limite de autenticaciones pendientes alcanzado', { pending_upgrades: pendingUpgrades });
      rejectUpgrade(socket, '503 Service Unavailable');
      return;
    }

    pendingUpgrades += 1;
    withAuthTimeout(Promise.resolve(authenticate({ agentId, token })))
      .then((agent) => {
        pendingUpgrades -= 1;
        if (socket.destroyed) return; // el cliente pudo haberse ido durante la autenticacion
        if (!agent) {
          rejectUpgrade(socket, '401 Unauthorized');
          return;
        }
        if (openConnections >= maxConnections) {
          log.warn?.('[print-agent.ws] limite de conexiones alcanzado tras autenticar', { open_connections: openConnections });
          rejectUpgrade(socket, '503 Service Unavailable');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, agent);
        });
      })
      .catch((error) => {
        pendingUpgrades -= 1;
        const isTimeout = error?.code === 'PRINT_AGENT_WS_AUTH_TIMEOUT';
        log.error?.(
          isTimeout ? '[print-agent.ws] timeout de autenticacion' : '[print-agent.ws] fallo de autenticacion',
          { code: error?.code || null }
        );
        if (!socket.destroyed) rejectUpgrade(socket, '503 Service Unavailable');
      });
  };

  const notifyJobAvailable = (idSucursal) => {
    const branchId = Number(idSucursal);
    const sockets = socketsByBranch.get(branchId);
    if (!sockets || sockets.size === 0) return 0;
    const message = JSON.stringify({ event: 'job_available', branch_id: branchId });
    let sent = 0;
    for (const ws of sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(message);
        sent += 1;
      } catch (error) {
        log.error?.('[print-agent.ws] fallo enviando job_available', { id_sucursal: branchId, code: error?.code || error?.message || null });
      }
    }
    return sent;
  };

  const close = () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  };

  return { handleUpgrade, notifyJobAvailable, close, wss };
};

let activeServer = null;

export const attachPrintAgentWebSocketServer = (httpServer, options = {}) => {
  const server = createPrintAgentWebSocketServer(options);
  httpServer.on('upgrade', server.handleUpgrade);
  activeServer = server;
  return server;
};

// Usado por printQueueService.enqueuePrintJob despues de confirmar la transaccion.
// Es un no-op seguro cuando el servidor WebSocket no esta activo (flag apagado o pruebas).
export const notifyPrintJobAvailable = (idSucursal) => {
  if (!activeServer) return 0;
  return activeServer.notifyJobAvailable(idSucursal);
};

export const detachPrintAgentWebSocketServer = async () => {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = null;
  await server.close();
};
