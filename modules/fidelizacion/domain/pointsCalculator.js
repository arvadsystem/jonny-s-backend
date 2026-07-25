// Formula pura de acumulacion. Sin acceso a datos ni dependencias externas.
// Unica fuente de esta formula: services/fidelizacionService.js la importa de
// aqui en vez de mantener su propia copia (tambien la usa el modulo de canje,
// via computeRedemptionPoints, fuera de alcance de esta fase).
export const computeAccumulationPoints = (montoFactura, lempirasPorPunto) => {
  const total = Number(montoFactura || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(total) || !Number.isFinite(ratio) || total <= 0 || ratio <= 0) return 0;
  return Math.floor(total / ratio);
};
