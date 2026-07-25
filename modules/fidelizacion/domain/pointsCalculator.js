// Formula pura de acumulacion. Sin acceso a datos ni dependencias externas.
// Nota: es una copia deliberada de la formula en services/fidelizacionService.js
// (usada tambien por el modulo de canje, fuera de alcance de esta fase).
export const computeAccumulationPoints = (montoFactura, lempirasPorPunto) => {
  const total = Number(montoFactura || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(total) || !Number.isFinite(ratio) || total <= 0 || ratio <= 0) return 0;
  return Math.floor(total / ratio);
};

export const isAccumulationWorthPersisting = (points) => Number(points) > 0;
