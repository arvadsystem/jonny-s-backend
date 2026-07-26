// Constantes puras del estado de procesamiento por factura (bloqueante:
// acumulacion retroactiva). Sin acceso a datos ni dependencias externas.
// Unica fuente de estos valores: infrastructure/fidelizacionRepository.js y
// application/accumulateInvoicePoints.js las importan de aqui.

export const ACCUMULATION_STATE = Object.freeze({
  PENDING: 'PENDING',
  PROCESSED: 'PROCESSED',
  SKIPPED_TERMINAL: 'SKIPPED_TERMINAL',
  RETRYABLE_ERROR: 'RETRYABLE_ERROR'
});

// La reconciliacion (reconcileMissingPoints) solo puede reintentar facturas
// en uno de estos dos estados; nunca un estado terminal.
export const RETRYABLE_ACCUMULATION_STATES = Object.freeze([
  ACCUMULATION_STATE.PENDING,
  ACCUMULATION_STATE.RETRYABLE_ERROR
]);

// Motivo usado cuando la reconciliacion (no la venta inmediata) es quien
// determina por primera vez que el perfil del cliente estaba incompleto: no
// se puede garantizar que el perfil actual refleje el perfil al momento de
// la compra, asi que se distingue de CLIENT_PROFILE_INCOMPLETE (que si es
// confiable porque lo evalua notifyPaidInvoice justo tras el COMMIT de la
// venta).
export const LEGACY_ELIGIBILITY_UNVERIFIABLE = 'LEGACY_ELIGIBILITY_UNVERIFIABLE';

// Motivo terminal cuando el snapshot durable (autoritativo) y el contexto
// actual de la factura discrepan en cliente/sucursal/pedido/fecha. Es
// terminal -no PENDING/RETRYABLE_ERROR- porque una discrepancia real no se
// resuelve reintentando: reintentar indefinidamente una inconsistencia
// persistente solo repetiria el mismo resultado.
export const ACCUMULATION_CONTEXT_MISMATCH = 'ACCUMULATION_CONTEXT_MISMATCH';

export const ACCUMULATION_TRIGGER = Object.freeze({
  LIVE: 'LIVE',
  RECONCILE: 'RECONCILE'
});
