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

// public.movimientos_inventario.descripcion es varchar(150). Es un resumen de
// auditoria derivado -- la trazabilidad estructurada real vive en columnas propias
// (id_producto/id_insumo/id_detalle_pedido/origen_consumo/ref_origen/id_ref/
// id_pedido_trazabilidad/cantidad). Este limite NUNCA debe romper una venta.
const MOVEMENT_DESCRIPTION_MAX_LENGTH = 150;
// Referencia de precision: el esquema ya trabaja con numeric(18,6) para cantidades.
const AUDIT_NUMBER_DECIMALS = 6;

const createInventoryTraceError = (code, message, details = null) => {
  const error = new Error(message);
  error.httpStatus = 409;
  error.code = code;
  if (details) error.details = details;
  return error;
};

// Normaliza UNICAMENTE la representacion textual de un numero de auditoria (shortage
// requerido/disponible/faltante). Nunca se usa para el valor real que descuenta
// inventario (`movement.cantidad`), que sigue viniendo de normalizeTraceQuantity/la
// logica de consumo existente sin pasar por aqui.
//
// Redondea a 6 decimales (numeric(18,6) es la referencia del esquema) para eliminar
// ruido de punto flotante (0.30000000000000004 -> 0.300000) y despues usa la
// conversion numero->string de JS, que ya elimina ceros finales innecesarios
// (0.300000 -> 0.3) sin notacion cientifica en el rango de valores de inventario.
export const formatAuditQty = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const fixed = Number(numeric.toFixed(AUDIT_NUMBER_DECIMALS));
  return String(fixed);
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

// Defensa en profundidad en el limite del INSERT: buildInventoryMovementDescription
// ya garantiza <=150 por construccion (ver arriba), asi que esto nunca deberia
// activarse. Se conserva como red de seguridad final (no como mecanismo principal)
// por si algun futuro caller de insertMovimientosBatch construye `descripcion` sin
// pasar por ese helper.
const clampMovementDescriptionForInsert = (rawDescripcion) => {
  const trimmed = String(rawDescripcion || '').trim();
  if (!trimmed) return null;
  return trimmed.length > MOVEMENT_DESCRIPTION_MAX_LENGTH
    ? trimmed.slice(0, MOVEMENT_DESCRIPTION_MAX_LENGTH)
    : trimmed;
};

const insertMovimientosBatch = async (client, movements) => {
  const rows = Array.isArray(movements) ? movements : [];
  if (!rows.length) return 0;
  const values = [];
  const placeholders = rows.map((movement, rowIndex) => {
    const offset = rowIndex * 10;
    values.push(
      Number(movement.cantidad),
      Number(movement.id_almacen),
      movement.id_producto ? Number(movement.id_producto) : null,
      movement.id_insumo ? Number(movement.id_insumo) : null,
      Number(movement.id_detalle_pedido),
      movement.origen_consumo,
      movement.ref_origen || MOVEMENT_REF,
      Number(movement.id_ref),
      Number(movement.id_pedido_trazabilidad),
      clampMovementDescriptionForInsert(movement.descripcion)
    );
    return `('SALIDA', $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
  }).join(', ');

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
      VALUES ${placeholders}
    `,
    values
  );
  return rows.length;
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

const buildShortageAuditSegment = (shortage) => (
  shortage
    ? `req:${formatAuditQty(shortage.requerido)} disp:${formatAuditQty(shortage.disponible)} def:${formatAuditQty(shortage.faltante)}`
    : ''
);

const joinDescriptionSegments = (segments, separator) => segments.filter(Boolean).join(separator);

// Construye la descripcion de auditoria de un movimiento de inventario, garantizando
// por construccion que nunca exceda MOVEMENT_DESCRIPTION_MAX_LENGTH (150, el limite
// real de la columna). El formato compacto por defecto ya conserva id_pedido,
// id_detalle_pedido, tipo de recurso + su id, origen_consumo (para insumo), usuario y
// el shortage completo (requerido/disponible/faltante) cuando existe. Si ese formato
// completo excediera el limite (numeros/IDs extremos), se reduce de forma semantica y
// deterministica -- separadores mas densos, luego se omite lo mas decorativo primero
// (origen_consumo, despues usuario) -- nunca recortando IDs ni valores esenciales a la
// mitad. La red de seguridad final (recorte) es defensiva y, dado el presupuesto de
// caracteres de estos campos, no deberia alcanzarse nunca en la practica.
export const buildInventoryMovementDescription = ({
  pedidoId,
  tipoRecurso,
  resourceId,
  detalleId,
  origenConsumo,
  actorUserId,
  shortage = null
}) => {
  const resourceLabel = tipoRecurso === 'producto' ? 'prod' : 'ins';
  const shortageSegment = buildShortageAuditSegment(shortage);
  const origenSegment = tipoRecurso === 'insumo' ? String(origenConsumo || '') : '';
  const userSegment = toPositiveInt(actorUserId) ? `usr:${actorUserId}` : '';

  const build = (separator, { includeOrigen = true, includeUser = true } = {}) => joinDescriptionSegments([
    `Pedido #${pedidoId}`,
    `${resourceLabel}:${resourceId}`,
    `det:${detalleId}`,
    includeOrigen ? origenSegment : '',
    shortageSegment,
    includeUser ? userSegment : ''
  ], separator);

  const candidates = [
    () => build(' | '),
    () => build('|'),
    () => build('|', { includeOrigen: false }),
    () => build('|', { includeOrigen: false, includeUser: false })
  ];

  for (const candidate of candidates) {
    const description = candidate();
    if (description.length <= MOVEMENT_DESCRIPTION_MAX_LENGTH) return description;
  }

  // Defensa final: en teoria inalcanzable (la ultima variante solo contiene 3 IDs y
  // etiquetas cortas), pero se conserva por seguridad en vez de asumirlo.
  return build('|', { includeOrigen: false, includeUser: false }).slice(0, MOVEMENT_DESCRIPTION_MAX_LENGTH);
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
        descripcion: buildInventoryMovementDescription({
          pedidoId,
          tipoRecurso: 'producto',
          resourceId: inputProductId,
          detalleId: idDetallePedido,
          origenConsumo,
          actorUserId,
          shortage
        })
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
      descripcion: buildInventoryMovementDescription({
        pedidoId,
        tipoRecurso: 'insumo',
        resourceId: inputInsumoId,
        detalleId: idDetallePedido,
        origenConsumo,
        actorUserId,
        shortage
      })
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
  excludedInsumoIds = new Set(),
  perf = null
}) => {
  const buildStartedAt = perf?.now?.() || 0;
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
  perf?.add?.('inventario_movimientos_build_ms', buildStartedAt);

  const expectedMovementCount = [...productoQtyMap.keys()]
    .filter((id) => !excludedProductIds.has(Number(id))).length
    + [...insumoQtyMap.keys()].filter((id) => !excludedInsumoIds.has(Number(id))).length;

  if (expectedMovementCount > 0 && tracedRows.length === 0) {
    throw createInventoryTraceError(
      'PEDIDO_TRAZABILIDAD_SIN_FILAS',
      'No se permiten nuevas salidas de pedido sin trazabilidad por linea.'
    );
  }

  const insertStartedAt = perf?.now?.() || 0;
  const insertedCount = await insertMovimientosBatch(client, tracedRows);
  perf?.add?.('inventario_movimientos_insert_ms', insertStartedAt);
  perf?.inc?.('inventario_movimientos_count', insertedCount);

  return insertedCount;
};

