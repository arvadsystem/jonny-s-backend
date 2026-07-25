import { connectClient, listPaidInvoicesMissingAccumulation } from '../infrastructure/fidelizacionRepository.js';
import { notifyPaidInvoice } from '../application/notifyPaidInvoice.js';

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

// Reconciliacion idempotente: busca facturas ya pagadas por completo que
// todavia no tienen movimiento de acumulacion (por ejemplo, si el proceso se
// reinicio entre el 201 de Ventas y el fin de accumulateInvoicePoints) y las
// vuelve a notificar por la misma via publica (notifyPaidInvoice), que las
// encola en la cola de concurrencia 1. Es seguro llamarla repetidamente: la
// idempotencia real vive en persistAccumulation, no aqui.
export const reconcileMissingPoints = async ({ limit = 25 } = {}) => {
  let client = null;
  try {
    client = await connectClient();
    const idsFactura = await listPaidInvoicesMissingAccumulation(client, { limit });

    idsFactura.forEach((idFactura) => {
      void notifyPaidInvoice({ idFactura });
    });

    return {
      implemented: true,
      candidates: idsFactura.length,
      ids_factura: idsFactura
    };
  } catch (err) {
    console.error('[fidelizacion:reconcile] error:', {
      code: err?.code || err?.name || 'FIDELIZACION_RECONCILE_ERROR'
    });
    return { implemented: true, candidates: 0, ids_factura: [], error: true };
  } finally {
    releaseClientSafely(client);
  }
};
