const cajaBootstrapCache = new Map();
const cajaBootstrapInFlight = new Map();
let cajaBootstrapCatalogVersion = 1;

const getCacheTtlMs = () => {
  const raw = process.env.VENTAS_CATALOG_CACHE_TTL_MS;
  const fallback = process.env.NODE_ENV === 'production' ? '0' : '30000';
  const parsed = Number.parseInt(String(raw ?? fallback).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

export const buildCajaBootstrapCacheKey = ({ idSucursal, idTipoDepartamento }) => (
  `caja-bootstrap:v=${cajaBootstrapCatalogVersion}:s=${Number(idSucursal)}:d=${Number(idTipoDepartamento)}`
);

export const clearVentasCajaBootstrapCache = () => {
  cajaBootstrapCatalogVersion += 1;
  cajaBootstrapCache.clear();
  cajaBootstrapInFlight.clear();
};

export const fetchCachedCajaBootstrap = async (cacheKey, loader) => {
  const ttlMs = getCacheTtlMs();
  const cached = cajaBootstrapCache.get(cacheKey);
  if (ttlMs > 0 && cached && Date.now() - cached.at < ttlMs) {
    return { value: cloneValue(cached.value), cache: 'HIT' };
  }
  if (cached) cajaBootstrapCache.delete(cacheKey);

  const inFlight = cajaBootstrapInFlight.get(cacheKey);
  if (inFlight) {
    const value = await inFlight;
    return { value: cloneValue(value), cache: 'HIT' };
  }

  const promise = Promise.resolve().then(loader);
  cajaBootstrapInFlight.set(cacheKey, promise);
  try {
    const value = await promise;
    if (ttlMs > 0) {
      cajaBootstrapCache.set(cacheKey, { at: Date.now(), value: cloneValue(value) });
    }
    return { value: cloneValue(value), cache: 'MISS' };
  } finally {
    if (cajaBootstrapInFlight.get(cacheKey) === promise) {
      cajaBootstrapInFlight.delete(cacheKey);
    }
  }
};

export const getCajaBootstrapCacheState = () => ({
  entries: cajaBootstrapCache.size,
  in_flight: cajaBootstrapInFlight.size,
  version: cajaBootstrapCatalogVersion,
  ttl_ms: getCacheTtlMs()
});
