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
const VALID_MOVEMENT_REFS = new Set([MOVEMENT_REF, SHORTAGE_MOVEMENT_REF]);
export const LEGACY_ID_COLLISION_TOLERANCE_MINUTES = 5;

export const normalizePedidoTraceRefOrigen = (refOrigen) => {
  const normalized = String(refOrigen || MOVEMENT_REF).trim().toUpperCase();
  if (normalized === SHORTAGE_MOVEMENT_REF) return MOVEMENT_REF;
  return normalized || MOVEMENT_REF;
};

export const normalizePedidoMovementRefOrigenStrict = (refOrigen) => {
  const normalized = String(refOrigen ?? '').trim().toUpperCase();
  if (!VALID_MOVEMENT_REFS.has(normalized)) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_REF_ORIGEN_INVALIDO',
      'ref_origen invalido para movimiento trazado de pedido.'
    );
  }
  return normalized;
};

export const normalizeOrigenConsumo = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!VALID_CONSUMPTION_ORIGINS.has(normalized)) {
    const error = new Error(`origen_consumo invalido: ${normalized || 'N/D'}`);
    error.httpStatus = 409;
    error.code = 'ORIGEN_CONSUMO_INVALIDO';
    throw error;
  }
  return normalized;
};

export const fetchExistingPedidoMovement = async (client, idPedido) => {
  const rs = await client.query(
    `
      SELECT id_movimiento
      FROM public.movimientos_inventario
      WHERE UPPER(BTRIM(ref_origen::text)) = ANY($1::text[])
        AND id_ref = $2
      LIMIT 1
    `,
    [[MOVEMENT_REF, SHORTAGE_MOVEMENT_REF], idPedido]
  );
  return rs.rows[0]?.id_movimiento ? Number(rs.rows[0].id_movimiento) : null;
};

export const fetchPedidoInventoryMovementsForUpdate = async (client, idPedido) => {
  const rs = await client.query(
    `
      SELECT
        id_movimiento,
        fecha_mov,
        (EXTRACT(EPOCH FROM (fecha_mov AT TIME ZONE 'UTC')) * 1000)::bigint AS fecha_mov_epoch_ms,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        id_detalle_pedido,
        id_ref,
        id_pedido_trazabilidad,
        ref_origen,
        origen_consumo
      FROM public.movimientos_inventario
      WHERE UPPER(BTRIM(ref_origen::text)) = ANY($1::text[])
        AND id_ref = $2
        AND tipo = 'SALIDA'
      ORDER BY id_movimiento
      FOR UPDATE
    `,
    [[MOVEMENT_REF, SHORTAGE_MOVEMENT_REF], idPedido]
  );
  return rs.rows || [];
};

const toEpochMs = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const hasValidResourceShape = (row) => {
  const idProducto = toPositiveInt(row?.id_producto);
  const idInsumo = toPositiveInt(row?.id_insumo);
  return Boolean(idProducto) !== Boolean(idInsumo);
};

const hasTraceRequiredFields = (row) => (
  toPositiveInt(row?.id_movimiento)
  && toPositiveInt(row?.id_almacen)
  && hasValidResourceShape(row)
  && String(row?.origen_consumo || '').trim()
);

export const partitionPedidoInventoryMovements = ({ rows = [], context = {} } = {}) => {
  const idPedido = toPositiveInt(context?.idPedido);
  const pedidoMs = toEpochMs(context?.fechaHoraPedidoEpochMs);
  const toleranceMs = LEGACY_ID_COLLISION_TOLERANCE_MINUTES * 60 * 1000;
  const legacyCutoffMs = pedidoMs === null ? null : pedidoMs - toleranceMs;
  const detallePedidoIds = new Set(
    [...(context?.detallePedidoIds instanceof Set ? context.detallePedidoIds : Array.isArray(context?.detallePedidoIds) ? context.detallePedidoIds : [])]
      .map((id) => toPositiveInt(id))
      .filter(Boolean)
  );
  const result = {
    currentRows: [],
    currentTracedRows: [],
    currentLegacyRows: [],
    ignoredLegacyCollisionRows: [],
    invalidCurrentTraceRows: []
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    const idRef = toPositiveInt(row?.id_ref);
    const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
    const idPedidoTrazabilidad = toPositiveInt(row?.id_pedido_trazabilidad);
    const rowMs = toEpochMs(row?.fecha_mov_epoch_ms);
    const isLegacyShape = idRef === idPedido && !idDetallePedido && !idPedidoTrazabilidad;
    const isCurrentTraced = (
      idRef === idPedido
      && idPedidoTrazabilidad === idPedido
      && idDetallePedido
      && detallePedidoIds.has(idDetallePedido)
      && hasTraceRequiredFields(row)
    );

    if (isCurrentTraced) {
      result.currentTracedRows.push(row);
      result.currentRows.push(row);
      continue;
    }

    if (isLegacyShape) {
      if (rowMs === null || legacyCutoffMs === null) {
        result.invalidCurrentTraceRows.push(row);
        continue;
      }
      if (rowMs < legacyCutoffMs) {
        result.ignoredLegacyCollisionRows.push(row);
        continue;
      }
      result.currentLegacyRows.push(row);
      result.currentRows.push(row);
      continue;
    }

    result.invalidCurrentTraceRows.push(row);
  }

  return result;
};

const resourceKeyForMovement = (row) => {
  const idProducto = toPositiveInt(row?.id_producto);
  const idInsumo = toPositiveInt(row?.id_insumo);
  if (idProducto && idInsumo) return null;
  if (idProducto) return `producto:${idProducto}`;
  if (idInsumo) return `insumo:${idInsumo}`;
  return null;
};

const createInventoryTraceError = (code, message, details = null) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  if (details) error.details = details;
  return error;
};

const movementIdentityKey = (row) => [
  toPositiveInt(row?.id_detalle_pedido) || 0,
  normalizePedidoTraceRefOrigen(row?.ref_origen),
  normalizeOrigenConsumo(row?.origen_consumo),
  Number(row?.id_almacen || 0),
  resourceKeyForMovement(row)
].join('|');

export const analyzePedidoMovementState = ({ expectedRows = [], existingRows = [] } = {}) => {
  const expected = new Map();
  for (const row of Array.isArray(expectedRows) ? expectedRows : []) {
    const key = movementIdentityKey(row);
    expected.set(key, { ...row, cantidad: Number(row.cantidad || 0) });
  }

  const existing = new Map();
  const duplicates = new Set();
  const invalidRows = [];
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const idRef = toPositiveInt(row?.id_ref);
    const idPedidoTrazabilidad = toPositiveInt(row?.id_pedido_trazabilidad);
    const idProducto = toPositiveInt(row?.id_producto);
    const idInsumo = toPositiveInt(row?.id_insumo);
    if (
      !toPositiveInt(row?.id_detalle_pedido) ||
      !String(row?.origen_consumo || '').trim() ||
      !idRef ||
      !idPedidoTrazabilidad ||
      idPedidoTrazabilidad !== idRef ||
      (idProducto && idInsumo) ||
      (!idProducto && !idInsumo)
    ) {
      invalidRows.push(row);
      continue;
    }
    const key = movementIdentityKey(row);
    if (existing.has(key)) duplicates.add(key);
    existing.set(key, { ...row, cantidad: Number(row.cantidad || 0) });
  }

  if (existing.size === 0 && invalidRows.length === 0) {
    return { state: 'NONE', expectedCount: expected.size, existingCount: 0 };
  }

  const missing = [];
  const mismatched = [];
  for (const [key, row] of expected.entries()) {
    const found = existing.get(key);
    if (!found) {
      missing.push(row);
      continue;
    }
    if (Number(found.cantidad || 0).toFixed(6) !== Number(row.cantidad || 0).toFixed(6)) {
      mismatched.push({ expected: row, existing: found });
    }
  }

  const unexpected = [...existing.entries()]
    .filter(([key]) => !expected.has(key))
    .map(([, row]) => row);

  if (!missing.length && !mismatched.length && !unexpected.length && duplicates.size === 0 && invalidRows.length === 0) {
    return {
      state: 'COMPLETE',
      id_movimiento: Number(existing.values().next().value?.id_movimiento || 0) || null,
      expectedCount: expected.size,
      existingCount: existing.size
    };
  }

  return {
    state: 'PARTIAL',
    expectedCount: expected.size,
    existingCount: existing.size,
    missing,
    mismatched,
    unexpected,
    duplicates: [...duplicates],
    invalidRows
  };
};

export const validateTracedPedidoMovement = (movement) => {
  const idRef = toPositiveInt(movement?.id_ref);
  if (!idRef) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ID_REF_INVALIDO',
      'No se pudo registrar inventario trazado sin id_ref de pedido valido.'
    );
  }
  const idPedidoTrazabilidad = toPositiveInt(movement?.id_pedido_trazabilidad);
  if (idPedidoTrazabilidad !== idRef) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ID_REF_INVALIDO',
      'No se pudo registrar inventario trazado sin id_pedido_trazabilidad consistente.'
    );
  }
  const idDetallePedido = toPositiveInt(movement?.id_detalle_pedido);
  if (!idDetallePedido) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_DETALLE_INVALIDO',
      'No se pudo registrar inventario trazado sin id_detalle_pedido valido.'
    );
  }
  const idAlmacen = toPositiveInt(movement?.id_almacen);
  if (!idAlmacen) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_ALMACEN_INVALIDO',
      'No se pudo registrar inventario trazado sin id_almacen valido.'
    );
  }
  const cantidad = Number(movement?.cantidad);
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA',
      'No se pudo registrar inventario trazado con cantidad invalida.'
    );
  }
  const idProducto = toPositiveInt(movement?.id_producto);
  const idInsumo = toPositiveInt(movement?.id_insumo);
  if (Boolean(idProducto) === Boolean(idInsumo)) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO',
      'No se pudo registrar inventario trazado sin un recurso unico valido.'
    );
  }
  const origenConsumo = normalizeOrigenConsumo(movement?.origen_consumo);
  const refOrigen = normalizePedidoMovementRefOrigenStrict(movement?.ref_origen);
  return {
    cantidad,
    idAlmacen,
    idProducto,
    idInsumo,
    idDetallePedido,
    origenConsumo,
    refOrigen,
    idRef,
    idPedidoTrazabilidad,
    descripcion: String(movement.descripcion || '').trim() || null
  };
};

const insertMovimiento = async (client, movement) => {
  const normalized = validateTracedPedidoMovement(movement);
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
      normalized.cantidad,
      normalized.idAlmacen,
      normalized.idProducto || null,
      normalized.idInsumo || null,
      normalized.idDetallePedido,
      normalized.origenConsumo,
      normalized.refOrigen,
      normalized.idRef,
      normalized.idPedidoTrazabilidad,
      normalized.descripcion
    ]
  );
};

export const buildLineMovementRows = ({
  movementRows = [],
  productosById,
  insumosById,
  actorUserId,
  idPedido,
  refOrigen = MOVEMENT_REF,
  shortagesByResource,
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
  const normalizedRefOrigen = normalizePedidoMovementRefOrigenStrict(refOrigen);
  const merged = new Map();
  const incompleteRows = [];
  for (const row of Array.isArray(movementRows) ? movementRows : []) {
    const tipoRecurso = String(row?.tipo_recurso || '').trim().toLowerCase();
    const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
    const quantity = Number(row?.cantidad || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA',
        'No se pudo construir inventario trazado con cantidad invalida.'
      );
    }
    if (tipoRecurso === 'producto' && excludedProductIds.has(Number(row.id_producto || 0))) continue;
    if (tipoRecurso === 'insumo' && excludedInsumoIds.has(Number(row.id_insumo || 0))) continue;
    if (!idDetallePedido) {
      incompleteRows.push(row);
      continue;
    }

    if (tipoRecurso === 'producto') {
      const rowProducto = productosById.get(Number(row.id_producto || 0));
      if (!rowProducto) continue;
      const idProductoMovimiento = toPositiveInt(rowProducto?.id_producto_maestro) || toPositiveInt(rowProducto?.id_producto) || toPositiveInt(row.id_producto);
      const key = [
        normalizedRefOrigen,
        idDetallePedido,
        'producto',
        idProductoMovimiento,
        Number(rowProducto.id_almacen),
        normalizeOrigenConsumo(row.origen_consumo || 'PRODUCTO')
      ].join(':');
      const existing = merged.get(key) || {
        cantidad: 0,
        id_almacen: Number(rowProducto.id_almacen),
        id_producto: idProductoMovimiento,
        id_insumo: null,
        id_detalle_pedido: idDetallePedido,
        id_ref: pedidoId,
        id_pedido_trazabilidad: pedidoId,
        ref_origen: normalizedRefOrigen,
        origen_consumo: normalizeOrigenConsumo(row.origen_consumo || 'PRODUCTO')
      };
      existing.cantidad += quantity;
      merged.set(key, existing);
    }

    if (tipoRecurso === 'insumo') {
      const rowInsumo = insumosById.get(Number(row.id_insumo || 0));
      if (!rowInsumo) continue;
      const idInsumoMovimiento = toPositiveInt(rowInsumo?.id_insumo_maestro) || toPositiveInt(rowInsumo?.id_insumo) || toPositiveInt(row.id_insumo);
      const key = [
        normalizedRefOrigen,
        idDetallePedido,
        'insumo',
        idInsumoMovimiento,
        Number(rowInsumo.id_almacen),
        normalizeOrigenConsumo(row.origen_consumo || 'RECETA')
      ].join(':');
      const existing = merged.get(key) || {
        cantidad: 0,
        id_almacen: Number(rowInsumo.id_almacen),
        id_producto: null,
        id_insumo: idInsumoMovimiento,
        id_detalle_pedido: idDetallePedido,
        id_ref: pedidoId,
        id_pedido_trazabilidad: pedidoId,
        ref_origen: normalizedRefOrigen,
        origen_consumo: normalizeOrigenConsumo(row.origen_consumo || 'RECETA')
      };
      existing.cantidad += quantity;
      merged.set(key, existing);
    }
  }
  if (incompleteRows.length > 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA',
      'No se puede descontar inventario parcialmente: hay consumos fisicos sin id_detalle_pedido.',
      { filas_sin_trazabilidad: incompleteRows.length }
    );
  }

  return [...merged.values()]
    .sort((left, right) => (
      Number(left.id_detalle_pedido) - Number(right.id_detalle_pedido)
      || String(left.origen_consumo).localeCompare(String(right.origen_consumo))
      || Number(left.id_producto || left.id_insumo || 0) - Number(right.id_producto || right.id_insumo || 0)
    ))
    .map((row) => {
      const resourceKey = row.id_producto ? `producto:${row.id_producto}` : `insumo:${row.id_insumo}`;
      const shortage = shortagesByResource.get(resourceKey) || null;
      return {
        ...row,
        id_ref: pedidoId,
        descripcion: `Descuento por pedido #${pedidoId} linea #${row.id_detalle_pedido} (${row.id_producto ? `producto ${row.id_producto}` : `insumo ${row.id_insumo}`}; origen ${row.origen_consumo})${shortage ? ` - faltante auditado req:${shortage.requerido} disp:${shortage.disponible} deficit:${shortage.faltante}` : ''}${toPositiveInt(actorUserId) ? ` - usuario ${actorUserId}` : ''}`
      };
    });
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
  const hasPositiveQuantity = (qtyMap) => [...(qtyMap instanceof Map ? qtyMap.values() : [])]
    .some((quantity) => Number.isFinite(Number(quantity)) && Number(quantity) > 0);
  const hasPhysicalConsumption = hasPositiveQuantity(productoQtyMap) || hasPositiveQuantity(insumoQtyMap);
  if (!Array.isArray(movementRows) || movementRows.length === 0) {
    if (!hasPhysicalConsumption) return 0;
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA',
      'No se pueden registrar movimientos de pedido sin trazabilidad por linea.'
    );
  }
  const lineMovementRows = buildLineMovementRows({
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
  for (const row of lineMovementRows) {
    await insertMovimiento(client, row);
  }
  return lineMovementRows.length;
};

