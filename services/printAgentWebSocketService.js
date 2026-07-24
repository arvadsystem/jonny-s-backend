import { WebSocketServer } from 'ws';
import { authenticatePrintAgent } from './printAgentAuthService.js';

export const PRINT_AGENT_WS_PATH = '/api/print-agent/ws';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000;

const parseBearerToken = (headers) => {
  const authorization = String(headers?.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
};

export const isPrintAgentWebSocketEnabled = (env = process.env) =>
  String(env.PRINT_AGENT_WEBSOCKET_ENABLED || '').trim().toLowerCase() === 'true';

// Servidor WebSocket aditivo: solo notifica "job_available" a agentes ya autenticados
// con la misma credencial HTTP existente. Nunca envia el documento ni ordena imprimir;
// el agente sigue reclamando por la RPC actual (unica autoridad de asignacion).
export const createPrintAgentWebSocketServer = ({
  authenticate = authenticatePrintAgent,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  log = console
} = {}) => {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByBranch = new Map();

  const registerSocket = (ws, agent) => {
    const branchId = Number(agent.id_sucursal);
    if (!socketsByBranch.has(branchId)) socketsByBranch.set(branchId, new Set());
    socketsByBranch.get(branchId).add(ws);
    ws.on('close', () => {
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
    Promise.resolve(authenticate({ agentId, token }))
      .then((agent) => {
        if (!agent) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, agent);
        });
      })
      .catch((error) => {
        log.error?.('[print-agent.ws] fallo de autenticacion', { code: error?.code || null });
        try {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        } catch { /* el socket ya pudo haberse cerrado */ }
        socket.destroy();
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
