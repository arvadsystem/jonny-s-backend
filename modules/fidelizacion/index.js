// Frontera publica del modulo: Ventas (y cualquier otro consumidor externo)
// solo puede depender de notifyPaidInvoice. Todo lo demas (accumulateInvoicePoints,
// reconcileMissingPoints, el repositorio, el pool, la cola) es detalle interno
// y se importa por ruta directa dentro del propio modulo (p. ej. jobs/ o pruebas).
export { notifyPaidInvoice } from './application/notifyPaidInvoice.js';
