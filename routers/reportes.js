import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();

const BASE_PERMISSION = 'REPORTES_VER';

const REPORT_DEFINITIONS = Object.freeze({
  '/reportes/ventas/resumen': {
    key: 'ventas_resumen',
    permissions: ['REPORTES_VENTAS_RESUMEN_VER']
  },
  '/reportes/ventas/metodos-pago': {
    key: 'ventas_metodos_pago',
    permissions: ['REPORTES_VENTAS_METODOS_PAGO_VER']
  },
  '/reportes/caja/cierres': {
    key: 'caja_cierres',
    permissions: ['REPORTES_CAJA_CIERRES_VER']
  },
  '/reportes/caja/diferencias': {
    key: 'caja_diferencias',
    permissions: ['REPORTES_CAJA_DIFERENCIAS_VER']
  },
  '/reportes/inventario/stock-critico': {
    key: 'inventario_stock_critico',
    permissions: ['REPORTES_INVENTARIO_STOCK_CRITICO_VER']
  },
  '/reportes/inventario/kardex': {
    key: 'inventario_kardex',
    permissions: ['REPORTES_INVENTARIO_KARDEX_VER']
  },
  '/reportes/ventas/descuentos': {
    key: 'ventas_descuentos',
    permissions: ['REPORTES_VENTAS_DESCUENTOS_VER']
  },
  '/reportes/ventas/items': {
    key: 'ventas_items',
    permissions: ['REPORTES_VENTAS_ITEMS_VER']
  }
});

const FILTER_KEYS = Object.freeze([
  'fecha_inicio',
  'fecha_fin',
  'sucursal',
  'caja',
  'usuario',
  'metodo_pago',
  'producto',
  'categoria',
  'estado',
  'proveedor',
  'tipo_movimiento'
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const normalizeFilterValue = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const parseFilters = (query = {}) => {
  const filters = {};

  for (const key of FILTER_KEYS) {
    const value = normalizeFilterValue(query[key]);
    if (value !== null) filters[key] = value;
  }

  const fechaInicio = filters.fecha_inicio || null;
  const fechaFin = filters.fecha_fin || null;

  if (fechaInicio && !DATE_RE.test(fechaInicio)) {
    return { ok: false, message: 'La fecha_inicio debe usar formato YYYY-MM-DD.' };
  }

  if (fechaFin && !DATE_RE.test(fechaFin)) {
    return { ok: false, message: 'La fecha_fin debe usar formato YYYY-MM-DD.' };
  }

  if (fechaInicio && fechaFin && fechaInicio > fechaFin) {
    return { ok: false, message: 'La fecha_inicio no puede ser mayor que fecha_fin.' };
  }

  const idSucursal = filters.sucursal ? parsePositiveInt(filters.sucursal) : null;
  if (filters.sucursal && !idSucursal) {
    return { ok: false, message: 'El filtro sucursal debe ser un ID numerico valido.' };
  }

  const idCaja = filters.caja ? parsePositiveInt(filters.caja) : null;
  if (filters.caja && !idCaja) {
    return { ok: false, message: 'El filtro caja debe ser un ID numerico valido.' };
  }

  const idUsuario = filters.usuario ? parsePositiveInt(filters.usuario) : null;
  if (filters.usuario && !idUsuario) {
    return { ok: false, message: 'El filtro usuario debe ser un ID numerico valido.' };
  }

  return {
    ok: true,
    filters,
    parsed: {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      id_sucursal: idSucursal,
      id_caja: idCaja,
      id_usuario: idUsuario,
      estado: filters.estado || null
    }
  };
};

const sendPhaseOnePayload = (res, reportKey, filters) => {
  return res.json({
    ok: true,
    reporte: reportKey,
    fase: 'fase_1_base',
    filtros: filters,
    data: [],
    meta: {
      pendiente_implementacion_detalle: true,
      generado_en: new Date().toISOString()
    }
  });
};

const buildVentasResumenWhere = ({ parsedFilters, scope, params }) => {
  const where = [];

  if (parsedFilters.fecha_inicio) {
    params.push(parsedFilters.fecha_inicio);
    where.push(`(COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion))::date >= $${params.length}::date`);
  }

  if (parsedFilters.fecha_fin) {
    params.push(parsedFilters.fecha_fin);
    where.push(`(COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion))::date <= $${params.length}::date`);
  }

  if (parsedFilters.id_sucursal) {
    params.push(parsedFilters.id_sucursal);
    where.push(`COALESCE(p.id_sucursal, f.id_sucursal) = $${params.length}`);
  } else if (!scope.isSuperAdmin) {
    const allowed = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter(Boolean)
      : [];

    if (allowed.length === 0) {
      return { forbidden: true, whereClause: '', params };
    }

    params.push(allowed);
    where.push(`COALESCE(p.id_sucursal, f.id_sucursal) = ANY($${params.length}::int[])`);
  }

  if (parsedFilters.id_caja) {
    params.push(parsedFilters.id_caja);
    where.push(`f.id_caja = $${params.length}`);
  }

  if (parsedFilters.id_usuario) {
    params.push(parsedFilters.id_usuario);
    where.push(`COALESCE(p.id_usuario, f.id_usuario) = $${params.length}`);
  }

  if (parsedFilters.estado) {
    params.push(`%${parsedFilters.estado}%`);
    where.push(`COALESCE(ep.descripcion, 'VENTA DIRECTA') ILIKE $${params.length}`);
  }

  return {
    forbidden: false,
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
};

const getVentasResumen = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];

  const built = buildVentasResumenWhere({ parsedFilters, scope, params });
  if (built.forbidden) {
    return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
  }

  const detailQuery = `
    WITH ventas_base AS (
      SELECT
        f.id_factura,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion)::date AS fecha,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        f.id_caja,
        COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado_pedido,
        COALESCE(p.sub_total, df_info.subtotal_neto, 0)::numeric(14,2) AS subtotal,
        COALESCE(df_info.descuento_total, 0)::numeric(14,2) AS descuentos,
        COALESCE(p.isv, COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 0)::numeric(14,2) AS impuestos,
        COALESCE(
          p.total,
          COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
        )::numeric(14,2) AS total_neto
      FROM facturas f
      LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(df.total_detalle), 0)::numeric(14,2) AS subtotal_neto,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(14,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      ${built.whereClause}
    )
    SELECT *
    FROM ventas_base
    ORDER BY fecha ASC, id_factura ASC
  `;

  const detailResult = await pool.query(detailQuery, built.params);
  const rows = Array.isArray(detailResult.rows) ? detailResult.rows : [];

  let subtotal = 0;
  let descuentos = 0;
  let impuestos = 0;
  let totalNeto = 0;
  let canceladas = 0;

  const byDate = new Map();
  const byState = new Map();

  rows.forEach((row) => {
    const fecha = String(row.fecha || '');
    const estado = String(row.estado_pedido || 'VENTA DIRECTA').trim() || 'VENTA DIRECTA';
    const subtotalRow = Number(row.subtotal || 0);
    const descuentosRow = Number(row.descuentos || 0);
    const impuestosRow = Number(row.impuestos || 0);
    const totalRow = Number(row.total_neto || 0);

    subtotal += subtotalRow;
    descuentos += descuentosRow;
    impuestos += impuestosRow;
    totalNeto += totalRow;

    if (/cancelad|anulad/i.test(estado)) canceladas += 1;

    const dayBucket = byDate.get(fecha) || { fecha, cantidad_ventas: 0, total_neto: 0 };
    dayBucket.cantidad_ventas += 1;
    dayBucket.total_neto += totalRow;
    byDate.set(fecha, dayBucket);

    const stateBucket = byState.get(estado) || { estado, cantidad_ventas: 0, total_neto: 0 };
    stateBucket.cantidad_ventas += 1;
    stateBucket.total_neto += totalRow;
    byState.set(estado, stateBucket);
  });

  const cantidadVentas = rows.length;
  const promedioVenta = cantidadVentas > 0 ? totalNeto / cantidadVentas : 0;

  return res.json({
    ok: true,
    reporte: 'ventas_resumen',
    fase: 'fase_2a_real',
    filtros: filters,
    data: {
      kpis: {
        total_ventas: roundMoney(totalNeto),
        cantidad_ventas: cantidadVentas,
        subtotal: roundMoney(subtotal),
        descuentos: roundMoney(descuentos),
        impuestos: roundMoney(impuestos),
        total_neto: roundMoney(totalNeto),
        promedio_por_venta: roundMoney(promedioVenta),
        ventas_canceladas_o_anuladas: canceladas
      },
      serie_diaria: [...byDate.values()].map((item) => ({
        ...item,
        total_neto: roundMoney(item.total_neto)
      })),
      desglose_por_estado: [...byState.values()].map((item) => ({
        ...item,
        total_neto: roundMoney(item.total_neto)
      }))
    },
    meta: {
      fuente_canonica: 'facturas + pedidos + detalle_facturas + descuentos',
      generado_en: new Date().toISOString()
    }
  });
};

router.use('/reportes', checkPermission(BASE_PERMISSION));

Object.entries(REPORT_DEFINITIONS).forEach(([path, config]) => {
  router.get(path, checkPermission([...config.permissions, BASE_PERMISSION]), async (req, res) => {
    try {
      const parsed = parseFilters(req.query || {});
      if (!parsed.ok) {
        return res.status(400).json({ error: true, message: parsed.message });
      }

      if (config.key === 'ventas_resumen') {
        return await getVentasResumen(req, res, parsed.filters, parsed.parsed);
      }

      return sendPhaseOnePayload(res, config.key, parsed.filters);
    } catch (error) {
      return res.status(500).json({ error: true, message: 'No se pudo generar el reporte solicitado.' });
    }
  });
});

export default router;
