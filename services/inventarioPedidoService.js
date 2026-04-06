import pool from '../config/db-connection.js';
import { normalizePedidoPayload, toPositiveInt } from './pedidoPayloadValidator.js';
import { resolvePedidoConsumo } from './pedidoConsumoResolver.js';
import { validarStockConBloqueo } from './inventarioStockValidator.js';
import { fetchExistingPedidoMovement, registrarMovimientosPedido } from './inventarioMovimientoService.js';

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
      insumoQtyMap: consumoResult.consumo.insumoQtyMap
    });

    // 3) Si existe cualquier faltante, rollback total (sin descuentos parciales).
    const faltantes = [
      ...(Array.isArray(consumoResult.faltantes) ? consumoResult.faltantes : []),
      ...(Array.isArray(stockResult.faltantes) ? stockResult.faltantes : [])
    ];

    if (faltantes.length > 0) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'STOCK_O_CONFIG_INSUFICIENTE',
        message: 'No se pudo descontar inventario porque faltan recursos o hay configuraciones incompletas.',
        id_pedido: idPedido,
        id_sucursal: idSucursal,
        faltantes
      };
    }

    // 4) Registrar movimientos de salida ligados al pedido.
    await registrarMovimientosPedido({
      client,
      idPedido,
      actorUserId,
      productoQtyMap: consumoResult.consumo.productoQtyMap,
      insumoQtyMap: consumoResult.consumo.insumoQtyMap,
      productosById: stockResult.lockedRows.productosById,
      insumosById: stockResult.lockedRows.insumosById
    });

    await client.query('COMMIT');

    return {
      ok: true,
      code: 'DESCUENTO_OK',
      message: 'Inventario descontado correctamente.',
      id_pedido: idPedido,
      id_sucursal: idSucursal,
      resumen: {
        productos_afectados: consumoResult.consumo.productoQtyMap.size,
        insumos_afectados: consumoResult.consumo.insumoQtyMap.size,
        movimientos_generados: consumoResult.consumo.productoQtyMap.size + consumoResult.consumo.insumoQtyMap.size
      }
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Si el rollback falla, se mantiene el error original.
    }
    throw error;
  } finally {
    client.release();
  }
};

