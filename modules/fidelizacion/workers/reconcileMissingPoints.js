// Interfaz preparada para una futura reconciliacion de facturas pagadas sin
// puntos acumulados (por ejemplo, si el proceso se reinicio entre el 201 de
// Ventas y el fin de accumulateInvoicePoints). No implementa todavia
// consultas de reconciliacion ni SQL nuevo.
export const reconcileMissingPoints = async () => ({
  implemented: false,
  reason: 'NOT_IMPLEMENTED_YET'
});
