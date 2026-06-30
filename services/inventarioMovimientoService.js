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
      WHERE ref_origen = ANY($1::text[])
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
      WHERE ref_origen = ANY($1::text[])
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

const normalizeTraceQuantity = (value, code = 'PEDIDO_TRAZABILIDAD_CANTIDAD_INVALIDA') => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw createInventoryTraceError(
      code,
      'No se pudo construir inventario trazado con cantidad invalida.'
    );
  }
  return quantity;
};

const normalizeComparableQuantity = (value) => Number(Number(value || 0).toFixed(6));

const addQuantity = (target, key, quantity) => {
  target.set(key, normalizeComparableQuantity((target.get(key) || 0) + Number(quantity || 0)));
};

const totalsToArray = (totals) => [...totals.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, cantidad]) => ({ key, cantidad: normalizeComparableQuantity(cantidad) }));

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

const buildExpectedCanonicalTotals = ({
  productoQtyMap,
  insumoQtyMap,
  productosById,
  insumosById,
  excludedProductIds,
  excludedInsumoIds
}) => {
  const expected = new Map();
  for (const [inputProductId, rawQuantity] of productoQtyMap instanceof Map ? productoQtyMap.entries() : []) {
    const idProducto = toPositiveInt(inputProductId);
    if (!idProducto || excludedProductIds.has(idProducto)) continue;
    const quantity = normalizeTraceQuantity(rawQuantity);
    const rowProducto = productosById.get(idProducto);
    if (!rowProducto) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_PRODUCTO_NO_RESUELTO',
        'No se pudo resolver el producto del movimiento trazado.'
      );
    }
    addQuantity(expected, `producto:${resolveProductMovementId(rowProducto, idProducto)}`, quantity);
  }
  for (const [inputInsumoId, rawQuantity] of insumoQtyMap instanceof Map ? insumoQtyMap.entries() : []) {
    const idInsumo = toPositiveInt(inputInsumoId);
    if (!idInsumo || excludedInsumoIds.has(idInsumo)) continue;
    const quantity = normalizeTraceQuantity(rawQuantity);
    const rowInsumo = insumosById.get(idInsumo);
    if (!rowInsumo) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_INSUMO_NO_RESUELTO',
        'No se pudo resolver el insumo del movimiento trazado.'
      );
    }
    addQuantity(expected, `insumo:${resolveInsumoMovementId(rowInsumo, idInsumo)}`, quantity);
  }
  return expected;
};

const buildTracedCanonicalTotals = (validatedRows = []) => {
  const traced = new Map();
  for (const row of validatedRows) {
    if (row.idProducto) addQuantity(traced, `producto:${row.idProducto}`, row.cantidad);
    if (row.idInsumo) addQuantity(traced, `insumo:${row.idInsumo}`, row.cantidad);
  }
  return traced;
};

const validateExpectedVsTracedTotals = ({ expectedTotals, tracedTotals }) => {
  const missing = [];
  const unexpected = [];
  const mismatched = [];

  for (const [key, expected] of expectedTotals.entries()) {
    if (!tracedTotals.has(key)) {
      missing.push({ key, expected: normalizeComparableQuantity(expected) });
      continue;
    }
    const traced = tracedTotals.get(key);
    if (normalizeComparableQuantity(expected) !== normalizeComparableQuantity(traced)) {
      mismatched.push({
        key,
        expected: normalizeComparableQuantity(expected),
        traced: normalizeComparableQuantity(traced)
      });
    }
  }

  for (const [key, traced] of tracedTotals.entries()) {
    if (!expectedTotals.has(key)) {
      unexpected.push({ key, traced: normalizeComparableQuantity(traced) });
    }
  }

  if (missing.length || unexpected.length || mismatched.length) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_TOTALES_INCONSISTENTES',
      'Los movimientos trazados no coinciden con el consumo fisico calculado.',
      {
        expected: totalsToArray(expectedTotals),
        traced: totalsToArray(tracedTotals),
        missing,
        unexpected,
        mismatched
      }
    );
  }
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

const insertValidatedMovimiento = async (client, normalized) => {
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
    if (!['producto', 'insumo'].includes(tipoRecurso)) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_TIPO_RECURSO_INVALIDO',
        'El movimiento contiene un tipo_recurso no permitido.'
      );
    }
    const rawProductId = toPositiveInt(row?.id_producto);
    const rawInsumoId = toPositiveInt(row?.id_insumo);
    if (
      (tipoRecurso === 'producto' && (!rawProductId || rawInsumoId))
      || (tipoRecurso === 'insumo' && (!rawInsumoId || rawProductId))
    ) {
      throw createInventoryTraceError(
        'PEDIDO_TRAZABILIDAD_RECURSO_INVALIDO',
        'No se pudo construir inventario trazado sin un recurso unico valido.'
      );
    }
    const origenConsumo = normalizeOrigenConsumo(row?.origen_consumo);
    const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
    const quantity = normalizeTraceQuantity(row?.cantidad);
    if (tipoRecurso === 'producto' && excludedProductIds.has(rawProductId)) continue;
    if (tipoRecurso === 'insumo' && excludedInsumoIds.has(rawInsumoId)) continue;
    if (!idDetallePedido) {
      incompleteRows.push(row);
      continue;
    }

    if (tipoRecurso === 'producto') {
      const rowProducto = productosById.get(rawProductId);
      if (!rowProducto) {
        throw createInventoryTraceError(
          'PEDIDO_TRAZABILIDAD_PRODUCTO_NO_RESUELTO',
          'No se pudo resolver el producto del movimiento trazado.'
        );
      }
      const idProductoMovimiento = resolveProductMovementId(rowProducto, rawProductId);
      const key = [
        normalizedRefOrigen,
        idDetallePedido,
        'producto',
        idProductoMovimiento,
        Number(rowProducto.id_almacen),
        origenConsumo
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
        origen_consumo: origenConsumo
      };
      existing.cantidad += quantity;
      merged.set(key, existing);
    }

    if (tipoRecurso === 'insumo') {
      const rowInsumo = insumosById.get(rawInsumoId);
      if (!rowInsumo) {
        throw createInventoryTraceError(
          'PEDIDO_TRAZABILIDAD_INSUMO_NO_RESUELTO',
          'No se pudo resolver el insumo del movimiento trazado.'
        );
      }
      const idInsumoMovimiento = resolveInsumoMovementId(rowInsumo, rawInsumoId);
      const key = [
        normalizedRefOrigen,
        idDetallePedido,
        'insumo',
        idInsumoMovimiento,
        Number(rowInsumo.id_almacen),
        origenConsumo
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
        origen_consumo: origenConsumo
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
  if (hasPhysicalConsumption && lineMovementRows.length === 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_LINEA_INCOMPLETA',
      'El consumo fisico no produjo movimientos trazados.'
    );
  }
  const validatedRows = lineMovementRows.map(validateTracedPedidoMovement);
  if (hasPhysicalConsumption) {
    validateExpectedVsTracedTotals({
      expectedTotals: buildExpectedCanonicalTotals({
        productoQtyMap,
        insumoQtyMap,
        productosById,
        insumosById,
        excludedProductIds,
        excludedInsumoIds
      }),
      tracedTotals: buildTracedCanonicalTotals(validatedRows)
    });
  }
  for (const row of validatedRows) {
    await insertValidatedMovimiento(client, row);
  }
  return validatedRows.length;
};

