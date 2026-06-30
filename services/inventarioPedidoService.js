import pool from '../config/db-connection.js';
import { normalizePedidoPayload, toPositiveInt } from './pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from './pedidoConsumoResolver.js';
import { validarStockConBloqueo } from './inventarioStockValidator.js';
import {
  MOVEMENT_REF,
  SHORTAGE_MOVEMENT_REF,
  analyzePedidoMovementState,
  buildLineMovementRows,
  fetchPedidoInventoryMovementsForUpdate,
  registrarMovimientosPedido
} from './inventarioMovimientoService.js';

// Orquestador de descuento por pedido (modulo INSUMOS).
// -----------------------------------------------------
// QUE HACE:
// - Coordina validacion de payload, resolucion de consumo, validacion de stock con locks y registro de movimientos.
//
// POR QUE ES IMPORTANTE:
// - Mantiene atomicidad: todo en una sola transaccion.
// - Mantiene consistencia: rollback total ante cualquier faltante/error.
// - Mantiene concurrencia segura: lock de filas de inventario antes del descuento.
// - Mantiene trazabilidad: movimientos con referencia explicita al pedido.

const ensureBranchExists = async (client, idSucursal) => {
  const rs = await client.query(
    `
      SELECT id_sucursal, nombre_sucursal, COALESCE(estado, true) AS estado
      FROM public.sucursales
      WHERE id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );
  if (!rs.rows.length) {
    const error = new Error('La sucursal enviada no existe.');
    error.httpStatus = 400;
    throw error;
  }
  if (!Boolean(rs.rows[0]?.estado)) {
    const error = new Error('La sucursal enviada esta inactiva.');
    error.httpStatus = 400;
    throw error;
  }
};

const createPedidoInventoryError = (code, message, status = 409, details = null) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  if (details) error.details = details;
  return error;
};

const lockPedidoForInventory = async (client, idPedido, idSucursal) => {
  const rs = await client.query(
    `
      SELECT
        id_pedido,
        id_sucursal,
        id_estado_pedido
      FROM public.pedidos
      WHERE id_pedido = $1
      FOR UPDATE
    `,
    [idPedido]
  );
  const pedido = rs.rows[0] || null;
  if (!pedido) {
    throw createPedidoInventoryError(
      'PEDIDO_NO_ENCONTRADO',
      `El pedido ${idPedido} no existe.`,
      404
    );
  }
  if (Number(pedido.id_sucursal) !== Number(idSucursal)) {
    throw createPedidoInventoryError(
      'PEDIDO_SUCURSAL_NO_COINCIDE',
      `El pedido ${idPedido} no pertenece a la sucursal ${idSucursal}.`
    );
  }
  return pedido;
};

const validatePedidoDetalleResources = async ({ client, idPedido, items }) => {
  const detailIds = [...new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => toPositiveInt(item?.id_detalle_pedido))
      .filter(Boolean)
  )];
  if (!detailIds.length) return;

  const detailsResult = await client.query(
    `
      SELECT id_detalle_pedido, id_pedido, id_producto, id_receta
      FROM public.detalle_pedido
      WHERE id_detalle_pedido = ANY($1::int[])
        AND COALESCE(estado, true) = true
      FOR UPDATE
    `,
    [detailIds]
  );
  const detailById = new Map(detailsResult.rows.map((row) => [Number(row.id_detalle_pedido), row]));

  const extrasResult = await client.query(
    `
      SELECT id_detalle_pedido, id_extra, id_insumo, id_almacen, origen_snapshot
      FROM public.detalle_pedido_extras
      WHERE id_detalle_pedido = ANY($1::int[])
        AND COALESCE(estado, true) = true
    `,
    [detailIds]
  );
  const extrasByDetail = new Map();
  for (const row of extrasResult.rows || []) {
    const idDetalle = Number(row.id_detalle_pedido);
    if (!extrasByDetail.has(idDetalle)) extrasByDetail.set(idDetalle, []);
    extrasByDetail.get(idDetalle).push(row);
  }

  for (const item of items) {
    const idDetalle = toPositiveInt(item?.id_detalle_pedido);
    if (!idDetalle) continue;

    const detail = detailById.get(idDetalle);
    if (!detail || Number(detail.id_pedido) !== Number(idPedido)) {
      throw createPedidoInventoryError(
        'PEDIDO_DETALLE_NO_PERTENECE',
        `La linea ${idDetalle} no pertenece al pedido ${idPedido}.`
      );
    }

    if (item.tipo_item === 'PRODUCTO') {
      if (Number(detail.id_producto || 0) !== Number(item.id_producto || item.id_item) || detail.id_receta !== null) {
        throw createPedidoInventoryError('PEDIDO_DETALLE_RECURSO_NO_COINCIDE', `La linea ${idDetalle} no corresponde al producto enviado.`);
      }
    }
    if (item.tipo_item === 'RECETA') {
      if (Number(detail.id_receta || 0) !== Number(item.id_receta || item.id_item) || detail.id_producto !== null) {
        throw createPedidoInventoryError('PEDIDO_DETALLE_RECURSO_NO_COINCIDE', `La linea ${idDetalle} no corresponde a la receta enviada.`);
      }
    }
    if (item.tipo_item === 'EXTRA') {
      const belongs = (extrasByDetail.get(idDetalle) || [])
        .some((row) => Number(row.id_extra || 0) === Number(item.id_extra || item.id_item));
      if (!belongs) {
        throw createPedidoInventoryError('PEDIDO_EXTRA_NO_PERTENECE_LINEA', `El extra enviado no pertenece a la linea ${idDetalle}.`);
      }
    }
    if (item.tipo_item === 'SALSA') {
      const belongs = (extrasByDetail.get(idDetalle) || [])
        .some((row) => {
          const snapshot = row.origen_snapshot && typeof row.origen_snapshot === 'object' ? row.origen_snapshot : {};
          const idSalsa = toPositiveInt(snapshot.id_salsa ?? snapshot.id_complemento ?? row.id_extra);
          const idInsumo = toPositiveInt(snapshot.id_insumo ?? row.id_insumo);
          const idAlmacen = toPositiveInt(snapshot.id_almacen ?? row.id_almacen);
          return idSalsa === Number(item.id_salsa || item.id_item)
            && idInsumo === Number(item.id_insumo)
            && idAlmacen === Number(item.id_almacen);
        });
      if (!belongs) {
        throw createPedidoInventoryError('PEDIDO_SALSA_NO_PERTENECE_LINEA', `La salsa enviada no pertenece a la linea ${idDetalle}.`);
      }
    }
  }
};

const normalizeExcludedIdSet = (value) => {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map((id) => Number(id)).filter((id) => id > 0));
  return new Set();
};

const filterQtyMap = (qtyMap, excludedIds) => {
  const result = new Map();
  for (const [id, qty] of qtyMap.entries()) {
    if (excludedIds.has(Number(id))) continue;
    result.set(id, qty);
  }
  return result;
};

const normalizePositiveIdSet = (value) => new Set(
  [...(value instanceof Set ? value : Array.isArray(value) ? value : [])]
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
);

const createPedidoMovementConflictError = ({ idPedido, movementState, cause }) => {
  const isComplete = movementState?.state === 'COMPLETE';
  const error = new Error(isComplete
    ? `El pedido ${idPedido} ya fue descontado en inventario.`
    : `El pedido ${idPedido} tiene movimientos de inventario parciales o inconsistentes.`);
  error.httpStatus = 409;
  error.code = isComplete ? 'PEDIDO_YA_DESCONTADO' : 'PEDIDO_INVENTARIO_PARCIAL_INCONSISTENTE';
  error.details = {
    id_movimiento: movementState?.id_movimiento || null,
    movimientos_esperados: movementState?.expectedCount || 0,
    movimientos_existentes: movementState?.existingCount || 0,
    faltantes: movementState?.missing?.length || 0,
    diferentes: movementState?.mismatched?.length || 0,
    inesperados: movementState?.unexpected?.length || 0,
    duplicados: movementState?.duplicates?.length || 0,
    invalidos: movementState?.invalidRows?.length || 0,
    constraint: cause?.constraint || null
  };
  return error;
};

export const validarYDescontarPedido = async (payload, options = {}) => {
  const normalized = normalizePedidoPayload(payload);
  if (!normalized.ok) {
    const error = new Error(normalized.errors[0] || 'Payload invalido.');
    error.httpStatus = 400;
    error.code = 'VALIDATION_ERROR';
    error.details = normalized.errors;
    throw error;
  }

  const { id_sucursal: idSucursal, id_pedido: idPedido, items } = normalized.value;
  const actorUserId = toPositiveInt(options?.id_usuario) || null;
  const allowNegativeStock = options?.allowNegativeStock === true;
  const allowCrossBranchWarehouse = options?.allowCrossBranchWarehouse === true;
  const allowIncompleteConfiguration = options?.allowIncompleteConfiguration === true;
  const shortageMode = String(options?.shortageMode || '').trim().toUpperCase();
  const movementRefForShortage = shortageMode === SHORTAGE_MOVEMENT_REF
    ? SHORTAGE_MOVEMENT_REF
    : MOVEMENT_REF;
  const externalClient = options?.dbClient || null;
  const strictInsumoIds = normalizePositiveIdSet(options?.strictInsumoIds);

  const client = externalClient || (await pool.connect());
  const manageTransaction = !externalClient;
  try {
    if (manageTransaction) await client.query('BEGIN');

    await lockPedidoForInventory(client, idPedido, idSucursal);
    await ensureBranchExists(client, idSucursal);
    await validatePedidoDetalleResources({ client, idPedido, items });

    // 1) Resolver consumo real desde items del pedido.
    const consumoResult = await resolvePedidoConsumo({
      client,
      items
    });

    // 2) Validar stock con locks de concurrencia.
    const stockResult = await validarStockConBloqueo({
      client,
      idSucursal,
      productoQtyMap: consumoResult.consumo.productoQtyMap,
      insumoQtyMap: consumoResult.consumo.insumoQtyMap,
      expectedInsumoWarehouseById: consumoResult.insumoWarehouseById,
      allowCrossBranchWarehouse
    });

    // 3) Si existe cualquier faltante, rollback total (sin descuentos parciales).
    const faltantes = [
      ...(Array.isArray(consumoResult.faltantes) ? consumoResult.faltantes : []),
      ...(Array.isArray(stockResult.faltantes) ? stockResult.faltantes : [])
    ];

    const configFaults = faltantes.filter(
      (item) => String(item?.motivo || '').trim().toUpperCase() !== 'STOCK_INSUFICIENTE'
    );
    const stockShortages = faltantes.filter(
      (item) => String(item?.motivo || '').trim().toUpperCase() === 'STOCK_INSUFICIENTE'
    );
    const strictConfigFaults = configFaults.filter((item) => strictInsumoIds.has(Number(item?.id_insumo || item?.id_recurso)));
    const strictStockShortages = stockShortages.filter((item) => strictInsumoIds.has(Number(item?.id_insumo || item?.id_recurso)));
    const operationalWarnings = Array.isArray(stockResult.advertencias)
      ? stockResult.advertencias
      : [];
    const configWarnings = allowIncompleteConfiguration ? configFaults : [];
    const warningDetails = [
      ...stockShortages,
      ...operationalWarnings,
      ...configWarnings
    ];

    if (strictConfigFaults.length > 0 || (configFaults.length > 0 && !allowIncompleteConfiguration)) {
      const blockingConfigFaults = strictConfigFaults.length > 0 ? strictConfigFaults : configFaults;
      const firstConfigFaultMessage = String(blockingConfigFaults[0]?.mensaje || '').trim();
      if (manageTransaction) await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'CONFIGURACION_INVENTARIO_INVALIDA',
        message: firstConfigFaultMessage || 'No se pudo descontar inventario por configuracion incompleta de productos/recetas/extras/insumos/almacen.',
        id_pedido: idPedido,
        id_sucursal: idSucursal,
        faltantes: blockingConfigFaults
      };
    }

    if (strictStockShortages.length > 0 || (stockShortages.length > 0 && !allowNegativeStock)) {
      const blockingStockShortages = strictStockShortages.length > 0 ? strictStockShortages : stockShortages;
      if (manageTransaction) await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'STOCK_O_CONFIG_INSUFICIENTE',
        message: 'No se pudo descontar inventario porque faltan recursos o hay configuraciones incompletas.',
        id_pedido: idPedido,
        id_sucursal: idSucursal,
        faltantes: blockingStockShortages
      };
    }

    const excludedProductIds = normalizeExcludedIdSet(stockResult.excludedResources?.productoIds);
    const excludedInsumoIds = normalizeExcludedIdSet(stockResult.excludedResources?.insumoIds);
    const movimientoProductoQtyMap = filterQtyMap(
      consumoResult.consumo.productoQtyMap,
      excludedProductIds
    );
    const movimientoInsumoQtyMap = filterQtyMap(
      consumoResult.consumo.insumoQtyMap,
      excludedInsumoIds
    );
    const shortagesByResource = new Map(
      stockShortages.map((item) => [`${item.tipo_recurso}:${item.id_recurso}`, item])
    );
    const expectedLineMovementRows = buildLineMovementRows({
      movementRows: consumoResult.consumo.movimientoRows,
      productosById: stockResult.lockedRows.productosById,
      insumosById: stockResult.lockedRows.insumosById,
      actorUserId,
      idPedido,
      refOrigen: stockShortages.length > 0 ? movementRefForShortage : MOVEMENT_REF,
      shortagesByResource,
      excludedProductIds,
      excludedInsumoIds
    });
    const existingMovementRows = await fetchPedidoInventoryMovementsForUpdate(client, idPedido);
    const movementState = analyzePedidoMovementState({
      expectedRows: expectedLineMovementRows,
      existingRows: existingMovementRows
    });
    if (movementState.state === 'COMPLETE') {
      throw createPedidoMovementConflictError({ idPedido, movementState });
    }
    if (movementState.state === 'PARTIAL') {
      throw createPedidoMovementConflictError({ idPedido, movementState });
    }

    // 4) Registrar movimientos de salida ligados al pedido.
    let generatedMovementCount = 0;
    await client.query('SAVEPOINT inventario_movimientos_insert');
    try {
      generatedMovementCount = await registrarMovimientosPedido({
        client,
        idPedido,
        actorUserId,
        productoQtyMap: movimientoProductoQtyMap,
        insumoQtyMap: movimientoInsumoQtyMap,
        productosById: stockResult.lockedRows.productosById,
        insumosById: stockResult.lockedRows.insumosById,
        insumoTraceById: consumoResult.insumoTraceById,
        movementRows: consumoResult.consumo.movimientoRows,
        refOrigen: stockShortages.length > 0 ? movementRefForShortage : MOVEMENT_REF,
        shortagesByResource,
        excludedProductIds,
        excludedInsumoIds
      });
      await client.query('RELEASE SAVEPOINT inventario_movimientos_insert');
    } catch (error) {
      if (error?.code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT inventario_movimientos_insert');
        const concurrentRows = await fetchPedidoInventoryMovementsForUpdate(client, idPedido);
        const concurrentState = analyzePedidoMovementState({
          expectedRows: expectedLineMovementRows,
          existingRows: concurrentRows
        });
        throw createPedidoMovementConflictError({ idPedido, movementState: concurrentState, cause: error });
      }
      throw error;
    }

    if (manageTransaction) await client.query('COMMIT');

    return {
      ok: true,
      code: 'DESCUENTO_OK',
      message: warningDetails.length > 0
        ? generatedMovementCount > 0
          ? 'Inventario descontado con advertencias operativas por consumo fisico en cocina.'
          : 'Pedido paso a preparacion con advertencias operativas; no se generaron movimientos para recursos no descontables.'
        : 'Inventario descontado correctamente.',
      id_pedido: idPedido,
      id_sucursal: idSucursal,
      warning: warningDetails.length > 0
        ? {
            code: 'STOCK_INSUFICIENTE_PERMITIDO',
            message: generatedMovementCount > 0
              ? 'Pedido paso a preparacion y el inventario se desconto con advertencias operativas.'
              : 'Pedido paso a preparacion con advertencias operativas de inventario.',
            faltantes: warningDetails
          }
        : null,
      resumen: {
        productos_afectados: movimientoProductoQtyMap.size,
        insumos_afectados: movimientoInsumoQtyMap.size,
        movimientos_generados: generatedMovementCount
      }
    };
  } catch (error) {
    try {
      if (manageTransaction) await client.query('ROLLBACK');
    } catch {
      // Si el rollback falla, se mantiene el error original.
    }
    throw error;
  } finally {
    if (manageTransaction) client.release();
  }
};

