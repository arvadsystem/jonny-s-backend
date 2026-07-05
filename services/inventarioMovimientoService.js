import { toPositiveInt } from './pedidoPayloadValidator.js';

// Servicio de movimientos de inventario para pedidos.
// ---------------------------------------------------
// QUE HACE:
// - Verifica idempotencia por pedido (evitar doble descuento).
// - Inserta movimientos SALIDA para productos/insumos.
//
// TRAZABILIDAD:
// - Se fija ref_origen='PEDIDO' y id_ref=id_pedido para auditar origen del descuento.

export const MOVEMENT_REF = 'PEDIDO';
export const SHORTAGE_MOVEMENT_REF = 'FALTANTE_COCINA';
const VALID_CONSUMPTION_ORIGINS = new Set(['PRODUCTO', 'RECETA', 'EXTRA', 'SALSA']);
const VALID_INSUMO_CONSUMPTION_ORIGINS = new Set(['RECETA', 'EXTRA', 'SALSA']);

const createInventoryTraceError = (code, message, details = null) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  if (details) error.details = details;
  return error;
};

export const normalizeOrigenConsumo = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!VALID_CONSUMPTION_ORIGINS.has(normalized)) {
    throw createInventoryTraceError(
      'ORIGEN_CONSUMO_INVALIDO',
      `origen_consumo invalido: ${normalized || 'N/D'}`
    );
  }
  return normalized;
};

const normalizeTraceQuantity = (value) => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA',
      'No se pudo construir inventario trazado con cantidad invalida.'
    );
  }
  return quantity;
};

const validateResourceOriginCompatibility = (tipoRecurso, origenConsumo) => {
  if (tipoRecurso === 'producto' && origenConsumo !== 'PRODUCTO') {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ORIGEN_INCOMPATIBLE',
      'Un producto solo puede usar origen_consumo PRODUCTO.'
    );
  }
  if (tipoRecurso === 'insumo' && !VALID_INSUMO_CONSUMPTION_ORIGINS.has(origenConsumo)) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ORIGEN_INCOMPATIBLE',
      'Un insumo solo puede usar origen_consumo RECETA, EXTRA o SALSA.'
    );
  }
};

export const fetchExistingPedidoMovement = async (client, idPedido) => {
  const rs = await client.query(
    `
      SELECT id_movimiento
      FROM public.movimientos_inventario
      WHERE ref_origen = ANY($1::text[])
        AND id_ref = $2
      LIMIT 1
    `,
    [[MOVEMENT_REF, SHORTAGE_MOVEMENT_REF], idPedido]
  );
  return rs.rows[0]?.id_movimiento ? Number(rs.rows[0].id_movimiento) : null;
};

const insertMovimiento = async (client, movement) => {
  await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        id_detalle_pedido,
        origen_consumo,
        ref_origen,
        id_ref,
        id_pedido_trazabilidad,
        descripcion
      )
      VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      Number(movement.cantidad),
      Number(movement.id_almacen),
      movement.id_producto ? Number(movement.id_producto) : null,
      movement.id_insumo ? Number(movement.id_insumo) : null,
      Number(movement.id_detalle_pedido),
      movement.origen_consumo,
      movement.ref_origen || MOVEMENT_REF,
      Number(movement.id_ref),
      Number(movement.id_pedido_trazabilidad),
      String(movement.descripcion || '').trim() || null
    ]
  );
};

const resolveProductMovementId = (rowProducto, inputProductId) => (
  toPositiveInt(rowProducto?.id_producto_maestro)
  || toPositiveInt(rowProducto?.id_producto)
  || toPositiveInt(inputProductId)
);

const resolveInsumoMovementId = (rowInsumo, inputInsumoId) => (
  toPositiveInt(rowInsumo?.id_insumo_maestro)
  || toPositiveInt(rowInsumo?.id_insumo)
  || toPositiveInt(inputInsumoId)
);

const addMergedMovementRow = (target, movement) => {
  const key = [
    movement.id_detalle_pedido,
    movement.origen_consumo,
    movement.id_almacen,
    movement.id_producto ? `producto:${movement.id_producto}` : `insumo:${movement.id_insumo}`
  ].join('|');
  const existing = target.get(key);
  if (!existing) {
    target.set(key, movement);
    return;
  }
  existing.cantidad = Number(existing.cantidad || 0) + Number(movement.cantidad || 0);
};

export const buildLineMovementRows = ({
  movementRows = [],
  productosById,
  insumosById,
  actorUserId,
  idPedido,
  refOrigen = MOVEMENT_REF,
  shortagesByResource = new Map(),
  excludedProductIds = new Set(),
  excludedInsumoIds = new Set()
}) => {
  const pedidoId = toPositiveInt(idPedido);
  if (!pedidoId) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ID_REF_INVALIDO',
      'No se pudo construir inventario trazado sin id_pedido valido.'
    );
  }

  const mergedRows = new Map();
  for (const row of Array.isArray(movementRows) ? movementRows : []) {
    const tipoRecurso = String(row?.tipo_recurso || '').trim().toLowerCase();
    if (!['producto', 'insumo'].includes(tipoRecurso)) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_TIPO_RECURSO_INVALIDO',
        'El movimiento contiene un tipo_recurso no permitido.'
      );
    }

    const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
    if (!idDetallePedido) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_DETALLE_INVALIDO',
        'No se permiten nuevas salidas de pedido sin id_detalle_pedido.'
      );
    }

    const origenConsumo = normalizeOrigenConsumo(row?.origen_consumo);
    validateResourceOriginCompatibility(tipoRecurso, origenConsumo);
    const quantity = normalizeTraceQuantity(row?.cantidad);

    if (tipoRecurso === 'producto') {
      const inputProductId = toPositiveInt(row?.id_producto);
      if (!inputProductId || excludedProductIds.has(inputProductId)) continue;
      const productRow = productosById.get(inputProductId);
      const idProducto = resolveProductMovementId(productRow, inputProductId);
      const idAlmacen = toPositiveInt(row?.id_almacen) || toPositiveInt(productRow?.id_almacen);
      if (!idProducto || !idAlmacen) {
        throw createInventoryTraceError(
          'PEDIDO_TRAZABILIDAD_PRODUCTO_NO_RESUELTO',
          'No se pudo resolver producto y almacen para el movimiento trazado.'
        );
      }
      const shortage = shortagesByResource.get(`producto:${inputProductId}`) || null;
      addMergedMovementRow(mergedRows, {
        cantidad: quantity,
        id_almacen: idAlmacen,
        id_producto: idProducto,
        id_insumo: null,
        id_detalle_pedido: idDetallePedido,
        origen_consumo: origenConsumo,
        id_ref: pedidoId,
        id_pedido_trazabilidad: pedidoId,
        ref_origen: refOrigen,
        descripcion: `Descuento por pedido #${pedidoId} (producto ${inputProductId}, detalle ${idDetallePedido})${shortage ? ` - faltante auditado req:${shortage.requerido} disp:${shortage.disponible} deficit:${shortage.faltante}` : ''}${toPositiveInt(actorUserId) ? ` - usuario ${actorUserId}` : ''}`
      });
      continue;
    }

    const inputInsumoId = toPositiveInt(row?.id_insumo);
    if (!inputInsumoId || excludedInsumoIds.has(inputInsumoId)) continue;
    const insumoRow = insumosById.get(inputInsumoId);
    const idInsumo = resolveInsumoMovementId(insumoRow, inputInsumoId);
    const idAlmacen = toPositiveInt(row?.id_almacen) || toPositiveInt(insumoRow?.id_almacen);
    if (!idInsumo || !idAlmacen) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_INSUMO_NO_RESUELTO',
        'No se pudo resolver insumo y almacen para el movimiento trazado.'
      );
    }
    const shortage = shortagesByResource.get(`insumo:${inputInsumoId}`) || null;
    addMergedMovementRow(mergedRows, {
      cantidad: quantity,
      id_almacen: idAlmacen,
      id_producto: null,
      id_insumo: idInsumo,
      id_detalle_pedido: idDetallePedido,
      origen_consumo: origenConsumo,
      id_ref: pedidoId,
      id_pedido_trazabilidad: pedidoId,
      ref_origen: refOrigen,
      descripcion: `Descuento por pedido #${pedidoId} (insumo ${inputInsumoId}, detalle ${idDetallePedido}, origen ${origenConsumo})${shortage ? ` - faltante auditado req:${shortage.requerido} disp:${shortage.disponible} deficit:${shortage.faltante}` : ''}${toPositiveInt(actorUserId) ? ` - usuario ${actorUserId}` : ''}`
    });
  }

  return [...mergedRows.values()].sort((left, right) => (
    left.id_detalle_pedido - right.id_detalle_pedido
    || String(left.origen_consumo).localeCompare(String(right.origen_consumo))
    || left.id_almacen - right.id_almacen
    || (left.id_producto || left.id_insumo) - (right.id_producto || right.id_insumo)
  ));
};

export const registrarMovimientosPedido = async ({
  client,
  idPedido,
  actorUserId,
  productoQtyMap,
  insumoQtyMap,
  productosById,
  insumosById,
  insumoTraceById = new Map(),
  movementRows = [],
  refOrigen = MOVEMENT_REF,
  shortagesByResource = new Map(),
  excludedProductIds = new Set(),
  excludedInsumoIds = new Set()
}) => {
  const tracedRows = buildLineMovementRows({
    movementRows,
    productosById,
    insumosById,
    actorUserId,
    idPedido,
    refOrigen,
    shortagesByResource,
    excludedProductIds,
    excludedInsumoIds
  });

  const expectedMovementCount = [...productoQtyMap.keys()]
    .filter((id) => !excludedProductIds.has(Number(id))).length
    + [...insumoQtyMap.keys()].filter((id) => !excludedInsumoIds.has(Number(id))).length;

  if (expectedMovementCount > 0 && tracedRows.length === 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_SIN_FILAS',
      'No se permiten nuevas salidas de pedido sin trazabilidad por linea.'
    );
  }

  for (const movement of tracedRows) {
    await insertMovimiento(client, movement);
  }

  return tracedRows.length;
};

