// Punto de encolado del trabajo diferido de fidelizacion. Hoy es un
// despacho en proceso (setImmediate); el contrato queda listo para que un
// reemplazo por una cola real (pg-boss, BullMQ, etc.) no cambie a los
// llamadores (application/notifyPaidInvoice.js).
export const enqueueInvoiceAccumulation = (job, handler) => {
  setImmediate(() => {
    Promise.resolve()
      .then(() => handler(job))
      .catch(() => undefined);
  });
};
