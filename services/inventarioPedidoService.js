import pool from '../config/db-connection.js';
import { toPositiveInt } from './pedidoPayloadValidator.js';
import { buildPedidoConsumoPayload } from './pedidoInventoryPayloadService.js';
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

const PEDIDO_TRACE_UNIQUE_CONSTRAINTS = new Set([
  'ux_mov_inv_linea_salida_insumo',
  'ux_mov_inv_linea_salida_producto'
]);

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
  const idSucursal = toPositiveInt(payload?.id_sucursal);
  const idPedido = toPositiveInt(payload?.id_pedido);
  if (!idSucursal || !idPedido) {
    throw createPedidoInventoryError(
      'VALIDATION_ERROR',
      'id_sucursal e id_pedido son obligatorios y deben ser enteros > 0.',
      400
    );
  }
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
    const canonicalResult = await buildPedidoConsumoPayload(client, idPedido, idSucursal);
    if (!canonicalResult.ok) {
      const body = canonicalResult.body || {};
      throw createPedidoInventoryError(
        body.code || 'PEDIDO_CONSUMO_INVALIDO',
        body.message || 'No se pudo construir el consumo canonico del pedido.',
        Number(canonicalResult.status || 409),
        body.details || null
      );
    }
    const canonicalItems = canonicalResult.payload.items;

    // 1) Resolver consumo real desde el pedido persistido, no desde el payload externo.
    const consumoResult = await resolvePedidoConsumo({
      client,
      items: canonicalItems
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

    // 3) Construir filas esperadas y revisar idempotencia antes de responder faltantes.
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
    const operationalWarnings = Array.isArray(stockResult.advertencias)
      ? stockResult.advertencias
      : [];
    const configWarnings = allowIncompleteConfiguration ? configFaults : [];
    const warningDetails = [
      ...stockShortages,
      ...operationalWarnings,
      ...configWarnings
    ];

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

    if (stockShortages.length > 0 && !allowNegativeStock) {
      if (manageTransaction) await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'STOCK_O_CONFIG_INSUFICIENTE',
        message: 'No se pudo descontar inventario porque faltan recursos o hay configuraciones incompletas.',
        id_pedido: idPedido,
        id_sucursal: idSucursal,
        faltantes: stockShortages
      };
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
      if (error?.code === '23505' && PEDIDO_TRACE_UNIQUE_CONSTRAINTS.has(error?.constraint)) {
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

