import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { getSmtpRuntimeInfo, isSmtpConfigured, sendReportEmail } from '../services/smtpMailer.js';

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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MAX_RECIPIENTS = 10;
const MAX_SUBJECT_LENGTH = 240;
const MAX_MESSAGE_LENGTH = 2000;
const IS_DEV_LOG = String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';

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

const isValidCalendarDate = (value) => {
  const text = String(value || '').trim();
  if (!DATE_RE.test(text)) return false;
  const [yearRaw, monthRaw, dayRaw] = text.split('-');
  const year = Number.parseInt(yearRaw, 10);
  const month = Number.parseInt(monthRaw, 10);
  const day = Number.parseInt(dayRaw, 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() + 1 === month
    && date.getUTCDate() === day
  );
};

const parseFilters = (query = {}) => {
  const filters = {};

  for (const key of FILTER_KEYS) {
    const value = normalizeFilterValue(query[key]);
    if (value !== null) filters[key] = value;
  }

  const fechaInicio = filters.fecha_inicio || null;
  const fechaFin = filters.fecha_fin || null;

  if (fechaInicio && !isValidCalendarDate(fechaInicio)) {
    return { ok: false, message: 'La fecha_inicio debe ser una fecha valida con formato YYYY-MM-DD.' };
  }

  if (fechaFin && !isValidCalendarDate(fechaFin)) {
    return { ok: false, message: 'La fecha_fin debe ser una fecha valida con formato YYYY-MM-DD.' };
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

const parseEmailRecipients = (value) => {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'El campo destinatarios debe ser un arreglo de correos.' };
  }

  const recipients = [];
  const seen = new Set();

  value.forEach((item) => {
    const normalized = String(item ?? '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    recipients.push(normalized);
  });

  if (recipients.length < 1) {
    return { ok: false, message: 'Debes indicar al menos un destinatario.' };
  }

  if (recipients.length > MAX_RECIPIENTS) {
    return { ok: false, message: `Solo se permiten hasta ${MAX_RECIPIENTS} destinatarios por envio.` };
  }

  const invalid = recipients.find((email) => !EMAIL_RE.test(email));
  if (invalid) {
    return { ok: false, message: `El correo ${invalid} no es valido.` };
  }

  return { ok: true, recipients };
};

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

const PDF_FILTER_LABELS = Object.freeze({
  fecha_inicio: 'Fecha inicio',
  fecha_fin: 'Fecha fin',
  sucursal: 'Sucursal',
  almacen: 'Almacen',
  caja: 'Caja',
  usuario: 'Usuario',
  metodo_pago: 'Metodo de pago',
  tipo_diferencia: 'Tipo diferencia',
  tipo_item: 'Tipo item',
  solo_criticos: 'Solo criticos',
  item: 'Item',
  categoria: 'Categoria',
  estado: 'Estado',
  tipo_movimiento: 'Tipo movimiento',
  tipo_descuento: 'Tipo descuento'
});

const PDF_REPORT_CONFIG = Object.freeze({
  ventas_resumen: {
    title: 'Ventas - Resumen',
    orientation: 'portrait',
    sections: [
      {
        key: 'serie_diaria',
        title: 'Serie diaria',
        columns: [
          { key: 'fecha', label: 'Fecha', weight: 1.6 },
          { key: 'cantidad_ventas', label: 'Cantidad de ventas', weight: 1, align: 'right' },
          { key: 'subtotal', label: 'Subtotal', weight: 1.2, align: 'right', format: 'currency' },
          { key: 'descuento', label: 'Descuento', weight: 1.2, align: 'right', format: 'currency' },
          { key: 'impuesto', label: 'Impuesto', weight: 1.2, align: 'right', format: 'currency' },
          { key: 'total_neto', label: 'Total neto', weight: 1.3, align: 'right', format: 'currency' },
          { key: 'ticket_promedio', label: 'Ticket promedio', weight: 1.2, align: 'right', format: 'currency' },
          { key: 'estado_principal', label: 'Estado principal', weight: 1.5 }
        ]
      },
      {
        key: 'desglose_por_estado',
        title: 'Desglose por estado',
        columns: [
          { key: 'estado', label: 'Estado', weight: 2 },
          { key: 'cantidad_ventas', label: 'Ventas', weight: 1, align: 'right' },
          { key: 'total_neto', label: 'Total neto', weight: 1.4, align: 'right', format: 'currency' }
        ]
      }
    ]
  },
  ventas_metodos_pago: {
    title: 'Ventas - Metodos de pago',
    orientation: 'landscape',
    sections: [
      {
        key: 'resumen_por_metodo',
        title: 'Resumen por metodo',
        columns: [
          { key: 'metodo_pago', label: 'Metodo', weight: 2 },
          { key: 'cantidad_ventas', label: 'Cantidad de ventas', weight: 1, align: 'right' },
          { key: 'total_vendido', label: 'Total', weight: 1.4, align: 'right', format: 'currency' },
          { key: 'porcentaje_sobre_total', label: '% participacion', weight: 1.1, align: 'right', format: 'percent' },
          { key: 'ticket_promedio', label: 'Ticket prom.', weight: 1.2, align: 'right', format: 'currency' }
        ]
      }
    ]
  },
  ventas_descuentos: {
    title: 'Ventas - Descuentos aplicados',
    orientation: 'landscape',
    sections: [
      {
        key: 'detalle',
        title: 'Detalle',
        columns: [
          { key: 'fecha', label: 'Fecha', weight: 1.1 },
          { key: 'sucursal', label: 'Sucursal', weight: 1.4 },
          { key: 'caja', label: 'Caja', weight: 1.3 },
          { key: 'usuario', label: 'Usuario', weight: 1.4 },
          { key: 'factura', label: 'Factura', weight: 0.8, align: 'right' },
          { key: 'pedido', label: 'Pedido', weight: 0.8, align: 'right' },
          { key: 'cliente', label: 'Cliente', weight: 1.5 },
          { key: 'tipo_descuento', label: 'Tipo desc.', weight: 1.2 },
          { key: 'item', label: 'Item', weight: 1.6 },
          { key: 'subtotal_linea', label: 'Subtotal', weight: 1, align: 'right', format: 'currency' },
          { key: 'descuento', label: 'Desc.', weight: 1, align: 'right', format: 'currency' },
          { key: 'total_linea', label: 'Total', weight: 1, align: 'right', format: 'currency' },
          { key: 'estado', label: 'Estado', weight: 1.2 }
        ]
      }
    ]
  },
  ventas_items: {
    title: 'Ventas - Ventas por item',
    orientation: 'landscape',
    sections: [
      {
        key: 'detalle',
        title: 'Detalle por item vendido',
        columns: [
          { key: 'fecha', label: 'Fecha', weight: 0.9 },
          { key: 'sucursal', label: 'Sucursal', weight: 1.1 },
          { key: 'caja', label: 'Caja', weight: 1 },
          { key: 'usuario', label: 'Usuario', weight: 1.1 },
          { key: 'factura', label: 'Factura', weight: 0.65, align: 'right' },
          { key: 'pedido', label: 'Pedido', weight: 0.65, align: 'right' },
          { key: 'tipo_item', label: 'Tipo', weight: 0.8 },
          { key: 'item', label: 'Item', weight: 1.5 },
          { key: 'categoria', label: 'Categoria', weight: 1.1 },
          { key: 'cantidad', label: 'Cant.', weight: 0.7, align: 'right', format: 'number' },
          { key: 'precio_unitario', label: 'P. unit.', weight: 0.9, align: 'right', format: 'currency' },
          { key: 'subtotal', label: 'Subtotal', weight: 0.9, align: 'right', format: 'currency' },
          { key: 'descuento', label: 'Desc.', weight: 0.9, align: 'right', format: 'currency' },
          { key: 'total', label: 'Total', weight: 0.9, align: 'right', format: 'currency' },
          { key: 'estado', label: 'Estado', weight: 1.05 }
        ]
      }
    ]
  },
  caja_cierres: {
    title: 'Caja - Cierres',
    orientation: 'landscape',
    sections: [
      {
        key: 'cierres',
        title: 'Cierres de caja',
        columns: [
          { key: 'fecha_cierre', label: 'Fecha cierre', weight: 1.1 },
          { key: 'sucursal', label: 'Sucursal', weight: 1.3 },
          { key: 'caja', label: 'Caja', weight: 1.2 },
          { key: 'responsable', label: 'Responsable', weight: 1.3 },
          { key: 'total_esperado', label: 'Monto esperado', weight: 1, align: 'right', format: 'currency' },
          { key: 'total_contado', label: 'Monto contado', weight: 1, align: 'right', format: 'currency' },
          { key: 'diferencia', label: 'Dif.', weight: 0.9, align: 'right', format: 'currency' },
          { key: 'estado', label: 'Estado', weight: 1 },
          { key: 'resolucion', label: 'Resolucion', weight: 1.2 },
          { key: 'observacion', label: 'Observacion', weight: 1.6 }
        ]
      }
    ]
  },
  caja_diferencias: {
    title: 'Caja - Diferencias',
    orientation: 'landscape',
    sections: [
      {
        key: 'diferencias',
        title: 'Diferencias detectadas',
        columns: [
          { key: 'fecha_cierre', label: 'Fecha cierre', weight: 1.1 },
          { key: 'sucursal', label: 'Sucursal', weight: 1.2 },
          { key: 'caja', label: 'Caja', weight: 1.2 },
          { key: 'responsable', label: 'Responsable', weight: 1.2 },
          { key: 'total_esperado', label: 'Monto esperado', weight: 1, align: 'right', format: 'currency' },
          { key: 'total_contado', label: 'Monto contado', weight: 1, align: 'right', format: 'currency' },
          { key: 'diferencia', label: 'Dif.', weight: 1, align: 'right', format: 'currency' },
          { key: 'tipo_diferencia', label: 'Tipo diferencia', weight: 1 },
          { key: 'resolucion', label: 'Resolucion', weight: 1.2 },
          { key: 'observacion', label: 'Observacion', weight: 1.4 },
          { key: 'estado', label: 'Estado', weight: 1 }
        ]
      }
    ]
  },
  inventario_stock_critico: {
    title: 'Inventario - Stock critico',
    orientation: 'landscape',
    sections: [
      {
        key: 'items',
        title: 'Items criticos',
        columns: [
          { key: 'tipo_item', label: 'Tipo', weight: 0.9 },
          { key: 'nombre', label: 'Nombre', weight: 1.5 },
          { key: 'categoria', label: 'Categoria', weight: 1.1 },
          { key: 'almacen', label: 'Almacen', weight: 1.2 },
          { key: 'sucursal', label: 'Sucursal', weight: 1.2 },
          { key: 'cantidad_actual', label: 'Cantidad actual', weight: 0.9, align: 'right', format: 'number' },
          { key: 'stock_minimo', label: 'Stock minimo', weight: 0.9, align: 'right', format: 'number' },
          { key: 'diferencia_minimo', label: 'Dif.', weight: 0.8, align: 'right', format: 'number' },
          { key: 'estado_stock', label: 'Estado stock', weight: 1 },
          { key: 'estado_item', label: 'Estado item', weight: 1 }
        ]
      }
    ]
  },
  inventario_kardex: {
    title: 'Inventario - Kardex',
    orientation: 'landscape',
    sections: [
      {
        key: 'movimientos',
        title: 'Movimientos',
        columns: [
          { key: 'fecha_mov', label: 'Fecha', weight: 1.1 },
          { key: 'nombre_sucursal', label: 'Sucursal', weight: 1.2 },
          { key: 'nombre_almacen', label: 'Almacen', weight: 1.2 },
          { key: 'item_tipo', label: 'Tipo item', weight: 0.9 },
          { key: 'item_nombre', label: 'Item', weight: 1.5 },
          { key: 'categoria', label: 'Categoria', weight: 1.1 },
          { key: 'tipo', label: 'Tipo movimiento', weight: 0.9 },
          { key: 'cantidad', label: 'Cantidad', weight: 0.8, align: 'right', format: 'number' },
          { key: 'saldo_antes', label: 'Saldo ant.', weight: 0.8, align: 'right', format: 'number' },
          { key: 'saldo_despues', label: 'Saldo act.', weight: 0.8, align: 'right', format: 'number' },
          { key: 'referencia', label: 'Referencia', weight: 1 },
          { key: 'origen_modulo', label: 'Origen/modulo', weight: 1 },
          { key: 'usuario', label: 'Usuario', weight: 1 },
          { key: 'descripcion', label: 'Descripcion', weight: 1.5 }
        ]
      }
    ]
  }
});

const resolveReportPdfConfig = (reportKey, data = {}) => {
  const config = PDF_REPORT_CONFIG[reportKey];
  if (config) return config;
  const firstArrayKey = Object.keys(data || {}).find((key) => key !== 'kpis' && Array.isArray(data[key]));
  return {
    title: `Reporte ${reportKey}`,
    orientation: 'portrait',
    sections: firstArrayKey
      ? [{ key: firstArrayKey, title: firstArrayKey, columns: [] }]
      : []
  };
};

const resolvePdfLogoPath = () => {
  const candidates = [
    path.resolve(process.cwd(), '..', 'jonny-s-smartorder', 'src', 'assets', 'images', 'logo-jonnys.png'),
    path.resolve(process.cwd(), '..', 'jonny-s-smartorder', 'src', 'assets', 'images', 'logo-sin-fondo.png'),
    path.resolve(process.cwd(), '..', 'jonny-s-smartorder', 'public', 'favicon-jonnys-round.png')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const formatPdfValue = (value, format) => {
  if (value === null || value === undefined || value === '') return '-';
  if (format === 'currency') return `L ${Number(value || 0).toFixed(2)}`;
  if (format === 'percent') return `${Number(value || 0).toFixed(2)}%`;
  if (format === 'number') return Number(value || 0).toFixed(2);
  return String(value);
};

const buildHumanFilters = (filters = {}) => {
  const entries = Object.entries(filters || {})
    .filter(([, value]) => String(value ?? '').trim() !== '')
    .map(([key, value]) => ({
      label: PDF_FILTER_LABELS[key] || key,
      value: String(value).trim()
    }));
  if (filters.fecha_inicio || filters.fecha_fin) {
    const period = `${filters.fecha_inicio || '...'} a ${filters.fecha_fin || '...'}`;
    return [{ label: 'Periodo', value: period }, ...entries.filter((entry) => entry.label !== 'Fecha inicio' && entry.label !== 'Fecha fin')];
  }
  return entries;
};

const truncateText = (text, maxLength = 42) => {
  const raw = String(text ?? '');
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, Math.max(0, maxLength - 1))}…`;
};

const fitTextToWidth = (doc, text, width, fontSize = 7, maxLines = 2) => {
  const raw = String(text ?? '');
  if (!raw) return '-';
  const safeWidth = Math.max(24, width);
  doc.fontSize(fontSize);
  if (doc.heightOfString(raw, { width: safeWidth }) <= (fontSize + 1.8) * maxLines) return raw;
  let low = 0;
  let high = raw.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${raw.slice(0, mid).trimEnd()}…`;
    if (doc.heightOfString(candidate, { width: safeWidth }) <= (fontSize + 1.8) * maxLines) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best || truncateText(raw, 20);
};

const buildReportPdfBuffer = ({ reportKey, payload, generatedBy = null }) => new Promise((resolve, reject) => {
  try {
    const data = payload?.data || {};
    const filtros = payload?.filtros || {};
    const kpis = data?.kpis || {};
    const config = resolveReportPdfConfig(reportKey, data);
    const logoPath = resolvePdfLogoPath();
    const humanFilters = buildHumanFilters(filtros);
    const pageLayout = config.orientation === 'landscape' ? 'landscape' : 'portrait';

    const doc = new PDFDocument({ size: 'A4', layout: pageLayout, margin: 28, bufferPages: true });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const drawHeader = () => {
      const top = doc.page.margins.top;
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      let headerY = top;
      if (logoPath) {
        try {
          doc.image(logoPath, left, top - 2, { fit: [46, 46] });
        } catch (_error) {
          // AM: fallback textual si el logo no puede renderizarse en PDFKit.
        }
      }
      doc.fontSize(18).fillColor('#0f172a').text('Jonny’s', left + 54, headerY, { continued: true });
      doc.fontSize(14).fillColor('#334155').text(' SmartOrden');
      headerY += 20;
      doc.fontSize(12).fillColor('#111827').text(config.title || `Reporte ${reportKey}`, left + 54, headerY);
      doc.fontSize(8).fillColor('#64748b').text(`Generado: ${new Date().toLocaleString('es-HN')}`, left + 54, headerY + 14);
      if (generatedBy) {
        doc.fontSize(8).fillColor('#64748b').text(`Usuario: ${generatedBy}`, left + 54, headerY + 26);
      }
      doc.moveTo(left, top + 52).lineTo(right, top + 52).strokeColor('#cbd5e1').lineWidth(1).stroke();
      return top + 58;
    };

    const drawKpis = (startY) => {
      if (!kpis || typeof kpis !== 'object' || Object.keys(kpis).length === 0) return startY;
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const pairs = Object.entries(kpis).slice(0, 8);
      if (!pairs.length) return startY;
      const cardsPerRow = pageLayout === 'landscape' ? 4 : 3;
      const gap = 8;
      const cardHeight = 36;
      const rows = Math.ceil(pairs.length / cardsPerRow);
      const boxTop = startY + 6;
      const boxHeight = (rows * cardHeight) + ((rows + 1) * gap);
      const cardWidth = ((right - left) - ((cardsPerRow + 1) * gap)) / cardsPerRow;
      doc.roundedRect(left, boxTop, right - left, boxHeight, 6).fillAndStroke('#f8fafc', '#e2e8f0');
      pairs.forEach(([key, value], index) => {
        const row = Math.floor(index / cardsPerRow);
        const col = index % cardsPerRow;
        const x = left + gap + (col * (cardWidth + gap));
        const y = boxTop + gap + (row * (cardHeight + gap));
        doc.roundedRect(x, y, cardWidth, cardHeight, 4).fillAndStroke('#ffffff', '#e2e8f0');
        doc.fontSize(7).fillColor('#64748b').text(key.replace(/_/g, ' '), x + 6, y + 5, { width: cardWidth - 12, lineBreak: false });
        doc.fontSize(9).fillColor('#0f172a').text(formatPdfValue(value, Number(value) === value && (key.includes('total') || key.includes('subtotal') || key.includes('ticket') || key.includes('promedio')) ? 'currency' : undefined), x + 6, y + 17, { width: cardWidth - 12, lineBreak: false });
      });
      return boxTop + boxHeight + 10;
    };

    const drawFilters = (startY) => {
      if (humanFilters.length === 0) return startY;
      const left = doc.page.margins.left;
      let y = startY + 2;
      doc.fontSize(9).fillColor('#0f172a').text('Filtros aplicados', left, y);
      y += 12;
      humanFilters.forEach(({ label, value }) => {
        doc.fontSize(8).fillColor('#334155').text(`${label}: ${value}`, left, y, { width: doc.page.width - left - doc.page.margins.right });
        y += 11;
      });
      return y + 2;
    };

    const drawTableSection = ({ section, rows, startY }) => {
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const tableWidth = right - left;
      const columns = (Array.isArray(section.columns) && section.columns.length > 0)
        ? section.columns
        : [...new Set((rows || []).flatMap((row) => Object.keys(row || {})))].map((key) => ({ key, label: key, weight: 1 }));
      const totalWeight = columns.reduce((sum, column) => sum + Number(column.weight || 1), 0) || 1;
      const colWidths = columns.map((column) => (tableWidth * Number(column.weight || 1)) / totalWeight);
      const headerHeight = 20;
      let y = startY;

      const ensureSpace = (requiredHeight) => {
        const limitY = doc.page.height - doc.page.margins.bottom - 22;
        if (y + requiredHeight <= limitY) return;
        doc.addPage();
        y = drawHeader();
        y = drawFilters(y);
        y += 4;
        drawHeaderRow();
      };

      const drawHeaderRow = () => {
        doc.rect(left, y, tableWidth, headerHeight).fillAndStroke('#e2e8f0', '#cbd5e1');
        let x = left;
        columns.forEach((column, index) => {
          const width = colWidths[index];
          const headerLabel = fitTextToWidth(doc, truncateText(column.label, 30), width - 8, 7, 2);
          doc.fontSize(7).fillColor('#0f172a').text(headerLabel, x + 4, y + 4, { width: width - 8, align: column.align === 'right' ? 'right' : 'left' });
          x += width;
        });
        y += headerHeight;
      };

      doc.fontSize(10).fillColor('#0f172a').text(section.title, left, y);
      y += 14;
      drawHeaderRow();

      if (!rows.length) {
        doc.fontSize(8).fillColor('#64748b').text('Sin datos.', left, y + 4);
        return y + 18;
      }

      rows.forEach((row, rowIndex) => {
        const preparedCells = columns.map((column, index) => {
          const width = colWidths[index];
          const raw = formatPdfValue(row?.[column.key], column.format);
          const display = fitTextToWidth(doc, raw, width - 8, 7, 2);
          const height = doc.heightOfString(display, { width: width - 8 });
          return { column, width, display, height };
        });
        const maxHeight = Math.max(...preparedCells.map((c) => c.height), 9.5);
        const rowHeight = Math.max(16, Math.min(28, maxHeight + 7));
        ensureSpace(rowHeight + 2);
        doc.rect(left, y, tableWidth, rowHeight).fillAndStroke(rowIndex % 2 === 0 ? '#ffffff' : '#f8fafc', '#e2e8f0');
        let x = left;
        preparedCells.forEach(({ column, width, display }, index) => {
          doc.fontSize(7).fillColor('#111827').text(
            display,
            x + 4,
            y + 3.5,
            { width: width - 6, align: column.align === 'right' ? 'right' : 'left' }
          );
          x += width;
        });
        y += rowHeight;
      });

      return y + 8;
    };

    let cursorY = drawHeader();
    cursorY = drawKpis(cursorY);
    cursorY = drawFilters(cursorY);
    cursorY += 4;

    const sections = Array.isArray(config.sections) ? config.sections : [];
    sections.forEach((section) => {
      const rows = Array.isArray(data?.[section.key]) ? data[section.key] : [];
      cursorY = drawTableSection({ section, rows, startY: cursorY });
    });

    if (sections.length === 0) {
      doc.fontSize(9).fillColor('#6b7280').text('Sin datos tabulares para este reporte.', doc.page.margins.left, cursorY + 6);
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      const pageWidth = doc.page.width;
      const bottomY = doc.page.height - doc.page.margins.bottom + 6;
      doc.fontSize(8).fillColor('#64748b').text(`Pagina ${i + 1} de ${range.count}`, 0, bottomY, { width: pageWidth, align: 'center' });
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
  if (!parsedFilters.estado) {
    // AM: por defecto excluimos anuladas/canceladas; solo se incluyen con filtro de estado explícito.
    built.whereClause = built.whereClause
      ? `${built.whereClause} AND COALESCE(ep.descripcion, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`
      : `WHERE COALESCE(ep.descripcion, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`;
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

    const dayBucket = byDate.get(fecha) || {
      fecha,
      cantidad_ventas: 0,
      subtotal: 0,
      descuento: 0,
      impuesto: 0,
      total_neto: 0,
      _estados: new Map()
    };
    dayBucket.cantidad_ventas += 1;
    dayBucket.subtotal += subtotalRow;
    dayBucket.descuento += descuentosRow;
    dayBucket.impuesto += impuestosRow;
    dayBucket.total_neto += totalRow;
    dayBucket._estados.set(estado, Number(dayBucket._estados.get(estado) || 0) + 1);
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
        subtotal_general: roundMoney(subtotal),
        descuento_general: roundMoney(descuentos),
        impuesto_general: roundMoney(impuestos),
        total_neto_general: roundMoney(totalNeto),
        ticket_promedio_general: roundMoney(promedioVenta),
        ventas_canceladas_o_anuladas: canceladas
      },
      serie_diaria: [...byDate.values()].map((item) => ({
        fecha: item.fecha,
        cantidad_ventas: item.cantidad_ventas,
        subtotal: roundMoney(item.subtotal),
        descuento: roundMoney(item.descuento),
        impuesto: roundMoney(item.impuesto),
        total_neto: roundMoney(item.total_neto),
        ticket_promedio: item.cantidad_ventas > 0 ? roundMoney(item.total_neto / item.cantidad_ventas) : 0,
        estado_principal: [...item._estados.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Sin estado'
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

  if (!parsedFilters.estado) {
    // AM: por defecto excluimos anuladas/canceladas; solo se incluyen cuando estado viene informado.
    built.whereClause = built.whereClause
      ? `${built.whereClause} AND COALESCE(ep.descripcion, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`
      : `WHERE COALESCE(ep.descripcion, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`;
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
  const ticketPromedioGeneral = totalVentasUnicas > 0 ? roundMoney(totalGeneral / totalVentasUnicas) : 0;

  return res.json({
    ok: true,
    reporte: 'ventas_metodos_pago',
    fase: 'fase_2b_real',
    filtros: filters,
    data: {
      kpis: {
        total_general: roundMoney(totalGeneral),
        total_ventas: totalVentasUnicas,
        ticket_promedio_general: ticketPromedioGeneral,
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
  if (!parsedFilters.estado) {
    // AM: por defecto excluimos cierres anulados; si estado viene informado se respeta el filtro explícito.
    built.whereClause = built.whereClause
      ? `${built.whereClause} AND COALESCE(resolucion.nombre, 'SIN RESOLUCION') !~* 'ANULAD'`
      : `WHERE COALESCE(resolucion.nombre, 'SIN RESOLUCION') !~* 'ANULAD'`;
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
      COALESCE(resolucion.nombre, 'SIN RESOLUCION') AS estado_cierre,
      COALESCE(resolucion.nombre, 'SIN RESOLUCION') AS resolucion,
      COALESCE(cc.observacion, '') AS observacion,
      CASE
        WHEN COALESCE(resolucion.nombre, '') ~* 'ANULAD' THEN 'ANULADO'
        ELSE 'CERRADO'
      END AS estado
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
        diferencia_neta: roundMoney(totals.totalDiferencia),
        cierres_con_diferencia: totals.conDiferencia,
        cierres_sin_diferencia: totals.sinDiferencia,
        cantidad_con_diferencia: totals.conDiferencia,
        cantidad_sin_diferencia: totals.sinDiferencia
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
        estado_cierre: row.estado_cierre,
        estado: row.estado || 'CERRADO',
        resolucion: row.resolucion || row.estado_cierre || 'SIN RESOLUCION',
        observacion: row.observacion || ''
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
  if (!parsedFilters.estado) {
    // AM: por defecto excluimos anulados; si estado viene informado, se respeta el filtro explícito.
    built.whereClause = built.whereClause
      ? `${built.whereClause} AND COALESCE(resolucion.nombre, 'SIN RESOLUCION') !~* 'ANULAD'`
      : `WHERE COALESCE(resolucion.nombre, 'SIN RESOLUCION') !~* 'ANULAD'`;
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
      COALESCE(resolucion.nombre, 'SIN RESOLUCION') AS resolucion,
      COALESCE(cc.observacion, '') AS observacion,
      CASE
        WHEN COALESCE(resolucion.nombre, '') ~* 'ANULAD' THEN 'ANULADO'
        ELSE 'VALIDO'
      END AS estado
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
      acc.diferenciaNeta += diferencia;
      if (abs > acc.mayorDiferenciaAbs) acc.mayorDiferenciaAbs = abs;
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
      diferenciaNeta: 0,
      mayorDiferenciaAbs: 0,
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
        diferencia_neta: roundMoney(totals.diferenciaNeta),
        mayor_diferencia_registrada: roundMoney(totals.mayorDiferenciaAbs),
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
        resolucion: row.resolucion || row.estado_resolucion || 'SIN RESOLUCION',
        observacion: row.observacion || '',
        estado: row.estado || 'VALIDO'
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
  } else {
    where.push('base.estado_activo = true'); // AM: por defecto excluimos items inactivos salvo filtro explícito.
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const onlyCriticosSql = parsedFilters.solo_criticos !== false // AM: por defecto mostramos solo sin stock/critico/bajo.
    ? `WHERE estado_calculado IN ('SIN STOCK', 'CRITICO', 'BAJO')`
    : '';

  const query = `
    WITH base AS (
      SELECT
        'PRODUCTO'::text AS tipo_item,
        p.id_producto AS id_item,
        p.nombre_producto AS nombre_item,
        p.id_categoria_producto AS id_categoria,
        cp.nombre_categoria AS categoria,
        a.id_almacen,
        COALESCE(a.nombre_almacen, a.nombre) AS almacen,
        a.id_sucursal,
        s.nombre_sucursal AS sucursal,
        COALESCE(pa.cantidad, 0)::numeric(14,2) AS cantidad_actual,
        COALESCE(pa.stock_minimo, 0)::numeric(14,2) AS stock_minimo,
        COALESCE(p.estado, true) AS estado_activo
      FROM public.productos_almacenes pa
      INNER JOIN public.productos p ON p.id_producto = pa.id_producto
      INNER JOIN public.almacenes a ON a.id_almacen = pa.id_almacen
      LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      LEFT JOIN public.categorias_productos cp ON cp.id_categoria_producto = p.id_categoria_producto
      WHERE COALESCE(pa.estado, true) = true

      UNION ALL

      SELECT
        'INSUMO'::text AS tipo_item,
        i.id_insumo AS id_item,
        i.nombre_insumo AS nombre_item,
        i.id_categoria_insumo AS id_categoria,
        ci.nombre_categoria AS categoria,
        a.id_almacen,
        COALESCE(a.nombre_almacen, a.nombre) AS almacen,
        a.id_sucursal,
        s.nombre_sucursal AS sucursal,
        COALESCE(ia.cantidad, 0)::numeric(14,2) AS cantidad_actual,
        COALESCE(ia.stock_minimo, 0)::numeric(14,2) AS stock_minimo,
        COALESCE(i.estado, true) AS estado_activo
      FROM public.insumos_almacenes ia
      INNER JOIN public.insumos i ON i.id_insumo = ia.id_insumo
      INNER JOIN public.almacenes a ON a.id_almacen = ia.id_almacen
      LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
      LEFT JOIN public.categorias_insumos ci ON ci.id_categoria_insumo = i.id_categoria_insumo
      WHERE COALESCE(ia.estado, true) = true
    ),
    filtrado AS (
      SELECT
        base.*,
        (base.cantidad_actual - base.stock_minimo)::numeric(14,2) AS diferencia_minimo,
        CASE
          WHEN base.cantidad_actual <= 0 THEN 'SIN STOCK'
          WHEN base.cantidad_actual <= base.stock_minimo THEN 'CRITICO'
          WHEN base.stock_minimo > 0 AND base.cantidad_actual <= (base.stock_minimo * 1.20) THEN 'BAJO'
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
      if (estado === 'CRITICO' || estado === 'SIN STOCK' || estado === 'BAJO') acc.criticos += 1;
      if (estado === 'SIN STOCK') acc.agotados += 1;
      if (estado === 'BAJO') acc.bajoStock += 1;
      if (['CRITICO', 'SIN STOCK', 'BAJO'].includes(estado) && row.tipo_item === 'PRODUCTO') acc.productosAfectados += 1;
      if (['CRITICO', 'SIN STOCK', 'BAJO'].includes(estado) && row.tipo_item === 'INSUMO') acc.insumosAfectados += 1;
      if (['CRITICO', 'SIN STOCK', 'BAJO'].includes(estado)) acc.almacenesAfectados.add(String(row.id_almacen || '0'));
      return acc;
    },
    { criticos: 0, agotados: 0, bajoStock: 0, productosAfectados: 0, insumosAfectados: 0, almacenesAfectados: new Set() }
  );

  return res.json({
    ok: true,
    reporte: 'inventario_stock_critico',
    fase: 'fase_3a_real',
    filtros: filters,
    data: {
      kpis: {
        total_items_revisados: rows.length,
        total_items_criticos_bajos: metrics.criticos,
        total_criticos: metrics.criticos,
        total_sin_stock: metrics.agotados,
        total_agotados: metrics.agotados,
        total_bajo_minimo: metrics.bajoStock,
        total_stock_bajo: metrics.bajoStock,
        productos_afectados: metrics.productosAfectados,
        insumos_afectados: metrics.insumosAfectados,
        almacenes_afectados: metrics.almacenesAfectados.size,
        productos_criticos: metrics.productosAfectados,
        insumos_criticos: metrics.insumosAfectados
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
        estado_stock: row.estado_calculado,
        estado_item: row.estado_activo ? 'ACTIVO' : 'INACTIVO',
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

  if (parsedFilters.categoria) {
    const categoriaId = parsePositiveInt(parsedFilters.categoria);
    if (categoriaId) {
      params.push(categoriaId);
      where.push(`(
        (LOWER(COALESCE(k.item_tipo, '')) = 'producto' AND k.id_categoria_producto = $${params.length})
        OR
        (LOWER(COALESCE(k.item_tipo, '')) = 'insumo' AND k.id_categoria_insumo = $${params.length})
      )`);
    } else {
      params.push(`%${parsedFilters.categoria}%`);
      where.push(`COALESCE(k.categoria, '') ILIKE $${params.length}`);
    }
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
      k.categoria,
      k.id_categoria_producto,
      k.id_categoria_insumo,
      k.impacto,
      k.ref_origen,
      k.id_ref,
      k.referencia,
      k.origen_modulo,
      k.usuario,
      k.descripcion
    FROM (
      SELECT
        kd.*,
        prod.id_categoria_producto,
        cp.nombre_categoria AS categoria_producto,
        ins.id_categoria_insumo,
        ci.nombre_categoria AS categoria_insumo,
        COALESCE(
          CASE WHEN LOWER(COALESCE(kd.item_tipo, '')) = 'producto' THEN cp.nombre_categoria END,
          CASE WHEN LOWER(COALESCE(kd.item_tipo, '')) = 'insumo' THEN ci.nombre_categoria END,
          'Sin categoria'
        ) AS categoria,
        COALESCE(kd.ref_origen, '-') || CASE WHEN kd.id_ref IS NOT NULL THEN (' #' || kd.id_ref::text) ELSE '' END AS referencia,
        COALESCE(kd.ref_origen, 'SISTEMA') AS origen_modulo,
        '-'::text AS usuario
      FROM public.v_kardex_detalle kd
      LEFT JOIN public.productos prod ON prod.id_producto = kd.id_producto
      LEFT JOIN public.categorias_productos cp ON cp.id_categoria_producto = prod.id_categoria_producto
      LEFT JOIN public.insumos ins ON ins.id_insumo = kd.id_insumo
      LEFT JOIN public.categorias_insumos ci ON ci.id_categoria_insumo = ins.id_categoria_insumo
    ) k
    ${whereSql}
    ORDER BY k.fecha_mov DESC, k.id_movimiento DESC
    ${limitSql}
  `;

  const result = await pool.query(query, params);
  const rows = Array.isArray(result.rows) ? result.rows : [];

  const metrics = rows.reduce(
    (acc, row) => {
      const tipo = String(row.tipo || '').trim().toUpperCase();
      const cantidad = Number(row.cantidad || 0);
      if (tipo === 'ENTRADA') {
        acc.entradas += 1;
        acc.cantidadEntradas += cantidad;
      } else if (tipo === 'SALIDA') {
        acc.salidas += 1;
        acc.cantidadSalidas += cantidad;
      } else {
        acc.ajustes += 1;
        acc.cantidadAjustes += cantidad;
      }
      acc.neta += Number(row.impacto || 0);
      if (row.item_id !== null && row.item_id !== undefined) acc.items.add(`${String(row.item_tipo || '').toLowerCase()}-${row.item_id}`);
      if (row.id_almacen !== null && row.id_almacen !== undefined) acc.almacenes.add(String(row.id_almacen));
      return acc;
    },
    { entradas: 0, salidas: 0, ajustes: 0, cantidadEntradas: 0, cantidadSalidas: 0, cantidadAjustes: 0, neta: 0, items: new Set(), almacenes: new Set() }
  );

  return res.json({
    ok: true,
    reporte: 'inventario_kardex',
    fase: 'fase_3b_real',
    filtros: filters,
    data: {
      kpis: {
        total_movimientos: rows.length,
        total_entradas: metrics.entradas,
        total_salidas: metrics.salidas,
        total_ajustes: metrics.ajustes,
        cantidad_neta_movida: Number(metrics.neta.toFixed(2)),
        items_afectados: metrics.items.size,
        almacenes_afectados: metrics.almacenes.size,
        entradas: metrics.entradas,
        salidas: metrics.salidas,
        ajustes_otros: metrics.ajustes,
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
  } else {
    // AM: por defecto excluimos anuladas/canceladas para mantener el reporte limpio.
    where.push(`COALESCE(ep.descripcion, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`);
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
      COALESCE(prod.nombre_producto, CONCAT('Item #', COALESCE(df.id_producto, 0))) AS item,
      COALESCE(dc.nombre_descuento, 'DESCUENTO MANUAL') AS nombre_descuento,
      COALESCE(d.monto_descuento, 0)::numeric(14,2) AS descuento,
      COALESCE(df.sub_total, 0)::numeric(14,2) AS subtotal_linea,
      COALESCE(df.total_detalle, 0)::numeric(14,2) AS total_linea,
      COALESCE(ep.descripcion, 'VENTA DIRECTA') AS estado
    FROM facturas f
    INNER JOIN detalle_facturas df ON df.id_factura = f.id_factura
    INNER JOIN descuentos d ON d.id_descuento = df.id_descuento
    LEFT JOIN productos prod ON prod.id_producto = df.id_producto
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

  const subtotalAfectado = rows.reduce((sum, row) => sum + Number(row.subtotal_linea || 0), 0);
  const totalDescuento = rows.reduce((sum, row) => sum + Number(row.descuento || 0), 0);
  const totalNeto = rows.reduce((sum, row) => sum + Number(row.total_linea || 0), 0);
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
        cantidad_descuentos_aplicados: rows.length,
        subtotal_afectado: roundMoney(subtotalAfectado),
        total_descuento: roundMoney(totalDescuento),
        total_neto_despues_descuento: roundMoney(totalNeto),
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
        item: row.item || 'Item',
        subtotal_linea: roundMoney(row.subtotal_linea),
        descuento: roundMoney(row.descuento),
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
  } else {
    // AM: por defecto excluimos anuladas/canceladas para no contaminar el reporte principal.
    where.push(`COALESCE(base.estado, 'VENTA DIRECTA') !~* '(ANULAD|CANCELAD)'`);
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
        CASE
          WHEN COALESCE(df.cantidad, 0) = 0 THEN 0::numeric(14,2)
          ELSE (COALESCE(df.sub_total, 0) / NULLIF(df.cantidad, 0))::numeric(14,2)
        END AS precio_unitario,
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
        CASE
          WHEN COALESCE(
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
          ) = 0 THEN 0::numeric(14,2)
          ELSE (
            COALESCE(dp.sub_total_pedido, 0)
            / NULLIF(
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
              ),
              0
            )
          )::numeric(14,2)
        END AS precio_unitario,
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
  const totalCantidad = rows.reduce((sum, row) => sum + Number(row.cantidad || 0), 0);
  const totalSubtotal = rows.reduce((sum, row) => sum + Number(row.subtotal || 0), 0);
  const totalDescuento = rows.reduce((sum, row) => sum + Number(row.descuento || 0), 0);
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
        cantidad_total_vendida: Number(totalCantidad.toFixed(2)),
        subtotal_total: roundMoney(totalSubtotal),
        descuento_total: roundMoney(totalDescuento),
        total_neto: roundMoney(totalVendido),
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
        precio_unitario: roundMoney(row.precio_unitario),
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
      payload: capture.state.body,
      generatedBy: req?.user?.nombre_usuario || req?.user?.usuario || req?.user?.email || null
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

router.post('/reportes/enviar-correo', checkPermission([BASE_PERMISSION, 'REPORTES_ENVIAR_CORREO']), async (req, res) => {
  try {
    if (IS_DEV_LOG) {
      const smtpInfo = getSmtpRuntimeInfo();
      const debugPayload = req.body && typeof req.body === 'object' ? req.body : {};
      console.log('[reportes][enviar-correo] request', {
        id_usuario: req?.user?.id_usuario || null,
        reporte: debugPayload?.reporte || null,
        formato: debugPayload?.formato || null,
        destinatarios_count: Array.isArray(debugPayload?.destinatarios) ? debugPayload.destinatarios.length : 0,
        smtp_configured: smtpInfo.configured,
        smtp_host: smtpInfo.host,
        smtp_port: smtpInfo.port,
        smtp_secure: smtpInfo.secure,
        smtp_from_email: smtpInfo.from_email
      });
    }

    if (!isSmtpConfigured()) {
      return res.status(503).json({
        error: true,
        message: 'El servicio de correo no esta configurado en este entorno.'
      });
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const reportKeyInput = normalizeReportKeyInput(payload.reporte);
    const reportDefinition = Object.values(REPORT_DEFINITIONS).find((item) => item.key === reportKeyInput);

    if (!reportDefinition) {
      return res.status(400).json({
        error: true,
        message: 'El campo reporte es invalido.'
      });
    }

    const formato = String(payload.formato || '').trim().toLowerCase();
    if (!['pdf', 'excel'].includes(formato)) {
      return res.status(400).json({
        error: true,
        message: 'El campo formato solo permite pdf o excel.'
      });
    }

    if (payload.confirmado !== true) {
      return res.status(400).json({
        error: true,
        message: 'Debes confirmar explicitamente el envio antes de continuar.'
      });
    }

    const recipientsValidation = parseEmailRecipients(payload.destinatarios);
    if (!recipientsValidation.ok) {
      return res.status(400).json({ error: true, message: recipientsValidation.message });
    }

    const hasReportPermission = await requestHasAnyPermission(req, reportDefinition.permissions);
    if (!hasReportPermission) {
      return res.status(403).json({
        error: true,
        message: 'Acceso denegado: permisos insuficientes'
      });
    }

    const formatPermission = formato === 'pdf' ? 'REPORTES_EXPORTAR_PDF' : 'REPORTES_EXPORTAR_EXCEL';
    const hasFormatPermission = await requestHasAnyPermission(req, [formatPermission]);
    if (!hasFormatPermission) {
      return res.status(403).json({
        error: true,
        message: 'Acceso denegado: no tienes permiso para enviar este formato.'
      });
    }

    const parsed = parseFilters(payload.filtros || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: true, message: parsed.message });
    }

    const rawSubject = String(payload.asunto || '').trim();
    if (!rawSubject) {
      return res.status(400).json({
        error: true,
        message: 'El asunto es obligatorio.'
      });
    }
    const subject = rawSubject.slice(0, MAX_SUBJECT_LENGTH);

    const messageRaw = String(payload.mensaje || '').trim();
    const message = messageRaw.slice(0, MAX_MESSAGE_LENGTH);

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

    const attachmentFilename = formato === 'pdf'
      ? buildPdfFileName({ reportKey: reportDefinition.key, parsedFilters: parsed.parsed })
      : buildExportFileName({ reportKey: reportDefinition.key, parsedFilters: parsed.parsed });

    const attachmentContent = formato === 'pdf'
      ? await buildReportPdfBuffer({
          reportKey: reportDefinition.key,
          payload: capture.state.body,
          generatedBy: req?.user?.nombre_usuario || req?.user?.usuario || req?.user?.email || null
        })
      : Buffer.from(
          buildExcelCompatibleCsv({ reportKey: reportDefinition.key, payload: capture.state.body }),
          'utf8'
        );

    const htmlBody = `
      <div style="font-family: Arial, sans-serif; color: #1f2937;">
        <h3 style="margin-bottom:8px;">Reporte ${reportDefinition.key}</h3>
        <p style="margin:0 0 8px;">${message || 'Se adjunta el reporte solicitado.'}</p>
        <p style="margin:0; font-size:12px; color:#6b7280;">Generado el ${new Date().toISOString()}</p>
      </div>
    `;

    const sendResult = await sendReportEmail({
      to: recipientsValidation.recipients,
      subject,
      html: htmlBody,
      text: `${message || 'Se adjunta el reporte solicitado.'}\n\nReporte: ${reportDefinition.key}`,
      attachments: [
        {
          filename: attachmentFilename,
          content: attachmentContent,
          contentType: formato === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8'
        }
      ]
    });

    if (IS_DEV_LOG) {
      console.log('[reportes][enviar-correo] success', {
        id_usuario: req?.user?.id_usuario || null,
        reporte: reportDefinition.key,
        formato,
        destinatarios_count: recipientsValidation.recipients.length,
        message_id: sendResult?.messageId || null
      });
    }

    return res.status(200).json({
      ok: true,
      enviado: true,
      reporte: reportDefinition.key,
      formato,
      destinatarios: recipientsValidation.recipients.length
    });
  } catch (error) {
    if (IS_DEV_LOG) {
      console.log('[reportes][enviar-correo] error', {
        id_usuario: req?.user?.id_usuario || null,
        name: error?.name || 'Error',
        code: error?.code || null,
        command: error?.command || null,
        response_code: error?.responseCode || null,
        message: String(error?.message || 'Error desconocido')
      });
    }

    if (String(error?.message || '').toUpperCase().includes('SMTP')) {
      return res.status(502).json({
        error: true,
        message: 'No se pudo enviar el reporte por correo. Verifica la configuracion SMTP.'
      });
    }

    return res.status(500).json({
      error: true,
      message: 'No se pudo enviar el reporte por correo.'
    });
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
