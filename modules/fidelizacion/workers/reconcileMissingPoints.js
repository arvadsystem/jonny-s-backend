import { connectClient, listPaidInvoicesMissingAccumulation } from '../infrastructure/fidelizacionRepository.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { enqueueInvoiceAccumulationBatch } from '../infrastructure/fidelizacionQueue.js';

const releaseClientSafely = (client) => {
  if (!client) return;
  try {
    client.release();
  } catch (releaseErr) {
    console.error('[fidelizacion:reconcile] error al liberar conexion:', {
      code: releaseErr?.code || releaseErr?.name || 'FIDELIZACION_RELEASE_ERROR'
    });
  }
};

// Reconciliacion idempotente: busca (via paginacion keyset) facturas ya
// pagadas por completo que todavia no tienen movimiento de acumulacion -por
// ejemplo si el proceso se reinicio entre el 201 de Ventas y el fin de
// accumulateInvoicePoints- y las vuelve a intentar por la MISMA cola que usa
// notifyPaidInvoice (misma deduplicacion por id_factura, misma concurrencia
// maxima de 1: nunca corren en paralelo notificaciones inmediatas y
// reconciliacion para la misma factura).
//
// Espera el resultado real de todo el lote antes de responder: no reporta
// exito solo porque las facturas fueron encoladas. Un error al listar
// candidatos (por ejemplo, la conexion cae) se propaga: el scheduler debe
// verlo como tick fallido, no como reconciliacion exitosa sin candidatos.
export const reconcileMissingPoints = async ({ cursor = 0, limit = 25 } = {}) => {
  let client = null;
  try {
    client = await connectClient();
    const { ids, nextCursor } = await listPaidInvoicesMissingAccumulation(client, { cursor, limit });

    const outcomes = await enqueueInvoiceAccumulationBatch(
      ids.map((idFactura) => ({ idFactura })),
      accumulateInvoicePoints
    );

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    outcomes.forEach((outcome, index) => {
      // accumulateInvoicePoints nunca lanza: un fallo inesperado (DB caida a
      // mitad de camino, etc.) llega aqui como resultado normal con
      // reason: 'ERROR', no como promesa rechazada. Se clasifica como fallo
      // real, distinto de un skip legitimo (ya acumulada, cliente no
      // elegible, sin configuracion, pago incompleto, puntos en cero).
      if (outcome.status === 'processed' && outcome.result?.reason !== 'ERROR') {
        if (outcome.result?.created) {
          processed += 1;
        } else {
          skipped += 1;
        }
        return;
      }

      failed += 1;
      console.error('[fidelizacion:reconcile] fallo individual en el lote:', {
        id_factura: ids[index],
        status: outcome.status,
        code: outcome.error?.code || outcome.error?.name || outcome.reason || outcome.result?.reason || 'FIDELIZACION_RECONCILE_ITEM_ERROR'
      });
    });

    return {
      implemented: true,
      scanned: ids.length,
      queued: ids.length,
      processed,
      skipped,
      failed,
      next_cursor: nextCursor,
      ids_factura: ids
    };
  } finally {
    releaseClientSafely(client);
  }
};
