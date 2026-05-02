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
  'tipo_diferencia',
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
      estado: filters.estado || null,
      metodo_pago: filters.metodo_pago || null,
      tipo_diferencia: filters.tipo_diferencia || null
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

const buildVentasScopeWhere = ({ parsedFilters, scope, params }) => {
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

  const built = buildVentasScopeWhere({ parsedFilters, scope, params });
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

const getVentasMetodosPago = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const built = buildVentasScopeWhere({ parsedFilters, scope, params });

  if (built.forbidden) {
    return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
  }

  if (parsedFilters.metodo_pago) {
    params.push(`%${parsedFilters.metodo_pago}%`);
    built.whereClause = built.whereClause
      ? `${built.whereClause} AND (cmp.nombre ILIKE $${params.length} OR cmp.codigo ILIKE $${params.length})`
      : `WHERE (cmp.nombre ILIKE $${params.length} OR cmp.codigo ILIKE $${params.length})`;
  }

  const query = `
    WITH cobros_base AS (
      SELECT
        f.id_factura,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion)::date AS fecha,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        f.id_caja,
        COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado_pedido,
        cmp.id_metodo_pago,
        cmp.codigo AS metodo_pago_codigo,
        cmp.nombre AS metodo_pago_nombre,
        COALESCE(fc.monto, 0)::numeric(14,2) AS monto
      FROM facturas f
      INNER JOIN facturas_cobros fc ON fc.id_factura = f.id_factura
      INNER JOIN cat_metodos_pago cmp ON cmp.id_metodo_pago = fc.id_metodo_pago
      LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      ${built.whereClause}
    )
    SELECT * FROM cobros_base
    ORDER BY fecha ASC, id_factura ASC, metodo_pago_nombre ASC
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const byMethod = new Map();
  const byDayMethod = new Map();
  let totalGeneral = 0;

  rows.forEach((row) => {
    const methodKey = String(row.metodo_pago_codigo || row.metodo_pago_nombre || row.id_metodo_pago);
    const methodName = String(row.metodo_pago_nombre || 'Sin metodo');
    const monto = Number(row.monto || 0);
    const facturaId = Number(row.id_factura || 0);
    const fecha = String(row.fecha || '');

    totalGeneral += monto;

    if (!byMethod.has(methodKey)) {
      byMethod.set(methodKey, {
        metodo_pago: methodName,
        metodo_pago_codigo: String(row.metodo_pago_codigo || ''),
        cantidad_ventas: 0,
        total_vendido: 0,
        _facturas: new Set()
      });
    }

    const bucket = byMethod.get(methodKey);
    bucket.total_vendido += monto;
    if (facturaId > 0) bucket._facturas.add(facturaId);

    const dayMethodKey = `${fecha}__${methodKey}`;
    if (!byDayMethod.has(dayMethodKey)) {
      byDayMethod.set(dayMethodKey, {
        fecha,
        metodo_pago: methodName,
        metodo_pago_codigo: String(row.metodo_pago_codigo || ''),
        cantidad_ventas: 0,
        total_vendido: 0,
        _facturas: new Set()
      });
    }
    const dayBucket = byDayMethod.get(dayMethodKey);
    dayBucket.total_vendido += monto;
    if (facturaId > 0) dayBucket._facturas.add(facturaId);
  });

  const resumenMetodos = [...byMethod.values()]
    .map((item) => {
      const cantidadVentas = item._facturas.size;
      const totalVendido = roundMoney(item.total_vendido);
      const porcentaje = totalGeneral > 0 ? roundMoney((item.total_vendido / totalGeneral) * 100) : 0;
      const ticketPromedio = cantidadVentas > 0 ? roundMoney(item.total_vendido / cantidadVentas) : 0;
      return {
        metodo_pago: item.metodo_pago,
        metodo_pago_codigo: item.metodo_pago_codigo,
        cantidad_ventas: cantidadVentas,
        total_vendido: totalVendido,
        porcentaje_sobre_total: porcentaje,
        ticket_promedio: ticketPromedio
      };
    })
    .sort((a, b) => b.total_vendido - a.total_vendido);

  const serieDiariaMetodo = [...byDayMethod.values()]
    .map((item) => ({
      fecha: item.fecha,
      metodo_pago: item.metodo_pago,
      metodo_pago_codigo: item.metodo_pago_codigo,
      cantidad_ventas: item._facturas.size,
      total_vendido: roundMoney(item.total_vendido)
    }))
    .sort((a, b) => {
      if (a.fecha === b.fecha) return a.metodo_pago.localeCompare(b.metodo_pago, 'es', { sensitivity: 'base' });
      return String(a.fecha).localeCompare(String(b.fecha));
    });

  const totalVentasUnicas = new Set(rows.map((row) => Number(row.id_factura || 0)).filter(Boolean)).size;

  return res.json({
    ok: true,
    reporte: 'ventas_metodos_pago',
    fase: 'fase_2b_real',
    filtros: filters,
    data: {
      kpis: {
        total_general: roundMoney(totalGeneral),
        total_ventas: totalVentasUnicas,
        metodos_activos: resumenMetodos.length
      },
      resumen_por_metodo: resumenMetodos,
      serie_diaria_por_metodo: serieDiariaMetodo
    },
    meta: {
      fuente_canonica: 'facturas + facturas_cobros + cat_metodos_pago (+ pedidos/estados_pedido para filtros)',
      generado_en: new Date().toISOString()
    }
  });
};

const buildCajaCierresScopeWhere = ({ parsedFilters, scope, params }) => {
  const where = [];

  if (parsedFilters.fecha_inicio) {
    params.push(parsedFilters.fecha_inicio);
    where.push(`cc.fecha_cierre::date >= $${params.length}::date`);
  }

  if (parsedFilters.fecha_fin) {
    params.push(parsedFilters.fecha_fin);
    where.push(`cc.fecha_cierre::date <= $${params.length}::date`);
  }

  if (parsedFilters.id_sucursal) {
    params.push(parsedFilters.id_sucursal);
    where.push(`cc.id_sucursal = $${params.length}`);
  } else if (!scope.isSuperAdmin) {
    const allowed = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter(Boolean)
      : [];

    if (allowed.length === 0) {
      return { forbidden: true, whereClause: '', params };
    }

    params.push(allowed);
    where.push(`cc.id_sucursal = ANY($${params.length}::int[])`);
  }

  if (parsedFilters.id_caja) {
    params.push(parsedFilters.id_caja);
    where.push(`cc.id_caja = $${params.length}`);
  }

  if (parsedFilters.id_usuario) {
    params.push(parsedFilters.id_usuario);
    where.push(`(cc.id_usuario_responsable = $${params.length} OR cc.id_usuario_cierre = $${params.length})`);
  }

  if (parsedFilters.estado) {
    params.push(`%${parsedFilters.estado}%`);
    where.push(`COALESCE(resolucion.nombre, 'SIN RESOLUCION') ILIKE $${params.length}`);
  }

  return {
    forbidden: false,
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
};

const getCajaCierres = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const built = buildCajaCierresScopeWhere({ parsedFilters, scope, params });

  if (built.forbidden) {
    return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
  }

  const query = `
    SELECT
      cc.id_cierre_caja,
      cc.id_sucursal,
      cc.id_caja,
      cc.id_usuario_responsable,
      cc.id_usuario_cierre,
      NULL::timestamp AS fecha_apertura,
      cc.fecha_cierre,
      COALESCE(cc.monto_teorico_cierre, 0)::numeric(14,2) AS total_esperado,
      COALESCE(cc.monto_declarado_cierre, 0)::numeric(14,2) AS total_contado,
      COALESCE(cc.diferencia, 0)::numeric(14,2) AS diferencia,
      c.codigo_caja,
      c.nombre_caja,
      s.nombre_sucursal,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_cierre.nombre, per_cierre.apellido)), ''), cierre.nombre_usuario) AS usuario_cierre,
      COALESCE(resolucion.nombre, 'SIN RESOLUCION') AS estado_cierre
    FROM public.cajas_cierres cc
    INNER JOIN public.cajas c ON c.id_caja = cc.id_caja
    INNER JOIN public.sucursales s ON s.id_sucursal = cc.id_sucursal
    INNER JOIN public.usuarios resp ON resp.id_usuario = cc.id_usuario_responsable
    LEFT JOIN public.empleados e_resp ON e_resp.id_empleado = resp.id_empleado
    LEFT JOIN public.personas per_resp ON per_resp.id_persona = e_resp.id_persona
    LEFT JOIN public.usuarios cierre ON cierre.id_usuario = cc.id_usuario_cierre
    LEFT JOIN public.empleados e_cierre ON e_cierre.id_empleado = cierre.id_empleado
    LEFT JOIN public.personas per_cierre ON per_cierre.id_persona = e_cierre.id_persona
    LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
    ${built.whereClause}
    ORDER BY cc.fecha_cierre DESC, cc.id_cierre_caja DESC
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const totals = rows.reduce(
    (acc, row) => {
      const esperado = Number(row.total_esperado || 0);
      const contado = Number(row.total_contado || 0);
      const diferencia = Number(row.diferencia || 0);
      const hasDifference = Math.abs(diferencia) > 0.009;

      acc.totalEsperado += esperado;
      acc.totalContado += contado;
      acc.totalDiferencia += diferencia;
      if (hasDifference) acc.conDiferencia += 1;
      else acc.sinDiferencia += 1;
      return acc;
    },
    {
      totalEsperado: 0,
      totalContado: 0,
      totalDiferencia: 0,
      conDiferencia: 0,
      sinDiferencia: 0
    }
  );

  return res.json({
    ok: true,
    reporte: 'caja_cierres',
    fase: 'fase_2c_real',
    filtros: filters,
    data: {
      kpis: {
        cantidad_cierres: rows.length,
        total_esperado: roundMoney(totals.totalEsperado),
        total_contado: roundMoney(totals.totalContado),
        diferencia_total: roundMoney(totals.totalDiferencia),
        cierres_con_diferencia: totals.conDiferencia,
        cierres_sin_diferencia: totals.sinDiferencia
      },
      cierres: rows.map((row) => ({
        id_cierre_caja: row.id_cierre_caja,
        fecha_apertura: row.fecha_apertura,
        fecha_cierre: row.fecha_cierre,
        sucursal: row.nombre_sucursal,
        caja: row.nombre_caja,
        codigo_caja: row.codigo_caja,
        responsable: row.responsable,
        usuario_cierre: row.usuario_cierre,
        total_esperado: roundMoney(row.total_esperado),
        total_contado: roundMoney(row.total_contado),
        diferencia: roundMoney(row.diferencia),
        estado_cierre: row.estado_cierre
      }))
    },
    meta: {
      fuente_canonica: 'cajas_cierres + cajas + sucursales + usuarios + cat_cajas_resoluciones_cierre',
      generado_en: new Date().toISOString()
    }
  });
};

const getCajaDiferencias = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const built = buildCajaCierresScopeWhere({ parsedFilters, scope, params });

  if (built.forbidden) {
    return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
  }

  const tipoDiferencia = String(parsedFilters.tipo_diferencia || '').trim().toLowerCase();
  if (tipoDiferencia && !['faltante', 'sobrante'].includes(tipoDiferencia)) {
    return res.status(400).json({
      error: true,
      message: 'El filtro tipo_diferencia solo permite: faltante o sobrante.'
    });
  }

  let tipoWhere = 'AND ABS(COALESCE(cc.diferencia, 0)) > 0.009';
  if (tipoDiferencia === 'faltante') {
    tipoWhere += ' AND COALESCE(cc.diferencia, 0) < 0';
  } else if (tipoDiferencia === 'sobrante') {
    tipoWhere += ' AND COALESCE(cc.diferencia, 0) > 0';
  }

  const query = `
    SELECT
      cc.id_cierre_caja,
      cc.id_sucursal,
      cc.id_caja,
      cc.id_usuario_responsable,
      cc.id_usuario_cierre,
      cc.fecha_cierre,
      COALESCE(cc.monto_teorico_cierre, 0)::numeric(14,2) AS total_esperado,
      COALESCE(cc.monto_declarado_cierre, 0)::numeric(14,2) AS total_contado,
      COALESCE(cc.diferencia, 0)::numeric(14,2) AS diferencia,
      c.codigo_caja,
      c.nombre_caja,
      s.nombre_sucursal,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', per_resp.nombre, per_resp.apellido)), ''), resp.nombre_usuario) AS responsable,
      COALESCE(resolucion.nombre, 'SIN RESOLUCION') AS estado_resolucion,
      COALESCE(cc.observacion, '') AS observacion
    FROM public.cajas_cierres cc
    INNER JOIN public.cajas c ON c.id_caja = cc.id_caja
    INNER JOIN public.sucursales s ON s.id_sucursal = cc.id_sucursal
    INNER JOIN public.usuarios resp ON resp.id_usuario = cc.id_usuario_responsable
    LEFT JOIN public.empleados e_resp ON e_resp.id_empleado = resp.id_empleado
    LEFT JOIN public.personas per_resp ON per_resp.id_persona = e_resp.id_persona
    LEFT JOIN public.cat_cajas_resoluciones_cierre resolucion ON resolucion.id_resolucion_cierre_caja = cc.id_resolucion_cierre_caja
    ${built.whereClause ? `${built.whereClause} ${tipoWhere}` : `WHERE 1=1 ${tipoWhere}`}
    ORDER BY cc.fecha_cierre DESC, cc.id_cierre_caja DESC
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const totals = rows.reduce(
    (acc, row) => {
      const diferencia = Number(row.diferencia || 0);
      const abs = Math.abs(diferencia);
      acc.totalAbsoluto += abs;
      if (diferencia < 0) {
        acc.totalFaltantes += abs;
        acc.cantidadFaltantes += 1;
      } else if (diferencia > 0) {
        acc.totalSobrantes += diferencia;
        acc.cantidadSobrantes += 1;
      }
      return acc;
    },
    {
      totalAbsoluto: 0,
      totalFaltantes: 0,
      totalSobrantes: 0,
      cantidadFaltantes: 0,
      cantidadSobrantes: 0
    }
  );

  return res.json({
    ok: true,
    reporte: 'caja_diferencias',
    fase: 'fase_2d_real',
    filtros: filters,
    data: {
      kpis: {
        cantidad_diferencias: rows.length,
        total_diferencia_absoluta: roundMoney(totals.totalAbsoluto),
        total_faltantes: roundMoney(totals.totalFaltantes),
        total_sobrantes: roundMoney(totals.totalSobrantes),
        cantidad_faltantes: totals.cantidadFaltantes,
        cantidad_sobrantes: totals.cantidadSobrantes
      },
      diferencias: rows.map((row) => ({
        id_cierre_caja: row.id_cierre_caja,
        fecha_cierre: row.fecha_cierre,
        sucursal: row.nombre_sucursal,
        caja: row.nombre_caja,
        codigo_caja: row.codigo_caja,
        responsable: row.responsable,
        total_esperado: roundMoney(row.total_esperado),
        total_contado: roundMoney(row.total_contado),
        diferencia: roundMoney(row.diferencia),
        tipo_diferencia: Number(row.diferencia || 0) < 0 ? 'FALTANTE' : 'SOBRANTE',
        estado_resolucion: row.estado_resolucion,
        observacion: row.observacion || ''
      }))
    },
    meta: {
      fuente_canonica: 'cajas_cierres + cajas + sucursales + usuarios + cat_cajas_resoluciones_cierre',
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
      if (config.key === 'ventas_metodos_pago') {
        return await getVentasMetodosPago(req, res, parsed.filters, parsed.parsed);
      }
      if (config.key === 'caja_cierres') {
        return await getCajaCierres(req, res, parsed.filters, parsed.parsed);
      }
      if (config.key === 'caja_diferencias') {
        return await getCajaDiferencias(req, res, parsed.filters, parsed.parsed);
      }

      return sendPhaseOnePayload(res, config.key, parsed.filters);
    } catch (error) {
      return res.status(500).json({ error: true, message: 'No se pudo generar el reporte solicitado.' });
    }
  });
});

export default router;
