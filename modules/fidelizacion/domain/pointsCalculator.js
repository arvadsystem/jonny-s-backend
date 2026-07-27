// Formula pura de acumulacion. Sin acceso a datos ni dependencias externas.
// Unica fuente de esta formula: services/fidelizacionService.js la importa de
// aqui en vez de mantener su propia copia (tambien la usa el modulo de canje,
// via computeRedemptionPoints, fuera de alcance de esta fase).
//
// Regla de cuentas divididas: el redondeo (floor) se aplica de forma
// INDIVIDUAL por cada factura pagada -montoFactura es siempre el monto de
// UNA factura (SUM(facturas_cobros.monto) filtrado por su propio id_factura),
// nunca el total agregado del pedido-. Si un pedido se divide en varias
// facturas, cada una calcula puntos = floor(su propio monto / lempiras_por_punto)
// por separado; no se vuelve a acumular sobre el total global del pedido.
export const computeAccumulationPoints = (montoFactura, lempirasPorPunto) => {
  const total = Number(montoFactura || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(total) || !Number.isFinite(ratio) || total <= 0 || ratio <= 0) return 0;
  return Math.floor(total / ratio);
};
