import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import {
  createPrintAgentWebSocketServer,
  isPrintAgentWebSocketEnabled,
  notifyPrintJobAvailable,
  PRINT_AGENT_WS_PATH
} from '../services/printAgentWebSocketService.js';

const silentLog = { error: () => {}, info: () => {}, warn: () => {} };
const agentOne = { id_agente: '11111111-1111-1111-1111-111111111111', id_sucursal: 1 };
const agentTwo = { id_agente: '22222222-2222-2222-2222-222222222222', id_sucursal: 2 };

const authenticateFixture = async ({ agentId, token }) => {
  if (agentId === agentOne.id_agente && token === 'token-1') return agentOne;
  if (agentId === agentTwo.id_agente && token === 'token-2') return agentTwo;
  return null;
};

const startServer = async (overrides = {}) => {
  const httpServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wsServer = createPrintAgentWebSocketServer({
    authenticate: authenticateFixture,
    heartbeatIntervalMs: 5000,
    log: silentLog,
    ...overrides
  });
  httpServer.on('upgrade', wsServer.handleUpgrade);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  return {
    wsServer,
    port,
    stop: async () => {
      await wsServer.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  };
};

const connect = (port, { path = PRINT_AGENT_WS_PATH, headers = {} } = {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const cleanup = () => {
    ws.off('open', onOpen);
    ws.off('error', onError);
    ws.off('unexpected-response', onUnexpected);
  };
  const onOpen = () => { cleanup(); resolve(ws); };
  const onError = (error) => { cleanup(); reject(error); };
  const onUnexpected = (_req, res) => { cleanup(); reject(Object.assign(new Error('UNEXPECTED_RESPONSE'), { statusCode: res.statusCode })); };
  ws.on('open', onOpen);
  ws.on('error', onError);
  ws.on('unexpected-response', onUnexpected);
});

const waitForMessage = (ws, timeoutMs = 1000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error('TIMEOUT_WAITING_MESSAGE')); }, timeoutMs);
  const onMessage = (raw) => { clearTimeout(timer); resolve(JSON.parse(String(raw))); };
  ws.once('message', onMessage);
});

const assertNoMessage = (ws, timeoutMs = 300) => new Promise((resolve, reject) => {
  const onMessage = (raw) => { clearTimeout(timer); reject(new Error(`UNEXPECTED_MESSAGE:${String(raw)}`)); };
  const timer = setTimeout(() => { ws.off('message', onMessage); resolve(); }, timeoutMs);
  ws.once('message', onMessage);
});

test('acepta conexion con credenciales validas y entrega job_available solo a la sucursal correspondiente', async () => {
  const server = await startServer();
  try {
    const clientOne = await connect(server.port, { headers: { Authorization: 'Bearer token-1', 'X-Print-Agent-Id': agentOne.id_agente } });
    const clientTwo = await connect(server.port, { headers: { Authorization: 'Bearer token-2', 'X-Print-Agent-Id': agentTwo.id_agente } });
    try {
      const sent = server.wsServer.notifyJobAvailable(1);
      assert.equal(sent, 1);
      const message = await waitForMessage(clientOne);
      assert.deepEqual(message, { event: 'job_available', branch_id: 1 });
      await assertNoMessage(clientTwo);
    } finally {
      clientOne.terminate();
      clientTwo.terminate();
    }
  } finally {
    await server.stop();
  }
});

test('rechaza la conexion cuando el token o el agente no son validos', async () => {
  const server = await startServer();
  try {
    await assert.rejects(
      connect(server.port, { headers: { Authorization: 'Bearer wrong', 'X-Print-Agent-Id': agentOne.id_agente } }),
      /UNEXPECTED_RESPONSE|401/
    );
  } finally {
    await server.stop();
  }
});

test('destruye upgrades fuera de la ruta del agente de impresion', async () => {
  const server = await startServer();
  try {
    await assert.rejects(
      connect(server.port, { path: '/otra-ruta', headers: { Authorization: 'Bearer token-1', 'X-Print-Agent-Id': agentOne.id_agente } })
    );
  } finally {
    await server.stop();
  }
});

test('notifyJobAvailable no envia nada cuando no hay sockets para la sucursal', async () => {
  const server = await startServer();
  try {
    const sent = server.wsServer.notifyJobAvailable(999);
    assert.equal(sent, 0);
  } finally {
    await server.stop();
  }
});

test('close() termina todas las conexiones activas', async () => {
  const server = await startServer();
  const client = await connect(server.port, { headers: { Authorization: 'Bearer token-1', 'X-Print-Agent-Id': agentOne.id_agente } });
  const closed = new Promise((resolve) => client.once('close', resolve));
  await server.stop();
  await closed;
});

test('notifyPrintJobAvailable del modulo es no-op seguro sin servidor adjunto', () => {
  assert.equal(notifyPrintJobAvailable(1), 0);
});

test('isPrintAgentWebSocketEnabled exige exactamente "true" y por defecto es false', () => {
  assert.equal(isPrintAgentWebSocketEnabled({}), false);
  assert.equal(isPrintAgentWebSocketEnabled({ PRINT_AGENT_WEBSOCKET_ENABLED: 'false' }), false);
  assert.equal(isPrintAgentWebSocketEnabled({ PRINT_AGENT_WEBSOCKET_ENABLED: 'yes' }), false);
  assert.equal(isPrintAgentWebSocketEnabled({ PRINT_AGENT_WEBSOCKET_ENABLED: 'true' }), true);
  assert.equal(isPrintAgentWebSocketEnabled({ PRINT_AGENT_WEBSOCKET_ENABLED: 'TRUE' }), true);
});
