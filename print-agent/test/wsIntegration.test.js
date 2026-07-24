import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createRunner } from '../src/runner.js';
import { createPrintStateStore } from '../src/stateStore.js';
import { createPrintAgentWebSocketClient } from '../src/wsClient.js';

// Prueba de integracion real: conecta runner.claimAndProcess() (runner.js) con el
// cliente WebSocket (wsClient.js) exactamente como los conecta index.js en produccion,
// para validar los casos obligatorios de la Etapa 4 sin mocks intermedios que oculten
// una condicion de carrera real entre el disparador WS y el polling.

const config = loadConfig({
  API_BASE_URL: 'https://qa.example.com', PRINT_AGENT_ID: 'agent-id', PRINT_AGENT_TOKEN: 'x'.repeat(48),
  BRANCH_ID: '2', QZ_HOST: 'localhost', QZ_SECURE_PORT: '8181', POLL_INTERVAL_MS: '500',
  HEARTBEAT_INTERVAL_MS: '5000', LEASE_SECONDS: '30', PRINTER_MAP_JSON: '{"factura":"QA Printer"}',
  PRINT_AGENT_WEBSOCKET_ENABLED: 'true'
});

const job = (id) => ({ id_trabajo: id, id_sucursal: 2, tipo_documento: 'factura', payload: { schema_version: 1 } });

const createFakeWebSocketImpl = () => {
  const instances = [];
  function FakeWebSocket(url, options) {
    const instance = new EventEmitter();
    instance.url = url;
    instance.options = options;
    instance.readyState = FakeWebSocket.CONNECTING;
    instance.ping = () => {};
    instance.send = () => {};
    instance.terminate = () => {
      if (instance.readyState === FakeWebSocket.CLOSED) return;
      instance.readyState = FakeWebSocket.CLOSED;
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

const openInstance = (instance, WebSocketImpl) => {
  instance.readyState = WebSocketImpl.OPEN;
  instance.emit('open');
};

const waitUntil = async (predicate, timeoutMs = 1000, intervalMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('WAIT_UNTIL_TIMEOUT');
};

const createStoreFixture = async (prefix) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const store = createPrintStateStore({ filePath: path.join(tempDir, 'state.json') });
  await store.init();
  return { tempDir, store };
};

// Fake API con "claim" con latencia artificial para abrir una ventana de carrera
// realista entre disparadores simultaneos (igual que una llamada HTTP real).
// IMPORTANTE: claimCalls.length se incrementa AL INICIAR la llamada, antes del
// delay -- no equivale a que claimInProgress ya se haya liberado. Las pruebas que
// necesitan disparadores estrictamente secuenciales deben esperar claimDelayMs+margen,
// no solo el conteo de claimCalls.
const createSlowClaimApi = ({ jobsQueue, claimDelayMs = 15 }) => {
  const claimCalls = [];
  let concurrentClaims = 0;
  let maxConcurrentClaims = 0;
  return {
    api: {
      claim: async () => {
        concurrentClaims += 1;
        maxConcurrentClaims = Math.max(maxConcurrentClaims, concurrentClaims);
        claimCalls.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, claimDelayMs));
        concurrentClaims -= 1;
        const next = jobsQueue.length > 0 ? [jobsQueue.shift()] : [];
        return { jobs: next };
      },
      printing: async () => {},
      renew: async () => {},
      confirmationPending: async () => {},
      complete: async () => {},
      fail: async () => {}
    },
    claimCalls,
    getMaxConcurrentClaims: () => maxConcurrentClaims
  };
};

test('WS activado: una señal genera un solo claim y una sola impresion', async () => {
  const fixture = await createStoreFixture('jonnys-ws-single-');
  const jobsQueue = [];
  const claimDelayMs = 10;
  const { api, claimCalls } = createSlowClaimApi({ jobsQueue, claimDelayMs });
  let dispatches = 0;
  const runner = createRunner({
    config, api, stateStore: fixture.store, log: () => {},
    qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
  });
  const WebSocketImpl = createFakeWebSocketImpl();
  const wsClient = createPrintAgentWebSocketClient({
    config, log: () => {}, WebSocketImpl, delayImpl: async () => {},
    onSignal: (trigger) => runner.claimAndProcess(trigger)
  });
  try {
    wsClient.start();
    const socket = WebSocketImpl.instances[0];
    openInstance(socket, WebSocketImpl); // dispara claimAndProcess('reconnect') con la cola vacia
    await waitUntil(() => claimCalls.length === 1, 500);
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 25)); // deja liberar claimInProgress
    assert.equal(dispatches, 0, 'reconnect sin trabajos disponibles no debe imprimir nada');

    jobsQueue.push(job(101));
    socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
    await waitUntil(() => dispatches === 1, 1000);
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 25));

    assert.equal(dispatches, 1);
    assert.equal(claimCalls.length, 2, 'reconnect + job_available: dos claims secuenciales, uno por cada señal');
  } finally {
    wsClient.stop();
    runner.stop();
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('dos señales WS consecutivas antes de resolver la primera: un solo claim en vuelo, una sola impresion', async () => {
  const fixture = await createStoreFixture('jonnys-ws-double-signal-');
  const jobsQueue = [];
  const claimDelayMs = 40;
  const { api, getMaxConcurrentClaims, claimCalls } = createSlowClaimApi({ jobsQueue, claimDelayMs });
  let dispatches = 0;
  const runner = createRunner({
    config, api, stateStore: fixture.store, log: () => {},
    qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
  });
  const WebSocketImpl = createFakeWebSocketImpl();
  const wsClient = createPrintAgentWebSocketClient({
    config, log: () => {}, WebSocketImpl, delayImpl: async () => {},
    onSignal: (trigger) => runner.claimAndProcess(trigger)
  });
  try {
    wsClient.start();
    const socket = WebSocketImpl.instances[0];
    openInstance(socket, WebSocketImpl);
    await waitUntil(() => claimCalls.length === 1, 500);
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 25)); // deja terminar el claim de 'reconnect' (sin jobs)
    claimCalls.length = 0;

    jobsQueue.push(job(102));
    socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
    socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
    await waitUntil(() => dispatches === 1, 1000);
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 25));

    assert.equal(dispatches, 1, 'dos señales consecutivas no deben generar dos impresiones');
    assert.equal(claimCalls.length, 1, 'la segunda señal debe ser absorbida por claimInProgress antes de llamar a claim()');
    assert.equal(getMaxConcurrentClaims(), 1, 'nunca debe haber dos claims en vuelo al mismo tiempo dentro del mismo agente');
  } finally {
    wsClient.stop();
    runner.stop();
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('WS y polling simultaneos: solo un procesamiento activo, un unico claim gana', async () => {
  const fixture = await createStoreFixture('jonnys-ws-polling-race-');
  const jobsQueue = [job(103)];
  const { api, getMaxConcurrentClaims } = createSlowClaimApi({ jobsQueue, claimDelayMs: 30 });
  let dispatches = 0;
  const runner = createRunner({
    config, api, stateStore: fixture.store, log: () => {},
    qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
  });
  const WebSocketImpl = createFakeWebSocketImpl();
  const wsClient = createPrintAgentWebSocketClient({
    config, log: () => {}, WebSocketImpl, delayImpl: async () => {},
    onSignal: (trigger) => runner.claimAndProcess(trigger)
  });
  try {
    // Dispara polling y WS practicamente al mismo tiempo, como pide la Etapa 4 (caso 4).
    const pollPromise = runner.claimAndProcess('polling');
    wsClient.start();
    const socket = WebSocketImpl.instances[0];
    openInstance(socket, WebSocketImpl); // emite claimAndProcess('reconnect') casi en el mismo instante
    socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 })); // y claimAndProcess('websocket') tambien

    await pollPromise;
    await waitUntil(() => dispatches === 1, 1000);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(dispatches, 1, 'polling + reconnect + websocket simultaneos solo deben imprimir una vez');
    assert.equal(getMaxConcurrentClaims(), 1, 'solo debe existir un claim en vuelo pese a tres disparadores casi simultaneos');
  } finally {
    wsClient.stop();
    runner.stop();
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('WS nunca llega a conectar: el polling del runner sigue funcionando de forma independiente', async () => {
  const fixture = await createStoreFixture('jonnys-ws-down-');
  const jobsQueue = [job(104)];
  const { api } = createSlowClaimApi({ jobsQueue, claimDelayMs: 5 });
  let dispatches = 0;
  const runner = createRunner({
    config, api, stateStore: fixture.store, log: () => {},
    qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
  });
  try {
    // Sin wsClient conectado (simula backend/WS caido); claimAndProcess('polling') --
    // exactamente lo que llama run() -- debe seguir procesando sin depender del WS.
    await runner.claimAndProcess('polling');
    assert.equal(dispatches, 1, 'el polling debe imprimir el trabajo aunque el WebSocket jamas conecte');
  } finally {
    runner.stop();
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test('varias señales WS sin trabajos disponibles: claims vacios, sin error y sin impresion', async () => {
  const fixture = await createStoreFixture('jonnys-ws-empty-');
  const claimDelayMs = 5;
  const { api, claimCalls } = createSlowClaimApi({ jobsQueue: [], claimDelayMs });
  let dispatches = 0;
  const runner = createRunner({
    config, api, stateStore: fixture.store, log: () => {},
    qz: { prepare: async (value) => ({ job: value }), dispatch: async () => { dispatches += 1; } }
  });
  const WebSocketImpl = createFakeWebSocketImpl();
  const wsClient = createPrintAgentWebSocketClient({
    config, log: () => {}, WebSocketImpl, delayImpl: async () => {},
    onSignal: (trigger) => runner.claimAndProcess(trigger)
  });
  try {
    wsClient.start();
    const socket = WebSocketImpl.instances[0];
    openInstance(socket, WebSocketImpl);
    await waitUntil(() => claimCalls.length === 1, 500);
    await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 20));

    for (let i = 0; i < 5; i += 1) {
      socket.emit('message', JSON.stringify({ event: 'job_available', branch_id: 2 }));
      await waitUntil(() => claimCalls.length === i + 2, 500);
      await new Promise((resolve) => setTimeout(resolve, claimDelayMs + 20));
    }

    assert.equal(dispatches, 0, 'sin trabajos en cola no debe haber impresiones');
    assert.equal(claimCalls.length, 6, 'reconnect + 5 señales = 6 claims vacios, todos sin error');
  } finally {
    wsClient.stop();
    runner.stop();
    await fs.rm(fixture.tempDir, { recursive: true, force: true });
  }
});
