import express from 'express';
import { checkPermission } from '../middleware/checkPermission.js';

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

  return { ok: true, filters };
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

router.use('/reportes', checkPermission(BASE_PERMISSION));

Object.entries(REPORT_DEFINITIONS).forEach(([path, config]) => {
  router.get(path, checkPermission([...config.permissions, BASE_PERMISSION]), (req, res) => {
    const parsed = parseFilters(req.query || {});
    if (!parsed.ok) {
      return res.status(400).json({ error: true, message: parsed.message });
    }

    return sendPhaseOnePayload(res, config.key, parsed.filters);
  });
});

export default router;
