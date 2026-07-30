import test from 'node:test';
import assert from 'node:assert/strict';
import { createQzClient } from '../src/qzClient.js';

// Fake qz.tray minimo, controlable por prueba: cuenta connect/find/disconnect y permite
// forzar exito, fallo o una espera controlada (deferred) para probar single-flight.
//
// El intercambio de certificado reproduce el comportamiento REAL de qz-tray 2.2.6
// (qz-tray.js: security.callCert / websocket.setup.sendCert), no una version simplificada:
// un handler AsyncFunction se detecta por constructor.name y se invoca SIN argumentos,
// usando directamente el valor que retorna; un handler "clasico" (resolve, reject) se
// invoca dentro de una promesa real, con resolve/reject genuinos. Si el handler falla,
// options.rejectOnFailure decide si la conexion se rechaza (rejectOnFailure:true) o
// degrada en silencio a certificate:null (comportamiento por defecto de QZ, y la causa raiz
// del bug: un handler AsyncFunction que esperaba resolve/reject nunca los recibia).
const createFakeQz = ({ connectMode = 'succeed' } = {}) => {
  let active = false;
  let signaturePromise = async () => {};
  let certHandler = null;
  let certOptions = null;
  let receivedCertificate; // permanece undefined si la conexion se rechazo antes de degradar
  const connectCalls = [];
  const findCalls = [];
  const disconnectCalls = [];
  let findList = ['ZKP8008'];
  let pendingConnect = null;

  const callCert = () => {
    if (certHandler && certHandler.constructor.name === 'AsyncFunction') {
      return certHandler();
    }
    return new Promise((resolve, reject) => certHandler(resolve, reject));
  };

  const qz = {
    api: { setPromiseType: () => {}, setWebSocketType: () => {} },
    security: {
      setCertificatePromise: (fn, options) => { certHandler = fn; certOptions = options || null; },
      setSignatureAlgorithm: () => {},
      setSignaturePromise: (fn) => { signaturePromise = fn; }
    },
    websocket: {
      isActive: () => active,
      connect: async (options) => {
        connectCalls.push(options);
        if (connectMode === 'fail') throw new Error('QZ_CONNECTION_REFUSED');

        try {
          const cert = await callCert();
          receivedCertificate = cert === undefined ? null : cert;
        } catch (error) {
          if (certOptions?.rejectOnFailure) throw error; // nunca degrada a certificate:null
          receivedCertificate = null;
        }

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
    getCertHandlerType: () => certHandler?.constructor?.name || null,
    getCertOptions: () => certOptions,
    getReceivedCertificate: () => receivedCertificate,
    invokeSignaturePromise: (digest = 'test-digest') => signaturePromise(digest)
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

// Temporizador controlable manualmente: setTimeoutImpl solo registra el callback (nunca
// lo dispara por si solo) y clearTimeoutImpl(id) lo cancela como el setTimeout/clearTimeout
// nativos. Permite hacer avanzar el reintento de preconexion (base de 5000ms) sin esperar
// tiempo real, y probar de forma determinista que un timer cancelado nunca reconecta.
const createControllableTimeout = () => {
  let nextId = 1;
  const callbacks = new Map();
  const setTimeoutImpl = (fn) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, fn);
    return id;
  };
  const clearTimeoutImpl = (id) => { callbacks.delete(id); };
  const fire = (id) => {
    const fn = callbacks.get(id);
    callbacks.delete(id);
    if (fn) fn();
  };
  return { setTimeoutImpl, clearTimeoutImpl, fire, lastId: () => nextId - 1 };
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
//
// Antes de reclamar un trabajo no existe signingContext (job_id, request), y QZ Tray exige
// firma ligada a un trabajo real -- nunca generica (QZ_GENERIC_SIGNING_DISABLED, ver
// setSignaturePromise en qzClient.js). Por eso, sin importar el valor de
// QZ_PRECONNECT_ENABLED, preconnect() por defecto (hasSecurePreconnectContext no inyectado)
// SIEMPRE omite la conexion en vez de dejar que QZ Tray la reciba sin firma valida (sesion
// "anonymous", job_id 0). Los tests marcados "con contexto seguro inyectado" simulan el
// unico escenario en el que algun dia se defina un mecanismo de firma seguro para la
// preconexion, y prueban que el resto del mecanismo (single-flight, backoff, cancelacion en
// disconnect) sigue intacto para ese caso futuro.

test('preconnect: sin contexto seguro (comportamiento por defecto) omite la conexion, sin sesion QZ "anonymous"', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const logs = [];
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  const result = await client.preconnect();

  assert.equal(result, false);
  assert.equal(fake.connectCalls.length, 0, 'nunca debe llamar a qz.websocket.connect sin un contexto de firma seguro');
  assert.equal(fake.isActive(), false);
  assert.ok(logs.some((entry) => entry.event === 'qz_preconnect_skipped' && entry.data.reason === 'NO_SECURE_SIGNING_CONTEXT'));
});

test('preconnect: con contexto seguro inyectado, conecta cuando QZ esta disponible y registra qz_preconnect_complete', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const logs = [];
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  const result = await client.preconnect();

  assert.equal(result, true);
  assert.equal(fake.connectCalls.length, 1);
  assert.equal(fake.isActive(), true);
  assert.ok(logs.some((entry) => entry.event === 'qz_preconnect_complete'));
});

test('preconnect: con contexto seguro inyectado, no bloquea el inicio si QZ esta cerrado (nunca lanza)', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const logs = [];
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true,
    log: (level, event, data) => logs.push({ level, event, data })
  });

  const result = await client.preconnect();

  assert.equal(result, false);
  assert.equal(fake.isActive(), false);
  assert.ok(logs.some((entry) => entry.event === 'qz_preconnect_failed'));
  client.stopPreconnectRetry();
});

test('preconnect: con contexto seguro inyectado, no crea conexiones simultaneas (single-flight)', async () => {
  const fake = createFakeQz({ connectMode: 'deferred' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true
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

test('preconnect: con contexto seguro inyectado, shutdown (disconnect) cancela el timer de reintento en segundo plano', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const { setTimeoutImpl, clearTimeoutImpl, fire, lastId } = createControllableTimeout();
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true,
    setTimeoutImpl, clearTimeoutImpl,
    log: () => {}
  });

  await client.preconnect();
  assert.equal(fake.connectCalls.length, 1, 'el primer intento fallido programa un reintento en segundo plano');
  const retryTimerId = lastId();

  await client.disconnect();
  // Avanza realmente el temporizador de 5000ms del reintento (en vez de esperar 20ms
  // reales, que jamas lo habrian alcanzado y dejarian pasar la prueba aunque disconnect()
  // no lo hubiera cancelado). Si disconnect() cancelo el timer, fire() no hace nada.
  fire(retryTimerId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake.connectCalls.length, 1, 'disconnect() debe cancelar el timer: ningun reintento adicional aunque venza el temporizador original');
});

test('preconnect: con contexto seguro inyectado, un trabajo puede conectar despues de una preconexion fallida', async () => {
  const fake = createFakeQz({ connectMode: 'fail' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true,
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

test('preconnect: (comportamiento por defecto) un trabajo conecta por el flujo normal aunque la preconexion se haya omitido', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    log: () => {}
  });

  const preconnected = await client.preconnect();
  assert.equal(preconnected, false);
  assert.equal(fake.connectCalls.length, 0, 'la preconexion omitida no debe haber abierto ninguna conexion');

  const prepared = await client.prepare(job(1));

  assert.equal(prepared.qzConfig.getPrinter(), 'ZKP8008');
  assert.equal(fake.connectCalls.length, 1, 'el primer trabajo real conecta por el flujo normal, sin depender de preconnect');
  assert.equal(fake.isActive(), true);
});

test('preconnect: nunca dispara api.sign (nunca job_id 0), ni con contexto seguro inyectado', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const signCalls = [];
  const client = createQzClient({
    config: baseConfig(),
    api: { ...fakeApi(), sign: async (jobId, request, digest) => { signCalls.push(jobId); return { signature: `signed:${digest}` }; } },
    qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true, // incluso si algun dia hubiera contexto seguro, connect() en si no firma nada
    log: () => {}
  });

  await client.preconnect();

  assert.deepEqual(signCalls, [], 'preconnect (connect()) nunca debe disparar api.sign, con o sin contexto seguro');
});

test('preconnect: el guard de firma generica sigue intacto (sin signingContext, la firma se rechaza siempre)', async () => {
  const fake = createFakeQz({ connectMode: 'succeed' });
  const client = createQzClient({
    config: baseConfig(), api: fakeApi(), qz: fake.qz, ...localhostNetworking,
    hasSecurePreconnectContext: () => true,
    log: () => {}
  });

  await client.preconnect(); // registra setCertificatePromise/setSignaturePromise en el fake

  // Sin un trabajo en curso (signingContext null), cualquier intento de firma -- generica o
  // no -- debe seguir siendo rechazado por QZ_GENERIC_SIGNING_DISABLED, nunca aceptado.
  await assert.rejects(fake.invokeSignaturePromise('some-digest'), /QZ_GENERIC_SIGNING_DISABLED/);
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

  // connect() ya reclama y resuelve el certificado real (via el callCert() del fake, que
  // reproduce el comportamiento de qz-tray 2.2.6) como parte de qz.websocket.connect().
  await client.prepare(job(1));
  const certificate = fake.getReceivedCertificate();

  assert.equal(certificate, secretCertificateText, 'la promesa de certificado sigue devolviendo el certificado real a QZ Tray');

  const certEvent = logs.find((entry) => entry.event === 'print_stage_timing' && entry.data.stage === 'qz_certificate');
  assert.ok(certEvent, 'debe existir una medicion real de qz_certificate, no solo documentada');
  assert.equal(certEvent.data.success, true);
  assert.ok(Number.isFinite(certEvent.data.duration_ms) && certEvent.data.duration_ms >= 0);

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /MUY-SECRETO/, 'el certificado jamas debe aparecer en las metricas');
  assert.doesNotMatch(serializedLogs, /BEGIN CERTIFICATE/, 'el certificado jamas debe aparecer en las metricas');
});

// --- Certificado QZ: comportamiento real de qz-tray 2.2.6 (regresion del bug de firma) ---
//
// Causa raiz confirmada: qz-tray 2.2.6 detecta un handler AsyncFunction por
// constructor.name y lo invoca SIN argumentos (callCert() -> certHandler()). Un handler
// `async (resolve, reject) => {...}` recibe resolve/reject undefined, nunca los llama, y
// QZ Tray termina enviando certificate:null -> Anonymous / UNKNOWN REQUEST / Signature
// Invalid. El fix registra una AsyncFunction de CERO argumentos que retorna el certificado
// directamente, con { rejectOnFailure: true }.

test('certificado QZ: el handler es una AsyncFunction (deteccion real de qz-tray 2.2.6), se invoca sin resolve/reject y el certificado llega completo', async () => {
  const fake = createFakeQz();
  const realCertificate = 'CERT-PEM-COMPLETO-DE-PRUEBA';
  const client = createQzClient({
    config: baseConfig(),
    api: { ...fakeApi(), certificate: async () => realCertificate },
    qz: fake.qz, ...localhostNetworking,
    log: () => {}
  });

  await client.prepare(job(1)); // dispara connect() -> registra e invoca setCertificatePromise

  assert.equal(fake.getCertHandlerType(), 'AsyncFunction', 'qz-tray 2.2.6 debe detectar el handler como AsyncFunction (constructor.name)');
  assert.deepEqual(fake.getCertOptions(), { rejectOnFailure: true });
  assert.equal(fake.getReceivedCertificate(), realCertificate, 'el certificado real debe llegar completo aunque el handler se invoque sin resolve/reject');
});

test('certificado QZ: una falla real de api.certificate() rechaza la conexion, nunca degrada a certificate:null', async () => {
  const fake = createFakeQz();
  const client = createQzClient({
    config: baseConfig(),
    api: { ...fakeApi(), certificate: async () => { throw new Error('CERT_BACKEND_UNAVAILABLE'); } },
    qz: fake.qz, ...localhostNetworking,
    log: () => {}
  });

  await assert.rejects(client.prepare(job(1)), /CERT_BACKEND_UNAVAILABLE/);
  assert.equal(fake.isActive(), false, 'la conexion nunca debe quedar activa/abierta con un certificado fallido');
  assert.equal(fake.getReceivedCertificate(), undefined, 'rejectOnFailure:true debe rechazar la conexion en vez de degradar en silencio a certificate:null');
});

test('regresion: el patron anterior (handler async con resolve/reject) degrada a certificate:null bajo el comportamiento real de qz-tray 2.2.6 -- por eso se corrigio', async () => {
  const fake = createFakeQz();
  // Reproduce exactamente el handler que causaba el bug: una AsyncFunction que esperaba
  // resolve/reject como parametros. qz-tray 2.2.6 la invoca sin argumentos (ver callCert()
  // en el fake, fiel al comportamiento real), asi que resolve/reject nunca se llaman y el
  // certificado real jamas llega.
  fake.qz.security.setCertificatePromise(async (resolve, reject) => {
    Promise.resolve('cert-pem-que-nunca-deberia-llegar').then(resolve, reject);
  });

  await fake.qz.websocket.connect({});

  assert.equal(fake.getReceivedCertificate(), null, 'el patron anterior (resolve/reject) degrada a certificate:null bajo qz-tray 2.2.6 real');
});
