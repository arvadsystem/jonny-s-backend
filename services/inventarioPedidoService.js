import pool from '../config/db-connection.js';
import { normalizePedidoPayload, toPositiveInt } from './pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from './pedidoConsumoResolver.js';
import { validarStockConBloqueo } from './inventarioStockValidator.js';
import {
  MOVEMENT_REF,
  SHORTAGE_MOVEMENT_REF,
  fetchExistingPedidoMovement,
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

  const client = externalClient || (await pool.connect());
  const manageTransaction = !externalClient;
  try {
    if (manageTransaction) await client.query('BEGIN');

    await ensureBranchExists(client, idSucursal);

    const alreadyProcessedMovementId = await fetchExistingPedidoMovement(client, idPedido);
    if (alreadyProcessedMovementId) {
      const error = new Error(`El pedido ${idPedido} ya fue descontado en inventario.`);
      error.httpStatus = 409;
      error.code = 'PEDIDO_YA_DESCONTADO';
      error.details = { id_movimiento: alreadyProcessedMovementId };
      throw error;
    }

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
    const operationalWarnings = Array.isArray(stockResult.advertencias)
      ? stockResult.advertencias
      : [];
    const configWarnings = allowIncompleteConfiguration ? configFaults : [];
    const warningDetails = [
      ...stockShortages,
      ...operationalWarnings,
      ...configWarnings
    ];

    if (configFaults.length > 0 && !allowIncompleteConfiguration) {
      const firstConfigFaultMessage = String(configFaults[0]?.mensaje || '').trim();
      if (manageTransaction) await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'CONFIGURACION_INVENTARIO_INVALIDA',
        message: firstConfigFaultMessage || 'No se pudo descontar inventario por configuracion incompleta de productos/recetas/combos/extras/insumos/almacen.',
        id_pedido: idPedido,
        id_sucursal: idSucursal,
        faltantes: configFaults
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
    const generatedMovementCount = movimientoProductoQtyMap.size + movimientoInsumoQtyMap.size;
    const shortagesByResource = new Map(
      stockShortages.map((item) => [`${item.tipo_recurso}:${item.id_recurso}`, item])
    );

    // 4) Registrar movimientos de salida ligados al pedido.
    await registrarMovimientosPedido({
      client,
      idPedido,
      actorUserId,
      productoQtyMap: movimientoProductoQtyMap,
      insumoQtyMap: movimientoInsumoQtyMap,
      productosById: stockResult.lockedRows.productosById,
      insumosById: stockResult.lockedRows.insumosById,
      refOrigen: stockShortages.length > 0 ? movementRefForShortage : MOVEMENT_REF,
      shortagesByResource
    });

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

