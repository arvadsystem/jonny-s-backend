import pool from '../config/db-connection.js';
import { generarCodigoDocumento } from './facturacionCorrelativoService.js';
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import { restoreSalsasInventoryFromSnapshots } from '../routers/ventas/services/salsasInventoryService.js';
import {
  lockCajaFinancialSessions,
  mapCajaFinancialLockError
} from './cajaFinancialLockService.js';

const REVERSAL_WINDOW_SQL = `NOW() - INTERVAL '1 hour'`;
const VALID_MOTIVOS = new Set([
  'PRODUCTO_EQUIVOCADO',
  'CANTIDAD_EQUIVOCADA',
  'VENTA_DUPLICADA',
  'CLIENTE_CANCELO',
  'METODO_PAGO_EQUIVOCADO',
  'ERROR_OPERATIVO',
  'OTRO',
  // Compatibilidad hacia atr\u00e1s (no visibles en frontend nuevo)
  'ERROR_DIGITACION',
  'PRODUCTO_NO_DISPONIBLE',
  'DEVOLUCION',
  'COBRO_INCORRECTO'
]);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isIntegerNumber = (value) => Number.isInteger(Number(value));

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const normalizeText = (value, max = 200) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : null;
};

const normalizeMotivo = (value) => String(value || '').trim().toUpperCase();

const createReversionError = (status, code, message) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const resolveSucursalScope = async (client, idUsuario) => {
  const result = await client.query(
    `
      SELECT
        u.id_usuario,
        e.id_sucursal AS id_sucursal_empleado,
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT es.id_sucursal), NULL) AS sucursales_extra,
        COALESCE(
          BOOL_OR(UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'),
          FALSE
        ) AS is_super_admin
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN public.empleados_sucursales es ON es.id_empleado = u.id_empleado AND COALESCE(es.estado, true) = true
      LEFT JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      LEFT JOIN public.roles r ON r.id_rol = ru.id_rol
      WHERE u.id_usuario = $1
      GROUP BY u.id_usuario, e.id_sucursal
      LIMIT 1
    `,
    [idUsuario]
  );

  const row = result.rows[0];
  if (!row) {
    throw createReversionError(403, 'VENTAS_REVERSION_SCOPE_INVALIDO', 'No se pudo resolver el alcance del usuario.');
  }

  const set = new Set();
  const baseSucursal = parsePositiveInt(row.id_sucursal_empleado);
  if (baseSucursal) set.add(baseSucursal);
  for (const id of Array.isArray(row.sucursales_extra) ? row.sucursales_extra : []) {
    const parsed = parsePositiveInt(id);
    if (parsed) set.add(parsed);
  }

  return {
    isSuperAdmin: Boolean(row.is_super_admin),
    allowedSucursalIds: [...set]
  };
};

const assertOriginalCajaSessionOpen = async ({ client, factura }) => {
  const idSesionCaja = parsePositiveInt(factura?.id_sesion_caja);
  const idSucursal = parsePositiveInt(factura?.id_sucursal);

  if (!idSesionCaja || !idSucursal) {
    throw createReversionError(
      409,
      'VENTA_SIN_SESION_CAJA_VALIDA',
      'La venta no tiene una sesión de caja válida para reversión.'
    );
  }

  const result = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.fecha_cierre,
        UPPER(TRIM(cse.codigo)) AS estado_codigo,
        COALESCE(c.estado, true) AS caja_activa
      FROM public.cajas_sesiones cs
      LEFT JOIN public.cat_cajas_sesiones_estados cse
        ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
      LEFT JOIN public.cajas c
        ON c.id_caja = cs.id_caja
       AND c.id_sucursal = cs.id_sucursal
      WHERE cs.id_sesion_caja = $1
        AND cs.id_sucursal = $2
      LIMIT 1
    `,
    [idSesionCaja, idSucursal]
  );

  if (!result.rowCount) {
    throw createReversionError(
      409,
      'VENTA_SIN_SESION_CAJA_VALIDA',
      'La venta no tiene una sesión de caja válida para reversión.'
    );
  }

  const session = result.rows[0];
  const facturaCajaId = parsePositiveInt(factura?.id_caja);
  if (facturaCajaId && Number(session.id_caja) !== Number(facturaCajaId)) {
    throw createReversionError(
      409,
      'VENTA_SIN_SESION_CAJA_VALIDA',
      'La venta no tiene una sesión de caja válida para reversión.'
    );
  }

  if (!Boolean(session.caja_activa)) {
    throw createReversionError(
      409,
      'VENTA_SIN_SESION_CAJA_VALIDA',
      'La venta no tiene una sesión de caja válida para reversión.'
    );
  }

  if (session.estado_codigo !== 'ABIERTA' || session.fecha_cierre) {
    throw createReversionError(
      409,
      'CAJA_CERRADA_REVERSA_NO_PERMITIDA',
      'No se puede reversar porque la caja de esta venta ya fue cerrada.'
    );
  }

  return session;
};

const assertSucursalAllowedForReversion = (scope, idSucursal, action = 'crear') => {
  const targetSucursalId = parsePositiveInt(idSucursal);
  if (!targetSucursalId) {
    throw createReversionError(403, 'VENTAS_REVERSION_SCOPE_INVALIDO', 'No se pudo resolver la sucursal de la venta.');
  }
  if (scope?.isSuperAdmin) return;
  const allowed = Array.isArray(scope?.allowedSucursalIds)
    ? scope.allowedSucursalIds.map((id) => parsePositiveInt(id)).filter(Boolean)
    : [];
  if (allowed.length === 0) {
    throw createReversionError(403, 'VENTAS_REVERSION_SCOPE_EMPTY', 'No tienes sucursales autorizadas para reversiones.');
  }
  if (!allowed.includes(targetSucursalId)) {
    const verb = action === 'consultar' ? 'consultar reversiones de' : 'reversar';
    throw createReversionError(403, 'VENTAS_REVERSION_SCOPE_FORBIDDEN', `No puedes ${verb} una venta de otra sucursal.`);
  }
};

const assertSucursalOpenForReversion = async ({ client, idSucursal }) => {
  const idSucursalTarget = parsePositiveInt(idSucursal);
  if (!idSucursalTarget) {
    throw createReversionError(
      409,
      'SUCURSAL_CERRADA_REVERSA_NO_PERMITIDA',
      'No se puede reversar porque la sucursal ya está fuera de horario operativo.'
    );
  }

  const result = await client.query(
    `
      WITH clock AS (
        SELECT
          (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS fecha_actual,
          (NOW() AT TIME ZONE 'America/Tegucigalpa')::time AS hora_actual,
          EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'America/Tegucigalpa'))::int AS dia_semana
      ),
      branch AS (
        SELECT id_sucursal, estado, hora_inicio, hora_final
        FROM public.sucursales
        WHERE id_sucursal = $1
        LIMIT 1
      )
      SELECT
        b.id_sucursal,
        CASE
          WHEN b.id_sucursal IS NULL THEN false
          WHEN COALESCE(b.estado, true) = false THEN false
          WHEN fe.id_fecha_especial IS NOT NULL THEN
            CASE
              WHEN COALESCE(fe.cerrado, false) = true THEN false
              WHEN fe.hora_inicio IS NULL OR fe.hora_final IS NULL THEN false
              WHEN fe.hora_final > fe.hora_inicio THEN clock.hora_actual >= fe.hora_inicio AND clock.hora_actual < fe.hora_final
              ELSE clock.hora_actual >= fe.hora_inicio OR clock.hora_actual < fe.hora_final
            END
          WHEN sh.id_horario IS NOT NULL THEN
            CASE
              WHEN COALESCE(sh.cerrado, false) = true THEN false
              WHEN sh.hora_inicio IS NULL OR sh.hora_final IS NULL THEN false
              WHEN sh.hora_final > sh.hora_inicio THEN clock.hora_actual >= sh.hora_inicio AND clock.hora_actual < sh.hora_final
              ELSE clock.hora_actual >= sh.hora_inicio OR clock.hora_actual < sh.hora_final
            END
          WHEN b.hora_inicio IS NOT NULL AND b.hora_final IS NOT NULL THEN
            CASE
              WHEN b.hora_final > b.hora_inicio THEN clock.hora_actual >= b.hora_inicio AND clock.hora_actual < b.hora_final
              ELSE clock.hora_actual >= b.hora_inicio OR clock.hora_actual < b.hora_final
            END
          ELSE true
        END AS abierta
      FROM clock
      LEFT JOIN branch b ON true
      LEFT JOIN LATERAL (
        SELECT id_fecha_especial, cerrado, hora_inicio, hora_final
        FROM public.sucursales_fechas_especiales
        WHERE id_sucursal = b.id_sucursal
          AND fecha = clock.fecha_actual
          AND COALESCE(estado, true) = true
        ORDER BY id_fecha_especial DESC
        LIMIT 1
      ) fe ON b.id_sucursal IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT id_horario, cerrado, hora_inicio, hora_final
        FROM public.sucursales_horarios
        WHERE id_sucursal = b.id_sucursal
          AND dia_semana = clock.dia_semana
          AND COALESCE(estado, true) = true
        LIMIT 1
      ) sh ON b.id_sucursal IS NOT NULL
    `,
    [idSucursalTarget]
  );

  if (!Boolean(result.rows?.[0]?.abierta)) {
    throw createReversionError(
      409,
      'SUCURSAL_CERRADA_REVERSA_NO_PERMITIDA',
      'No se puede reversar porque la sucursal ya está fuera de horario operativo.'
    );
  }
};

const resolveReversionCajaMovementType = async (client) => {
  const result = await client.query(
    `
      SELECT id_tipo_movimiento_caja, UPPER(TRIM(codigo)) AS codigo
      FROM public.cat_cajas_movimientos_tipos
      WHERE COALESCE(estado, true) = true
        AND signo = -1
        AND UPPER(TRIM(codigo)) = ANY($1::text[])
      ORDER BY CASE UPPER(TRIM(codigo))
        WHEN 'REVERSION' THEN 1
        WHEN 'REVERSO' THEN 2
        WHEN 'REVERSIÓN' THEN 3
        ELSE 99
      END
      LIMIT 1
    `,
    [['REVERSION', 'REVERSO', 'REVERSIÓN']]
  );

  if (!result.rowCount) {
    throw createReversionError(
      409,
      'VENTAS_REVERSION_TIPO_MOVIMIENTO_CAJA_INVALIDO',
      'No existe tipo de movimiento de caja REVERSION/REVERSO activo en cat\u00e1logo.'
    );
  }

  return Number(result.rows[0].id_tipo_movimiento_caja);
};

const buildRequestedLines = (lineas) => {
  const rows = Array.isArray(lineas) ? lineas : [];
  const byDetail = new Map();

  for (const row of rows) {
    const idDetalle = parsePositiveInt(row?.id_detalle_factura);
    if (!idDetalle) {
      throw createReversionError(400, 'VENTAS_REVERSION_LINEA_INVALIDA', 'Cada l\u00ednea debe incluir id_detalle_factura v\u00e1lido.');
    }

    const cantidadRaw = row?.cantidad;
    if (!isIntegerNumber(cantidadRaw)) {
      throw createReversionError(400, 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA', 'cantidad debe ser entera para reversi\u00f3n parcial de inventario.');
    }

    const cantidad = parsePositiveInt(cantidadRaw);
    if (!cantidad) {
      throw createReversionError(400, 'VENTAS_REVERSION_LINEA_INVALIDA', 'cantidad debe ser mayor a 0.');
    }

    const prev = byDetail.get(idDetalle) || 0;
    byDetail.set(idDetalle, prev + cantidad);
  }

  return byDetail;
};

const resolveFacturaLinesForUpdate = async (client, idFactura) => {
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

const resolveAlreadyReversedQty = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT rd.id_detalle_factura, COALESCE(SUM(rd.cantidad_revertida), 0)::numeric AS cantidad_revertida
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
    map.set(Number(row.id_detalle_factura), Number(row.cantidad_revertida));
  }
  return map;
};

const resolveReversionLines = ({ tipoReversion, requestedLines, facturaLines, reversedQtyMap }) => {
  const byId = new Map(facturaLines.map((row) => [Number(row.id_detalle_factura), row]));

  if (tipoReversion === 'PARCIAL') {
    for (const reqId of requestedLines.keys()) {
      if (!byId.has(reqId)) {
        throw createReversionError(409, 'VENTAS_REVERSION_LINEA_NO_PERTENECE', `La l\u00ednea ${reqId} no pertenece a la factura.`);
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

    const reversedQty = Number(reversedQtyMap.get(idDetalle) || 0);
    const availableQty = soldQty - reversedQty;

    const requestedQty = tipoReversion === 'TOTAL'
      ? availableQty
      : Number(requestedLines.get(idDetalle) || 0);

    if (tipoReversion === 'PARCIAL' && requestedLines.has(idDetalle) && availableQty <= 0) {
      throw createReversionError(409, 'VENTAS_REVERSION_LINEA_AGOTADA', `La l\u00ednea ${idDetalle} ya fue totalmente reversada.`);
    }

    if (requestedQty <= 0) {
      continue;
    }

    if (!Number.isInteger(requestedQty)) {
      throw createReversionError(400, 'VENTAS_REVERSION_CANTIDAD_ENTERA_REQUERIDA', 'cantidad debe ser entera para reversi\u00f3n parcial de inventario.');
    }

    if (requestedQty > availableQty) {
      throw createReversionError(409, 'VENTAS_REVERSION_CANTIDAD_EXCEDE', `La l\u00ednea ${idDetalle} excede la cantidad reversible.`);
    }

    const ratio = requestedQty / soldQty;
    const subtotal = roundMoney(Number(line.sub_total) * ratio);
    const descuento = roundMoney(Number(line.descuento_linea) * ratio);
    const total = roundMoney(Number(line.total_detalle) * ratio);

    const isv15Rate = Number(line.isv_porcentaje || 0) === 15 ? 0.15 : 0;
    const isv18Rate = Number(line.isv_porcentaje || 0) === 18 ? 0.18 : 0;

    output.push({
      id_detalle_factura: idDetalle,
      origen_snapshot: line.origen_snapshot || null,
      tipo_item: line.tipo_item,
      id_producto: parsePositiveInt(line.id_producto),
      id_receta: parsePositiveInt(line.id_receta),
      cantidad_revertida: requestedQty,
      precio_unitario_original: roundMoney(line.precio_unitario),
      subtotal_revertido: subtotal,
      descuento_revertido: descuento,
      isv_15_revertido: roundMoney(subtotal * isv15Rate),
      isv_18_revertido: roundMoney(subtotal * isv18Rate),
      total_revertido: total,
      devuelve_inventario: Boolean(line.devuelve_inventario)
    });
  }

  if (!output.length) {
    throw createReversionError(409, 'VENTAS_REVERSION_SIN_LINEAS', 'No hay l\u00edneas reversables para procesar.');
  }

  if (tipoReversion === 'PARCIAL') {
    const provided = [...requestedLines.keys()].sort((a, b) => a - b);
    const applied = output.map((row) => row.id_detalle_factura).sort((a, b) => a - b);
    if (provided.length !== applied.length || provided.some((id, idx) => id !== applied[idx])) {
      throw createReversionError(409, 'VENTAS_REVERSION_LINEAS_INVALIDAS', 'La solicitud parcial contiene l\u00edneas inv\u00e1lidas o no reversables.');
    }
  }

  return output;
};

const computeFacturaTotal = async (client, idFactura) => {
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


const validatePartialReversionApplicability = ({ tipoReversion, facturaLines, reversedQtyMap }) => {
  if (tipoReversion !== 'PARCIAL') return;

  const pendingQuantities = facturaLines
    .map((line) => {
      const soldQty = Number(line.cantidad_vendida || 0);
      if (!Number.isInteger(soldQty) || soldQty <= 0) return null;

      const idDetalle = Number(line.id_detalle_factura || 0);
      const reversedQty = Number(reversedQtyMap.get(idDetalle) || 0);
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
    'La reversi\u00f3n parcial no aplica para una venta con una sola unidad pendiente. Usa reversi\u00f3n total.'
  );
};

const revertLoyaltyForFactura = async ({
  client,
  idFactura,
  idSucursal,
  idUsuario,
  tipoReversion,
  montoReversado,
  totalFactura
}) => {
  const sourceResult = await client.query(
    `
      SELECT
        fm.id_movimiento,
        fm.id_cliente,
        fm.puntos_delta
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om ON om.id_origen_movimiento = fm.id_origen_movimiento
      WHERE fm.id_factura = $1
        AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
        AND UPPER(TRIM(om.codigo)) = 'FACTURA'
        AND fm.puntos_delta > 0
      ORDER BY fm.id_movimiento ASC
      LIMIT 1
      FOR UPDATE OF fm
    `,
    [idFactura]
  );

  if (!sourceResult.rowCount) return { applied: false, reason: 'NO_LOYALTY_MOVEMENT' };

  const source = sourceResult.rows[0];
  const puntosOriginales = Number(source.puntos_delta || 0);
  if (puntosOriginales <= 0) return { applied: false, reason: 'INVALID_LOYALTY_DELTA' };

  const reverseCatalogResult = await client.query(
    `
      SELECT
        tm.id_tipo_movimiento AS id_tipo_movimiento_reverso,
        om.id_origen_movimiento AS id_origen_movimiento_reverso
      FROM public.cat_fidelizacion_tipos_movimiento tm
      CROSS JOIN public.cat_fidelizacion_origenes_movimiento om
      WHERE UPPER(TRIM(tm.codigo)) = 'REVERSO'
        AND UPPER(TRIM(om.codigo)) = 'REVERSO_FACTURA'
        AND COALESCE(tm.estado, true) = true
        AND COALESCE(om.estado, true) = true
      LIMIT 1
    `
  );
  if (!reverseCatalogResult.rowCount) {
    return { applied: false, reason: 'LOYALTY_REVERSAL_CATALOG_MISSING' };
  }

  const reverseCatalog = reverseCatalogResult.rows[0];
  const reverseTypeId = Number(reverseCatalog.id_tipo_movimiento_reverso);
  const reverseOriginId = Number(reverseCatalog.id_origen_movimiento_reverso);

  const reversedResult = await client.query(
    `
      SELECT COALESCE(SUM(ABS(puntos_delta)), 0)::int AS puntos_revertidos
      FROM public.fidelizacion_movimientos
      WHERE id_factura = $1
        AND puntos_delta < 0
    `,
    [idFactura]
  );

  const puntosYaRevertidos = Number(reversedResult.rows?.[0]?.puntos_revertidos || 0);
  const puntosPendientes = Math.max(0, puntosOriginales - puntosYaRevertidos);
  if (puntosPendientes <= 0) return { applied: false, reason: 'ALREADY_REVERSED' };

  let puntosObjetivo = puntosPendientes;
  if (tipoReversion === 'PARCIAL') {
    if (totalFactura <= 0) return { applied: false, reason: 'TOTAL_FACTURA_INVALID_FOR_PARTIAL' };
    const montoReversadoAcumuladoResult = await client.query(
      `
        SELECT COALESCE(SUM(fr.monto_reversado), 0)::numeric AS monto_reversado_acumulado
        FROM public.facturas_reversiones fr
        WHERE fr.id_factura_original = $1
          AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
      `,
      [idFactura]
    );
    const montoReversadoAcumulado = Number(montoReversadoAcumuladoResult.rows?.[0]?.monto_reversado_acumulado || 0);
    const proporcion = Math.max(0, Math.min(1, montoReversadoAcumulado / totalFactura));
    puntosObjetivo = Math.floor(puntosOriginales * proporcion) - puntosYaRevertidos;
    puntosObjetivo = Math.max(0, Math.min(puntosObjetivo, puntosPendientes));
  }

  if (puntosObjetivo <= 0) return { applied: false, reason: 'PARTIAL_WITHOUT_POINTS' };

  const saldoResult = await client.query(
    `
      SELECT id_cliente, puntos_disponibles, puntos_acumulados_total
      FROM public.fidelizacion_saldos_cliente
      WHERE id_cliente = $1
      FOR UPDATE
    `,
    [source.id_cliente]
  );
  if (!saldoResult.rowCount) return { applied: false, reason: 'NO_LOYALTY_BALANCE' };

  const saldo = saldoResult.rows[0];
  const saldoAnterior = Number(saldo.puntos_disponibles || 0);
  const puntosAplicables = Math.min(puntosObjetivo, saldoAnterior);
  if (puntosAplicables <= 0) return { applied: false, reason: 'LOYALTY_BALANCE_ZERO' };

  const nuevoSaldo = saldoAnterior - puntosAplicables;
  const nuevoAcumulado = Math.max(0, Number(saldo.puntos_acumulados_total || 0) - puntosAplicables);

  await client.query(
    `
      UPDATE public.fidelizacion_saldos_cliente
      SET
        puntos_disponibles = $1,
        puntos_acumulados_total = $2,
        fecha_actualizacion = NOW()
      WHERE id_cliente = $3
    `,
    [nuevoSaldo, nuevoAcumulado, source.id_cliente]
  );

  await client.query(
    `
      UPDATE public.clientes
      SET puntos = $1
      WHERE id_cliente = $2
    `,
    [nuevoSaldo, source.id_cliente]
  );

  const existingReverseResult = await client.query(
    `
      SELECT id_movimiento, puntos_delta
      FROM public.fidelizacion_movimientos
      WHERE id_factura = $1
        AND id_tipo_movimiento = $2
        AND id_origen_movimiento = $3
      LIMIT 1
      FOR UPDATE
    `,
    [idFactura, reverseTypeId, reverseOriginId]
  );

  if (existingReverseResult.rowCount) {
    const existing = existingReverseResult.rows[0];
    const nuevoDelta = Number(existing.puntos_delta || 0) - puntosAplicables;

    await client.query(
      `
        UPDATE public.fidelizacion_movimientos
        SET
          puntos_delta = $1,
          saldo_nuevo = $2,
          observacion = $3,
          id_usuario_ejecutor = $4
        WHERE id_movimiento = $5
      `,
      [
        nuevoDelta,
        nuevoSaldo,
        `Reversión ${tipoReversion} de puntos por reversión de venta.`,
        idUsuario,
        Number(existing.id_movimiento)
      ]
    );
  } else {
    await client.query(
      `
        INSERT INTO public.fidelizacion_movimientos (
          id_cliente,
          id_sucursal,
          id_tipo_movimiento,
          puntos_delta,
          saldo_anterior,
          saldo_nuevo,
          id_origen_movimiento,
          id_factura,
          observacion,
          id_usuario_ejecutor,
          fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `,
      [
        source.id_cliente,
        idSucursal,
        reverseTypeId,
        puntosAplicables * -1,
        saldoAnterior,
        nuevoSaldo,
        reverseOriginId,
        idFactura,
        `Reversión ${tipoReversion} de puntos por reversión de venta.`,
        idUsuario
      ]
    );
  }

  return {
    applied: true,
    id_cliente: Number(source.id_cliente),
    puntos_revertidos: puntosAplicables,
    saldo_anterior: saldoAnterior,
    saldo_nuevo: nuevoSaldo
  };
};

const registerInventoryReturn = async ({ client, idReversion, codigoReversion, codigoVenta, lineas }) => {
  for (const line of lineas) {
    if (!line.devuelve_inventario || !line.id_producto) continue;

    if (!Number.isInteger(Number(line.cantidad_revertida)) || Number(line.cantidad_revertida) <= 0) {
      throw createReversionError(400, 'VENTAS_REVERSION_INVENTARIO_CANTIDAD_INVALIDA', 'Cantidad de devoluci\u00f3n a inventario debe ser entera positiva.');
    }

    const prodResult = await client.query(
      `
        SELECT id_producto, id_almacen
        FROM public.productos
        WHERE id_producto = $1
        LIMIT 1
        FOR UPDATE`,
      [line.id_producto]
    );

    if (!prodResult.rowCount) continue;
    const product = prodResult.rows[0];

    await client.query(
      `
        INSERT INTO public.movimientos_inventario (
          tipo,
          cantidad,
          id_almacen,
          id_producto,
          id_insumo,
          ref_origen,
          id_ref,
          descripcion
        )
        VALUES ('ENTRADA', $1, $2, $3, NULL, 'REVERSION_VENTA', $4, $5)
      `,
      [
        Number(line.cantidad_revertida),
        product.id_almacen,
        product.id_producto,
        idReversion,
        `Entrada por reversi\u00f3n ${codigoReversion} de venta ${codigoVenta}`
      ]
    );
  }
};

export const buildSalsaInventorySnapshotsForReturn = (lineas = []) => {
  const snapshots = [];
  for (const line of Array.isArray(lineas) ? lineas : []) {
    const source = line?.origen_snapshot;
    const selection = Array.isArray(source?.componentes?.seleccion)
      ? source.componentes.seleccion
      : Array.isArray(source?.complementos?.seleccion)
        ? source.complementos.seleccion
        : [];
    const soldQty = Number(source?.cantidad || 0);
    const reversedQty = Number(line?.cantidad_revertida || 0);
    const ratio = soldQty > 0 && reversedQty > 0 ? Math.min(1, reversedQty / soldQty) : 1;
    const aggregateSnapshotsSeen = new Set();
    for (const entry of selection) {
      const snapshot = entry?.inventario;
      if (!snapshot || typeof snapshot !== 'object') continue;
      const totalBase = Number(snapshot.cantidad_base_total || 0);
      if (totalBase <= 0) continue;
      const aggregateKey = `${Number(snapshot.id_salsa || entry?.id_salsa || 0)}:${Number(snapshot.id_insumo || 0)}:${Number(snapshot.id_almacen || 0)}`;
      if (Number(snapshot.porciones || 0) > 1) {
        if (aggregateSnapshotsSeen.has(aggregateKey)) continue;
        aggregateSnapshotsSeen.add(aggregateKey);
      }
      snapshots.push({
        ...snapshot,
        cantidad_base_total: totalBase * ratio,
        porciones: Number(snapshot.porciones || 0) * ratio
      });
    }
  }
  return snapshots;
};

const filterConsumedSalsaSnapshots = async ({ client, idPedido, idFactura, snapshots }) => {
  const pedidoId = parsePositiveInt(idPedido);
  const facturaId = parsePositiveInt(idFactura);
  if (!pedidoId && !facturaId) return [];

  const result = await client.query(
    `
      SELECT DISTINCT mi.id_insumo, mi.id_almacen
      FROM public.movimientos_inventario mi
      WHERE mi.tipo = 'SALIDA'
        AND mi.id_insumo IS NOT NULL
        AND (
          (mi.ref_origen IN ('PEDIDO', 'FALTANTE_COCINA') AND mi.id_ref = $1)
          OR (mi.ref_origen = 'PEDIDO_PENDIENTE_SALSA' AND mi.id_ref = $1)
          OR (mi.ref_origen = 'VENTA_SALSA' AND mi.id_ref = $2)
        )
    `,
    [pedidoId, facturaId]
  );
  const consumedKeys = new Set((result.rows || []).map((row) => `${Number(row.id_insumo)}:${Number(row.id_almacen)}`));
  return (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) => (
    consumedKeys.has(`${Number(snapshot?.id_insumo)}:${Number(snapshot?.id_almacen)}`)
  ));
};

export const listFacturaReversiones = async ({ idFactura, idUsuario }) => {
  const facturaId = parsePositiveInt(idFactura);
  const userId = parsePositiveInt(idUsuario);
  if (!facturaId || !userId) {
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Par\u00e1metros inv\u00e1lidos.');
  }

  const client = await pool.connect();
  try {
    const scope = await resolveSucursalScope(client, userId);
    const facturaResult = await client.query(
      `SELECT id_factura, id_sucursal FROM public.facturas WHERE id_factura = $1 LIMIT 1`,
      [facturaId]
    );

    if (!facturaResult.rowCount) {
      throw createReversionError(404, 'VENTAS_REVERSION_FACTURA_NOT_FOUND', 'Venta no encontrada.');
    }

    const factura = facturaResult.rows[0];
    const idSucursal = Number(factura.id_sucursal || 0);
    assertSucursalAllowedForReversion(scope, idSucursal, 'consultar');

    const result = await client.query(
      `
        SELECT
          fr.id_reversion,
          fr.codigo_reversion,
          fr.id_factura_original,
          fr.tipo_reversion,
          fr.motivo,
          fr.observacion,
          fr.monto_reversado,
          fr.estado,
          fr.creada_en,
          fr.fecha_operacion,
          fr.id_caja_original,
          fr.id_sesion_caja_original,
          fr.id_caja_actual,
          fr.id_sesion_caja_actual,
          u.nombre_usuario AS usuario,
          COALESCE(lineas_info.lineas, '[]'::json) AS lineas
        FROM public.facturas_reversiones fr
        LEFT JOIN public.usuarios u ON u.id_usuario = fr.creada_por
        LEFT JOIN LATERAL (
          SELECT JSON_AGG(
            JSON_BUILD_OBJECT(
              'id_detalle_factura', rd.id_detalle_factura,
              'tipo_item', rd.tipo_item,
              'id_producto', rd.id_producto,
              'id_receta', rd.id_receta,
              'nombre_item', COALESCE(
                dfo.origen_snapshot->>'nombre_item',
                df.origen_snapshot->>'nombre_item',
                prod.nombre_producto,
                rec.nombre_receta,
                'Item'
              ),
              'cantidad_revertida', rd.cantidad_revertida,
              'precio_unitario_original', rd.precio_unitario_original,
              'subtotal_revertido', rd.subtotal_revertido,
              'descuento_revertido', rd.descuento_revertido,
              'isv_15_revertido', rd.isv_15_revertido,
              'isv_18_revertido', rd.isv_18_revertido,
              'total_revertido', rd.total_revertido,
              'devuelve_inventario', rd.devuelve_inventario
            )
            ORDER BY rd.id_reversion_detalle
          ) AS lineas
          FROM public.facturas_reversiones_detalle rd
          LEFT JOIN public.detalle_facturas df
            ON df.id_detalle_factura = rd.id_detalle_factura
          LEFT JOIN public.detalle_facturas_origen dfo
            ON dfo.id_detalle_factura = rd.id_detalle_factura
          LEFT JOIN public.productos prod
            ON prod.id_producto = COALESCE(rd.id_producto, dfo.id_producto, df.id_producto)
          LEFT JOIN public.recetas rec
            ON rec.id_receta = COALESCE(rd.id_receta, dfo.id_receta, df.id_receta::int)
          WHERE rd.id_reversion = fr.id_reversion
        ) lineas_info ON true
        WHERE fr.id_factura_original = $1
        ORDER BY fr.id_reversion DESC
      `,
      [facturaId]
    );

    return result.rows;
  } finally {
    client.release();
  }
};

export const createVentaReversion = async ({ idFactura, body, req, idUsuario, idempotency = null }) => {
  const facturaId = parsePositiveInt(idFactura);
  const userId = parsePositiveInt(idUsuario);
  if (!facturaId || !userId) {
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Solicitud inv\u00e1lida.');
  }

  const tipoReversion = String(body?.tipo_reversion || '').trim().toUpperCase();
  if (!['TOTAL', 'PARCIAL'].includes(tipoReversion)) {
    throw createReversionError(400, 'VENTAS_REVERSION_TIPO_INVALIDO', 'tipo_reversion debe ser TOTAL o PARCIAL.');
  }

  const motivo = normalizeMotivo(body?.motivo);
  if (!VALID_MOTIVOS.has(motivo)) {
    throw createReversionError(400, 'VENTAS_REVERSION_MOTIVO_INVALIDO', 'Motivo de reversi\u00f3n inv\u00e1lido.');
  }

  const observacion = normalizeText(body?.observacion, 300);
  const requestedLines = tipoReversion === 'PARCIAL' ? buildRequestedLines(body?.lineas) : new Map();
  if (tipoReversion === 'PARCIAL' && requestedLines.size === 0) {
    throw createReversionError(400, 'VENTAS_REVERSION_LINEAS_REQUERIDAS', 'Debe enviar l\u00edneas para reversi\u00f3n parcial.');
  }

  const ip = normalizeText(getClientIp(req), 80) || '-';
  const uaRaw = String(req?.headers?.['user-agent'] || '');
  const ua = parseUserAgent(uaRaw);
  const dispositivo = normalizeText(ua.dispositivo || '', 80) || 'Desconocido';
  const userAgent = normalizeText(uaRaw, 500) || 'Desconocido';

  const client = await pool.connect();
  let idempotencyReservation = null;
  try {
    await client.query('BEGIN');

    if (typeof idempotency?.reserve === 'function') {
      idempotencyReservation = await idempotency.reserve(client);
      if (idempotencyReservation?.replay || idempotencyReservation?.conflict) {
        await client.query('COMMIT');
        return { idempotency: idempotencyReservation };
      }
    }

    const scope = await resolveSucursalScope(client, userId);

    const facturaResult = await client.query(
      `
        SELECT
          f.id_factura,
          f.codigo_venta,
          f.id_sucursal,
          f.id_caja,
          f.id_sesion_caja,
          f.fecha_hora_facturacion,
          f.fecha_operacion,
          f.id_pedido,
          f.id_cliente
        FROM public.facturas f
        WHERE f.id_factura = $1
        FOR UPDATE`,
      [facturaId]
    );

    if (!facturaResult.rowCount) {
      throw createReversionError(404, 'VENTAS_REVERSION_FACTURA_NOT_FOUND', 'Venta no encontrada.');
    }

    const factura = facturaResult.rows[0];
    const idSucursal = Number(factura.id_sucursal || 0);
    assertSucursalAllowedForReversion(scope, idSucursal, 'crear');

    const cajaContext = await assertOriginalCajaSessionOpen({ client, factura });
    await lockCajaFinancialSessions(client, [
      factura.id_sesion_caja,
      cajaContext.id_sesion_caja
    ]);
    await assertOriginalCajaSessionOpen({ client, factura });
    await assertSucursalOpenForReversion({ client, idSucursal });

    const ageResult = await client.query(
      `SELECT CASE WHEN $1::timestamp >= (${REVERSAL_WINDOW_SQL}) THEN true ELSE false END AS in_window`,
      [factura.fecha_hora_facturacion]
    );

    if (!Boolean(ageResult.rows?.[0]?.in_window)) {
      throw createReversionError(409, 'VENTAS_REVERSION_FUERA_VENTANA', 'La venta excede la ventana m\u00e1xima de 1 hora para reversi\u00f3n.');
    }

    const facturaLines = await resolveFacturaLinesForUpdate(client, facturaId);
    const reversedQtyMap = await resolveAlreadyReversedQty(client, facturaId);
    validatePartialReversionApplicability({ tipoReversion, facturaLines, reversedQtyMap });

    const reversionLines = resolveReversionLines({
      tipoReversion,
      requestedLines,
      facturaLines,
      reversedQtyMap
    });

    const idTipoMovimientoCaja = await resolveReversionCajaMovementType(client);

    const correlativo = await generarCodigoDocumento({
      client,
      idSucursal,
      tipoDocumento: 'REVERSION'
    });

    const montoReversado = roundMoney(reversionLines.reduce((acc, line) => acc + Number(line.total_revertido || 0), 0));
    const totalFactura = await computeFacturaTotal(client, facturaId);

    const insertReversion = await client.query(
      `
        INSERT INTO public.facturas_reversiones (
          codigo_reversion,
          id_factura_original,
          id_sucursal,
          id_caja_original,
          id_sesion_caja_original,
          id_caja_actual,
          id_sesion_caja_actual,
          tipo_reversion,
          motivo,
          observacion,
          monto_reversado,
          estado,
          creada_por,
          fecha_operacion,
          ip_origen,
          dispositivo,
          user_agent,
          correo_notificado
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, 'APLICADA', $12,
          $13::date, $14, $15, $16, false
        )
        RETURNING id_reversion
      `,
      [
        correlativo.codigo,
        facturaId,
        idSucursal,
        parsePositiveInt(factura.id_caja),
        parsePositiveInt(factura.id_sesion_caja),
        parsePositiveInt(cajaContext.id_caja),
        parsePositiveInt(cajaContext.id_sesion_caja),
        tipoReversion,
        motivo,
        observacion,
        montoReversado,
        userId,
        correlativo.fecha_operacion,
        ip,
        dispositivo,
        userAgent
      ]
    );

    const idReversion = Number(insertReversion.rows[0].id_reversion);

    for (const line of reversionLines) {
      await client.query(
        `
          INSERT INTO public.facturas_reversiones_detalle (
            id_reversion,
            id_detalle_factura,
            tipo_item,
            id_producto,
            id_receta,
            cantidad_revertida,
            precio_unitario_original,
            subtotal_revertido,
            descuento_revertido,
            isv_15_revertido,
            isv_18_revertido,
            total_revertido,
            devuelve_inventario
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `,
        [
          idReversion,
          line.id_detalle_factura,
          line.tipo_item,
          line.id_producto,
          line.id_receta,
          line.cantidad_revertida,
          line.precio_unitario_original,
          line.subtotal_revertido,
          line.descuento_revertido,
          line.isv_15_revertido,
          line.isv_18_revertido,
          line.total_revertido,
          line.devuelve_inventario
        ]
      );
    }

    await client.query(
      `
        INSERT INTO public.cajas_movimientos (
          id_sesion_caja,
          id_caja,
          id_sucursal,
          id_tipo_movimiento_caja,
          id_usuario_ejecutor,
          monto,
          referencia,
          observacion,
          fecha_movimiento,
          fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      `,
      [
        cajaContext.id_sesion_caja,
        cajaContext.id_caja,
        idSucursal,
        idTipoMovimientoCaja,
        userId,
        montoReversado,
        correlativo.codigo,
        `Reversi\u00f3n ${correlativo.codigo} de venta ${factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`}`
      ]
    );

    const loyalty = await revertLoyaltyForFactura({
      client,
      idFactura: facturaId,
      idSucursal,
      idUsuario: userId,
      tipoReversion,
      montoReversado,
      totalFactura
    });

    await registerInventoryReturn({
      client,
      idReversion,
      codigoReversion: correlativo.codigo,
      codigoVenta: factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`,
      lineas: reversionLines
    });
    const salsaSnapshots = await filterConsumedSalsaSnapshots({
      client,
      idPedido: factura.id_pedido,
      idFactura: facturaId,
      snapshots: buildSalsaInventorySnapshotsForReturn(reversionLines)
    });
    await restoreSalsasInventoryFromSnapshots({
      client,
      snapshots: salsaSnapshots,
      idReversion,
      codigoReversion: correlativo.codigo,
      codigoVenta: factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`
    });

    const result = {
      id_reversion: idReversion,
      codigo_reversion: correlativo.codigo,
      fecha_operacion: correlativo.fecha_operacion,
      tipo_reversion: tipoReversion,
      motivo,
      observacion,
      monto_reversado: montoReversado,
      total_factura: totalFactura,
      codigo_venta: factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`,
      id_factura_original: facturaId,
      id_sucursal: idSucursal,
      id_caja_original: parsePositiveInt(factura.id_caja),
      id_sesion_caja_original: parsePositiveInt(factura.id_sesion_caja),
      id_caja_actual: parsePositiveInt(cajaContext.id_caja),
      id_sesion_caja_actual: parsePositiveInt(cajaContext.id_sesion_caja),
      lineas: reversionLines,
      fidelizacion: loyalty,
      auditoria: {
        ip_origen: ip,
        dispositivo,
        user_agent: userAgent
      }
    };
    const responseBody = {
      success: true,
      data: result,
      message: 'Reversión registrada correctamente.'
    };

    if (typeof idempotency?.saveSuccess === 'function') {
      await idempotency.saveSuccess(client, idempotencyReservation, responseBody, result);
    }

    await client.query('COMMIT');

    return { result, responseBody };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    const mappedError = mapCajaFinancialLockError(error);
    if (error?.code === '23514' && error?.constraint === 'ck_facturas_reversiones_motivo') {
      throw createReversionError(
        409,
        'VENTAS_REVERSION_MOTIVO_NO_HABILITADO',
        'El motivo seleccionado no está habilitado para reversiones.'
      );
    }
    throw mappedError;
  } finally {
    client.release();
  }
};

export { VALID_MOTIVOS, createReversionError };
