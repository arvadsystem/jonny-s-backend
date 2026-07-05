// Validador de payload para descuento por pedido.
// ------------------------------------------------
// QUE HACE:
// - Verifica contrato de entrada: id_sucursal, id_pedido, items.
// - Normaliza tipo de item y cantidad para consumo posterior.
//
// POR QUE SE SEPARA:
// - Mantiene la validacion aislada del flujo transaccional para facilitar mantenimiento.

export const ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  EXTRA: 'EXTRA',
  SALSA: 'SALSA'
});

export const toPositiveInt = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^0*[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const decimalPlaces = (value) => {
  const text = String(value).trim().toLowerCase();
  if (text.includes('e')) return null;
  const [, decimals = ''] = text.split('.');
  return decimals.length;
};

export const parseStrictPositiveQuantity = (value, {
  integer = false,
  max = null,
  maxDecimals = null
} = {}) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (integer && !Number.isSafeInteger(parsed)) return null;
  if (max !== null && parsed > max) return null;
  if (maxDecimals !== null) {
    const places = decimalPlaces(value);
    if (places === null || places > maxDecimals) return null;
  }
  return parsed;
};

export const normalizeItemType = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase();
  if (raw === ITEM_TYPES.PRODUCTO) return ITEM_TYPES.PRODUCTO;
  if (raw === ITEM_TYPES.RECETA) return ITEM_TYPES.RECETA;
  if (raw === ITEM_TYPES.EXTRA) return ITEM_TYPES.EXTRA;
  if (raw === ITEM_TYPES.SALSA) return ITEM_TYPES.SALSA;
  return null;
};

export const normalizePedidoPayload = (payload = {}) => {
  const errors = [];
  const idSucursal = toPositiveInt(payload?.id_sucursal);
  const idPedido = toPositiveInt(payload?.id_pedido);
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];

  if (!idSucursal) errors.push('id_sucursal es obligatorio y debe ser entero > 0.');
  if (!idPedido) errors.push('id_pedido es obligatorio y debe ser entero > 0.');
  if (rawItems.length === 0) errors.push('items debe incluir al menos un item.');

  const items = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const row = rawItems[index] && typeof rawItems[index] === 'object' ? rawItems[index] : {};
    const tipoItem = normalizeItemType(row.tipo_item);
    const cantidad = tipoItem === ITEM_TYPES.SALSA
      ? parseStrictPositiveQuantity(row.cantidad, { maxDecimals: 6 })
      : parseStrictPositiveQuantity(row.cantidad, { integer: true, max: 999 });

    if (!tipoItem) {
      errors.push(`items[${index}].tipo_item invalido. Use PRODUCTO, RECETA, EXTRA o SALSA.`);
      continue;
    }
    if (!cantidad) {
      errors.push(`items[${index}].cantidad invalida. Debe ser > 0.`);
      continue;
    }

    let idItem = null;
    if (tipoItem === ITEM_TYPES.PRODUCTO) {
      idItem = toPositiveInt(row.id_producto ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_producto es obligatorio para tipo PRODUCTO.`);
    }
    if (tipoItem === ITEM_TYPES.RECETA) {
      idItem = toPositiveInt(row.id_receta ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_receta es obligatorio para tipo RECETA.`);
    }
    if (tipoItem === ITEM_TYPES.EXTRA) {
      idItem = toPositiveInt(row.id_extra ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_extra es obligatorio para tipo EXTRA.`);
    }
    if (tipoItem === ITEM_TYPES.SALSA) {
      idItem = toPositiveInt(row.id_salsa ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_salsa es obligatorio para tipo SALSA.`);
      if (!toPositiveInt(row.id_insumo)) errors.push(`items[${index}].id_insumo es obligatorio para tipo SALSA.`);
      if (!toPositiveInt(row.id_almacen)) errors.push(`items[${index}].id_almacen es obligatorio para tipo SALSA.`);
    }

    if (idItem) {
      items.push({
        tipo_item: tipoItem,
        id_item: idItem,
        cantidad,
        id_detalle_pedido: toPositiveInt(row.id_detalle_pedido) || null,
        id_producto: tipoItem === ITEM_TYPES.PRODUCTO ? idItem : toPositiveInt(row.id_producto) || null,
        id_receta: tipoItem === ITEM_TYPES.RECETA ? idItem : toPositiveInt(row.id_receta) || null,
        id_extra: tipoItem === ITEM_TYPES.EXTRA ? idItem : toPositiveInt(row.id_extra) || null,
        id_salsa: tipoItem === ITEM_TYPES.SALSA ? idItem : toPositiveInt(row.id_salsa) || null,
        id_insumo: toPositiveInt(row.id_insumo) || null,
        id_almacen: toPositiveInt(row.id_almacen) || null,
        cant: parseStrictPositiveQuantity(row.cant ?? row.cantidad_insumo, { maxDecimals: 6 }) || null,
        id_unidad_medida: toPositiveInt(row.id_unidad_medida) || null,
        codigo: typeof row.codigo === 'string' ? row.codigo.trim() || null : null,
        nombre: typeof row.nombre === 'string' ? row.nombre.trim() || null : null
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      id_sucursal: idSucursal,
      id_pedido: idPedido,
      items
    }
  };
};

