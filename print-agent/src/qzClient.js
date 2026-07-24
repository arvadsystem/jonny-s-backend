import { lookup as dnsLookup } from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import { networkInterfaces as getNetworkInterfaces } from 'node:os';
import qzImport from 'qz-tray';
import WebSocket from 'ws';
import { normalizeQzHost } from './config.js';
import { renderPrintJobHtml, validateCanonicalPrintJobData } from './documentRenderer.js';
import { createStageTimer } from './metrics.js';

const normalizeIpAddress = (address) => {
  const value = String(address || '').trim().toLowerCase().split('%', 1)[0];
  const family = net.isIP(value);
  if (family === 4) return value.split('.').map(Number).join('.');
  if (family !== 6) return null;
  try { return new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
};

const isLoopbackAddress = (address) => (
  address === '::1' || (net.isIP(address) === 4 && address.startsWith('127.'))
);

export const assertQzHostResolvesLocally = async ({
  host,
  lookupImpl = dnsLookup,
  networkInterfacesImpl = getNetworkInterfaces
}) => {
  const normalizedHost = normalizeQzHost(host);
  let records;
  try {
    records = await lookupImpl(normalizedHost, { all: true, verbatim: true });
  } catch {
    throw new Error('QZ_HOST_DNS_LOOKUP_FAILED');
  }
  const resolvedAddresses = (Array.isArray(records) ? records : [records])
    .map((record) => normalizeIpAddress(record?.address ?? record))
    .filter(Boolean);
  if (resolvedAddresses.length === 0) throw new Error('QZ_HOST_DNS_LOOKUP_FAILED');
  if (resolvedAddresses.some(isLoopbackAddress)) return resolvedAddresses;

  let interfaces;
  try { interfaces = networkInterfacesImpl(); } catch { throw new Error('QZ_HOST_LOCAL_INTERFACES_UNAVAILABLE'); }
  const localAddresses = new Set(
    Object.values(interfaces || {}).flatMap((entries) => Array.isArray(entries) ? entries : [])
      .map((entry) => normalizeIpAddress(entry?.address))
      .filter(Boolean)
  );
  if (!resolvedAddresses.some((address) => localAddresses.has(address))) {
    throw new Error('QZ_HOST_NOT_LOCAL');
  }
  return resolvedAddresses;
};

export const createSecureWebSocketType = ({ WebSocketImpl = WebSocket, ca = null } = {}) => {
  function SecureWebSocket(address) {
    if (!/^wss:\/\//i.test(String(address))) throw new Error('QZ_WSS_REQUIRED');
    return new WebSocketImpl(address, {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {})
    });
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) SecureWebSocket[key] = WebSocketImpl[key];
  return SecureWebSocket;
};

const isPrinterInList = (list, printerName) => (
  Array.isArray(list) && list.some((name) => String(name).toLowerCase() === printerName.toLowerCase())
);

// Reintento en segundo plano de la preconexion, con backoff acotado: nunca mas de un
// timer pendiente a la vez, nunca compite con un trabajo real (comparten el mismo
// connect() single-flight), y se detiene por completo en disconnect()/shutdown.
const PRECONNECT_RETRY_BASE_MS = 5000;
const PRECONNECT_RETRY_MAX_MS = 60000;

export const createQzClient = ({
  config,
  api,
  qz = qzImport?.default || qzImport,
  WebSocketImpl = WebSocket,
  lookupImpl = dnsLookup,
  networkInterfacesImpl = getNetworkInterfaces,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  log = () => {}
}) => {
  let securityConfigured = false;
  let signingContext = null;
  const ca = config.qzCaCertPath ? fs.readFileSync(config.qzCaCertPath) : null;
  const { timeStage } = createStageTimer({ log, enabled: config.perfLogsEnabled === true });

  // Single-flight: preconexion al iniciar, el WebSocket de señalización y cada
  // qz.prepare() de un trabajo pueden pedir conectar casi al mismo tiempo. Todos
  // comparten esta misma promesa en vez de disparar qz.websocket.connect() por
  // duplicado; ninguno bloquea a otro trabajo ya en procesamiento porque connect()
  // nunca toca el journal ni el estado de un trabajo.
  let connectPromise = null;

  // Cache en memoria de printers.find, nunca en disco ni compartida entre procesos.
  let printerCacheList = null;
  let printerCacheExpiresAt = 0;
  let printerCachePromise = null;

  const invalidatePrinterCache = () => {
    printerCacheList = null;
    printerCacheExpiresAt = 0;
  };

  const connect = () => {
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      qz.api.setPromiseType((resolver) => new Promise(resolver));
      qz.api.setWebSocketType(createSecureWebSocketType({ WebSocketImpl, ca }));
      if (!securityConfigured) {
        // Medicion real (no solo documentada): el valor devuelto por api.certificate()
        // nunca se pasa a timeStage/log, asi que el certificado en si jamas queda expuesto
        // en las metricas -- timeStage solo registra job_id/stage/duration_ms/success.
        qz.security.setCertificatePromise(async (resolve, reject) => {
          timeStage(signingContext?.jobId ?? null, 'qz_certificate', () => api.certificate()).then(resolve, reject);
        });
        qz.security.setSignatureAlgorithm('SHA512');
        qz.security.setSignaturePromise(async (digest) => {
          if (!signingContext) throw new Error('QZ_GENERIC_SIGNING_DISABLED');
          const authorization = await api.sign(signingContext.jobId, signingContext.request, digest);
          return authorization.signature;
        });
        securityConfigured = true;
      }
      if (!qz.websocket.isActive()) {
        await assertQzHostResolvesLocally({
          host: config.qzHost,
          lookupImpl,
          networkInterfacesImpl
        });
        await qz.websocket.connect({
          host: config.qzHost,
          usingSecure: true,
          port: { secure: [config.qzSecurePort] },
          retries: 1,
          delay: 1
        });
        // Sesion nueva: cualquier lista de impresoras cacheada de una conexion
        // anterior deja de ser confiable.
        invalidatePrinterCache();
      }
    })();
    return connectPromise.finally(() => { connectPromise = null; });
  };

  let preconnectRetryTimer = null;
  let preconnectRetryAttempt = 0;
  let preconnectStopped = false;

  const scheduleBackgroundPreconnectRetry = () => {
    if (preconnectStopped || preconnectRetryTimer) return; // nunca mas de un reintento pendiente
    const wait = Math.min(PRECONNECT_RETRY_BASE_MS * (2 ** preconnectRetryAttempt), PRECONNECT_RETRY_MAX_MS);
    preconnectRetryAttempt += 1;
    preconnectRetryTimer = setTimeoutImpl(() => {
      preconnectRetryTimer = null;
      if (!preconnectStopped) void preconnect();
    }, wait);
    preconnectRetryTimer?.unref?.();
  };

  // Best-effort al iniciar el agente: nunca lanza. Si QZ Tray esta cerrado, el agente
  // sigue vivo, programa un reintento en segundo plano con backoff y el primer trabajo
  // real puede conectar de todas formas via prepare() (comparten el mismo single-flight).
  const preconnect = async () => {
    try {
      await connect();
      log('info', 'qz_preconnect_complete', {});
      preconnectRetryAttempt = 0;
      return true;
    } catch (error) {
      log('warn', 'qz_preconnect_failed', { code: String(error?.code || error?.message || 'QZ_PRECONNECT_FAILED').slice(0, 200) });
      scheduleBackgroundPreconnectRetry();
      return false;
    }
  };

  const stopPreconnectRetry = () => {
    preconnectStopped = true;
    if (preconnectRetryTimer) {
      clearTimeoutImpl(preconnectRetryTimer);
      preconnectRetryTimer = null;
    }
  };

  const fetchPrintersRaw = async (jobId) => {
    const findRequest = { call: 'printers.find', params: {}, timestamp: Date.now() };
    signingContext = { jobId, request: findRequest };
    try {
      return await qz.printers.find(undefined, undefined, findRequest.timestamp);
    } catch (error) {
      // Un fallo al hablar con QZ puede significar sesion invalida; no se confia en
      // una lista cacheada de antes de este error.
      invalidatePrinterCache();
      throw error;
    } finally {
      signingContext = null;
    }
  };

  const getPrinters = async (jobId) => {
    const now = Date.now();
    if (printerCacheList && now < printerCacheExpiresAt) {
      return { list: printerCacheList, cacheHit: true };
    }
    if (!printerCachePromise) {
      printerCachePromise = fetchPrintersRaw(jobId)
        .then((list) => {
          printerCacheList = list;
          printerCacheExpiresAt = Date.now() + config.printerCacheTtlMs;
          return list;
        })
        .finally(() => { printerCachePromise = null; });
    }
    const list = await printerCachePromise;
    return { list, cacheHit: false };
  };

  const resolvePrinterName = (job) => {
    const logical = String(job.payload?.impresora_logica || job.tipo_documento || '').toLowerCase();
    const printerName = String(config.printerMap[logical] || '').trim();
    if (!printerName) throw new Error(`IMPRESORA_LOGICA_NO_CONFIGURADA:${logical}`);
    return { logical, printerName };
  };

  return {
    preconnect,
    prepare: async (job) => {
      const jobId = job.id_trabajo;
      await timeStage(jobId, 'qz_connect', async (note) => {
        note({ cache_hit: qz.websocket.isActive() });
        await connect();
      });

      const { logical, printerName } = resolvePrinterName(job);
      const printerFound = await timeStage(jobId, 'printer_resolution', async () => {
        let { list, cacheHit } = await timeStage(jobId, 'printers_find', async (note) => {
          const outcome = await getPrinters(jobId);
          note({ cache_hit: outcome.cacheHit });
          return outcome;
        });
        if (isPrinterInList(list, printerName)) return true;

        // La impresora configurada no aparece en la lista cacheada: se invalida y se
        // vuelve a consultar una sola vez antes de declarar IMPRESORA_NO_ENCONTRADA.
        invalidatePrinterCache();
        ({ list } = await timeStage(jobId, 'printers_find', async (note) => {
          const outcome = await getPrinters(jobId);
          note({ cache_hit: outcome.cacheHit, forced_refresh: true });
          return outcome;
        }));
        return isPrinterInList(list, printerName);
      });
      if (!printerFound) throw new Error(`IMPRESORA_NO_ENCONTRADA:${logical}`);

      const schemaVersion = Number(job.payload?.schema_version);
      let dataItem;
      if (schemaVersion === 2) {
        const canonicalDocument = await timeStage(jobId, 'document_download', () => api.document(job.id_trabajo));
        dataItem = await timeStage(jobId, 'document_validation', () => validateCanonicalPrintJobData(job.payload, canonicalDocument));
      } else {
        dataItem = {
          type: 'pixel',
          format: 'html',
          flavor: 'plain',
          data: renderPrintJobHtml(job.payload),
          options: { pageWidth: Number(job.payload?.ancho_mm) === 58 ? 58 : 80 }
        };
      }
      const data = [dataItem];
      const qzConfig = qz.configs.create(printerName, {
        copies: 1,
        jobName: `Jonny-${job.id_trabajo}`,
        margins: 0,
        scaleContent: false,
        units: 'mm'
      });
      return { job, qzConfig, data };
    },
    dispatch: async ({ job, qzConfig, data }) => {
      const jobId = job.id_trabajo;
      const printRequest = {
        call: 'print',
        params: {
          printer: qzConfig.getPrinter(),
          options: qzConfig.getOptions(),
          data
        },
        timestamp: Date.now()
      };
      signingContext = { jobId, request: printRequest };
      try {
        await timeStage(jobId, 'qz_print', () => qz.print(qzConfig, data, [], [printRequest.timestamp]));
      } catch (error) {
        // Resultado fisico ambiguo (ver runner.js): tambien puede indicar sesion QZ
        // invalida, asi que la proxima resolucion de impresora no confia en la cache.
        invalidatePrinterCache();
        throw error;
      } finally {
        signingContext = null;
      }
    },
    disconnect: async () => {
      stopPreconnectRetry();
      if (qz.websocket.isActive()) await qz.websocket.disconnect();
      invalidatePrinterCache();
    },
    // Expuesto para pruebas y para un shutdown explicito que no deba cerrar la sesion QZ
    // (por ejemplo si un trabajo real sigue en curso), solo detener el reintento en
    // segundo plano de la preconexion.
    stopPreconnectRetry
  };
};
