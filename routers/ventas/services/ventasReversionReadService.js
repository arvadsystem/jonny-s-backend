// Endpoints de solo lectura de reversion de venta (Fase 2):
// GET /ventas/:id/reversion-context y POST /ventas/:id/reversion-preview.
// El frontend NUNCA debe calcular elegibilidad ni montos criticos: ambos
// endpoints recalculan siempre desde la base de datos.
import pool from '../../../config/db-connection.js';
import { parsePositiveInt, normalizeTextKey } from '../utils/parseUtils.js';
import { ESTADO_PEDIDO_CODES } from '../constants.js';
import {
  resolveSucursalScope,
  assertSucursalAllowedForReversion,
  createReversionError
} from '../../../services/ventasReversionService.js';
import {
  buildRequestedLines,
  resolveFacturaLinesForUpdate,
  resolveAlreadyReversedQty,
  resolveReversionLines,
  computeFacturaTotal,
  computeAccumulatedResult
} from './ventasReversionCalculationService.js';

const roundToTwo = (value) => Number(Number(value || 0).toFixed(2));

const ALLOWED_PEDIDO_STATE_CODES = new Set(['PENDIENTE', 'EN_COCINA']);

const resolvePedidoStateCode = (descripcion) => {
  const normalized = normalizeTextKey(descripcion);
  for (const [code, aliases] of Object.entries(ESTADO_PEDIDO_CODES)) {
    if (aliases.has(normalized)) return code;
  }
  return null;
};

const loadFacturaForRead = async (client, facturaId) => {
  const result = await client.query(
    `
      SELECT
        f.id_factura,
        f.codigo_venta,
        f.id_sucursal,
        f.id_caja,
        f.id_sesion_caja,
        f.id_pedido
      FROM public.facturas f
      WHERE f.id_factura = $1
      LIMIT 1
    `,
    [facturaId]
  );
  return result.rows?.[0] || null;
};

/**
 * Resolucion de sesion original SIN bloqueos (solo lectura, informativa).
 * La transaccion real de creacion vuelve a resolver y bloquear todo desde
 * cero: este helper nunca es la fuente de verdad para autorizar nada.
 */
const resolveSesionOriginalInfo = async (client, { idFactura, idSucursal }) => {
  const cobrosResult = await client.query(
    `SELECT DISTINCT id_sesion_caja FROM public.facturas_cobros WHERE id_factura = $1`,
    [idFactura]
  );
  const sessionIds = [...new Set(
    cobrosResult.rows.map((row) => parsePositiveInt(row.id_sesion_caja)).filter(Boolean)
  )];

  if (sessionIds.length === 0) {
    return { reversible: false, code: 'VENTAS_REVERSION_SESSION_MISSING', motivo_bloqueo: 'La venta no tiene una sesión de caja original válida.', sesion: null };
  }
  if (sessionIds.length > 1) {
    return { reversible: false, code: 'VENTAS_REVERSION_SESSION_AMBIGUOUS', motivo_bloqueo: 'La venta tiene cobros asociados a más de una sesión de caja.', sesion: null };
  }

  const idSesionCaja = sessionIds[0];
  const sessionResult = await client.query(
    `
      SELECT
        cs.id_sesion_caja, cs.id_caja, cs.id_sucursal, cs.fecha_cierre,
        UPPER(TRIM(cse.codigo)) AS estado_codigo,
        COALESCE(c.estado, true) AS caja_activa
      FROM public.cajas_sesiones cs
      LEFT JOIN public.cat_cajas_sesiones_estados cse ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
      LEFT JOIN public.cajas c ON c.id_caja = cs.id_caja AND c.id_sucursal = cs.id_sucursal
      WHERE cs.id_sesion_caja = $1
      LIMIT 1
    `,
    [idSesionCaja]
  );
  const session = sessionResult.rows?.[0];
  const isOpen = Boolean(session)
    && Number(session.id_sucursal) === idSucursal
    && Boolean(session.caja_activa)
    && session.estado_codigo === 'ABIERTA'
    && !session.fecha_cierre;

  if (!isOpen) {
    return {
      reversible: false,
      code: 'VENTAS_REVERSION_SESION_CERRADA',
      motivo_bloqueo: 'La sesión original de caja ya fue cerrada.',
      sesion: session ? {
        id_sesion_caja: Number(session.id_sesion_caja),
        id_caja: Number(session.id_caja),
        estado: session.estado_codigo || 'DESCONOCIDO'
      } : null
    };
  }

  return {
    reversible: true,
    code: null,
    motivo_bloqueo: null,
    sesion: {
      id_sesion_caja: Number(session.id_sesion_caja),
      id_caja: Number(session.id_caja),
      estado: 'ABIERTA'
    }
  };
};

const resolvePedidoInfo = async (client, idPedido) => {
  if (!idPedido) return { reversible: true, code: null, motivo_bloqueo: null, pedido: null };

  const result = await client.query(
    `
      SELECT p.id_pedido, p.en_preparacion_at, ep.descripcion AS estado_descripcion
      FROM public.pedidos p
      LEFT JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      WHERE p.id_pedido = $1
      LIMIT 1
    `,
    [idPedido]
  );
  const pedido = result.rows?.[0];
  if (!pedido) return { reversible: true, code: null, motivo_bloqueo: null, pedido: null };

  const stateCode = resolvePedidoStateCode(pedido.estado_descripcion);
  const preparacionIniciada = pedido.en_preparacion_at !== null && pedido.en_preparacion_at !== undefined;
  const allowed = ALLOWED_PEDIDO_STATE_CODES.has(stateCode) && !preparacionIniciada;

  return {
    reversible: allowed,
    code: allowed ? null : 'VENTAS_REVERSION_PREPARACION_INICIADA',
    motivo_bloqueo: allowed ? null : 'La venta ya inició preparación y no puede reversarse.',
    pedido: {
      id_pedido: Number(pedido.id_pedido),
      estado: stateCode || 'DESCONOCIDO',
      preparacion_iniciada: preparacionIniciada
    }
  };
};

const loadItemsInfo = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT
        df.id_detalle_factura,
        COALESCE(df.cantidad, 0)::int AS cantidad_original,
        COALESCE(df.total_detalle, 0)::numeric(12,2) AS total_original,
        COALESCE(
          dfo.origen_snapshot->>'nombre_item',
          df.origen_snapshot->>'nombre_item',
          prod.nombre_producto,
          rec.nombre_receta,
          'Item'
        ) AS nombre,
        COALESCE(rev.cantidad_reversada, 0)::int AS cantidad_reversada,
        COALESCE(rev.total_reversado, 0)::numeric(12,2) AS total_reversado
      FROM public.detalle_facturas df
      LEFT JOIN public.detalle_facturas_origen dfo ON dfo.id_detalle_factura = df.id_detalle_factura
      LEFT JOIN public.productos prod ON prod.id_producto = COALESCE(dfo.id_producto, df.id_producto)
      LEFT JOIN public.recetas rec ON rec.id_receta = COALESCE(dfo.id_receta, df.id_receta::int)
      LEFT JOIN LATERAL (
        SELECT
          SUM(rd.cantidad_revertida)::int AS cantidad_reversada,
          SUM(rd.total_revertido)::numeric(12,2) AS total_reversado
        FROM public.facturas_reversiones_detalle rd
        INNER JOIN public.facturas_reversiones fr ON fr.id_reversion = rd.id_reversion
        WHERE rd.id_detalle_factura = df.id_detalle_factura
          AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
      ) rev ON true
      WHERE df.id_factura = $1
      ORDER BY df.id_detalle_factura
    `,
    [idFactura]
  );

  return result.rows.map((row) => ({
    id_detalle_factura: Number(row.id_detalle_factura),
    nombre: row.nombre,
    cantidad_original: Number(row.cantidad_original),
    cantidad_reversada: Number(row.cantidad_reversada),
    cantidad_disponible: Math.max(0, Number(row.cantidad_original) - Number(row.cantidad_reversada)),
    total_original: Number(row.total_original),
    total_reversado: Number(row.total_reversado),
    total_disponible: Math.max(0, Number((Number(row.total_original) - Number(row.total_reversado)).toFixed(2)))
  }));
};

export const getVentaReversionContext = async ({ idFactura, idUsuario }) => {
  const facturaId = parsePositiveInt(idFactura);
  const userId = parsePositiveInt(idUsuario);
  if (!facturaId || !userId) {
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Parámetros inválidos.');
  }

  const client = await pool.connect();
  try {
    const scope = await resolveSucursalScope(client, userId);
    const factura = await loadFacturaForRead(client, facturaId);
    if (!factura) {
      throw createReversionError(404, 'VENTAS_REVERSION_FACTURA_NOT_FOUND', 'Venta no encontrada.');
    }
    const idSucursal = Number(factura.id_sucursal || 0);
    assertSucursalAllowedForReversion(scope, idSucursal, 'consultar');

    const items = await loadItemsInfo(client, facturaId);
    const totalOriginal = roundToTwo(items.reduce((sum, item) => sum + item.total_original, 0));
    const totalReversado = roundToTwo(items.reduce((sum, item) => sum + item.total_reversado, 0));
    const totalRestante = Math.max(0, roundToTwo(totalOriginal - totalReversado));
    const estadoReversion = totalReversado <= 0
      ? 'NINGUNA'
      : totalRestante <= 0
        ? 'TOTAL'
        : 'PARCIAL';

    const sesionInfo = await resolveSesionOriginalInfo(client, { idFactura: facturaId, idSucursal });
    const pedidoInfo = sesionInfo.reversible
      ? await resolvePedidoInfo(client, parsePositiveInt(factura.id_pedido))
      : { reversible: true, code: null, motivo_bloqueo: null, pedido: null };

    const bloqueoActivo = !sesionInfo.reversible
      ? sesionInfo
      : (!pedidoInfo.reversible ? pedidoInfo : (totalRestante <= 0 ? {
        reversible: false,
        code: 'VENTAS_REVERSION_TOTALMENTE_APLICADA',
        motivo_bloqueo: 'La factura ya fue reversada completamente.'
      } : { reversible: true, code: null, motivo_bloqueo: null }));

    return {
      reversible: bloqueoActivo.reversible,
      code: bloqueoActivo.code,
      motivo_bloqueo: bloqueoActivo.motivo_bloqueo,
      sesion_original: sesionInfo.sesion,
      pedido: pedidoInfo.pedido,
      factura: {
        id_factura: facturaId,
        total_original: totalOriginal,
        total_reversado: totalReversado,
        total_restante: totalRestante,
        estado_reversion: estadoReversion
      },
      items
    };
  } finally {
    client.release();
  }
};

export const previewVentaReversion = async ({ idFactura, idUsuario, body }) => {
  const facturaId = parsePositiveInt(idFactura);
  const userId = parsePositiveInt(idUsuario);
  if (!facturaId || !userId) {
    throw createReversionError(400, 'VENTAS_REVERSION_PARAM_INVALIDO', 'Parámetros inválidos.');
  }

  const tipoReversion = String(body?.tipo_reversion || '').trim().toUpperCase();
  if (!['TOTAL', 'PARCIAL'].includes(tipoReversion)) {
    throw createReversionError(400, 'VENTAS_REVERSION_TIPO_INVALIDO', 'tipo_reversion debe ser TOTAL o PARCIAL.');
  }

  const requestedLines = tipoReversion === 'PARCIAL' ? buildRequestedLines(body?.lineas) : new Map();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const scope = await resolveSucursalScope(client, userId);
      const factura = await loadFacturaForRead(client, facturaId);
      if (!factura) {
        throw createReversionError(404, 'VENTAS_REVERSION_FACTURA_NOT_FOUND', 'Venta no encontrada.');
      }
      const idSucursal = Number(factura.id_sucursal || 0);
      assertSucursalAllowedForReversion(scope, idSucursal, 'consultar');

      const facturaLines = await resolveFacturaLinesForUpdate(client, facturaId);
      const reversedQtyMapBefore = await resolveAlreadyReversedQty(client, facturaId);
      const reversionLines = resolveReversionLines({
        tipoReversion,
        requestedLines,
        facturaLines,
        reversedQtyMap: reversedQtyMapBefore
      });
      const totalFactura = await computeFacturaTotal(client, facturaId);
      const accumulated = computeAccumulatedResult({ facturaLines, reversedQtyMapBefore, reversionLines });

      const subtotal = roundToTwo(reversionLines.reduce((sum, line) => sum + Number(line.subtotal_revertido || 0), 0));
      const descuento = roundToTwo(reversionLines.reduce((sum, line) => sum + Number(line.descuento_revertido || 0), 0));
      const isv15 = roundToTwo(reversionLines.reduce((sum, line) => sum + Number(line.isv_15_revertido || 0), 0));
      const isv18 = roundToTwo(reversionLines.reduce((sum, line) => sum + Number(line.isv_18_revertido || 0), 0));
      const total = roundToTwo(reversionLines.reduce((sum, line) => sum + Number(line.total_revertido || 0), 0));

      return {
        tipo_reversion_solicitado: tipoReversion,
        subtotal,
        descuento,
        isv_15: isv15,
        isv_18: isv18,
        total,
        total_factura: totalFactura,
        estado_acumulado_resultante: accumulated.resultado_acumulado,
        cantidad_restante_resultante: accumulated.cantidad_restante_final,
        factura_totalmente_reversada: accumulated.factura_totalmente_reversada,
        lineas: reversionLines.map((line) => ({
          id_detalle_factura: line.id_detalle_factura,
          cantidad_revertida: line.cantidad_revertida,
          subtotal_revertido: line.subtotal_revertido,
          descuento_revertido: line.descuento_revertido,
          isv_15_revertido: line.isv_15_revertido,
          isv_18_revertido: line.isv_18_revertido,
          total_revertido: line.total_revertido
        })),
        // Inventario, puntos pendientes e impresion se calculan en fases
        // posteriores (3/4/5); no se inventan aqui.
        disponible_en_fase_posterior: {
          inventario: false,
          puntos_pendientes: false,
          impresion: false
        }
      };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
  } finally {
    client.release();
  }
};
