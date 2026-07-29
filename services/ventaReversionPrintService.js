import { createCanonicalPrintJob } from './printJobDocumentService.js';
import { enqueuePrintJobInTransaction } from './printQueueService.js';
import { loadVentaReversionTicketData } from './ventaReversionTicketPdfService.js';

export const enqueueAutomaticVentaReversionPrintJob = async ({
  client,
  idReversion,
  idFactura,
  idSucursal,
  idUsuario,
  loadReversion = loadVentaReversionTicketData,
  createDocument = createCanonicalPrintJob,
  enqueue = enqueuePrintJobInTransaction
}) => {
  const reversion = await loadReversion({ db: client, idReversion });
  if (!reversion) {
    throw Object.assign(new Error('No se pudo construir el comprobante canonico de la reversion.'), {
      code: 'PRINTING_REVERSION_SCHEMA_PENDIENTE',
      status: 409,
      httpStatus: 409,
      publicMessage: 'No se pudo construir el comprobante canonico de la reversion.'
    });
  }
  if (reversion.imprimir_comprobante_reversion !== true) {
    return { enabled: false, job: null };
  }
  const canonical = await createDocument({
    tipoDocumento: 'reversion',
    venta: reversion,
    widthMm: reversion.ancho_ticket_mm
  });
  const job = await enqueue({
    client,
    idSucursal,
    tipoDocumento: 'reversion',
    payload: canonical.payload,
    canonicalDocument: canonical.document,
    idempotencyKey: `reversion:${idReversion}:inicial`,
    idFactura,
    idReversion,
    idUsuario,
    esReimpresion: false
  });
  return { enabled: true, job };
};
