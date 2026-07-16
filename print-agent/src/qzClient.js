import fs from 'node:fs';
import qzImport from 'qz-tray';
import WebSocket from 'ws';
import { renderPrintJobHtml } from './documentRenderer.js';

export const createSecureWebSocketType = ({ WebSocketImpl = WebSocket, ca = null } = {}) => {
  function SecureWebSocket(address) {
    return new WebSocketImpl(address, {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {})
    });
  }
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) SecureWebSocket[key] = WebSocketImpl[key];
  return SecureWebSocket;
};

export const createQzClient = ({ config, api, qz = qzImport?.default || qzImport, WebSocketImpl = WebSocket }) => {
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
        params: { query: null },
        timestamp: Date.now()
      };
      signingContext = { jobId: job.id_trabajo, request: findRequest };
      let available;
      try {
        available = await qz.printers.find(null, undefined, findRequest.timestamp);
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
