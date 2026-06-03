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
  COMBO: 'COMBO',
  EXTRA: 'EXTRA'
});

export const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const toPositiveNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const normalizeItemType = (value) => {
  const raw = String(value || '').trim().toUpperCase();
  if (raw === ITEM_TYPES.PRODUCTO) return ITEM_TYPES.PRODUCTO;
  if (raw === ITEM_TYPES.RECETA) return ITEM_TYPES.RECETA;
  if (raw === ITEM_TYPES.COMBO) return ITEM_TYPES.COMBO;
  if (raw === ITEM_TYPES.EXTRA) return ITEM_TYPES.EXTRA;
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
    const cantidad = toPositiveNumber(row.cantidad);

    if (!tipoItem) {
      errors.push(`items[${index}].tipo_item invalido. Use PRODUCTO, RECETA, COMBO o EXTRA.`);
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
    if (tipoItem === ITEM_TYPES.COMBO) {
      idItem = toPositiveInt(row.id_combo ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_combo es obligatorio para tipo COMBO.`);
    }
    if (tipoItem === ITEM_TYPES.EXTRA) {
      idItem = toPositiveInt(row.id_extra ?? row.id_item_origen ?? row.id_item);
      if (!idItem) errors.push(`items[${index}].id_extra es obligatorio para tipo EXTRA.`);
    }

    if (idItem) {
      items.push({
        tipo_item: tipoItem,
        id_item: idItem,
        cantidad,
        id_detalle_pedido: toPositiveInt(row.id_detalle_pedido) || null,
        id_producto: tipoItem === ITEM_TYPES.PRODUCTO ? idItem : toPositiveInt(row.id_producto) || null,
        id_receta: tipoItem === ITEM_TYPES.RECETA ? idItem : toPositiveInt(row.id_receta) || null,
        id_combo: tipoItem === ITEM_TYPES.COMBO ? idItem : toPositiveInt(row.id_combo) || null,
        id_extra: tipoItem === ITEM_TYPES.EXTRA ? idItem : toPositiveInt(row.id_extra) || null
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

