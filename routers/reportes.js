import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import PDFDocument from 'pdfkit';

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
  'almacen',
  'caja',
  'usuario',
  'metodo_pago',
  'tipo_diferencia',
  'tipo_item',
  'solo_criticos',
  'item',
  'producto',
  'categoria',
  'estado',
  'proveedor',
  'tipo_movimiento'
  ,
  'tipo_descuento'
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const toDateStamp = () => new Date().toISOString().slice(0, 10);

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

  const idAlmacen = filters.almacen ? parsePositiveInt(filters.almacen) : null;
  if (filters.almacen && !idAlmacen) {
    return { ok: false, message: 'El filtro almacen debe ser un ID numerico valido.' };
  }

  const idUsuario = filters.usuario ? parsePositiveInt(filters.usuario) : null;
  if (filters.usuario && !idUsuario) {
    return { ok: false, message: 'El filtro usuario debe ser un ID numerico valido.' };
  }

  const tipoItem = String(filters.tipo_item || '').trim().toLowerCase();
  if (tipoItem && !['producto', 'insumo', 'combo', 'receta', 'todos'].includes(tipoItem)) {
    return { ok: false, message: 'El filtro tipo_item solo permite: producto, insumo, combo, receta o todos.' };
  }

  const soloCriticosRaw = String(filters.solo_criticos || '').trim().toLowerCase();
  const soloCriticos =
    soloCriticosRaw === ''
      ? null
      : ['1', 'true', 'si', 'sí', 'yes'].includes(soloCriticosRaw)
        ? true
        : ['0', 'false', 'no'].includes(soloCriticosRaw)
          ? false
          : null;
  if (soloCriticosRaw && soloCriticos === null) {
    return { ok: false, message: 'El filtro solo_criticos debe ser true/false, 1/0 o si/no.' };
  }

  return {
    ok: true,
    filters,
    parsed: {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      id_sucursal: idSucursal,
      id_almacen: idAlmacen,
      id_caja: idCaja,
      id_usuario: idUsuario,
      estado: filters.estado || null,
      metodo_pago: filters.metodo_pago || null,
      tipo_diferencia: filters.tipo_diferencia || null,
      tipo_item: tipoItem || null,
      solo_criticos: soloCriticos,
      categoria: filters.categoria || null,
      tipo_movimiento: filters.tipo_movimiento || null,
      item: filters.item || null,
      tipo_descuento: filters.tipo_descuento || null
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

const normalizeReportKeyInput = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

const csvEscape = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\r?\n/g, ' ').trim();
  if (/[",;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
};

const buildCsvFromRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const headerLine = headers.map(csvEscape).join(';');
  const lines = rows.map((row) =>
    headers
      .map((key) => csvEscape(row?.[key] ?? ''))
      .join(';')
  );
  return [headerLine, ...lines].join('\n');
};

const buildExcelCompatibleCsv = ({ reportKey, payload }) => {
  const sections = [];
  const data = payload?.data || {};
  const filtros = payload?.filtros || {};
  const kpis = data?.kpis || null;

  sections.push(`Reporte;${csvEscape(reportKey)}`);
  sections.push(`Generado;${csvEscape(new Date().toISOString())}`);
  sections.push(`Filtros;${csvEscape(JSON.stringify(filtros))}`);

  if (kpis && typeof kpis === 'object') {
    sections.push('');
    sections.push('KPIs');
    sections.push('Metrica;Valor');
    Object.entries(kpis).forEach(([key, value]) => {
      sections.push(`${csvEscape(key)};${csvEscape(value)}`);
    });
  }

  const arraySections = Object.entries(data).filter(
    ([key, value]) => key !== 'kpis' && Array.isArray(value)
  );

  arraySections.forEach(([key, value]) => {
    sections.push('');
    sections.push(key);
    const csv = buildCsvFromRows(value);
    sections.push(csv || 'Sin datos');
  });

  if (arraySections.length === 0) {
    sections.push('');
    sections.push('Detalle');
    sections.push('Sin datos para exportar');
  }

  return `\uFEFF${sections.join('\n')}\n`;
};

const buildExportFileName = ({ reportKey, parsedFilters }) => {
  const base = `reporte_${String(reportKey || 'general').toLowerCase()}`;
  const from = parsedFilters?.fecha_inicio || '';
  const to = parsedFilters?.fecha_fin || '';
  const range = from || to ? `_${from || 'inicio'}_${to || 'fin'}` : '';
  return `${base}${range}_${toDateStamp()}.csv`;
};

const buildPdfFileName = ({ reportKey, parsedFilters }) => {
  const base = `reporte_${String(reportKey || 'general').toLowerCase()}`;
  const from = parsedFilters?.fecha_inicio || '';
  const to = parsedFilters?.fecha_fin || '';
  const range = from || to ? `_${from || 'inicio'}_${to || 'fin'}` : '';
  return `${base}${range}_${toDateStamp()}.pdf`;
};

const renderPdfLine = (doc, label, value) => {
  const text = `${label}: ${value ?? ''}`;
  doc.fontSize(9).fillColor('#111827').text(text, { width: 520 });
};

const renderPdfTable = ({ doc, title, rows, maxRows = 200 }) => {
  doc.moveDown(0.6);
  doc.fontSize(11).fillColor('#111827').text(title);
  doc.moveDown(0.2);

  if (!Array.isArray(rows) || rows.length === 0) {
    doc.fontSize(9).fillColor('#6b7280').text('Sin datos.');
    return;
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row || {})))].slice(0, 8);
  doc.fontSize(8).fillColor('#111827').text(headers.join(' | '), { width: 520 });
  doc.moveDown(0.2);

  const limitedRows = rows.slice(0, maxRows);
  limitedRows.forEach((row) => {
    const line = headers.map((key) => String(row?.[key] ?? '')).join(' | ');
    doc.fontSize(8).fillColor('#374151').text(line, { width: 520 });
  });

  if (rows.length > maxRows) {
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor('#b45309').text(`Nota: se muestran ${maxRows} filas de ${rows.length} por control de tamaño.`);
  }
};

const buildReportPdfBuffer = ({ reportKey, payload }) => new Promise((resolve, reject) => {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const data = payload?.data || {};
    const filtros = payload?.filtros || {};
    const kpis = data?.kpis || {};

    doc.fontSize(16).fillColor('#111827').text('Jonny’s SmartOrden');
    doc.fontSize(12).fillColor('#1f2937').text(`Reporte: ${reportKey}`);
    doc.moveDown(0.4);
    renderPdfLine(doc, 'Generado', new Date().toISOString());
    renderPdfLine(doc, 'Filtros', JSON.stringify(filtros));

    if (kpis && typeof kpis === 'object' && Object.keys(kpis).length > 0) {
      doc.moveDown(0.6);
      doc.fontSize(11).fillColor('#111827').text('KPIs principales');
      Object.entries(kpis).forEach(([key, value]) => renderPdfLine(doc, key, value));
    }

    const arraySections = Object.entries(data).filter(
      ([key, value]) => key !== 'kpis' && Array.isArray(value)
    );

    arraySections.forEach(([key, rows]) => {
      if (doc.y > 700) doc.addPage();
      renderPdfTable({ doc, title: key, rows, maxRows: 200 });
    });

    if (arraySections.length === 0) {
      doc.moveDown(0.8);
      doc.fontSize(9).fillColor('#6b7280').text('Sin datos tabulares para este reporte.');
    }

    doc.end();
  } catch (error) {
    reject(error);
  }
});

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

const getInventarioStockCritico = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const where = [];
  const tipoItem = parsedFilters.tipo_item || 'todos';

  if (parsedFilters.id_sucursal) {
    params.push(parsedFilters.id_sucursal);
    where.push(`base.id_sucursal = $${params.length}`);
  } else if (!scope.isSuperAdmin) {
    const allowed = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter(Boolean)
      : [];
    if (allowed.length === 0) {
      return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
    }
    params.push(allowed);
    where.push(`base.id_sucursal = ANY($${params.length}::int[])`);
  }

  if (parsedFilters.id_almacen) {
    params.push(parsedFilters.id_almacen);
    where.push(`base.id_almacen = $${params.length}`);
  }

  if (parsedFilters.categoria) {
    const categoriaId = parsePositiveInt(parsedFilters.categoria);
    if (categoriaId) {
      params.push(categoriaId);
      where.push(`(
        (base.tipo_item = 'PRODUCTO' AND base.id_categoria = $${params.length})
        OR
        (base.tipo_item = 'INSUMO' AND base.id_categoria = $${params.length})
      )`);
    } else {
      params.push(`%${parsedFilters.categoria}%`);
      where.push(`COALESCE(base.categoria, '') ILIKE $${params.length}`);
    }
  }

  if (tipoItem === 'producto') where.push(`base.tipo_item = 'PRODUCTO'`);
  if (tipoItem === 'insumo') where.push(`base.tipo_item = 'INSUMO'`);

  if (parsedFilters.estado) {
    const estadoFiltro = String(parsedFilters.estado).trim().toLowerCase();
    if (['activo', 'activos'].includes(estadoFiltro)) where.push('base.estado_activo = true');
    else if (['inactivo', 'inactivos'].includes(estadoFiltro)) where.push('base.estado_activo = false');
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const onlyCriticosSql = parsedFilters.solo_criticos === true
    ? `WHERE estado_calculado IN ('AGOTADO', 'CRITICO', 'BAJO STOCK')`
    : '';

  const query = `
    WITH productos_rel AS (
      SELECT DISTINCT pa.id_producto, pa.id_almacen
      FROM public.productos_almacenes pa
      UNION
      SELECT p.id_producto, p.id_almacen
      FROM public.productos p
      WHERE p.id_almacen IS NOT NULL
    ),
    insumos_rel AS (
      SELECT DISTINCT ia.id_insumo, ia.id_almacen
      FROM public.insumos_almacenes ia
      UNION
      SELECT i.id_insumo, i.id_almacen
      FROM public.insumos i
      WHERE i.id_almacen IS NOT NULL
    ),
    base AS (
      SELECT
        'PRODUCTO'::text AS tipo_item,
        p.id_producto AS id_item,
        p.nombre_producto AS nombre_item,
        p.id_categoria_producto AS id_categoria,
        cp.nombre_categoria AS categoria,
        a.id_almacen,
        a.nombre AS almacen,
        a.id_sucursal,
        s.nombre_sucursal AS sucursal,
        COALESCE(p.cantidad, 0)::numeric(14,2) AS cantidad_actual,
        COALESCE(p.stock_minimo, 0)::numeric(14,2) AS stock_minimo,
        COALESCE(p.estado, true) AS estado_activo
      FROM public.productos p
      INNER JOIN productos_rel pr ON pr.id_producto = p.id_producto
      LEFT JOIN public.almacenes a ON a.id_almacen = pr.id_almacen
      LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      LEFT JOIN public.categorias_productos cp ON cp.id_categoria_producto = p.id_categoria_producto

      UNION ALL

      SELECT
        'INSUMO'::text AS tipo_item,
        i.id_insumo AS id_item,
        i.nombre_insumo AS nombre_item,
        i.id_categoria_insumo AS id_categoria,
        ci.nombre_categoria AS categoria,
        a.id_almacen,
        a.nombre AS almacen,
        a.id_sucursal,
        s.nombre_sucursal AS sucursal,
        COALESCE(i.cantidad, 0)::numeric(14,2) AS cantidad_actual,
        COALESCE(i.stock_minimo, 0)::numeric(14,2) AS stock_minimo,
        COALESCE(i.estado, true) AS estado_activo
      FROM public.insumos i
      INNER JOIN insumos_rel ir ON ir.id_insumo = i.id_insumo
      LEFT JOIN public.almacenes a ON a.id_almacen = ir.id_almacen
      LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      LEFT JOIN public.categorias_insumos ci ON ci.id_categoria_insumo = i.id_categoria_insumo
    ),
    filtrado AS (
      SELECT
        base.*,
        (base.cantidad_actual - base.stock_minimo)::numeric(14,2) AS diferencia_minimo,
        CASE
          WHEN base.cantidad_actual <= 0 THEN 'AGOTADO'
          WHEN base.cantidad_actual <= base.stock_minimo THEN 'CRITICO'
          WHEN base.stock_minimo > 0 AND base.cantidad_actual <= (base.stock_minimo * 1.20) THEN 'BAJO STOCK'
          ELSE 'NORMAL'
        END AS estado_calculado
      FROM base
      ${whereSql}
    )
    SELECT *
    FROM filtrado
    ${onlyCriticosSql}
    ORDER BY tipo_item ASC, estado_calculado ASC, nombre_item ASC
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const metrics = rows.reduce(
    (acc, row) => {
      const estado = String(row.estado_calculado || 'NORMAL');
      if (estado === 'CRITICO' || estado === 'AGOTADO' || estado === 'BAJO STOCK') acc.criticos += 1;
      if (estado === 'AGOTADO') acc.agotados += 1;
      if (estado === 'BAJO STOCK') acc.bajoStock += 1;
      if (estado === 'CRITICO' && row.tipo_item === 'PRODUCTO') acc.productosCriticos += 1;
      if (estado === 'CRITICO' && row.tipo_item === 'INSUMO') acc.insumosCriticos += 1;
      return acc;
    },
    { criticos: 0, agotados: 0, bajoStock: 0, productosCriticos: 0, insumosCriticos: 0 }
  );

  return res.json({
    ok: true,
    reporte: 'inventario_stock_critico',
    fase: 'fase_3a_real',
    filtros: filters,
    data: {
      kpis: {
        total_items_revisados: rows.length,
        total_criticos: metrics.criticos,
        total_agotados: metrics.agotados,
        total_stock_bajo: metrics.bajoStock,
        productos_criticos: metrics.productosCriticos,
        insumos_criticos: metrics.insumosCriticos
      },
      items: rows.map((row) => ({
        tipo_item: row.tipo_item,
        nombre: row.nombre_item,
        categoria: row.categoria || 'Sin categoria',
        almacen: row.almacen || 'Sin almacen',
        sucursal: row.sucursal || 'Sin sucursal',
        cantidad_actual: Number(row.cantidad_actual || 0),
        stock_minimo: Number(row.stock_minimo || 0),
        diferencia_minimo: Number(row.diferencia_minimo || 0),
        estado: row.estado_calculado
      }))
    },
    meta: {
      fuente_canonica: 'productos + insumos + almacenes + sucursales + categorias + relaciones *_almacenes',
      generado_en: new Date().toISOString()
    }
  });
};

const getInventarioKardex = async (req, res, filters, parsedFilters) => {
  if (parsedFilters.categoria) {
    return res.status(400).json({
      error: true,
      message: 'El filtro categoria no aplica para Kardex en esta fase.'
    });
  }

  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const where = [];

  if (parsedFilters.fecha_inicio) {
    params.push(parsedFilters.fecha_inicio);
    where.push(`k.fecha_mov::date >= $${params.length}::date`);
  }

  if (parsedFilters.fecha_fin) {
    params.push(parsedFilters.fecha_fin);
    where.push(`k.fecha_mov::date <= $${params.length}::date`);
  }

  if (parsedFilters.id_sucursal) {
    params.push(parsedFilters.id_sucursal);
    where.push(`k.id_sucursal = $${params.length}`);
  } else if (!scope.isSuperAdmin) {
    const allowed = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter(Boolean)
      : [];
    if (allowed.length === 0) {
      return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
    }
    params.push(allowed);
    where.push(`k.id_sucursal = ANY($${params.length}::int[])`);
  }

  if (parsedFilters.id_almacen) {
    params.push(parsedFilters.id_almacen);
    where.push(`k.id_almacen = $${params.length}`);
  }

  if (parsedFilters.tipo_movimiento) {
    params.push(`%${parsedFilters.tipo_movimiento}%`);
    where.push(`COALESCE(k.tipo, '') ILIKE $${params.length}`);
  }

  const tipoItem = String(parsedFilters.tipo_item || 'todos').trim().toLowerCase();
  if (!['producto', 'insumo', 'todos'].includes(tipoItem)) {
    return res.status(400).json({ error: true, message: 'El filtro tipo_item solo permite: producto, insumo o todos.' });
  }
  if (tipoItem !== 'todos') {
    params.push(tipoItem);
    where.push(`LOWER(COALESCE(k.item_tipo, '')) = $${params.length}`);
  }

  if (parsedFilters.item) {
    const itemId = parsePositiveInt(parsedFilters.item);
    if (itemId) {
      params.push(itemId);
      where.push(`k.item_id = $${params.length}`);
    } else {
      params.push(`%${parsedFilters.item}%`);
      where.push(`COALESCE(k.item_nombre, '') ILIKE $${params.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const shouldLimit = !parsedFilters.fecha_inicio && !parsedFilters.fecha_fin && !parsedFilters.item;
  const limitSql = shouldLimit ? 'LIMIT 1000' : '';

  const query = `
    SELECT
      k.id_movimiento,
      k.fecha_mov,
      k.tipo,
      k.cantidad,
      k.saldo_antes,
      k.saldo_despues,
      k.es_legacy,
      k.id_almacen,
      k.nombre_almacen,
      k.id_sucursal,
      k.nombre_sucursal,
      k.id_producto,
      k.nombre_producto,
      k.id_insumo,
      k.nombre_insumo,
      k.item_tipo,
      k.item_id,
      k.item_nombre,
      k.impacto,
      k.ref_origen,
      k.id_ref,
      k.descripcion
    FROM public.v_kardex_detalle k
    ${whereSql}
    ORDER BY k.fecha_mov DESC, k.id_movimiento DESC
    ${limitSql}
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const metrics = rows.reduce(
    (acc, row) => {
      const tipo = String(row.tipo || '').trim().toUpperCase();
      if (tipo === 'ENTRADA') acc.entradas += 1;
      else if (tipo === 'SALIDA') acc.salidas += 1;
      else acc.ajustesOtros += 1;
      if (row.item_id !== null && row.item_id !== undefined) acc.items.add(`${String(row.item_tipo || '').toLowerCase()}-${row.item_id}`);
      return acc;
    },
    { entradas: 0, salidas: 0, ajustesOtros: 0, items: new Set() }
  );

  return res.json({
    ok: true,
    reporte: 'inventario_kardex',
    fase: 'fase_3b_real',
    filtros: filters,
    data: {
      kpis: {
        total_movimientos: rows.length,
        entradas: metrics.entradas,
        salidas: metrics.salidas,
        ajustes_otros: metrics.ajustesOtros,
        items_unicos: metrics.items.size
      },
      movimientos: rows
    },
    meta: {
      fuente_canonica: 'v_kardex_detalle',
      limitado: shouldLimit,
      limite: shouldLimit ? 1000 : null,
      generado_en: new Date().toISOString()
    }
  });
};

const getVentasDescuentos = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
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
      return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
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

  if (parsedFilters.tipo_descuento) {
    const tipoId = parsePositiveInt(parsedFilters.tipo_descuento);
    if (tipoId) {
      params.push(tipoId);
      where.push(`td.id_tipo_descuento = $${params.length}`);
    } else {
      const tipoText = String(parsedFilters.tipo_descuento || '').trim();
      if (!/^[\p{L}\p{N}\s._-]+$/u.test(tipoText)) {
        return res.status(400).json({ error: true, message: 'El filtro tipo_descuento contiene caracteres no permitidos.' });
      }
      params.push(`%${tipoText}%`);
      where.push(`COALESCE(td.nombre_tipo_descuento, '') ILIKE $${params.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const detailQuery = `
    SELECT
      COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion)::date AS fecha,
      COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
      COALESCE(s.nombre_sucursal, 'Sin sucursal') AS sucursal,
      f.id_caja,
      CASE
        WHEN c.id_caja IS NULL THEN 'Sin caja'
        WHEN COALESCE(c.codigo_caja, '') = '' THEN COALESCE(c.nombre_caja, 'Caja')
        ELSE CONCAT(c.codigo_caja, ' - ', COALESCE(c.nombre_caja, 'Caja'))
      END AS caja,
      COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
      COALESCE(u.nombre_usuario, 'Sin usuario') AS usuario,
      f.id_factura,
      f.id_pedido,
      COALESCE(
        NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
        emp.nombre_empresa,
        'Consumidor final'
      ) AS cliente,
      COALESCE(td.id_tipo_descuento, 0) AS id_tipo_descuento,
      COALESCE(td.nombre_tipo_descuento, 'SIN TIPO') AS tipo_descuento,
      COALESCE(dc.nombre_descuento, 'DESCUENTO MANUAL') AS nombre_descuento,
      COALESCE(d.monto_descuento, 0)::numeric(14,2) AS descuento,
      COALESCE(df.sub_total, 0)::numeric(14,2) AS subtotal_linea,
      COALESCE(df.total_detalle, 0)::numeric(14,2) AS total_linea,
      COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado
    FROM facturas f
    INNER JOIN detalle_facturas df ON df.id_factura = f.id_factura
    INNER JOIN descuentos d ON d.id_descuento = df.id_descuento
    LEFT JOIN descuentos_catalogos dc ON dc.id_descuento_catalogo = d.id_descuento_catalogo
    LEFT JOIN tipo_descuentos td ON td.id_tipo_descuento = dc.id_tipo_descuento
    LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
    LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
    LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
    LEFT JOIN cajas c ON c.id_caja = f.id_caja
    LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
    LEFT JOIN clientes cl ON cl.id_cliente = COALESCE(p.id_cliente, f.id_cliente)
    LEFT JOIN personas per ON per.id_persona = cl.id_persona
    LEFT JOIN empresas emp ON emp.id_empresa = cl.id_empresa
    ${whereSql}
    ORDER BY fecha DESC, f.id_factura DESC, df.id_detalle_factura DESC
  `;

  const result = await pool.query(detailQuery, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const totalDescuento = rows.reduce((sum, row) => sum + Number(row.descuento || 0), 0);
  const facturasUnicas = new Set(rows.map((row) => Number(row.id_factura || 0)).filter(Boolean));

  const byTipo = new Map();
  rows.forEach((row) => {
    const key = `${row.id_tipo_descuento}-${row.tipo_descuento}`;
    if (!byTipo.has(key)) {
      byTipo.set(key, {
        tipo_descuento: row.tipo_descuento || 'SIN TIPO',
        cantidad_lineas: 0,
        _ventas: new Set(),
        total_descuento: 0
      });
    }
    const bucket = byTipo.get(key);
    bucket.cantidad_lineas += 1;
    if (row.id_factura) bucket._ventas.add(Number(row.id_factura));
    bucket.total_descuento += Number(row.descuento || 0);
  });

  const resumenTipo = [...byTipo.values()]
    .map((item) => ({
      tipo_descuento: item.tipo_descuento,
      cantidad_lineas: item.cantidad_lineas,
      ventas: item._ventas.size,
      total_descuento: roundMoney(item.total_descuento)
    }))
    .sort((a, b) => b.total_descuento - a.total_descuento);

  return res.json({
    ok: true,
    reporte: 'ventas_descuentos',
    fase: 'fase_4a_real',
    filtros: filters,
    data: {
      kpis: {
        total_descuento: roundMoney(totalDescuento),
        ventas_con_descuento: facturasUnicas.size,
        lineas_con_descuento: rows.length,
        ticket_promedio_descuento: facturasUnicas.size > 0 ? roundMoney(totalDescuento / facturasUnicas.size) : 0
      },
      resumen_tipo_descuento: resumenTipo,
      detalle: rows.map((row) => ({
        fecha: row.fecha,
        sucursal: row.sucursal,
        caja: row.caja,
        usuario: row.usuario,
        factura: row.id_factura,
        pedido: row.id_pedido,
        cliente: row.cliente,
        tipo_descuento: row.tipo_descuento,
        descuento: roundMoney(row.descuento),
        subtotal_linea: roundMoney(row.subtotal_linea),
        total_linea: roundMoney(row.total_linea),
        estado: row.estado
      }))
    },
    meta: {
      fuente_canonica: 'facturas + detalle_facturas + descuentos + descuentos_catalogos + tipo_descuentos + pedidos',
      generado_en: new Date().toISOString()
    }
  });
};

const getVentasItems = async (req, res, filters, parsedFilters) => {
  const scope = await resolveRequestUserSucursalScope(req);
  const params = [];
  const where = [];

  const tipoItem = String(parsedFilters.tipo_item || 'todos').trim().toLowerCase();
  if (!['producto', 'combo', 'receta', 'todos'].includes(tipoItem)) {
    return res.status(400).json({
      error: true,
      message: 'El filtro tipo_item solo permite: producto, combo, receta o todos.'
    });
  }

  if (parsedFilters.fecha_inicio) {
    params.push(parsedFilters.fecha_inicio);
    where.push(`base.fecha >= $${params.length}::date`);
  }

  if (parsedFilters.fecha_fin) {
    params.push(parsedFilters.fecha_fin);
    where.push(`base.fecha <= $${params.length}::date`);
  }

  if (parsedFilters.id_sucursal) {
    params.push(parsedFilters.id_sucursal);
    where.push(`base.id_sucursal = $${params.length}`);
  } else if (!scope.isSuperAdmin) {
    const allowed = Array.isArray(scope.allowedSucursalIds)
      ? scope.allowedSucursalIds.map((value) => parsePositiveInt(value)).filter(Boolean)
      : [];
    if (allowed.length === 0) {
      return res.status(403).json({ error: true, message: 'No tiene sucursales asignadas para consultar este reporte.' });
    }
    params.push(allowed);
    where.push(`base.id_sucursal = ANY($${params.length}::int[])`);
  }

  if (parsedFilters.id_caja) {
    params.push(parsedFilters.id_caja);
    where.push(`base.id_caja = $${params.length}`);
  }

  if (parsedFilters.id_usuario) {
    params.push(parsedFilters.id_usuario);
    where.push(`base.id_usuario = $${params.length}`);
  }

  if (tipoItem !== 'todos') {
    params.push(tipoItem.toUpperCase());
    where.push(`base.tipo_item = $${params.length}`);
  }

  if (parsedFilters.estado) {
    params.push(`%${parsedFilters.estado}%`);
    where.push(`COALESCE(base.estado, 'VENTA DIRECTA') ILIKE $${params.length}`);
  }

  if (parsedFilters.item) {
    const itemId = parsePositiveInt(parsedFilters.item);
    if (itemId) {
      params.push(itemId);
      where.push(`base.id_item = $${params.length}`);
    } else {
      params.push(`%${parsedFilters.item}%`);
      where.push(`COALESCE(base.nombre_item, '') ILIKE $${params.length}`);
    }
  }

  if (parsedFilters.categoria) {
    if (tipoItem === 'combo' || tipoItem === 'receta') {
      return res.status(400).json({
        error: true,
        message: 'El filtro categoria solo aplica para tipo_item producto en este reporte.'
      });
    }
    const categoriaId = parsePositiveInt(parsedFilters.categoria);
    if (categoriaId) {
      params.push(categoriaId);
      where.push(`base.tipo_item = 'PRODUCTO' AND base.id_categoria_producto = $${params.length}`);
    } else {
      params.push(`%${parsedFilters.categoria}%`);
      where.push(`base.tipo_item = 'PRODUCTO' AND COALESCE(base.categoria, '') ILIKE $${params.length}`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const query = `
    WITH ventas_directas_items AS (
      SELECT
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion)::date AS fecha,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(s.nombre_sucursal, 'Sin sucursal') AS sucursal,
        f.id_caja,
        CASE
          WHEN c.id_caja IS NULL THEN 'Sin caja'
          WHEN COALESCE(c.codigo_caja, '') = '' THEN COALESCE(c.nombre_caja, 'Caja')
          ELSE CONCAT(c.codigo_caja, ' - ', COALESCE(c.nombre_caja, 'Caja'))
        END AS caja,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        COALESCE(u.nombre_usuario, 'Sin usuario') AS usuario,
        f.id_factura,
        COALESCE(df.id_pedido, f.id_pedido) AS id_pedido,
        COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado,
        'PRODUCTO'::text AS tipo_item,
        prod.id_producto AS id_item,
        COALESCE(prod.nombre_producto, CONCAT('Producto #', prod.id_producto)) AS nombre_item,
        prod.id_categoria_producto,
        cp.nombre_categoria AS categoria,
        COALESCE(df.cantidad, 0)::numeric(14,2) AS cantidad,
        COALESCE(df.sub_total, 0)::numeric(14,2) AS subtotal,
        COALESCE(d.monto_descuento, 0)::numeric(14,2) AS descuento,
        COALESCE(df.total_detalle, 0)::numeric(14,2) AS total
      FROM facturas f
      INNER JOIN detalle_facturas df ON df.id_factura = f.id_factura
      INNER JOIN productos prod ON prod.id_producto = df.id_producto
      LEFT JOIN categorias_productos cp ON cp.id_categoria_producto = prod.id_categoria_producto
      LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
      LEFT JOIN pedidos p ON p.id_pedido = COALESCE(df.id_pedido, f.id_pedido)
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
      LEFT JOIN cajas c ON c.id_caja = f.id_caja
      LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
    ),
    ventas_pedido_items AS (
      SELECT
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion)::date AS fecha,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(s.nombre_sucursal, 'Sin sucursal') AS sucursal,
        f.id_caja,
        CASE
          WHEN c.id_caja IS NULL THEN 'Sin caja'
          WHEN COALESCE(c.codigo_caja, '') = '' THEN COALESCE(c.nombre_caja, 'Caja')
          ELSE CONCAT(c.codigo_caja, ' - ', COALESCE(c.nombre_caja, 'Caja'))
        END AS caja,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        COALESCE(u.nombre_usuario, 'Sin usuario') AS usuario,
        f.id_factura,
        p.id_pedido,
        COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado,
        CASE
          WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
          WHEN dp.id_combo IS NOT NULL THEN 'COMBO'
          WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
          ELSE 'OTRO'
        END AS tipo_item,
        COALESCE(dp.id_producto, dp.id_combo, dp.id_receta) AS id_item,
        COALESCE(prod.nombre_producto, cb.nombre_combo, rc.nombre_receta, 'Item') AS nombre_item,
        prod.id_categoria_producto,
        cp.nombre_categoria AS categoria,
        COALESCE(
          CASE
            WHEN dp.id_producto IS NOT NULL THEN GREATEST(
              1,
              ROUND(
                COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                / NULLIF(prod.precio, 0)
              )::int
            )
            WHEN dp.id_combo IS NOT NULL THEN GREATEST(
              1,
              ROUND(
                COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                / NULLIF(cb.precio, 0)
              )::int
            )
            WHEN dp.id_receta IS NOT NULL THEN GREATEST(
              1,
              ROUND(
                COALESCE(NULLIF(dp.sub_total_pedido, 0), dp.total_pedido, 0)
                / NULLIF(rc.precio, 0)
              )::int
            )
            ELSE 1
          END,
          1
        )::numeric(14,2) AS cantidad,
        COALESCE(dp.sub_total_pedido, 0)::numeric(14,2) AS subtotal,
        COALESCE(d2.monto_descuento, 0)::numeric(14,2) AS descuento,
        COALESCE(dp.total_pedido, 0)::numeric(14,2) AS total
      FROM facturas f
      INNER JOIN pedidos p ON p.id_pedido = f.id_pedido
      INNER JOIN detalle_pedido dp ON dp.id_pedido = p.id_pedido
      LEFT JOIN productos prod ON prod.id_producto = dp.id_producto
      LEFT JOIN categorias_productos cp ON cp.id_categoria_producto = prod.id_categoria_producto
      LEFT JOIN combos cb ON cb.id_combo = dp.id_combo
      LEFT JOIN recetas rc ON rc.id_receta = dp.id_receta
      LEFT JOIN descuentos d2 ON d2.id_descuento = dp.id_descuento
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
      LEFT JOIN cajas c ON c.id_caja = f.id_caja
      LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
    ),
    base AS (
      SELECT * FROM ventas_directas_items
      UNION ALL
      SELECT * FROM ventas_pedido_items
    ),
    filtrado AS (
      SELECT *
      FROM base
      ${whereSql}
    )
    SELECT *
    FROM filtrado
    ORDER BY fecha DESC, id_factura DESC, tipo_item ASC, nombre_item ASC
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const totalVendido = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const facturasUnicas = new Set(rows.map((row) => Number(row.id_factura || 0)).filter(Boolean));
  const itemsUnicos = new Set(
    rows
      .filter((row) => row.id_item !== null && row.id_item !== undefined)
      .map((row) => `${String(row.tipo_item || '').toUpperCase()}-${row.id_item}`)
  );

  const resumenMap = new Map();
  rows.forEach((row) => {
    const key = `${String(row.tipo_item || '').toUpperCase()}-${row.id_item || 'na'}`;
    if (!resumenMap.has(key)) {
      resumenMap.set(key, {
        tipo_item: String(row.tipo_item || '').toUpperCase(),
        id_item: row.id_item || null,
        nombre_item: row.nombre_item || 'Item',
        categoria: row.categoria || 'Sin categoría',
        cantidad_vendida: 0,
        subtotal: 0,
        descuento: 0,
        total: 0,
        _facturas: new Set()
      });
    }
    const bucket = resumenMap.get(key);
    bucket.cantidad_vendida += Number(row.cantidad || 0);
    bucket.subtotal += Number(row.subtotal || 0);
    bucket.descuento += Number(row.descuento || 0);
    bucket.total += Number(row.total || 0);
    if (row.id_factura) bucket._facturas.add(Number(row.id_factura));
  });

  const resumenItems = [...resumenMap.values()]
    .map((item) => ({
      tipo_item: item.tipo_item,
      id_item: item.id_item,
      nombre_item: item.nombre_item,
      categoria: item.categoria,
      cantidad_vendida: Number(item.cantidad_vendida.toFixed(2)),
      ventas: item._facturas.size,
      subtotal: roundMoney(item.subtotal),
      descuento: roundMoney(item.descuento),
      total: roundMoney(item.total)
    }))
    .sort((a, b) => b.total - a.total);

  return res.json({
    ok: true,
    reporte: 'ventas_items',
    fase: 'fase_4b_real',
    filtros: filters,
    data: {
      kpis: {
        total_vendido: roundMoney(totalVendido),
        ventas: facturasUnicas.size,
        lineas: rows.length,
        cantidad_items: itemsUnicos.size,
        ticket_promedio: facturasUnicas.size > 0 ? roundMoney(totalVendido / facturasUnicas.size) : 0
      },
      resumen_items: resumenItems,
      detalle: rows.map((row) => ({
        fecha: row.fecha,
        sucursal: row.sucursal,
        caja: row.caja,
        usuario: row.usuario,
        factura: row.id_factura,
        pedido: row.id_pedido,
        tipo_item: row.tipo_item,
        item: row.nombre_item,
        categoria: row.categoria || 'Sin categoría',
        cantidad: Number(Number(row.cantidad || 0).toFixed(2)),
        subtotal: roundMoney(row.subtotal),
        descuento: roundMoney(row.descuento),
        total: roundMoney(row.total),
        estado: row.estado || 'VENTA DIRECTA'
      }))
    },
    meta: {
      fuente_canonica: 'facturas + detalle_facturas + pedidos + detalle_pedido + productos + combos + recetas + categorias_productos',
      generado_en: new Date().toISOString()
    }
  });
};

const executeReportByKey = async ({ key, req, res, filters, parsedFilters }) => {
  if (key === 'ventas_resumen') return await getVentasResumen(req, res, filters, parsedFilters);
  if (key === 'ventas_metodos_pago') return await getVentasMetodosPago(req, res, filters, parsedFilters);
  if (key === 'caja_cierres') return await getCajaCierres(req, res, filters, parsedFilters);
  if (key === 'caja_diferencias') return await getCajaDiferencias(req, res, filters, parsedFilters);
  if (key === 'inventario_stock_critico') return await getInventarioStockCritico(req, res, filters, parsedFilters);
  if (key === 'inventario_kardex') return await getInventarioKardex(req, res, filters, parsedFilters);
  if (key === 'ventas_descuentos') return await getVentasDescuentos(req, res, filters, parsedFilters);
  if (key === 'ventas_items') return await getVentasItems(req, res, filters, parsedFilters);
  return sendPhaseOnePayload(res, key, filters);
};

const createCaptureResponse = () => {
  const state = { statusCode: 200, body: null };
  return {
    state,
    api: {
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(payload) {
        state.body = payload;
        return payload;
      },
      setHeader() {
        return this;
      }
    }
  };
};

router.get('/reportes/exportar/excel', checkPermission([BASE_PERMISSION, 'REPORTES_EXPORTAR_EXCEL']), async (req, res) => {
  try {
    const reportKeyInput = normalizeReportKeyInput(req.query?.reporte);
    const reportDefinition = Object.values(REPORT_DEFINITIONS).find((item) => item.key === reportKeyInput);

    if (!reportDefinition) {
      return res.status(400).json({
        error: true,
        message: 'El parametro reporte es invalido para exportacion.'
      });
    }

    const hasReportPermission = await requestHasAnyPermission(req, reportDefinition.permissions);
    if (!hasReportPermission) {
      return res.status(403).json({
        error: true,
        message: 'Acceso denegado: permisos insuficientes'
      });
    }

    const parsed = parseFilters(req.query || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: true, message: parsed.message });
    }

    const capture = createCaptureResponse();
    await executeReportByKey({
      key: reportDefinition.key,
      req,
      res: capture.api,
      filters: parsed.filters,
      parsedFilters: parsed.parsed
    });

    if (capture.state.statusCode >= 400) {
      return res.status(capture.state.statusCode).json(
        capture.state.body || { error: true, message: 'No se pudo generar el reporte solicitado.' }
      );
    }

    const csvContent = buildExcelCompatibleCsv({
      reportKey: reportDefinition.key,
      payload: capture.state.body
    });
    const filename = buildExportFileName({
      reportKey: reportDefinition.key,
      parsedFilters: parsed.parsed
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
  } catch (error) {
    return res.status(500).json({ error: true, message: 'No se pudo exportar el reporte solicitado.' });
  }
});

router.get('/reportes/exportar/pdf', checkPermission([BASE_PERMISSION, 'REPORTES_EXPORTAR_PDF']), async (req, res) => {
  try {
    const reportKeyInput = normalizeReportKeyInput(req.query?.reporte);
    const reportDefinition = Object.values(REPORT_DEFINITIONS).find((item) => item.key === reportKeyInput);

    if (!reportDefinition) {
      return res.status(400).json({
        error: true,
        message: 'El parametro reporte es invalido para exportacion.'
      });
    }

    const hasReportPermission = await requestHasAnyPermission(req, reportDefinition.permissions);
    if (!hasReportPermission) {
      return res.status(403).json({
        error: true,
        message: 'Acceso denegado: permisos insuficientes'
      });
    }

    const parsed = parseFilters(req.query || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: true, message: parsed.message });
    }

    const capture = createCaptureResponse();
    await executeReportByKey({
      key: reportDefinition.key,
      req,
      res: capture.api,
      filters: parsed.filters,
      parsedFilters: parsed.parsed
    });

    if (capture.state.statusCode >= 400) {
      return res.status(capture.state.statusCode).json(
        capture.state.body || { error: true, message: 'No se pudo generar el reporte solicitado.' }
      );
    }

    const pdfBuffer = await buildReportPdfBuffer({
      reportKey: reportDefinition.key,
      payload: capture.state.body
    });
    const filename = buildPdfFileName({
      reportKey: reportDefinition.key,
      parsedFilters: parsed.parsed
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    return res.status(500).json({ error: true, message: 'No se pudo exportar el reporte solicitado.' });
  }
});

router.use('/reportes', checkPermission(BASE_PERMISSION));

Object.entries(REPORT_DEFINITIONS).forEach(([path, config]) => {
  router.get(path, checkPermission([...config.permissions, BASE_PERMISSION]), async (req, res) => {
    try {
      const parsed = parseFilters(req.query || {});
      if (!parsed.ok) {
        return res.status(400).json({ error: true, message: parsed.message });
      }
      return await executeReportByKey({
        key: config.key,
        req,
        res,
        filters: parsed.filters,
        parsedFilters: parsed.parsed
      });
    } catch (error) {
      return res.status(500).json({ error: true, message: 'No se pudo generar el reporte solicitado.' });
    }
  });
});

export default router;
