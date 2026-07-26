import { connectClient, listPaidInvoicesMissingAccumulation } from '../infrastructure/fidelizacionRepository.js';
import { accumulateInvoicePoints } from '../application/accumulateInvoicePoints.js';
import { enqueueInvoiceAccumulationBatch } from '../infrastructure/fidelizacionQueue.js';
import { ACCUMULATION_TRIGGER } from '../domain/accumulationState.js';

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

// Clasifica un resultado de la cola como fallo real (algo se rompio o la cola
// lo rechazo) frente a un skip legitimo de negocio (ya acumulada, cliente no
// elegible, sin configuracion, pago incompleto, puntos en cero). Un fallo
// real es lo unico que detiene el avance del cursor.
const isRealFailure = (outcome) => (
  outcome.status === 'failed'
  || outcome.status === 'rejected'
  || (outcome.status === 'processed' && outcome.result?.reason === 'ERROR')
);

// Reconciliacion idempotente: busca (via paginacion keyset) facturas ya
// pagadas por completo que todavia no tienen movimiento de acumulacion -por
// ejemplo si el proceso se reinicio entre el 201 de Ventas y el fin de
// accumulateInvoicePoints- y las vuelve a intentar por la MISMA cola que usa
// notifyPaidInvoice (misma deduplicacion por id_factura, misma concurrencia
// maxima de 1: nunca corren en paralelo notificaciones inmediatas y
// reconciliacion para la misma factura).
//
// IMPORTANTE (pool max: 1): la conexion usada para LISTAR candidatos se
// libera antes de encolar el lote. Cada acumulacion pide su propia conexion
// al mismo pool dedicado (max: 1); si la conexion de listado siguiera
// retenida mientras se espera el lote, la primera acumulacion se quedaria
// esperando para siempre una conexion que nunca se libera (deadlock).
//
// Espera el resultado real de todo el lote antes de responder: no reporta
// exito solo porque las facturas fueron encoladas. Un error al listar
// candidatos (por ejemplo, la conexion cae) se propaga: el scheduler debe
// verlo como tick fallido, no como reconciliacion exitosa sin candidatos.
export const reconcileMissingPoints = async ({ cursor = 0, limit = 25 } = {}) => {
  let client = null;
  let listing;
  try {
    client = await connectClient();
    listing = await listPaidInvoicesMissingAccumulation(client, { cursor, limit });
  } finally {
    releaseClientSafely(client);
  }

  const { ids, nextCursor } = listing;

  // trigger: RECONCILE -- distingue este camino asincrono del inmediato
  // (notifyPaidInvoice, LIVE por defecto) para que persistAccumulation sepa
  // que un rechazo por perfil incompleto aqui no puede vouch por el momento
  // de la compra (ver domain/accumulationState.js).
  const outcomes = await enqueueInvoiceAccumulationBatch(
    ids.map((idFactura) => ({ idFactura, trigger: ACCUMULATION_TRIGGER.RECONCILE })),
    accumulateInvoicePoints
  );

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let rejected = 0;
  let firstFailureIndex = -1;

  outcomes.forEach((outcome, index) => {
    if (isRealFailure(outcome)) {
      if (outcome.status === 'rejected') {
        rejected += 1;
      } else {
        failed += 1;
      }
      if (firstFailureIndex === -1) firstFailureIndex = index;
      console.error('[fidelizacion:reconcile] fallo individual en el lote:', {
        id_factura: ids[index],
        status: outcome.status,
        code: outcome.error?.code || outcome.error?.name || outcome.reason || outcome.result?.reason || 'FIDELIZACION_RECONCILE_ITEM_ERROR'
      });
      return;
    }

    if (outcome.result?.created) {
      processed += 1;
    } else {
      skipped += 1;
    }
  });

  const success = failed === 0 && rejected === 0;

  // No avanzar mas alla de la primera factura fallida/rechazada: el
  // siguiente tick debe poder volver a intentarla (y a todo lo que venia
  // despues en este mismo lote). Lo que ya tenga movimiento para entonces
  // queda excluido de forma natural por el NOT EXISTS del listado, asi que
  // reintentar el resto del lote no duplica nada.
  const retryCursor = success || firstFailureIndex === -1
    ? null
    : Math.max(0, ids[firstFailureIndex] - 1);

  return {
    implemented: true,
    scanned: ids.length,
    queued: ids.length,
    processed,
    skipped,
    failed,
    rejected,
    next_cursor: nextCursor,
    retry_cursor: retryCursor,
    success,
    partial: !success,
    reached_end: ids.length === 0,
    ids_factura: ids
  };
};
