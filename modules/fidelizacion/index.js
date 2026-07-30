// Frontera publica del modulo: Ventas (y cualquier otro consumidor externo)
// solo puede depender de estas dos operaciones. Todo lo demas
// (accumulateInvoicePoints, reconcileMissingPoints, el repositorio, el pool,
// la cola) es detalle interno y se importa por ruta directa dentro del propio
// modulo (p. ej. jobs/ o pruebas).
//
// - reservePaidInvoiceAccumulation: se llama DENTRO de la transaccion
//   financiera, antes del COMMIT. Deja la evidencia durable (PENDING +
//   snapshot historico) y nunca lanza ni aborta esa transaccion.
// - notifyPaidInvoice: se llama DESPUES del COMMIT y de responder. Encola el
//   procesamiento real y nunca lanza.
export { reservePaidInvoiceAccumulation } from './application/reservePaidInvoiceAccumulation.js';
export { notifyPaidInvoice } from './application/notifyPaidInvoice.js';
