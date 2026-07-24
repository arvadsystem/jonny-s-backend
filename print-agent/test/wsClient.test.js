import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { backoffDelayMs, buildPrintAgentWsUrl, createPrintAgentWebSocketClient } from '../src/wsClient.js';

const baseConfig = { apiBaseUrl: 'https://qa.example.com', token: 'x'.repeat(48), agentId: 'agent-1', branchId: 2 };

const createFakeWebSocketImpl = () => {
  const instances = [];
  function FakeWebSocket(url, options) {
    const instance = new EventEmitter();
    instance.url = url;
    instance.options = options;
    instance.readyState = FakeWebSocket.CONNECTING;
    instance.pings = 0;
    instance.terminated = false;
    instance.ping = () => { instance.pings += 1; };
    instance.send = () => {};
    instance.terminate = () => {
      if (instance.readyState === FakeWebSocket.CLOSED) return;
      instance.readyState = FakeWebSocket.CLOSED;
      instance.terminated = true;
      instance.emit('close');
    };
    instances.push(instance);
    return instance;
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.instances = instances;
  return FakeWebSocket;
};

const tick = async (times = 3) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const waitUntil = async (predicate, timeoutMs = 500, intervalMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('WAIT_UNTIL_TIMEOUT');
};

const openInstance = (instance, WebSocketImpl) => {
  instance.readyState = WebSocketImpl.OPEN;
  instance.emit('open');
};

test('buildPrintAgentWsUrl convierte https a wss y agrega la ruta del agente', () => {
  assert.equal(buildPrintAgentWsUrl('https://qa.example.com'), 'wss://qa.example.com/api/print-agent/ws');
  assert.equal(buildPrintAgentWsUrl('HTTPS://Local.Example.Com'), 'wss://Local.Example.Com/api/print-agent/ws');
});

test('backoffDelayMs sigue 1,2,4,8,16,30s con tope y jitter pequeño', () => {
  const noJitter = () => 0;
  assert.equal(backoffDelayMs(0, noJitter), 1000);
  assert.equal(backoffDelayMs(1, noJitter), 2000);
  assert.equal(backoffDelayMs(2, noJitter), 4000);
  assert.equal(backoffDelayMs(3, noJitter), 8000);
  assert.equal(backoffDelayMs(4, noJitter), 16000);
  assert.equal(backoffDelayMs(5, noJitter), 30000);
  assert.equal(backoffDelayMs(9, noJitter), 30000);

  const maxJitter = () => 1;
  const withJitter = backoffDelayMs(0, maxJitter);
  assert.ok(withJitter >= 1000 && withJitter <= 1100, `jitter fuera de rango: ${withJitter}`);
});

test('al conectar (open) NO ejecuta claimAndProcess("reconnect") de inmediato', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    stableConnectionMs: 10000 // deliberadamente largo: nada debe emitirse todavia
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  assert.equal(socket.url, 'wss://qa.example.com/api/print-agent/ws');
  assert.equal(socket.options.headers.Authorization, `Bearer ${baseConfig.token}`);
  assert.equal(socket.options.headers['X-Print-Agent-Id'], baseConfig.agentId);

  openInstance(socket, WebSocketImpl);
  await tick();
  assert.deepEqual(signals, [], 'open por si solo no debe disparar reconnect antes de probar estabilidad');
  client.stop();
});

test('una conexion que permanece abierta stableConnectionMs si ejecuta claimAndProcess("reconnect")', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    stableConnectionMs: 10
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  openInstance(socket, WebSocketImpl);
  await waitUntil(() => signals.includes('reconnect'), 500);
  assert.deepEqual(signals, ['reconnect']);
  client.stop();
});

test('job_available de la sucursal propia ejecuta claimAndProcess("websocket")', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {}
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  openInstance(socket, WebSocketImpl);
  await tick();
  signals.length = 0;

  socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
  await tick();
  assert.deepEqual(signals, ['websocket']);
  client.stop();
});

test('job_available de otra sucursal se ignora', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {}
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  openInstance(socket, WebSocketImpl);
  await tick();
  signals.length = 0;

  socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 1 }));
  socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: '99' }));
  await tick();
  assert.deepEqual(signals, []);
  client.stop();
});

test('mensajes invalidos o sin evento job_available se ignoran sin lanzar', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {}
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  openInstance(socket, WebSocketImpl);
  await tick();
  signals.length = 0;

  socket.emit('message', 'no-es-json');
  socket.emit('message', JSON.stringify({ event: 'otra_cosa', branch_id: 2 }));
  socket.emit('message', JSON.stringify(null));
  await tick();
  assert.deepEqual(signals, []);
  client.stop();
});

test('dos señales consecutivas: el wsClient llama onSignal ambas veces, pero el guard tipo claimInProgress solo procesa una', async () => {
  // El wsClient en si NO deduplica (esa es responsabilidad de runner.claimAndProcess).
  // Esta prueba conecta el wsClient a un onSignal que replica exactamente el guard
  // claimInProgress de runner.js, para validar el caso obligatorio de la Etapa 4:
  // "Dos señales consecutivas no generan dos impresiones".
  const WebSocketImpl = createFakeWebSocketImpl();
  const attempts = [];
  const processed = [];
  let claimInProgress = false;
  const guardedOnSignal = async (trigger) => {
    attempts.push(trigger);
    if (claimInProgress) return;
    claimInProgress = true;
    try {
      processed.push(trigger);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      claimInProgress = false;
    }
  };
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: guardedOnSignal,
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    stableConnectionMs: 10
  });
  client.start();
  const socket = WebSocketImpl.instances[0];
  openInstance(socket, WebSocketImpl);
  // Espera a que el guard libere claimInProgress tras procesar la señal 'reconnect'
  // inicial (incluye sus 20ms de "trabajo" simulado) antes de medir las dos señales.
  await waitUntil(() => processed.includes('reconnect'), 500);
  await new Promise((resolve) => setTimeout(resolve, 30));
  attempts.length = 0;
  processed.length = 0;

  socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
  socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
  await waitUntil(() => attempts.length === 2, 500);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(attempts, ['websocket', 'websocket'], 'el wsClient debe invocar onSignal por cada mensaje recibido');
  assert.deepEqual(processed, ['websocket'], 'el guard claimInProgress debe absorber la segunda señal concurrente');
  client.stop();
});

test('al cerrarse la conexion programa reconexion y, una vez estable, vuelve a emitir reconnect', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    stableConnectionMs: 10
  });
  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);
  await waitUntil(() => signals.includes('reconnect'), 500);
  signals.length = 0;

  first.readyState = WebSocketImpl.CLOSED;
  first.emit('close');
  await waitUntil(() => WebSocketImpl.instances.length === 2, 500);
  const second = WebSocketImpl.instances[1];
  openInstance(second, WebSocketImpl);
  await waitUntil(() => signals.includes('reconnect'), 500);
  assert.deepEqual(signals, ['reconnect']);
  client.stop();
});

test('stop() detiene la reconexion: un close tardio no crea un nuevo socket', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async () => {},
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {}
  });
  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);
  await tick();

  client.stop();
  assert.equal(first.terminated, true);
  await tick(5);
  assert.equal(WebSocketImpl.instances.length, 1, 'no debe reconectar despues de stop()');
});

test('sin pong a tiempo, termina el socket y reconecta (heartbeat con timers reales acelerados)', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async () => {},
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    pingIntervalMs: 20,
    pongTimeoutMs: 15
  });
  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);

  await waitUntil(() => first.pings >= 1, 500);
  await waitUntil(() => first.terminated === true, 500);
  await waitUntil(() => WebSocketImpl.instances.length >= 2, 500);
  client.stop();
});

test('un pong a tiempo evita el terminate por timeout', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async () => {},
    log: () => {},
    WebSocketImpl,
    delayImpl: async () => {},
    pingIntervalMs: 20,
    pongTimeoutMs: 200
  });
  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);

  await waitUntil(() => first.pings >= 1, 500);
  first.emit('pong');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(first.terminated, false, 'un pong a tiempo no debe forzar terminate');
  client.stop();
});
