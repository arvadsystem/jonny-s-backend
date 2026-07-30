// Devolucion de inventario por reversion de venta, POR LINEA (Fase 3).
//
// Reemplaza el algoritmo global que sumaba cantidades revertidas/vendidas
// de TODO el pedido y aplicaba ese ratio a TODOS sus movimientos
// (services/ventasReversionService.js:buildPedidoMovementReturnRows,
// ahora eliminado). Ese algoritmo podia devolver inventario de un producto
// nunca seleccionado para reversion con solo reversar una unidad de otra
// linea del mismo pedido.
//
// Algoritmo nuevo, exigido por el ticket de Fase 3: para cada linea
// reversada, se localizan los movimientos ORIGINALES `SALIDA` de
// movimientos_inventario que pertenecen EXACTAMENTE a su
// id_detalle_pedido (v�a detalle_facturas_origen.id_detalle_pedido, ya
// resuelto en resolveFacturaLinesForUpdate). Nunca se infiere por nombre,
// producto, receta o posicion, y NUNCA se usa productos.id_almacen como
// respaldo: si una linea marcada para devolver inventario no tiene
// movimientos originales trazables, se aborta con
// VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED (rollback completo, sin REV,
// sin movimiento de caja, sin puntos, sin pedido cancelado).
import { parsePositiveInt } from '../utils/parseUtils.js';

const createReversionError = (status, code, message) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = message;
  return error;
};

// movimientos_inventario.cantidad es numeric(14,4) en las migraciones que
// lo pueblan (sql/2026-06-11_fase_3d_...): se redondea a 4 decimales, no a
// 2, para no perder precision en insumos fraccionarios (ej. gramos/onzas).
const roundQty = (value) => Number((Number(value) || 0).toFixed(4));

// Las SALIDAS originales ya llegan validadas por la politica central:
// solo PEDIDO y FALTANTE_COCINA son referencias compatibles.
const RETURN_REF_ORIGEN = 'REVERSION_VENTA_INVENTARIO';

/**
 * Suma cuanto ya se devolvio (ENTRADA de reversion) para ESTE movimiento
 * original especifico, identificado por id_movimiento_origen.
 * Bloquea primero las filas ENTRADA candidatas (FOR UPDATE) antes de
 * agregar, para que dos reversiones que tocaran el mismo movimiento nunca
 * puedan calcular su residuo con datos obsoletos.
 */
const resolveAlreadyReturnedForMovement = async (client, idMovimientoOrigen) => {
  await client.query(
    `
      SELECT id_movimiento
      FROM public.movimientos_inventario
      WHERE tipo = 'ENTRADA'
        AND ref_origen = $1
        AND id_movimiento_origen = $2
      ORDER BY id_movimiento
      FOR UPDATE
    `,
    [RETURN_REF_ORIGEN, idMovimientoOrigen]
  );

  const sumResult = await client.query(
    `
      SELECT COALESCE(SUM(cantidad), 0)::numeric(14,4) AS total
      FROM public.movimientos_inventario
      WHERE tipo = 'ENTRADA'
        AND ref_origen = $1
        AND id_movimiento_origen = $2
    `,
    [RETURN_REF_ORIGEN, idMovimientoOrigen]
  );
  return Number(sumResult.rows?.[0]?.total || 0);
};

/**
 * Devuelve el inventario de UNA linea de reversion (id_detalle_factura),
 * usando exclusivamente sus movimientos SALIDA originales por
 * id_detalle_pedido. No usa productos.id_almacen ni ningun otro respaldo
 * por nombre/receta/almacen general/primer-almacen-encontrado.
 *
 * cantidadAcumuladaReversada: cantidad total revertida de ESTA linea
 * (reversiones previas + esta operacion). cantidadOriginalVendida:
 * cantidad original vendida de la linea (detalle_facturas.cantidad).
 *
 * Si `line.requiereTrazabilidad` es true (linea PRODUCTO/RECETA) y no se
 * encuentra ningun movimiento original, aborta con
 * VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED -- el llamador debe dejar que
 * esto propague y provoque ROLLBACK completo de la transaccion.
 */
export const returnInventoryForReversionLine = async ({
  client,
  line,
  idReversion,
  codigoReversion,
  codigoVenta,
  idUsuario,
  cantidadAcumuladaReversada,
  cantidadOriginalVendida
}) => {
  const idDetallePedido = parsePositiveInt(line.id_detalle_pedido);
  if (!idDetallePedido) {
    if (line.requiereTrazabilidad) {
      throw createReversionError(
        409,
        'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED',
        'No existe trazabilidad suficiente para devolver el inventario de esta venta.'
      );
    }
    return { returned: false, reason: 'SIN_DETALLE_PEDIDO' };
  }

  const originals = Array.isArray(line.movimientosOriginales)
    ? line.movimientosOriginales
    : [];
  if (!line.devuelve_inventario) {
    return { returned: false, reason: line.motivo_no_devolucion || 'POLITICA_NO_DEVUELVE' };
  }
  if (!originals.length) {
    if (line.requiereTrazabilidad) {
      throw createReversionError(
        409,
        'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED',
        'No existe trazabilidad suficiente para devolver el inventario de esta venta.'
      );
    }
    return { returned: false, reason: 'SIN_MOVIMIENTOS_ORIGINALES' };
  }

  const soldQty = Number(cantidadOriginalVendida || 0);
  const accumulatedQty = Number(cantidadAcumuladaReversada || 0);
  if (!(soldQty > 0)) {
    throw createReversionError(
      409,
      'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED',
      'No existe trazabilidad suficiente para devolver el inventario de esta venta.'
    );
  }

  const completesLine = accumulatedQty >= soldQty;
  const inserted = [];

  for (const original of originals) {
    const originalQty = Number(original.cantidad || 0);
    if (originalQty <= 0) continue;

    const context = {
      idDetallePedido,
      idAlmacen: parsePositiveInt(original.id_almacen),
      idProducto: parsePositiveInt(original.id_producto),
      idInsumo: parsePositiveInt(original.id_insumo),
      origenConsumo: original.origen_consumo || null
    };
    if (!context.idAlmacen || (!context.idProducto && !context.idInsumo)) {
      // Movimiento original sin almacen o sin producto/insumo resoluble:
      // no hay a donde devolver de forma segura. Nunca se adivina.
      throw createReversionError(
        409,
        'VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED',
        'No existe trazabilidad suficiente para devolver el inventario de esta venta.'
      );
    }

    const idMovimientoOrigen = Number(original.id_movimiento);
    const yaDevuelto = await resolveAlreadyReturnedForMovement(client, idMovimientoOrigen);

    // Objetivo acumulado de devolucion para este movimiento original:
    // proporcional a la cantidad acumulada reversada de la linea, salvo
    // que esta operacion complete la linea, en cuyo caso el objetivo es el
    // remanente COMPLETO del movimiento original (evita residuos de
    // redondeo de inventario, tal como se exige para los montos).
    const objetivoAcumulado = completesLine
      ? originalQty
      : roundQty((originalQty * accumulatedQty) / soldQty);

    const remanente = roundQty(originalQty - yaDevuelto);
    let entradaActual = roundQty(objetivoAcumulado - yaDevuelto);
    entradaActual = Math.min(entradaActual, remanente);

    if (entradaActual <= 0) continue;

    // Nunca debe superar la salida original (invariante de idempotencia).
    if (roundQty(yaDevuelto + entradaActual) > roundQty(originalQty + 0.0001)) {
      throw createReversionError(
        500,
        'VENTAS_REVERSION_INVENTARIO_INCONSISTENCIA',
        'La devolucion de inventario calculada excede el movimiento original.'
      );
    }

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
          id_movimiento_origen,
          id_pedido_trazabilidad,
          descripcion
        )
        VALUES ('ENTRADA', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        entradaActual,
        context.idAlmacen,
        context.idProducto,
        context.idInsumo,
        idDetallePedido,
        context.origenConsumo,
        RETURN_REF_ORIGEN,
        idReversion,
        idMovimientoOrigen,
        parsePositiveInt(original.id_pedido_trazabilidad),
        `Entrada por reversión ${codigoReversion} de venta ${codigoVenta} (movimiento original #${original.id_movimiento}, usuario ${idUsuario || 'N/D'})`
      ]
    );

    inserted.push({
      id_movimiento_origen: idMovimientoOrigen,
      cantidad: entradaActual,
      id_insumo: context.idInsumo || null,
      id_almacen: context.idAlmacen || null
    });
  }

  return { returned: inserted.length > 0, movimientos: inserted };
};

/**
 * Orquesta la devolucion de inventario por movimiento original para TODAS
 * las lineas de una reversion. `reversedQtyMapBefore` es el mapa (ya
 * bloqueado) de cantidades reversadas ANTES de esta operacion; se usa
 * para calcular la cantidad acumulada real (antes + esta operacion) por
 * linea.
 */
export const returnInventoryForReversionLines = async ({
  client,
  reversionLines,
  idPedido,
  idReversion,
  codigoReversion,
  codigoVenta,
  idUsuario,
  reversedQtyMapBefore
}) => {
  const results = [];
  // Claves id_insumo:id_almacen ya devueltas por movimiento original en
  // esta operacion -- el llamador las excluye del respaldo de snapshots de
  // salsas para nunca devolver dos veces el mismo insumo.
  const returnedInsumoKeys = new Set();

  for (const line of reversionLines) {
    if (!line.requiereTrazabilidad && !parsePositiveInt(line.id_detalle_pedido)) continue;

    const previa = reversedQtyMapBefore.get(Number(line.id_detalle_factura));
    const cantidadAntes = Number(previa?.cantidad || 0);
    const cantidadAcumulada = cantidadAntes + Number(line.cantidad_revertida || 0);

    const result = await returnInventoryForReversionLine({
      client,
      line,
      idReversion,
      codigoReversion,
      codigoVenta,
      idUsuario,
      cantidadAcumuladaReversada: cantidadAcumulada,
      cantidadOriginalVendida: Number(line.cantidad_vendida || 0)
    });
    results.push({ id_detalle_factura: line.id_detalle_factura, ...result });

    for (const movimiento of result.movimientos || []) {
      if (movimiento.id_insumo && movimiento.id_almacen) {
        returnedInsumoKeys.add(`${movimiento.id_insumo}:${movimiento.id_almacen}`);
      }
    }
  }
  return { results, returnedInsumoKeys };
};

export { RETURN_REF_ORIGEN };
