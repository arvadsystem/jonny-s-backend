// Clasificador CANONICO del origen de un pedido. Funcion pura, sin imports
// ni acceso a datos, para que la puedan compartir modulos que no deben
// depender entre si (Ventas y Fidelizacion).
//
// Antes vivia solo en routers/ventas/services/pedidoOperationalRoutingService.js;
// se extrajo aqui para que fidelizacion reutilice EXACTAMENTE la misma regla
// en vez de duplicar una propia (la duplicacion es justo lo que produce
// criterios divergentes entre modulos). Ese servicio ahora reexporta desde
// aqui, asi que todos sus consumidores actuales siguen funcionando igual.
//
// Valores persistidos reales en pedidos.origen_pedido: 'MENU' (menu publico,
// ver routers/public_menu/publicMenuQueries.js) y 'CAJA' (POS, ver la RPC de
// pedido pendiente). La columna es nullable: filas legadas pueden traer NULL,
// y por eso NULL clasifica como UNKNOWN (nunca se asume menu publico solo por
// ausencia de dato).

export const PEDIDO_ORIGIN = Object.freeze({
  PUBLIC_MENU: 'PUBLIC_MENU',
  INTERNAL_POS: 'INTERNAL_POS',
  UNKNOWN: 'UNKNOWN'
});

export const normalizePedidoOrigenCode = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

export const resolvePedidoOrigin = ({ origen_pedido: persistedSource } = {}) => {
  const normalizedSource = normalizePedidoOrigenCode(persistedSource);
  if (normalizedSource === 'MENU') return PEDIDO_ORIGIN.PUBLIC_MENU;
  if (normalizedSource === 'CAJA') return PEDIDO_ORIGIN.INTERNAL_POS;
  return PEDIDO_ORIGIN.UNKNOWN;
};
