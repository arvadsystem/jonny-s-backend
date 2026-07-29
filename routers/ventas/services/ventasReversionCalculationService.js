// Calculo puro/consulta de lineas de reversion de venta (Fase 2): parseo y
// consolidacion segura del payload, resolucion de lineas de factura,
// cantidades ya reversadas, prorrateo monetario y resultado acumulado.
// No abre transacciones ni hace INSERT/UPDATE: recibe siempre un `client`
// ya posicionado dentro de la transaccion del llamador (o de un preview de
// solo lectura).
import { parsePositiveInt } from '../utils/parseUtils.js';
import { roundMoney } from '../utils/moneyUtils.js';

const MAX_REVERSION_LINEAS = 200;

export const createReversionError = (status, code, message) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Valida y consolida el arreglo `lineas` de una reversion parcial.
 *
 * Rechaza explicitamente: no-arreglo, arreglo vacio, mas de
 * MAX_REVERSION_LINEAS entradas, entradas que no sean objetos planos
 * (arreglos/null/primitivos), id_detalle_factura o cantidad que no sean
 * enteros positivos seguros (decimales, cero, negativos, NaN, Infinity,
 * texto parcialmente numerico, arreglos, objetos quedan cubiertos por
 * parsePositiveInt, que exige `typeof === 'number' | 'string'` y un patron
 * entero exacto). Los duplicados de la misma id_detalle_factura se
 * consolidan sumando cantidades, verificando que la suma siga siendo un
 * entero seguro antes de aceptarla (evita overflow silencioso).
 */
export const buildRequestedLines = (lineas) => {
  if (!Array.isArray(lineas)) {
    throw createReversionError(400, 'VENTAS_REVERSION_LINEAS_FORMATO_INVALIDO', 'lineas debe ser un arreglo.');
  }
  if (lineas.length === 0) {
    throw createReversionError(400, 'VENTAS_REVERSION_LINEAS_REQUERIDAS', 'Debe enviar líneas para reversión parcial.');
  }
  if (lineas.length > MAX_REVERSION_LINEAS) {
    throw createReversionError(400, 'VENTAS_REVERSION_LINEAS_EXCEDE_MAXIMO', `No se permiten más de ${MAX_REVERSION_LINEAS} líneas por solicitud.`);
  }

  const byDetail = new Map();

  for (const row of lineas) {
    if (!isPlainObject(row)) {
      throw createReversionError(400, 'VENTAS_REVERSION_LINEA_INVALIDA', 'Cada línea debe ser un objeto válido.');
    }

    const idDetalle = parsePositiveInt(row.id_detalle_factura);
    if (!idDetalle) {
      throw createReversionError(400, 'VENTAS_REVERSION_LINEA_INVALIDA', 'Cada línea debe incluir id_detalle_factura entero positivo.');
    }

    const cantidad = parsePositiveInt(row.cantidad);
    if (!cantidad) {
      throw createReversionError(400, 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA', 'cantidad debe ser un entero positivo.');
    }

    const prev = byDetail.get(idDetalle) || 0;
    const next = prev + cantidad;
    if (!Number.isSafeInteger(next)) {
      throw createReversionError(400, 'VENTAS_REVERSION_CANTIDAD_OVERFLOW', 'La cantidad consolidada de la línea excede el máximo permitido.');
    }
    byDetail.set(idDetalle, next);
  }

  return byDetail;
};

export const resolveFacturaLinesForUpdate = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT
        df.id_detalle_factura,
        COALESCE(dfo.id_producto, df.id_producto) AS id_producto,
        COALESCE(dfo.id_receta, df.id_receta::int) AS id_receta,
        COALESCE(dfo.id_detalle_pedido, df.id_detalle_pedido::int) AS id_detalle_pedido,
        COALESCE(dfo.origen_snapshot, df.origen_snapshot) AS origen_snapshot,
        COALESCE(df.cantidad, 0)::int AS cantidad_vendida,
        COALESCE(df.precio_unitario, 0)::numeric(12,2) AS precio_unitario,
        COALESCE(df.sub_total, 0)::numeric(12,2) AS sub_total,
        COALESCE(df.total_detalle, 0)::numeric(12,2) AS total_detalle,
        COALESCE((SELECT d.monto_descuento FROM public.descuentos d WHERE d.id_descuento = df.id_descuento), 0)::numeric(12,2) AS descuento_linea,
        -- ISV: ver hallazgo de Fase 2 (documentado tambien en el reporte).
        -- routers/ventas.js:4778 fija la constante isv en cero de forma
        -- incondicional en el calculo de totales de TODA venta nueva
        -- (registrar_venta_pos_v1/v2/v3), y facturas.isv_15/isv_18 siempre
        -- se insertan como 0 (routers/ventas.js:9305-9306,10231-10232).
        -- No existe en today ninguna venta con ISV real persistido en
        -- ningun lado (ni columna de detalle, ni snapshot JSON, ni cabecera
        -- de factura) de la cual leer un porcentaje historico. Por lo
        -- tanto este 0::numeric NO es un valor inventado: refleja
        -- fielmente que el sistema completo cobra ISV=0 hoy. Si en el
        -- futuro se activa ISV real, este punto debe leer el porcentaje
        -- persistido en el momento de la venta (nunca la configuracion
        -- fiscal actual de la sucursal).
        0::numeric(6,2) AS isv_porcentaje,
        CASE
          WHEN NULLIF(TRIM(dfo.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(dfo.tipo_item))
          WHEN NULLIF(TRIM(df.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(df.tipo_item))
          WHEN df.id_producto IS NOT NULL THEN 'PRODUCTO'
          ELSE 'ITEM'
        END AS tipo_item,
        CASE
          WHEN UPPER(
            COALESCE(
              NULLIF(TRIM(dfo.tipo_item), ''),
              NULLIF(TRIM(df.tipo_item), ''),
              CASE WHEN COALESCE(dfo.id_producto, df.id_producto) IS NOT NULL THEN 'PRODUCTO' ELSE 'ITEM' END
            )
          ) = 'PRODUCTO'
            AND COALESCE(dfo.id_producto, df.id_producto) IS NOT NULL THEN true
          ELSE false
        END AS devuelve_inventario
      FROM public.detalle_facturas df
      LEFT JOIN public.detalle_facturas_origen dfo
        ON dfo.id_detalle_factura = df.id_detalle_factura
      WHERE df.id_factura = $1
      ORDER BY df.id_detalle_factura
      FOR UPDATE OF df`,
    [idFactura]
  );

  if (!result.rowCount) {
    throw createReversionError(409, 'VENTAS_REVERSION_FACTURA_SIN_DETALLE', 'La factura no tiene detalle para reversar.');
  }

  return result.rows;
};

const EMPTY_REVERSED_AMOUNTS = Object.freeze({
  cantidad: 0,
  subtotal: 0,
  descuento: 0,
  isv_15: 0,
  isv_18: 0,
  total: 0
});

/**
 * Bloquea (FOR UPDATE) las cabeceras de reversiones APLICADA de esta
 * factura antes de agregar sus cantidades/montos revertidos, para que
 * ninguna transaccion concurrente pueda alterar su estado mientras se
 * calculan los saldos reversables de esta operacion. La serializacion
 * primaria ya viene del `SELECT ... FOR UPDATE` sobre la propia factura
 * (tomado antes que esto en el flujo de creacion); este lock es una capa
 * adicional explicita sobre las reversiones anteriores en si.
 *
 * Devuelve, por id_detalle_factura, tanto la cantidad ya revertida como
 * los montos ya revertidos (subtotal/descuento/isv_15/isv_18/total) --
 * necesarios para que la ultima reversion que completa una linea absorba
 * exactamente el residuo restante en vez de volver a prorratear desde el
 * valor original (ver ajusteResiduoMonetario en resolveReversionLines).
 */
export const resolveAlreadyReversedQty = async (client, idFactura) => {
  await client.query(
    `
      SELECT id_reversion
      FROM public.facturas_reversiones
      WHERE id_factura_original = $1
        AND UPPER(TRIM(COALESCE(estado, ''))) = 'APLICADA'
      ORDER BY id_reversion
      FOR UPDATE
    `,
    [idFactura]
  );

  const result = await client.query(
    `
      SELECT
        rd.id_detalle_factura,
        COALESCE(SUM(rd.cantidad_revertida), 0)::numeric AS cantidad_revertida,
        COALESCE(SUM(rd.subtotal_revertido), 0)::numeric(12,2) AS subtotal_revertido,
        COALESCE(SUM(rd.descuento_revertido), 0)::numeric(12,2) AS descuento_revertido,
        COALESCE(SUM(rd.isv_15_revertido), 0)::numeric(12,2) AS isv_15_revertido,
        COALESCE(SUM(rd.isv_18_revertido), 0)::numeric(12,2) AS isv_18_revertido,
        COALESCE(SUM(rd.total_revertido), 0)::numeric(12,2) AS total_revertido
      FROM public.facturas_reversiones fr
      INNER JOIN public.facturas_reversiones_detalle rd ON rd.id_reversion = fr.id_reversion
      WHERE fr.id_factura_original = $1
        AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
      GROUP BY rd.id_detalle_factura
    `,
    [idFactura]
  );

  const map = new Map();
  for (const row of result.rows) {
    map.set(Number(row.id_detalle_factura), {
      cantidad: Number(row.cantidad_revertida),
      subtotal: Number(row.subtotal_revertido),
      descuento: Number(row.descuento_revertido),
      isv_15: Number(row.isv_15_revertido),
      isv_18: Number(row.isv_18_revertido),
      total: Number(row.total_revertido)
    });
  }
  return map;
};

const getReversedAmounts = (reversedQtyMap, idDetalle) => reversedQtyMap.get(idDetalle) || EMPTY_REVERSED_AMOUNTS;

const computeTotalSoldQuantity = (facturaLines) => facturaLines.reduce((sum, line) => {
  const soldQty = Number(line.cantidad_vendida || 0);
  return Number.isInteger(soldQty) && soldQty > 0 ? sum + soldQty : sum;
}, 0);

const computeTotalReversedQuantity = (facturaLines, reversedQtyMap) => facturaLines.reduce((sum, line) => {
  const soldQty = Number(line.cantidad_vendida || 0);
  if (!Number.isInteger(soldQty) || soldQty <= 0) return sum;
  return sum + getReversedAmounts(reversedQtyMap, Number(line.id_detalle_factura)).cantidad;
}, 0);

export const validatePartialReversionApplicability = ({ tipoReversion, facturaLines, reversedQtyMap }) => {
  if (tipoReversion !== 'PARCIAL') return;

  const pendingQuantities = facturaLines
    .map((line) => {
      const soldQty = Number(line.cantidad_vendida || 0);
      if (!Number.isInteger(soldQty) || soldQty <= 0) return null;

      const idDetalle = Number(line.id_detalle_factura || 0);
      const reversedQty = getReversedAmounts(reversedQtyMap, idDetalle).cantidad;
      const pendingQty = soldQty - reversedQty;
      if (!Number.isInteger(pendingQty) || pendingQty <= 0) return null;

      return pendingQty;
    })
    .filter(Boolean);

  const hasMultiplePendingLines = pendingQuantities.length > 1;
  const hasPendingQtyGreaterThanOne = pendingQuantities.some((qty) => qty > 1);
  if (hasMultiplePendingLines || hasPendingQtyGreaterThanOne) return;

  throw createReversionError(
    409,
    'VENTAS_REVERSION_PARCIAL_NO_APLICA',
    'La reversión parcial no aplica para una venta con una sola unidad pendiente. Usa reversión total.'
  );
};

export const resolveReversionLines = ({ tipoReversion, requestedLines, facturaLines, reversedQtyMap }) => {
  const byId = new Map(facturaLines.map((row) => [Number(row.id_detalle_factura), row]));

  if (tipoReversion === 'PARCIAL') {
    for (const reqId of requestedLines.keys()) {
      if (!byId.has(reqId)) {
        throw createReversionError(409, 'VENTAS_REVERSION_LINEA_NO_PERTENECE', `La línea ${reqId} no pertenece a la factura.`);
      }
    }
  }

  const output = [];

  for (const line of facturaLines) {
    const idDetalle = Number(line.id_detalle_factura);
    const soldQty = Number(line.cantidad_vendida || 0);

    if (!Number.isInteger(soldQty) || soldQty <= 0) {
      continue;
    }

    const reversedAmounts = getReversedAmounts(reversedQtyMap, idDetalle);
    const reversedQty = reversedAmounts.cantidad;
    const availableQty = soldQty - reversedQty;

    const requestedQty = tipoReversion === 'TOTAL'
      ? availableQty
      : Number(requestedLines.get(idDetalle) || 0);

    if (tipoReversion === 'PARCIAL' && requestedLines.has(idDetalle) && availableQty <= 0) {
      throw createReversionError(409, 'VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE', `La línea ${idDetalle} ya fue totalmente reversada.`);
    }

    if (requestedQty <= 0) {
      continue;
    }

    if (!Number.isInteger(requestedQty)) {
      throw createReversionError(400, 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA', 'cantidad debe ser entera para reversión parcial de inventario.');
    }

    if (requestedQty > availableQty) {
      throw createReversionError(409, 'VENTAS_REVERSION_CANTIDAD_EXCEDE_DISPONIBLE', `La línea ${idDetalle} excede la cantidad reversible.`);
    }

    // Ajuste de residuo monetario acumulado: cada valor (subtotal,
    // descuento, ISV 15, ISV 18, total) se calcula por separado como
    // "valor original - ya revertido", nunca solo "original * ratio" desde
    // cero. Si esta operacion COMPLETA la cantidad reversable de la linea
    // (requestedQty === availableQty), se usa exactamente ese residuo en
    // vez de un prorrateo nuevo -- esto es lo que garantiza que
    // SUM(reversiones aplicadas de la linea) == snapshot original exacto,
    // sin importar cuantas reversiones parciales precedieron. Si NO
    // completa la linea, se aplica el prorrateo normal (ratio =
    // requestedQty/soldQty) pero recortado (Math.min) para que nunca
    // pueda exceder el residuo disponible por errores de redondeo.
    const isv15Rate = Number(line.isv_porcentaje || 0) === 15 ? 0.15 : 0;
    const isv18Rate = Number(line.isv_porcentaje || 0) === 18 ? 0.18 : 0;

    const originalSubtotal = roundMoney(line.sub_total);
    const originalDescuento = roundMoney(line.descuento_linea);
    const originalTotal = roundMoney(line.total_detalle);
    const originalIsv15 = roundMoney(Number(line.sub_total) * isv15Rate);
    const originalIsv18 = roundMoney(Number(line.sub_total) * isv18Rate);

    const remainingSubtotal = roundMoney(originalSubtotal - reversedAmounts.subtotal);
    const remainingDescuento = roundMoney(originalDescuento - reversedAmounts.descuento);
    const remainingIsv15 = roundMoney(originalIsv15 - reversedAmounts.isv_15);
    const remainingIsv18 = roundMoney(originalIsv18 - reversedAmounts.isv_18);
    const remainingTotal = roundMoney(originalTotal - reversedAmounts.total);

    const completesLine = requestedQty === availableQty;

    let subtotal;
    let descuento;
    let isv15;
    let isv18;
    let total;

    if (completesLine) {
      subtotal = remainingSubtotal;
      descuento = remainingDescuento;
      isv15 = remainingIsv15;
      isv18 = remainingIsv18;
      total = remainingTotal;
    } else {
      const ratio = requestedQty / soldQty;
      subtotal = Math.min(roundMoney(originalSubtotal * ratio), remainingSubtotal);
      descuento = Math.min(roundMoney(originalDescuento * ratio), remainingDescuento);
      isv15 = Math.min(roundMoney(originalIsv15 * ratio), remainingIsv15);
      isv18 = Math.min(roundMoney(originalIsv18 * ratio), remainingIsv18);
      total = Math.min(roundMoney(originalTotal * ratio), remainingTotal);
    }

    output.push({
      id_detalle_factura: idDetalle,
      origen_snapshot: line.origen_snapshot || null,
      tipo_item: line.tipo_item,
      id_producto: parsePositiveInt(line.id_producto),
      id_receta: parsePositiveInt(line.id_receta),
      id_detalle_pedido: parsePositiveInt(line.id_detalle_pedido),
      cantidad_vendida: soldQty,
      cantidad_revertida: requestedQty,
      precio_unitario_original: roundMoney(line.precio_unitario),
      subtotal_revertido: subtotal,
      descuento_revertido: descuento,
      isv_15_revertido: isv15,
      isv_18_revertido: isv18,
      total_revertido: total,
      devuelve_inventario: Boolean(line.devuelve_inventario)
    });
  }

  if (!output.length) {
    const totalSold = computeTotalSoldQuantity(facturaLines);
    const totalReversedBefore = computeTotalReversedQuantity(facturaLines, reversedQtyMap);
    if (totalSold > 0 && totalReversedBefore >= totalSold) {
      throw createReversionError(409, 'VENTAS_REVERSION_TOTALMENTE_APLICADA', 'La factura ya fue reversada completamente.');
    }
    throw createReversionError(409, 'VENTAS_REVERSION_SIN_LINEAS', 'No hay líneas reversables para procesar.');
  }

  if (tipoReversion === 'PARCIAL') {
    const provided = [...requestedLines.keys()].sort((a, b) => a - b);
    const applied = output.map((row) => row.id_detalle_factura).sort((a, b) => a - b);
    if (provided.length !== applied.length || provided.some((id, idx) => id !== applied[idx])) {
      throw createReversionError(409, 'VENTAS_REVERSION_LINEAS_INVALIDAS', 'La solicitud parcial contiene líneas inválidas o no reversables.');
    }
  }

  return output;
};

export const computeFacturaTotal = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS total_factura
      FROM public.detalle_facturas df
      WHERE df.id_factura = $1
    `,
    [idFactura]
  );
  return Number(result.rows?.[0]?.total_factura || 0);
};

/**
 * Determina, DESPUES de calcular la operacion actual, el resultado
 * acumulado real de la factura: si ya no queda ninguna cantidad
 * reversible en NINGUNA linea (no solo las tocadas por esta operacion),
 * el resultado es TOTAL y factura_totalmente_reversada=true, sin importar
 * si el cliente solicito `tipo_reversion=PARCIAL`. tipo_reversion_solicitado
 * se conserva sin cambios para auditoria.
 */
export const computeAccumulatedResult = ({ facturaLines, reversedQtyMapBefore, reversionLines }) => {
  const cantidadOriginalTotal = computeTotalSoldQuantity(facturaLines);
  const cantidadReversadaAnterior = computeTotalReversedQuantity(facturaLines, reversedQtyMapBefore);
  const cantidadReversadaActual = (Array.isArray(reversionLines) ? reversionLines : [])
    .reduce((sum, line) => sum + Number(line.cantidad_revertida || 0), 0);

  const cantidadReversadaTotal = cantidadReversadaAnterior + cantidadReversadaActual;
  const cantidadRestanteFinal = Math.max(0, cantidadOriginalTotal - cantidadReversadaTotal);
  const facturaTotalmenteReversada = cantidadOriginalTotal > 0 && cantidadRestanteFinal <= 0;

  return {
    cantidad_original_total: cantidadOriginalTotal,
    cantidad_reversada_anterior: cantidadReversadaAnterior,
    cantidad_reversada_actual: cantidadReversadaActual,
    cantidad_restante_final: cantidadRestanteFinal,
    resultado_acumulado: facturaTotalmenteReversada ? 'TOTAL' : 'PARCIAL',
    factura_totalmente_reversada: facturaTotalmenteReversada
  };
};
