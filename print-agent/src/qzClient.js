import qzImport from 'qz-tray';
import WebSocket from 'ws';
import { renderPrintJobHtml } from './documentRenderer.js';

export const createQzClient = ({ config, api, qz = qzImport?.default || qzImport }) => {
  let securityConfigured = false;
  const connect = async () => {
    qz.api.setPromiseType((resolver) => new Promise(resolver));
    qz.api.setWebSocketType(WebSocket);
    if (!securityConfigured) {
      qz.security.setCertificatePromise(async (resolve, reject) => api.certificate().then(resolve, reject));
      qz.security.setSignatureAlgorithm('SHA512');
      qz.security.setSignaturePromise((toSign) => async (resolve, reject) => api.sign(toSign).then(resolve, reject));
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
    print: async (job) => {
      await connect();
      const logical = String(job.payload?.impresora_logica || job.tipo_documento || '').toLowerCase();
      const printer = String(config.printerMap[logical] || '').trim();
      if (!printer) throw new Error(`IMPRESORA_LOGICA_NO_CONFIGURADA:${logical}`);
      const available = await qz.printers.find();
      if (!available.some((name) => String(name).toLowerCase() === printer.toLowerCase())) throw new Error(`IMPRESORA_NO_ENCONTRADA:${logical}`);
      const html = renderPrintJobHtml(job.payload);
      const qzConfig = qz.configs.create(printer, { copies: 1, margins: 0, units: 'mm', jobName: `Jonny-${job.id_trabajo}` });
      await qz.print(qzConfig, [{ type: 'pixel', format: 'html', flavor: 'plain', data: html, options: { pageWidth: Number(job.payload?.ancho_mm) === 58 ? 58 : 80 } }]);
    },
    disconnect: async () => { if (qz.websocket.isActive()) await qz.websocket.disconnect(); }
  };
};
