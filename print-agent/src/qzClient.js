import { lookup as dnsLookup } from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import { networkInterfaces as getNetworkInterfaces } from 'node:os';
import qzImport from 'qz-tray';
import WebSocket from 'ws';
import { normalizeQzHost } from './config.js';
import { renderPrintJobHtml } from './documentRenderer.js';

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

export const createQzClient = ({
  config,
  api,
  qz = qzImport?.default || qzImport,
  WebSocketImpl = WebSocket,
  lookupImpl = dnsLookup,
  networkInterfacesImpl = getNetworkInterfaces
}) => {
  let securityConfigured = false;
  let signingContext = null;
  const ca = config.qzCaCertPath ? fs.readFileSync(config.qzCaCertPath) : null;

  const connect = async () => {
    qz.api.setPromiseType((resolver) => new Promise(resolver));
    qz.api.setWebSocketType(createSecureWebSocketType({ WebSocketImpl, ca }));
    if (!securityConfigured) {
      qz.security.setCertificatePromise(async (resolve, reject) => api.certificate().then(resolve, reject));
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
    }
  };

  return {
    prepare: async (job) => {
      await connect();
      const findRequest = {
        call: 'printers.find',
        params: {},
        timestamp: Date.now()
      };
      signingContext = { jobId: job.id_trabajo, request: findRequest };
      let available;
      try {
        available = await qz.printers.find(undefined, undefined, findRequest.timestamp);
      } finally {
        signingContext = null;
      }
      const logical = String(job.payload?.impresora_logica || job.tipo_documento || '').toLowerCase();
      const printer = String(config.printerMap[logical] || '').trim();
      if (!printer) throw new Error(`IMPRESORA_LOGICA_NO_CONFIGURADA:${logical}`);
      if (!available.some((name) => String(name).toLowerCase() === printer.toLowerCase())) throw new Error(`IMPRESORA_NO_ENCONTRADA:${logical}`);
      const data = [{
        type: 'pixel',
        format: 'html',
        flavor: 'plain',
        data: renderPrintJobHtml(job.payload),
        options: { pageWidth: Number(job.payload?.ancho_mm) === 58 ? 58 : 80 }
      }];
      const qzConfig = qz.configs.create(printer, {
        copies: 1,
        margins: 0,
        units: 'mm',
        jobName: `Jonny-${job.id_trabajo}`
      });
      return { job, qzConfig, data };
    },
    dispatch: async ({ job, qzConfig, data }) => {
      const printRequest = {
        call: 'print',
        params: {
          printer: qzConfig.getPrinter(),
          options: qzConfig.getOptions(),
          data
        },
        timestamp: Date.now()
      };
      signingContext = { jobId: job.id_trabajo, request: printRequest };
      try {
        await qz.print(qzConfig, data, undefined, printRequest.timestamp);
      } finally {
        signingContext = null;
      }
    },
    disconnect: async () => { if (qz.websocket.isActive()) await qz.websocket.disconnect(); }
  };
};
