import pool from '../config/db-connection.js';
import { generarCodigoDocumento } from './facturacionCorrelativoService.js';
import { getClientIp, parseUserAgent } from '../utils/security/clientInfo.js';
import {
  lockCajaFinancialSessions,
  mapCajaFinancialLockError
} from './cajaFinancialLockService.js';
import { parsePositiveInt } from '../routers/ventas/utils/parseUtils.js';
import { roundMoney } from '../routers/ventas/utils/moneyUtils.js';
import {
  resolveOriginalSessionFromCobros,
  lockAndValidateOriginalCajaSession
} from '../routers/ventas/services/ventasReversionSessionService.js';
import {
  assertPedidoEligibleForReversion,
  resolveCancelledEstadoPedidoIdOrThrow
} from '../routers/ventas/services/ventasReversionEligibilityService.js';
import {
  buildRequestedLines,
  resolveFacturaLinesForUpdate,
  resolveAlreadyReversedQty,
  resolveReversionLines,
  computeFacturaTotal,
  computeAccumulatedResult,
  validatePartialReversionApplicability
} from '../routers/ventas/services/ventasReversionCalculationService.js';
import { returnInventoryForReversionLines } from '../routers/ventas/services/ventasReversionInventoryService.js';
import { applyLoyaltyReversalForFactura } from '../routers/ventas/services/ventasReversionFidelizacionService.js';
import {
  buildVentaReversionPrintStatus,
  enqueueAutomaticVentaReversionPrintJob
} from './ventaReversionPrintService.js';

// Fase 2: eliminada la ventana de 1 hora (REVERSAL_WINDOW_SQL /
// VENTAS_REVERSION_FUERA_VENTANA) y el bloqueo por horario administrativo
// de sucursal (assertSucursalOpenForReversion). Regla definitiva: la venta
// puede reversarse mientras la sesion original (resuelta desde
// facturas_cobros, no desde facturas.id_sesion_caja) permanezca abierta y
// el pedido asociado no haya iniciado preparacion. Ver
// ventasReversionSessionService.js y ventasReversionEligibilityService.js.

const VALID_MOTIVOS = new Set([
  'PRODUCTO_EQUIVOCADO',
  'CANTIDAD_EQUIVOCADA',
  'VENTA_DUPLICADA',
  'CLIENTE_CANCELO',
  'METODO_PAGO_EQUIVOCADO',
  'ERROR_OPERATIVO',
  'OTRO',
  // Compatibilidad hacia atrás (no visibles en frontend nuevo)
  'ERROR_DIGITACION',
  'PRODUCTO_NO_DISPONIBLE',
  'DEVOLUCION',
  'COBRO_INCORRECTO'
]);

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
      'No existe tipo de movimiento de caja REVERSION/REVERSO activo en catálogo.'
    );
  }

  return Number(result.rows[0].id_tipo_movimiento_caja);
};

// Fase 4: eliminada revertLoyaltyForFactura (reemplazada por completo por
// routers/ventas/services/ventasReversionFidelizacionService.js:applyLoyaltyReversalForFactura,
// que corrige la ambiguedad de fuente, el calculo del objetivo acumulado
// real, la deuda de puntos durable (fidelizacion_ajustes_pendientes) y la
// trazabilidad por reversion (id_reversion en fidelizacion_movimientos).

// Fase 3: eliminados por completo registerInventoryReturn (usaba
// productos.id_almacen como respaldo -- prohibido), buildPedidoMovementReturnRows
// y restorePedidoInventoryMovementsForReversion (ratio global de TODO el
// pedido aplicado a TODOS sus movimientos, sin importar la linea
// reversada). Reemplazados por
// routers/ventas/services/ventasReversionInventoryService.js, que
// devuelve inventario por id_detalle_pedido de CADA linea individual y
// aborta con VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED si una linea que
// exige trazabilidad (PRODUCTO/RECETA, o cualquier linea con evidencia de
// consumo de salsa/complemento) no tiene movimiento original rastreable.
//
// Fase 3 (correccion final): eliminados tambien buildSalsaInventorySnapshotsForReturn
// y filterConsumedSalsaSnapshots -- el respaldo ambiguo que agrupaba por
// id_insumo+id_almacen (sin id_detalle_pedido) para "adivinar" que salsas
// devolver cuando el movimiento original por linea no se encontraba. Ese
// respaldo podia: confundir consumo de otra linea del mismo pedido,
// devolver de mas o de menos si dos lineas compartian el mismo insumo y
// almacen, y no absorber el residuo acumulado de parciales. Ahora,
// cualquier linea con evidencia de consumo de salsa/complemento
// (hasSalsaInventoryConsumptionEvidence en ventasReversionCalculationService.js)
// exige trazabilidad exacta igual que PRODUCTO/RECETA: sin movimiento
// original rastreable, la transaccion aborta con
// VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED (rollback completo) en vez de
// usar el respaldo ambiguo.

export const listFacturaReversiones = async ({ idFactura, idUsuario }) => {
  const facturaId = parsePositiveInt(idFactura);
  const userId = parsePositiveInt(idUsuario);
  if (!facturaId || !userId) {
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Parámetros inválidos.');
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
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Solicitud inválida.');
  }

  const tipoReversion = String(body?.tipo_reversion || '').trim().toUpperCase();
  if (!['TOTAL', 'PARCIAL'].includes(tipoReversion)) {
    throw createReversionError(400, 'VENTAS_REVERSION_TIPO_INVALIDO', 'tipo_reversion debe ser TOTAL o PARCIAL.');
  }

  const motivo = normalizeMotivo(body?.motivo);
  if (!VALID_MOTIVOS.has(motivo)) {
    throw createReversionError(400, 'VENTAS_REVERSION_MOTIVO_INVALIDO', 'Motivo de reversión inválido.');
  }

  const observacion = normalizeText(body?.observacion, 300);
  // buildRequestedLines valida formato/limites/duplicados con overflow
  // seguro y lanza sus propios errores 400 (ver
  // ventasReversionCalculationService.js).
  const requestedLines = tipoReversion === 'PARCIAL' ? buildRequestedLines(body?.lineas) : new Map();

  const ip = normalizeText(getClientIp(req), 80) || '-';
  const uaRaw = String(req?.headers?.['user-agent'] || '');
  const ua = parseUserAgent(uaRaw);
  const dispositivo = normalizeText(ua.dispositivo || '', 80) || 'Desconocido';
  const userAgent = normalizeText(uaRaw, 500) || 'Desconocido';

  const client = await pool.connect();
  let idempotencyReservation = null;
  try {
    await client.query('BEGIN');

    // 1) reservar idempotencia
    if (typeof idempotency?.reserve === 'function') {
      idempotencyReservation = await idempotency.reserve(client);
      if (idempotencyReservation?.replay || idempotencyReservation?.conflict) {
        await client.query('COMMIT');
        return { idempotency: idempotencyReservation };
      }
    }

    const scope = await resolveSucursalScope(client, userId);

    // 2) bloquear factura
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

    // 3) bloquear detalles de factura
    const facturaLines = await resolveFacturaLinesForUpdate(client, facturaId);

    // 4) bloquear cobros + 5) resolver sesion original (facturas_cobros, no
    // facturas.id_sesion_caja)
    const resolvedSession = await resolveOriginalSessionFromCobros({
      client,
      idFactura: facturaId,
      facturaIdSesionCaja: factura.id_sesion_caja
    });

    // 6) bloquear sesion de caja original y validar que siga ABIERTA
    const sessionContext = await lockAndValidateOriginalCajaSession({
      client,
      idSesionCaja: resolvedSession.id_sesion_caja,
      idSucursal
    });

    // 7) bloquear pedido + validar elegibilidad de Cocina (venta directa
    // sin pedido: no hay nada que validar, se permite)
    await assertPedidoEligibleForReversion({ client, idPedido: factura.id_pedido });

    // 8) bloquear reversiones anteriores + calcular saldos reversables
    const reversedQtyMapBefore = await resolveAlreadyReversedQty(client, facturaId);
    validatePartialReversionApplicability({ tipoReversion, facturaLines, reversedQtyMap: reversedQtyMapBefore });

    const reversionLines = resolveReversionLines({
      tipoReversion,
      requestedLines,
      facturaLines,
      reversedQtyMap: reversedQtyMapBefore
    });

    const idTipoMovimientoCaja = await resolveReversionCajaMovementType(client);

    const correlativo = await generarCodigoDocumento({
      client,
      idSucursal,
      tipoDocumento: 'REVERSION'
    });

    const montoReversado = roundMoney(reversionLines.reduce((acc, line) => acc + Number(line.total_revertido || 0), 0));
    const totalFactura = await computeFacturaTotal(client, facturaId);
    const accumulated = computeAccumulatedResult({ facturaLines, reversedQtyMapBefore, reversionLines });

    // 9) insertar reversion (cabecera).
    // id_caja_actual/id_sesion_caja_actual: el esquema de
    // facturas_reversiones obliga a NOT NULL en estas columnas "actual".
    // Fase 2 elimina el concepto de "caja actual distinta de la original"
    // (ver seccion 20 del ticket): se almacena aqui EXACTAMENTE el mismo
    // valor que id_caja_original/id_sesion_caja_original, porque la unica
    // sesion valida para reversar es la original resuelta desde
    // facturas_cobros -- nunca una sesion "actualmente abierta" distinta.
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
          $1, $2, $3, $4, $5, $4, $5,
          $6, $7, $8, $9, 'APLICADA', $10,
          $11::date, $12, $13, $14, false
        )
        RETURNING id_reversion
      `,
      [
        correlativo.codigo,
        facturaId,
        idSucursal,
        sessionContext.id_caja,
        sessionContext.id_sesion_caja,
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

    // 10) insertar detalles
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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

    // 11) registrar movimiento de caja en la sesion ORIGINAL (nunca en una
    // sesion distinta)
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
        sessionContext.id_sesion_caja,
        sessionContext.id_caja,
        idSucursal,
        idTipoMovimientoCaja,
        userId,
        montoReversado,
        correlativo.codigo,
        `Reversión ${correlativo.codigo} de venta ${factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`}`
      ]
    );

    // Fidelizacion (Fase 4): reversion de puntos por el resultado ACUMULADO
    // real (accumulated.factura_totalmente_reversada), nunca por
    // tipo_reversion solicitado. Si falta saldo disponible, el remanente
    // se registra como deuda durable en fidelizacion_ajustes_pendientes
    // (o aborta con FIDELIZACION_SCHEMA_PENDIENTE si esa tabla no existe
    // todavia) -- nunca se descarta en silencio. Debe seguir ejecutandose
    // dentro de la MISMA transaccion que Caja e inventario: cualquier
    // error aqui hace ROLLBACK completo (sin REV, sin Caja, sin
    // inventario devuelto).
    const loyalty = await applyLoyaltyReversalForFactura({
      client,
      idFactura: facturaId,
      idSucursal,
      idUsuario: userId,
      tipoReversion,
      idReversion,
      codigoReversion: correlativo.codigo,
      totalFactura,
      facturaTotalmenteReversada: accumulated.factura_totalmente_reversada
    });

    // Devolucion de inventario POR LINEA (Fase 3): cada linea reversada se
    // resuelve exclusivamente contra sus propios movimientos SALIDA
    // originales (via id_detalle_pedido), nunca contra un ratio agregado
    // de todo el pedido ni contra un respaldo ambiguo por
    // insumo+almacen. Lineas PRODUCTO/RECETA, y cualquier linea con
    // evidencia de consumo de salsa/complemento, sin movimiento original
    // trazable abortan con VENTAS_REVERSION_INVENTARIO_TRACE_REQUIRED,
    // provocando ROLLBACK completo (sin REV, sin movimiento de caja, sin
    // puntos retirados, sin pedido cancelado, sin inventario parcial) --
    // ver routers/ventas/services/ventasReversionInventoryService.js.
    const codigoVenta = factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`;
    await returnInventoryForReversionLines({
      client,
      reversionLines,
      idPedido: factura.id_pedido,
      idReversion,
      codigoReversion: correlativo.codigo,
      codigoVenta,
      idUsuario: userId,
      reversedQtyMapBefore
    });

    // 12) actualizar estados finales cuando corresponda. Si la factura
    // queda totalmente reversada (segun el resultado ACUMULADO real, sin
    // importar si esta operacion puntual fue solicitada como PARCIAL) y
    // tiene pedido asociado, se cancela el pedido y se anula el pago. Si
    // el catalogo CANCELADO no esta configurado en este entorno, la
    // transaccion completa aborta (ROLLBACK) en vez de dejar el pedido en
    // un estado incorrecto o de confirmar la reversion financiera sin la
    // transicion de estado correspondiente.
    let estadoFinal = null;
    if (accumulated.factura_totalmente_reversada && factura.id_pedido) {
      const idEstadoCancelado = await resolveCancelledEstadoPedidoIdOrThrow(client);
      await client.query(
        `
          UPDATE public.pedidos
          SET id_estado_pedido = $2,
              estado_pago = 'PAGO_ANULADO'
          WHERE id_pedido = $1
        `,
        [factura.id_pedido, idEstadoCancelado]
      );
      estadoFinal = { estado_pago: 'PAGO_ANULADO', estado_pedido: 'CANCELADO' };
    }
    // Venta directa (sin pedido) totalmente reversada: facturas no tiene
    // columna de estado propia (confirmado en la auditoria de Fase 0); no
    // hay nada adicional que actualizar.

    const result = {
      id_reversion: idReversion,
      codigo_reversion: correlativo.codigo,
      fecha_operacion: correlativo.fecha_operacion,
      tipo_reversion_solicitado: tipoReversion,
      tipo_reversion: tipoReversion,
      motivo,
      observacion,
      monto_reversado: montoReversado,
      total_factura: totalFactura,
      codigo_venta: factura.codigo_venta || `VTA-${String(facturaId).padStart(5, '0')}`,
      id_factura_original: facturaId,
      id_sucursal: idSucursal,
      id_caja_original: sessionContext.id_caja,
      id_sesion_caja_original: sessionContext.id_sesion_caja,
      id_caja_actual: sessionContext.id_caja,
      id_sesion_caja_actual: sessionContext.id_sesion_caja,
      lineas: reversionLines,
      resultado_acumulado: accumulated.resultado_acumulado,
      cantidad_restante_final: accumulated.cantidad_restante_final,
      factura_totalmente_reversada: accumulated.factura_totalmente_reversada,
      estado_final: estadoFinal,
      fidelizacion: loyalty,
      auditoria: {
        ip_origen: ip,
        dispositivo,
        user_agent: userAgent
      }
    };

    // Fase 5: el trabajo inicial y su PDF canonico quedan durables dentro de
    // la misma transaccion financiera. No se contacta al agente ni a QZ aqui;
    // una impresora apagada no puede deshacer la reversion.
    const printResult = await enqueueAutomaticVentaReversionPrintJob({
      client,
      idReversion,
      idFactura: facturaId,
      idSucursal,
      idUsuario: userId
    });
    result.impresion = buildVentaReversionPrintStatus(printResult);

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

export {
  VALID_MOTIVOS,
  createReversionError,
  resolveSucursalScope,
  assertSucursalAllowedForReversion
};
