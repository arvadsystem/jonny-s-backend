import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzClient } from '../src/qzClient.js';

// Fake qz.tray minimo, controlable por prueba: cuenta connect/find/disconnect y permite
// forzar exito, fallo o una espera controlada (deferred) para probar single-flight.
const createFakeQz = ({ connectMode = 'succeed' } = {}) => {
  let active = false;
  let signaturePromise = async () => {};
  let certificatePromise = null;
  const connectCalls = [];
  const findCalls = [];
  const disconnectCalls = [];
  let findList = ['ZKP8008'];
  let pendingConnect = null;

  const qz = {
    api: { setPromiseType: () => {}, setWebSocketType: () => {} },
    security: {
      setCertificatePromise: (fn) => { certificatePromise = fn; },
      setSignatureAlgorithm: () => {},
      setSignaturePromise: (fn) => { signaturePromise = fn; }
    },
    websocket: {
      isActive: () => active,
      connect: async (options) => {
        connectCalls.push(options);
        if (connectMode === 'fail') throw new Error('QZ_CONNECTION_REFUSED');
        if (connectMode === 'deferred') {
          await new Promise((resolve) => { pendingConnect = resolve; });
        }
        active = true;
      },
      disconnect: async () => { disconnectCalls.push(Date.now()); active = false; }
    },
    printers: {
      find: async (...args) => {
        findCalls.push(args);
        await signaturePromise('find-digest');
        return findList;
      }
    },
    configs: {
      create: (printer, options) => ({ getPrinter: () => printer, getOptions: () => options })
    },
    print: async () => { await signaturePromise('print-digest'); }
  };

  return {
    qz,
    connectCalls,
    findCalls,
    disconnectCalls,
    isActive: () => active,
    setFindList: (list) => { findList = list; },
    resolvePendingConnect: () => { pendingConnect?.(); },
    invokeCertificatePromise: () => new Promise((resolve, reject) => certificatePromise(resolve, reject))
  };
};

const baseConfig = () => ({
  qzHost: 'localhost',
  qzSecurePort: 8181,
  printerMap: { factura: 'ZKP8008' },
  printerCacheTtlMs: 60000
});

const fakeApi = () => ({
  certificate: async () => 'cert-pem',
  sign: async (_jobId, _request, digest) => ({ signature: `signed:${digest}` }),
  document: async () => { throw new Error('unused in these tests'); }
});

const localhostNetworking = {
  lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
  networkInterfacesImpl: () => ({})
};

const job = (id, logical = 'factura') => ({
  id_trabajo: id,
  tipo_documento: 'factura',
  payload: {
    schema_version: 1,
    impresora_logica: logical,
    ancho_mm: 80,
    documento: { titulo: "JONNY'S", items: [{ cantidad: 1, descripcion: 'Combo', total: 100 }], total: 100 }
  }
});

// --- Preconexion --------------------------------------------------------------------

test('preconnect: conecta cuando QZ esta disponible y registra qz_preconnect_complete', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const logs = [];
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  const result = await client.preconnect();

  assert.equal(result, true);
  assert.equal(fake.connectCalls.length, 1);
  assert.equal(fake.isActive(), true);
  assert.ok(logs.some((entry) => entry.event === 'qz_preconnect_complete'));
});

test('preconnect: no bloquea el inicio si QZ esta cerrado (nunca lanza)', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const logs = [];
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  const result = await client.preconnect();

  assert.equal(result, false);
  assert.equal(fake.isActive(), false);
  assert.ok(logs.some((entry) => entry.event === 'qz_preconnect_failed'));
  client.stopPreconnectRetry();
});

test('preconnect: no crea conexiones simultaneas (single-flight)', async () => {
  const fake = createFakeQz({ connectMode: 'deferred' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking
  });

  const first = client.preconnect();
  const second = client.preconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.connectCalls.length, 1, 'dos preconnect() casi simultaneos comparten el mismo intento de conexion');

  fake.resolvePendingConnect();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(fake.connectCalls.length, 1);
});

test('preconnect: shutdown (disconnect) cancela el timer de reintento en segundo plano', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: () => {}
  });

  await client.preconnect();
  assert.equal(fake.connectCalls.length, 1, 'el primer intento fallido programa un reintento en segundo plano');

  await client.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.connectCalls.length, 1, 'disconnect() debe cancelar el timer: ningun reintento adicional despues del shutdown');
});

test('preconnect: un trabajo puede conectar despues de una preconexion fallida', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: () => {}
  });

  const preconnected = await client.preconnect();
  assert.equal(preconnected, false);

  // QZ Tray se abre despues del intento fallido de preconexion.
  fake.qz.websocket.connect = async (options) => { fake.connectCalls.push(options); fake.qz.websocket.isActive = () => true; };
  const prepared = await client.prepare(job(1));

  assert.equal(prepared.qzConfig.getPrinter(), 'ZKP8008');
  client.stopPreconnectRetry();
});

// --- Cache de impresoras --------------------------------------------------------------

test('cache: la primera llamada ejecuta printers.find', async () => {
  const fake = createFakeQz();
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  await client.prepare(job(1));

  assert.equal(fake.findCalls.length, 1);
});

test('cache: la segunda llamada dentro del TTL usa cache (no repite printers.find)', async () => {
  const fake = createFakeQz();
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  await client.prepare(job(1));
  await client.prepare(job(2));

  assert.equal(fake.findCalls.length, 1, 'la segunda preparacion debe reutilizar la lista cacheada');
});

test('cache: despues del TTL vuelve a consultar', async () => {
  const fake = createFakeQz();
  const client = createQzClient({
    config: { ...baseConfig(), printerCacheTtlMs: 20 }, api: fakeApi(), qz: fake.qz, ...localhostNetworking
  });

  await client.prepare(job(1));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await client.prepare(job(2));

  assert.equal(fake.findCalls.length, 2, 'una vez vencido el TTL debe consultar printers.find de nuevo');
});

test('cache: llamadas simultaneas comparten la misma promesa (single-flight)', async () => {
  const fake = createFakeQz();
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  const [preparedOne, preparedTwo] = await Promise.all([client.prepare(job(1)), client.prepare(job(2))]);

  assert.equal(fake.findCalls.length, 1, 'dos prepare() concurrentes sin cache previa deben compartir un unico printers.find');
  assert.equal(preparedOne.qzConfig.getPrinter(), 'ZKP8008');
  assert.equal(preparedTwo.qzConfig.getPrinter(), 'ZKP8008');
});

test('cache: impresora ausente fuerza una actualizacion antes de fallar', async () => {
  const fake = createFakeQz();
  fake.setFindList(['Otra impresora']);
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  await assert.rejects(client.prepare(job(1)), /IMPRESORA_NO_ENCONTRADA:factura/);

  assert.equal(fake.findCalls.length, 2, 'debe invalidar la cache y reintentar una sola vez antes de declarar el error');
});

test('cache: si sigue ausente tras el refresh forzado, devuelve IMPRESORA_NO_ENCONTRADA', async () => {
  const fake = createFakeQz();
  fake.setFindList(['Otra impresora']);
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  await assert.rejects(client.prepare(job(1)), /IMPRESORA_NO_ENCONTRADA:factura/);
});

test('cache: una reconexion invalida la cache', async () => {
  const fake = createFakeQz();
  const client = createQzClient({ config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking });

  await client.prepare(job(1));
  assert.equal(fake.findCalls.length, 1);

  await client.disconnect(); // fuerza isActive() === false
  await client.prepare(job(2));

  assert.equal(fake.findCalls.length, 2, 'tras reconectar, la lista cacheada de la sesion anterior ya no es confiable');
});

// --- qz_certificate: medicion real, sin exponer el certificado -----------------------

test('qz_certificate se mide de verdad (print_stage_timing) y nunca expone el certificado', async () => {
  const fake = createFakeQz();
  const logs = [];
  const secretCertificateText = '-----BEGIN CERTIFICATE-----MUY-SECRETO-----END CERTIFICATE-----';
  const client = createQzClient({
    config: { ...baseConfig(), perfLogsEnabled: true },
    api: { ...fakeApi(), certificate: async () => secretCertificateText },
    qz: fake.qz,
    ...localhostNetworking,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  await client.prepare(job(1)); // dispara connect() -> registra setCertificatePromise
  const certificate = await fake.invokeCertificatePromise();

  assert.equal(certificate, secretCertificateText, 'la promesa de certificado sigue devolviendo el certificado real a QZ Tray');

  const certEvent = logs.find((entry) => entry.event === 'print_stage_timing' && entry.data.stage === 'qz_certificate');
  assert.ok(certEvent, 'debe existir una medicion real de qz_certificate, no solo documentada');
  assert.equal(certEvent.data.success, true);
  assert.ok(Number.isFinite(certEvent.data.duration_ms) && certEvent.data.duration_ms >= 0);

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /MUY-SECRETO/, 'el certificado jamas debe aparecer en las metricas');
  assert.doesNotMatch(serializedLogs, /BEGIN CERTIFICATE/, 'el certificado jamas debe aparecer en las metricas');
});
