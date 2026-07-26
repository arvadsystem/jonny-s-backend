// Funcion pura: decide que contexto (cliente/sucursal/pedido/fecha) es
// AUTORITATIVO para acreditar puntos de una factura. Sin acceso a datos ni
// dependencias externas -por eso vive en domain/, junto a accumulationState.js.
//
// Por que existe: el snapshot durable (capturado en la reserva pre-COMMIT o
// reconstruido con evidencia historica confiable) puede referirse a un
// cliente/sucursal/pedido/fecha distinto al que resuelve el contexto ACTUAL
// de la factura (p.ej. si la fila es legada, o si el pedido/factura fueron
// corregidos despues). Combinar (COALESCE) ambos permitiria que la
// elegibilidad historica de un cliente se aplique al saldo de otro. La regla
// es entonces binaria: si hay snapshot, sus 4 campos GANAN enteros -nunca se
// mezclan con el contexto actual-; si no hay snapshot, se usa el contexto
// actual tal cual.

const normalizeId = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

const FIELD_NORMALIZERS = Object.freeze({
  idCliente: normalizeId,
  idSucursal: normalizeId,
  idPedido: normalizeId,
  referenceDate: normalizeDate
});

export const resolveEffectiveAccumulationContext = ({ currentContext = {}, eligibilitySnapshot = null } = {}) => {
  if (!eligibilitySnapshot) {
    return {
      effective: {
        idCliente: currentContext.idCliente ?? null,
        idSucursal: currentContext.idSucursal ?? null,
        idPedido: currentContext.idPedido ?? null,
        referenceDate: currentContext.referenceDate ?? null
      },
      mismatch: null
    };
  }

  const effective = {
    idCliente: eligibilitySnapshot.idCliente ?? null,
    idSucursal: eligibilitySnapshot.idSucursal ?? null,
    idPedido: eligibilitySnapshot.idPedido ?? null,
    referenceDate: eligibilitySnapshot.fechaReferencia ?? null
  };

  const mismatch = [];
  for (const field of Object.keys(FIELD_NORMALIZERS)) {
    const normalize = FIELD_NORMALIZERS[field];
    const snapshotValue = normalize(effective[field]);
    const currentValue = normalize(currentContext[field]);
    // Solo hay contradiccion real cuando AMBOS lados tienen valor y difieren.
    // Un lado null (dato faltante/no resuelto) nunca es, por si solo, una
    // inconsistencia -no hay nada que contradiga al snapshot.
    if (snapshotValue !== null && currentValue !== null && snapshotValue !== currentValue) {
      mismatch.push(field);
    }
  }

  return { effective, mismatch: mismatch.length > 0 ? mismatch : null };
};
