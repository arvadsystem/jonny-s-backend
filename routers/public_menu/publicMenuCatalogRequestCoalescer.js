const catalogRequestsInFlight = new Map();

const normalizeOrderType = (value) => String(value || 'na').trim().toLowerCase() || 'na';

export const buildPublicCatalogRequestKey = ({ idSucursal, tipoPedido }) =>
  `${Number(idSucursal) || 0}::${normalizeOrderType(tipoPedido)}`;

// Coalescencia local por proceso: evita trabajo duplicado simultaneo sin retener
// respuestas terminadas ni introducir riesgo de datos obsoletos entre replicas.
export const fetchCoalescedPublicCatalog = async ({ idSucursal, tipoPedido }, loader) => {
  if (typeof loader !== 'function') throw new TypeError('loader es requerido.');

  const cacheKey = buildPublicCatalogRequestKey({ idSucursal, tipoPedido });
  const inFlight = catalogRequestsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = Promise.resolve().then(loader);
  catalogRequestsInFlight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    if (catalogRequestsInFlight.get(cacheKey) === promise) {
      catalogRequestsInFlight.delete(cacheKey);
    }
  }
};

export const getPublicCatalogRequestCoalescerState = () => ({
  in_flight: catalogRequestsInFlight.size
});
