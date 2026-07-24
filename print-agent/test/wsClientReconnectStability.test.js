import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPrintAgentWebSocketClient } from '../src/wsClient.js';

// Cubre el ciclo de reconexion reportado en QA: un proxy que deja abrir el WebSocket pero
// lo cierra casi de inmediato no debe resetear el backoff ni disparar la reconciliacion
// por reconexion (emitSignal('reconnect')) en cada intento -- eso generaba una tormenta de
// conexiones y de solicitudes HTTP (502) cada ~1 segundo.

const baseConfig = { apiBaseUrl: 'https://qa.example.com', token: 'x'.repeat(48), agentId: 'agent-1', branchId: 2 };

const createFakeWebSocketImpl = () => {
  const instances = [];
  function FakeWebSocket(url, options) {
    const instance = new EventEmitter();
    instance.url = url;
    instance.options = options;
    instance.readyState = FakeWebSocket.CONNECTING;
    instance.terminated = false;
    instance.ping = () => {};
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

const openInstance = (instance, WebSocketImpl) => {
  instance.readyState = WebSocketImpl.OPEN;
  instance.emit('open');
};

const closeInstance = (instance, WebSocketImpl) => {
  instance.readyState = WebSocketImpl.CLOSED;
  instance.emit('close');
};

const waitUntil = async (predicate, timeoutMs = 500, intervalMs = 5) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('WAIT_UNTIL_TIMEOUT');
};

// delayImpl instantaneo (como en el resto de la suite) pero que registra cada espera
// programada y cuantas quedan pendientes al mismo tiempo, para probar el guard de un
// solo reconnectTimer sin esperar minutos de backoff real.
const createRecordingDelay = () => {
  const delays = [];
  let pending = 0;
  let maxPending = 0;
  const delayImpl = (ms) => {
    delays.push(ms);
    pending += 1;
    maxPending = Math.max(maxPending, pending);
    return Promise.resolve().then(() => { pending -= 1; });
  };
  return { delayImpl, delays, getMaxPending: () => maxPending };
};

test('open seguido de close inmediato no reinicia el backoff', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const { delayImpl, delays } = createRecordingDelay();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    delayImpl, randomImpl: () => 0, stableConnectionMs: 10000
  });

  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);
  closeInstance(first, WebSocketImpl); // cierre inmediato, mucho antes de stableConnectionMs
  await waitUntil(() => WebSocketImpl.instances.length === 2, 500);

  const second = WebSocketImpl.instances[1];
  openInstance(second, WebSocketImpl);
  closeInstance(second, WebSocketImpl); // tambien inmediato
  await waitUntil(() => WebSocketImpl.instances.length === 3, 500);

  assert.equal(delays.length, 2);
  assert.equal(delays[0], 1000, 'primer reintento: backoff base (attempt=0)');
  assert.equal(delays[1], 2000, 'segundo reintento: backoff duplicado (attempt=1); el open anterior no reinicio attempt a 0');
  client.stop();
});

test('varios ciclos open/close generan retrasos crecientes (backoff exponencial real)', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const { delayImpl, delays } = createRecordingDelay();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    delayImpl, randomImpl: () => 0, stableConnectionMs: 10000
  });

  client.start();
  for (let i = 0; i < 5; i += 1) {
    await waitUntil(() => WebSocketImpl.instances.length === i + 1, 500);
    const instance = WebSocketImpl.instances[i];
    openInstance(instance, WebSocketImpl);
    closeInstance(instance, WebSocketImpl);
  }
  await waitUntil(() => WebSocketImpl.instances.length === 6, 500);

  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000], 'cada ciclo de flapping debe duplicar el retraso anterior');
  client.stop();
});

test('el retraso de reconexion nunca supera 30000ms', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const { delayImpl, delays } = createRecordingDelay();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    delayImpl, randomImpl: () => 0, stableConnectionMs: 10000
  });

  client.start();
  for (let i = 0; i < 9; i += 1) {
    await waitUntil(() => WebSocketImpl.instances.length === i + 1, 500);
    const instance = WebSocketImpl.instances[i];
    openInstance(instance, WebSocketImpl);
    closeInstance(instance, WebSocketImpl);
  }
  await waitUntil(() => WebSocketImpl.instances.length === 10, 500);

  assert.equal(delays.length, 9);
  assert.ok(delays.every((wait) => wait <= 30000), `ningun retraso debe superar 30000ms: ${delays}`);
  assert.equal(delays.at(-1), 30000, 'a partir del tope, el retraso se estabiliza en 30000ms');
  assert.equal(delays.at(-2), 30000);
  client.stop();
});

test('nunca existe mas de un timer/espera de reconexion pendiente a la vez', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const { delayImpl, getMaxPending } = createRecordingDelay();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    delayImpl, randomImpl: () => 0, stableConnectionMs: 10000
  });

  client.start();
  for (let i = 0; i < 4; i += 1) {
    await waitUntil(() => WebSocketImpl.instances.length === i + 1, 500);
    const instance = WebSocketImpl.instances[i];
    openInstance(instance, WebSocketImpl);
    closeInstance(instance, WebSocketImpl);
  }
  await waitUntil(() => WebSocketImpl.instances.length === 5, 500);

  assert.equal(getMaxPending(), 1, 'jamas debe haber dos esperas de reconexion en vuelo al mismo tiempo');
  client.stop();
});

test('una conexion estable (permanece abierta stableConnectionMs) si reinicia attempt', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const { delayImpl, delays } = createRecordingDelay();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    delayImpl, randomImpl: () => 0, stableConnectionMs: 10
  });

  client.start();
  // Dos ciclos de flapping primero, para crecer el backoff (attempt=2).
  for (let i = 0; i < 2; i += 1) {
    await waitUntil(() => WebSocketImpl.instances.length === i + 1, 500);
    const instance = WebSocketImpl.instances[i];
    openInstance(instance, WebSocketImpl);
    closeInstance(instance, WebSocketImpl);
  }
  await waitUntil(() => WebSocketImpl.instances.length === 3, 500);
  assert.deepEqual(delays, [1000, 2000]);

  // La tercera conexion si permanece abierta el tiempo suficiente para estabilizarse.
  const stableSocket = WebSocketImpl.instances[2];
  openInstance(stableSocket, WebSocketImpl);
  await new Promise((resolve) => setTimeout(resolve, 30)); // > stableConnectionMs (10ms)
  closeInstance(stableSocket, WebSocketImpl);
  await waitUntil(() => WebSocketImpl.instances.length === 4, 500);

  assert.equal(delays.length, 3);
  assert.equal(delays[2], 1000, 'tras estabilizarse, el proximo backoff vuelve a la base (attempt=0)');
  client.stop();
});

test('stop() cancela heartbeat, stableTimer y la reconexion pendiente (ninguno dispara despues)', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  // delayImpl real (no instantaneo) para probar que, aunque el timer subyacente this
  // llegue a cumplirse, stop() impide que dispare una nueva conexion.
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    pingIntervalMs: 20, pongTimeoutMs: 15, stableConnectionMs: 10000
  });

  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl);
  closeInstance(first, WebSocketImpl); // cierre externo (simulado); programa scheduleReconnect con backoff real (~1000-1100ms)

  await new Promise((resolve) => setTimeout(resolve, 20));
  client.stop(); // socket ya esta cerrado externamente; stop() no tiene nada que terminar aqui

  // Espera mas de lo que hubiera tardado el backoff real (~1000-1100ms) y el heartbeat.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(WebSocketImpl.instances.length, 1, 'stop() debe impedir cualquier reconexion, incluso despues de que el backoff hubiera vencido');
});

test('stop() termina el socket activo cuando la conexion sigue abierta', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    pingIntervalMs: 20, pongTimeoutMs: 15, stableConnectionMs: 10000
  });

  client.start();
  const first = WebSocketImpl.instances[0];
  openInstance(first, WebSocketImpl); // sigue abierto: nadie la cerro todavia

  client.stop();
  assert.equal(first.terminated, true, 'stop() debe terminar una conexion que sigue activa');
});

test('emitSignal("reconnect") no se ejecuta para una conexion que abre y cierra rapido (inestable)', async () => {
  const WebSocketImpl = createFakeWebSocketImpl();
  const signals = [];
  const client = createPrintAgentWebSocketClient({
    config: baseConfig,
    onSignal: async (trigger) => { signals.push(trigger); },
    log: () => {}, WebSocketImpl,
    delayImpl: async () => {}, stableConnectionMs: 10000
  });

  client.start();
  for (let i = 0; i < 3; i += 1) {
    await waitUntil(() => WebSocketImpl.instances.length === i + 1, 500);
    const instance = WebSocketImpl.instances[i];
    openInstance(instance, WebSocketImpl);
    closeInstance(instance, WebSocketImpl);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(signals, [], 'ninguna de las conexiones inestables debe haber disparado la reconciliacion por reconnect');
  client.stop();
});

test('una caida sostenida (equivalente a HTTP 502 repetido) no genera solicitudes cada segundo', async () => {
  // Simula la caida reportada en QA: el proxy deja abrir el WebSocket pero lo corta antes
  // de stableConnectionMs, una y otra vez, apenas se crea cada nuevo intento. Con backoff
  // real (delayImpl por defecto), en ~2.9s debe haber como mucho 2 intentos de conexion
  // (t=0 y t=1s), nunca uno nuevo cada segundo sin crecer.
  const WebSocketImpl = createFakeWebSocketImpl();
  const client = createPrintAgentWebSocketClient({
    config: baseConfig, onSignal: async () => {}, log: () => {}, WebSocketImpl,
    stableConnectionMs: 10000 // la caida siempre llega antes de estabilizarse
  });

  let processedCount = 0;
  const flapNewInstances = setInterval(() => {
    while (processedCount < WebSocketImpl.instances.length) {
      const instance = WebSocketImpl.instances[processedCount];
      processedCount += 1;
      openInstance(instance, WebSocketImpl); // el proxy deja abrir...
      closeInstance(instance, WebSocketImpl); // ...pero lo corta casi de inmediato
    }
  }, 5);

  client.start();
  await new Promise((resolve) => setTimeout(resolve, 2900));
  clearInterval(flapNewInstances);

  // Con el bug original (attempt se reseteaba en cada open), cada intento volvia a usar
  // el backoff base (~1s) -> aproximadamente un socket/solicitud nueva por segundo (~3 en
  // 2.9s). Con el fix, el backoff crece de verdad: el segundo intento no llega hasta ~1s
  // y el tercero hasta ~3s, asi que a los 2.9s debe haber a lo sumo 2 instancias.
  assert.ok(
    WebSocketImpl.instances.length <= 2,
    `se esperaban a lo sumo 2 intentos de conexion en ~2.9s de caida sostenida, hubo ${WebSocketImpl.instances.length}`
  );
  client.stop();
});
