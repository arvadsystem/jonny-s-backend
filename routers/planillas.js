import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload
} from '../utils/security/personasHardening.js';

const router = express.Router();

// API cap intentionally fixed to 100; consumers should paginate to gather complete datasets.
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

const PLANILLA_FUNCTION_NAMES = Object.freeze([
  'fn_generar_planilla_mensual_por_sucursal',
  'fn_recalcular_detalle_planilla',
  'fn_recalcular_planilla_por_sucursal',
  'fn_listar_planillas_por_sucursal',
  'fn_listar_detalle_planilla',
  'fn_listar_empleados_activos_por_sucursal',
  'fn_listar_adelantos_pendientes_por_sucursal',
  'fn_listar_adelantos_aplicables_a_planilla',
  'fn_aplicar_adelanto_a_planilla',
  'fn_listar_resumen_planilla_por_sucursal',
  'fn_registrar_movimiento_planilla',
  'fn_listar_movimientos_planilla',
  'fn_listar_movimientos_planilla_detalle',
  'fn_anular_movimiento_planilla',
  'fn_actualizar_estado_planilla',
  'fn_planilla_completa_json',
  'fn_anular_planilla_completa',
  'fn_listar_auditoria_planilla'
]);

const PLANILLAS_VIEW_PERMISSIONS = ['PLANILLAS_LISTADO_VER'];
const PLANILLAS_DETAIL_PERMISSIONS = ['PLANILLAS_DETALLE_VER'];
const PLANILLAS_GENERATE_PERMISSIONS = ['PLANILLAS_GENERAR'];
const PLANILLAS_RECALCULAR_PERMISSIONS = ['PLANILLAS_RECALCULAR'];
const PLANILLAS_ADELANTOS_APLICAR_PERMISSIONS = ['PLANILLAS_ADELANTOS_APLICAR'];
const PLANILLAS_ADELANTOS_REGISTRAR_PERMISSIONS = ['PLANILLAS_ADELANTOS_REGISTRAR', 'PLANILLAS_ADELANTOS_APLICAR'];
const PLANILLAS_ADELANTOS_ANULAR_PERMISSIONS = ['PLANILLAS_ADELANTOS_ANULAR', 'PLANILLAS_ADELANTOS_APLICAR'];
const PLANILLAS_MOVIMIENTO_REGISTER_PERMISSIONS = ['PLANILLAS_MOVIMIENTO_REGISTRAR'];
const PLANILLAS_MOVIMIENTO_EDIT_PERMISSIONS = ['PLANILLAS_MOVIMIENTO_EDITAR', 'PLANILLAS_MOVIMIENTO_REGISTRAR'];
const PLANILLAS_MOVIMIENTO_ANULAR_PERMISSIONS = ['PLANILLAS_MOVIMIENTO_ANULAR'];
const PLANILLAS_ESTADO_PERMISSIONS = [
  'PLANILLAS_CERRAR',
  'PLANILLAS_REABRIR',
  'PLANILLAS_APROBAR',
  'PLANILLAS_PAGAR',
  'PLANILLAS_PAGO_REVERSAR',
  'PLANILLAS_ANULAR'
];
const PLANILLAS_AUDITORIA_PERMISSIONS = ['PLANILLAS_AUDITORIA_VER'];
const PLANILLAS_EXPORT_PERMISSIONS = ['PLANILLAS_EXPORTAR'];
const PLANILLAS_SUMMARY_COSTS_PERMISSIONS = ['PLANILLAS_RESUMEN_VER_COSTOS'];

const PLANILLA_ENDPOINT_CONTRACT = Object.freeze({
  list: 'fn_listar_planillas_por_sucursal',
  generar: 'fn_generar_planilla_mensual_por_sucursal',
  recalcularPlanilla: 'fn_recalcular_planilla_por_sucursal',
  detalle: 'fn_listar_detalle_planilla',
  resumen: 'fn_listar_resumen_planilla_por_sucursal',
  completa: 'fn_planilla_completa_json',
  actualizarEstado: 'fn_actualizar_estado_planilla',
  anularPlanilla: 'fn_anular_planilla_completa',
  empleadosActivos: 'fn_listar_empleados_activos_por_sucursal',
  adelantosPendientes: 'fn_listar_adelantos_pendientes_por_sucursal',
  adelantosAplicables: 'fn_listar_adelantos_aplicables_a_planilla',
  aplicarAdelanto: 'fn_aplicar_adelanto_a_planilla',
  registrarMovimiento: 'fn_registrar_movimiento_planilla',
  movimientos: 'fn_listar_movimientos_planilla',
  movimientosDetalle: 'fn_listar_movimientos_planilla_detalle',
  anularMovimiento: 'fn_anular_movimiento_planilla',
  auditoria: 'fn_listar_auditoria_planilla',
  recalcularDetalle: 'fn_recalcular_detalle_planilla'
});
const GENERAR_ALLOWED_FIELDS = new Set([
  'id_sucursal',
  'periodo',
  'id_estado_planilla',
  'dias_laborados',
  'horas_laboradas',
  'tipo_periodo',
  'quincena'
]);
const ESTADO_ALLOWED_FIELDS = new Set([
  'id_estado_planilla',
  'id_estado',
  'estado',
  'recalcular',
  'id_sucursal',
  'tipo_periodo',
  'quincena',
  'usuario_accion'
]);
const ANULAR_ALLOWED_FIELDS = new Set(['usuario_accion', 'motivo', 'id_sucursal']);
const ANULAR_MOVIMIENTO_ALLOWED_FIELDS = new Set(['usuario_accion', 'motivo', 'id_planilla', 'id_sucursal']);
const RECALCULAR_ALLOWED_FIELDS = new Set(['id_sucursal']);
const RECALCULAR_DETALLE_ALLOWED_FIELDS = new Set(['id_sucursal']);
const APLICAR_ADELANTO_ALLOWED_FIELDS = new Set([
  'id_adelanto',
  'id_adelanto_salario',
  'monto_aplicar',
  'monto',
  'id_sucursal',
  'tipo_periodo',
  'quincena'
]);
const REGISTRAR_ADELANTO_ALLOWED_FIELDS = new Set([
  'id_empleado',
  'fecha',
  'monto',
  'id_sucursal'
]);
const ACTUALIZAR_ADELANTO_ALLOWED_FIELDS = new Set([
  'id_empleado',
  'fecha',
  'monto',
  'observacion',
  'motivo',
  'id_sucursal'
]);
const ANULAR_ADELANTO_ALLOWED_FIELDS = new Set([
  'motivo',
  'observacion',
  'id_sucursal'
]);
const REGISTRAR_HORAS_EXTRA_ALLOWED_FIELDS = new Set([
  'id_empleado',
  'fecha',
  'horas',
  'observacion',
  'id_sucursal',
  'id_tipo_hora',
  'id_factor_horas_extras',
  'tarifa_base',
  'tipo_periodo',
  'quincena'
]);
const COMPENSAR_HORAS_EXTRA_ALLOWED_FIELDS = new Set([
  'observacion',
  'id_sucursal',
  'tipo_periodo',
  'quincena'
]);
const ACTUALIZAR_HORAS_EXTRA_ALLOWED_FIELDS = new Set([
  'id_empleado',
  'fecha',
  'horas',
  'observacion',
  'id_sucursal',
  'tipo_periodo',
  'quincena'
]);
const MOVIMIENTO_ALLOWED_FIELDS = new Set([
  'id_detalle',
  'id_detalle_planilla',
  'tipo',
  'tipo_movimiento',
  'concepto',
  'monto',
  'observacion',
  'id_sucursal',
  'tipo_periodo',
  'quincena'
]);

const LIST_QUERY_ALLOWED_FIELDS = new Set([
  'page',
  'limit',
  'id_sucursal',
  'periodo',
  'search',
  'q',
  'estado',
  'tipo_periodo',
  'quincena',
  '_ts'
]);
const DETALLE_QUERY_ALLOWED_FIELDS = new Set([
  'page',
  'limit',
  'search',
  'q',
  'id_sucursal',
  'tipo_periodo',
  'quincena',
  '_ts'
]);
const RESUMEN_QUERY_ALLOWED_FIELDS = new Set(['id_sucursal', 'tipo_periodo', 'quincena', '_ts']);
const COMPLETA_QUERY_ALLOWED_FIELDS = new Set(['id_sucursal', 'tipo_periodo', 'quincena', '_ts']);
const HORAS_EXTRA_QUERY_ALLOWED_FIELDS = new Set([
  'page',
  'limit',
  'id_empleado',
  'estado',
  'id_sucursal',
  'tipo_periodo',
  'quincena',
  '_ts'
]);
const EMPLEADOS_ACTIVOS_QUERY_ALLOWED_FIELDS = new Set(['page', 'limit', 'search', 'q', '_ts']);
const ADELANTOS_PENDIENTES_QUERY_ALLOWED_FIELDS = new Set(['page', 'limit', 'search', 'q', 'periodo', '_ts']);
const ADELANTOS_APLICABLES_QUERY_ALLOWED_FIELDS = new Set(['page', 'limit', 'id_detalle', 'id_sucursal', '_ts']);
const MOVIMIENTOS_QUERY_ALLOWED_FIELDS = new Set([
  'page',
  'limit',
  'id_detalle',
  'id_sucursal',
  'tipo_periodo',
  'quincena',
  '_ts'
]);
const MOVIMIENTOS_DETALLE_QUERY_ALLOWED_FIELDS = new Set([
  'page',
  'limit',
  'id_sucursal',
  'tipo_periodo',
  'quincena',
  '_ts'
]);
const AUDITORIA_QUERY_ALLOWED_FIELDS = new Set(['page', 'limit', 'entidad', 'id_sucursal', '_ts']);

let planillaFunctionCatalogPromise;
let horasExtraIdColumnPromise;

const HORAS_EXTRA_ID_COLUMN_CANDIDATES = Object.freeze([
  'id_horas_extras',
  'id_horas_extra'
]);
const TIPO_PERIODO = Object.freeze({
  MENSUAL: 'MENSUAL',
  QUINCENAL: 'QUINCENAL'
});
const QUINCENA_ESTADO_AUDITORIA_ACCION = 'ESTADO_QUINCENA';
const QUINCENA_ESTADO_AUDITORIA_ENTIDAD = 'PLANILLA_QUINCENAL';
const QUINCENA_ADELANTO_AUDITORIA_ACCION = 'ADELANTO_QUINCENA';
const QUINCENA_ADELANTO_AUDITORIA_ENTIDAD = 'PLANILLA_ADELANTO';

const normalizeTipoPeriodo = (value) => {
  if (value === null || value === undefined || value === '') return TIPO_PERIODO.MENSUAL;
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) return TIPO_PERIODO.MENSUAL;
  if (normalized === TIPO_PERIODO.MENSUAL) return TIPO_PERIODO.MENSUAL;
  if (normalized === TIPO_PERIODO.QUINCENAL) return TIPO_PERIODO.QUINCENAL;
  return null;
};

const normalizeTipoPeriodoStrict = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === TIPO_PERIODO.MENSUAL) return TIPO_PERIODO.MENSUAL;
  if (normalized === TIPO_PERIODO.QUINCENAL) return TIPO_PERIODO.QUINCENAL;
  return null;
};

const normalizeQuincena = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parsePositiveInt(value);
  if (!parsed) return null;
  if (parsed !== 1 && parsed !== 2) return null;
  return parsed;
};

const parseQuincenaFromText = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/(^|\b)q\s*1(\b|$)/i.test(text) || /quincena\s*1/i.test(text)) return 1;
  if (/(^|\b)q\s*2(\b|$)/i.test(text) || /quincena\s*2/i.test(text)) return 2;
  return null;
};

const resolveRowQuincena = (row = {}) => {
  const direct = normalizeQuincena(
    row?.quincena ??
      row?.numero_quincena ??
      row?.id_quincena ??
      row?.quincena_numero
  );
  if (direct) return direct;

  const textSources = [
    row?.subperiodo,
    row?.periodo_subtipo,
    row?.descripcion_periodo,
    row?.periodo_label,
    row?.codigo_planilla
  ];
  for (const source of textSources) {
    const parsed = parseQuincenaFromText(source);
    if (parsed) return parsed;
  }

  const periodStart = normalizeDateOnlyKey(row?.periodo_inicio ?? row?.fecha_inicio_periodo);
  if (periodStart) {
    const day = Number.parseInt(periodStart.slice(8, 10), 10);
    if (Number.isInteger(day)) return day <= 15 ? 1 : 2;
  }

  return null;
};

const resolveRowTipoPeriodo = (row = {}) => {
  const direct = normalizeTipoPeriodoStrict(
    row?.tipo_periodo ??
      row?.periodo_tipo ??
      row?.tipoPeriodo
  );
  if (direct) return direct;

  const resolvedQuincena = resolveRowQuincena(row);
  if (resolvedQuincena === 1 || resolvedQuincena === 2) return TIPO_PERIODO.QUINCENAL;

  return TIPO_PERIODO.MENSUAL;
};

const parsePositiveInt = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const parsePositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseStrictBoolean = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return null;
};

const sanitizeText = (value, maxLength = 200) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const normalizePeriodo = (value) => {
  const text = sanitizeText(value, 10);
  if (!text) return null;
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
};

const normalizeTimestampInput = (value) => {
  const text = sanitizeText(value, 40);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
};

const todayLocalDateKey = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const normalizeDateOnlyKey = (value) => {
  const text = sanitizeText(value, 40);
  if (!text) return null;

  const directDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (directDateMatch) {
    return `${directDateMatch[1]}-${directDateMatch[2]}-${directDateMatch[3]}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(
    parsed.getUTCDate()
  ).padStart(2, '0')}`;
};

const isFutureDateInput = (value) => {
  const dateKey = normalizeDateOnlyKey(value);
  if (!dateKey) return false;
  return dateKey > todayLocalDateKey();
};

const normalizeEstadoAlias = (value) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!normalized) return null;

  const aliases = {
    ABIERTA: 'BORRADOR',
    BORRADOR: 'BORRADOR',
    CERRADA: 'CALCULADA',
    CALCULADA: 'CALCULADA',
    PAGADA: 'PAGADA',
    ANULADA: 'ANULADA'
  };

  return aliases[normalized] || normalized;
};

const toMonthKey = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const getDaysInMonth = (dateValue) => {
  const baseDate = new Date(dateValue);
  if (Number.isNaN(baseDate.getTime())) return 30;
  return new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + 1, 0)).getUTCDate();
};

const resolveQuincenaWindow = (dateValue, quincena) => {
  const baseDate = new Date(dateValue);
  if (Number.isNaN(baseDate.getTime())) return null;

  const year = baseDate.getUTCFullYear();
  const month = baseDate.getUTCMonth();
  const lastDay = getDaysInMonth(baseDate);
  const normalizedQuincena = quincena === 2 ? 2 : 1;
  const startDay = normalizedQuincena === 1 ? 1 : 16;
  const endDay = normalizedQuincena === 1 ? Math.min(15, lastDay) : lastDay;

  const start = new Date(Date.UTC(year, month, startDay));
  const end = new Date(Date.UTC(year, month, endDay));
  const totalDays = Math.max(1, lastDay);
  const quincenaDays = Math.max(1, endDay - startDay + 1);

  return {
    quincena: normalizedQuincena,
    inicio: start.toISOString().slice(0, 10),
    fin: end.toISOString().slice(0, 10),
    dias_quincena: quincenaDays,
    dias_mes: totalDays,
    factor: quincenaDays / totalDays
  };
};

const buildPeriodoMeta = ({ fechaPlanilla, tipoPeriodo, quincena = null, diasLaborados, horasLaboradas }) => {
  if (tipoPeriodo !== TIPO_PERIODO.QUINCENAL) {
    return {
      tipo_periodo: TIPO_PERIODO.MENSUAL,
      quincena: null,
      periodo_inicio: null,
      periodo_fin: null,
      dias_laborados: diasLaborados,
      horas_laboradas: horasLaboradas,
      factor_prorrateo: 1
    };
  }

  const quincenaWindow = resolveQuincenaWindow(fechaPlanilla, quincena || 1);
  return {
    tipo_periodo: TIPO_PERIODO.QUINCENAL,
    quincena: quincenaWindow?.quincena || 1,
    periodo_inicio: quincenaWindow?.inicio || null,
    periodo_fin: quincenaWindow?.fin || null,
    dias_laborados: diasLaborados,
    horas_laboradas: horasLaboradas,
    factor_prorrateo: quincenaWindow?.factor || 0.5
  };
};

const resolvePeriodoContextInput = ({
  rawTipoPeriodo,
  rawQuincena,
  defaultTipoPeriodo = TIPO_PERIODO.MENSUAL
} = {}) => {
  const hasTipoPeriodo =
    rawTipoPeriodo !== undefined &&
    rawTipoPeriodo !== null &&
    String(rawTipoPeriodo).trim() !== '';

  const tipoPeriodo = hasTipoPeriodo
    ? normalizeTipoPeriodoStrict(rawTipoPeriodo)
    : defaultTipoPeriodo;
  if (hasTipoPeriodo && !tipoPeriodo) {
    return { error: 'tipo_periodo invalido. Use mensual o quincenal.' };
  }

  const hasQuincena =
    rawQuincena !== undefined &&
    rawQuincena !== null &&
    String(rawQuincena).trim() !== '';
  const quincena = hasQuincena ? normalizeQuincena(rawQuincena) : null;
  if (hasQuincena && quincena === null) {
    return { error: 'quincena invalida. Use 1 o 2.' };
  }

  if (tipoPeriodo === TIPO_PERIODO.QUINCENAL && quincena === null) {
    return { error: 'quincena es requerida cuando tipo_periodo es quincenal.' };
  }

  return {
    hasTipoPeriodo,
    hasQuincena,
    tipo_periodo: tipoPeriodo || TIPO_PERIODO.MENSUAL,
    quincena
  };
};

const roundTo = (value, digits = 2) => {
  const safe = Number(value);
  if (!Number.isFinite(safe)) return 0;
  const base = 10 ** digits;
  return Math.round((safe + Number.EPSILON) * base) / base;
};

const resolveQuincenaFromDateLike = (value) => {
  const normalizedDate = normalizeDateOnlyKey(value);
  if (!normalizedDate) return null;
  const day = Number.parseInt(normalizedDate.slice(8, 10), 10);
  if (!Number.isInteger(day)) return null;
  return day <= 15 ? 1 : 2;
};

const resolveQuincenaFromRowContext = (row = {}) => {
  const fromNumeric = normalizeQuincena(
    row?.quincena_resuelta ??
      row?.quincena ??
      row?.numero_quincena ??
      row?.id_quincena
  );
  if (fromNumeric) return fromNumeric;

  const textSources = [
    row?.observacion,
    row?.concepto,
    row?.descripcion,
    row?.periodo_subtipo,
    row?.periodo_label
  ];
  for (const source of textSources) {
    const fromText = parseQuincenaFromText(source);
    if (fromText) return fromText;
  }

  const dateSources = [row?.fecha, row?.fecha_registro, row?.fecha_compensacion, row?.fecha_aplicacion];
  for (const source of dateSources) {
    const fromDate = resolveQuincenaFromDateLike(source);
    if (fromDate) return fromDate;
  }

  return null;
};

const buildQuincenaContextTag = (quincena) => {
  const safe = normalizeQuincena(quincena);
  if (!safe) return '';
  return `[QCTX:Q${safe}]`;
};

const appendQuincenaContextTag = (text, quincena) => {
  const tag = buildQuincenaContextTag(quincena);
  const base = sanitizeText(text, 255) || '';
  if (!tag) return base || null;
  if (base.includes(tag)) return base;
  const merged = base ? `${base} ${tag}` : tag;
  return sanitizeText(merged, 255) || tag;
};

const filterRowsByPeriodoContext = ({ rows = [], tipoPeriodo = TIPO_PERIODO.MENSUAL, quincena = null } = {}) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (tipoPeriodo !== TIPO_PERIODO.QUINCENAL) return safeRows;
  const resolvedQuincena = normalizeQuincena(quincena);
  if (!resolvedQuincena) return safeRows;

  return safeRows.filter((row) => resolveQuincenaFromRowContext(row) === resolvedQuincena);
};

const aggregateDetalleMetricsFromMovimientos = ({ detalleRows = [], movimientosRows = [] } = {}) => {
  const detailToEmpleado = new Map();
  const metricsByEmpleado = new Map();

  const ensureMetric = (idEmpleado) => {
    const normalized = parsePositiveInt(idEmpleado);
    if (!normalized) return null;
    if (!metricsByEmpleado.has(normalized)) {
      metricsByEmpleado.set(normalized, {
        bonos: 0,
        deducciones: 0,
        adelantos: 0,
        horasPendientes: 0
      });
    }
    return metricsByEmpleado.get(normalized);
  };

  (Array.isArray(detalleRows) ? detalleRows : []).forEach((row) => {
    const idDetalle = parsePositiveInt(row?.id_detalle_planilla ?? row?.id_detalle);
    const idEmpleado = parsePositiveInt(row?.id_empleado);
    if (idDetalle && idEmpleado) {
      detailToEmpleado.set(idDetalle, idEmpleado);
    }
    ensureMetric(idEmpleado);
  });

  (Array.isArray(movimientosRows) ? movimientosRows : []).forEach((row) => {
    if (row?.anulado === true || row?.activo === false) return;

    const idDetalle = parsePositiveInt(row?.id_detalle_planilla ?? row?.id_detalle);
    const idEmpleadoDirecto = parsePositiveInt(row?.id_empleado);
    const idEmpleado = idEmpleadoDirecto || (idDetalle ? detailToEmpleado.get(idDetalle) : null);
    const metric = ensureMetric(idEmpleado);
    if (!metric) return;

    const tipo = String(row?.tipo_movimiento ?? row?.tipo ?? '').trim().toUpperCase();
    const monto = Number(row?.monto ?? 0);
    const montoSeguro = Number.isFinite(monto) ? monto : 0;

    if (tipo === 'BONO') {
      metric.bonos += montoSeguro;
      return;
    }

    if (tipo === 'DEDUCCION') {
      metric.deducciones += montoSeguro;
      return;
    }

    if (tipo === 'ADELANTO') {
      metric.adelantos += montoSeguro;
      return;
    }

    if (tipo === 'H.E. TIEMPO' && row?.compensada !== true) {
      metric.horasPendientes += montoSeguro;
    }
  });

  return metricsByEmpleado;
};

const parseQuincenaEstadoAuditPayload = (descripcion) => {
  const raw = String(descripcion ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const quincena = normalizeQuincena(parsed?.quincena);
    const estado = normalizeEstadoAlias(parsed?.estado);
    if (!quincena || !estado) return null;
    return {
      quincena,
      estado,
      id_estado_planilla: parsePositiveInt(parsed?.id_estado_planilla)
    };
  } catch {
    return null;
  }
};

const listQuincenaEstadoAuditByPlanillaIds = async (planillaIds = []) => {
  const safeIds = Array.from(
    new Set((Array.isArray(planillaIds) ? planillaIds : []).map((id) => parsePositiveInt(id)).filter(Boolean))
  );
  if (!safeIds.length) return new Map();

  const query = `
    SELECT
      id_referencia,
      descripcion,
      fecha_registro,
      id_auditoria_planilla
    FROM public.auditoria_planilla
    WHERE accion = $1
      AND entidad = $2
      AND id_referencia = ANY($3::int[])
    ORDER BY fecha_registro DESC, id_auditoria_planilla DESC
  `;

  let rows = [];
  try {
    const result = await pool.query(query, [
      QUINCENA_ESTADO_AUDITORIA_ACCION,
      QUINCENA_ESTADO_AUDITORIA_ENTIDAD,
      safeIds
    ]);
    rows = result.rows || [];
  } catch {
    return new Map();
  }

  const mapByPlanilla = new Map();
  for (const row of rows) {
    const idPlanilla = parsePositiveInt(row?.id_referencia);
    if (!idPlanilla) continue;

    const payload = parseQuincenaEstadoAuditPayload(row?.descripcion);
    if (!payload?.quincena || !payload?.estado) continue;

    const planillaKey = String(idPlanilla);
    if (!mapByPlanilla.has(planillaKey)) {
      mapByPlanilla.set(planillaKey, new Map());
    }

    const planillaMap = mapByPlanilla.get(planillaKey);
    if (!planillaMap.has(payload.quincena)) {
      planillaMap.set(payload.quincena, payload);
    }
  }

  return mapByPlanilla;
};

const resolveContextualEstadoQuincena = ({
  baseEstado,
  quincena,
  auditEstadoMap
}) => {
  const normalizedBaseEstado = normalizeEstadoAlias(baseEstado);
  const normalizedQuincena = normalizeQuincena(quincena);

  if (!normalizedQuincena) {
    return {
      estado: normalizedBaseEstado,
      id_estado_planilla: null
    };
  }

  const auditPayload = auditEstadoMap?.get?.(normalizedQuincena);
  if (auditPayload?.estado) {
    return {
      estado: normalizeEstadoAlias(auditPayload.estado),
      id_estado_planilla: parsePositiveInt(auditPayload.id_estado_planilla)
    };
  }

  // Compatibilidad: si solo se pago la primera quincena y la planilla mensual quedo PAGADA,
  // no se debe reflejar automaticamente como PAGADA en Q2.
  if (normalizedQuincena === 2 && normalizedBaseEstado === 'PAGADA') {
    return {
      estado: 'CALCULADA',
      id_estado_planilla: null
    };
  }

  return {
    estado: normalizedBaseEstado,
    id_estado_planilla: null
  };
};

const registerQuincenaEstadoAudit = async ({
  idPlanilla,
  quincena,
  estado,
  idEstadoPlanilla = null,
  usuarioAccion = 'sistema'
}) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  const safeQuincena = normalizeQuincena(quincena);
  const safeEstado = normalizeEstadoAlias(estado);
  if (!safePlanillaId || !safeQuincena || !safeEstado) return;

  const payload = {
    quincena: safeQuincena,
    estado: safeEstado,
    id_estado_planilla: parsePositiveInt(idEstadoPlanilla),
    usuario: sanitizeText(usuarioAccion, 100) || 'sistema',
    ts: new Date().toISOString()
  };

  try {
    await pool.query(
      `
        INSERT INTO public.auditoria_planilla (
          accion,
          entidad,
          id_referencia,
          descripcion,
          usuario_accion
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        QUINCENA_ESTADO_AUDITORIA_ACCION,
        QUINCENA_ESTADO_AUDITORIA_ENTIDAD,
        safePlanillaId,
        JSON.stringify(payload),
        payload.usuario
      ]
    );
  } catch {
    // No bloqueamos el flujo principal por fallas de auditoria.
  }
};

const registerQuincenaAdelantoAudit = async ({
  idPlanilla,
  idAdelantoSalario,
  quincena,
  usuarioAccion = 'sistema'
}) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  const safeAdelantoId = parsePositiveInt(idAdelantoSalario);
  const safeQuincena = normalizeQuincena(quincena);
  if (!safePlanillaId || !safeAdelantoId || !safeQuincena) return;

  const payload = {
    id_adelanto_salario: safeAdelantoId,
    quincena: safeQuincena,
    usuario: sanitizeText(usuarioAccion, 100) || 'sistema',
    ts: new Date().toISOString()
  };

  try {
    await pool.query(
      `
        INSERT INTO public.auditoria_planilla (
          accion,
          entidad,
          id_referencia,
          descripcion,
          usuario_accion
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        QUINCENA_ADELANTO_AUDITORIA_ACCION,
        QUINCENA_ADELANTO_AUDITORIA_ENTIDAD,
        safePlanillaId,
        JSON.stringify(payload),
        payload.usuario
      ]
    );
  } catch {
    // No bloqueamos el flujo principal por fallas de auditoria.
  }
};

const listQuincenaAdelantoAuditByPlanillaId = async (idPlanilla) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  if (!safePlanillaId) return new Map();

  const query = `
    SELECT
      descripcion,
      fecha_registro,
      id_auditoria_planilla
    FROM public.auditoria_planilla
    WHERE accion = $1
      AND entidad = $2
      AND id_referencia = $3
    ORDER BY fecha_registro DESC, id_auditoria_planilla DESC
  `;

  let rows = [];
  try {
    const result = await pool.query(query, [
      QUINCENA_ADELANTO_AUDITORIA_ACCION,
      QUINCENA_ADELANTO_AUDITORIA_ENTIDAD,
      safePlanillaId
    ]);
    rows = result.rows || [];
  } catch {
    return new Map();
  }

  const map = new Map();
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row?.descripcion ?? '{}'));
      const idAdelanto = parsePositiveInt(payload?.id_adelanto_salario);
      const quincena = normalizeQuincena(payload?.quincena);
      if (!idAdelanto || !quincena) continue;
      if (!map.has(idAdelanto)) {
        map.set(idAdelanto, quincena);
      }
    } catch {
      // noop
    }
  }

  return map;
};

const parsePagination = (query = {}) => {
  const page = query.page === undefined ? 1 : parsePositiveInt(query.page);
  const requestedLimit = query.limit === undefined ? DEFAULT_LIMIT : parsePositiveInt(query.limit);
  if (!page || !requestedLimit) return null;
  return { page, limit: Math.min(requestedLimit, MAX_LIMIT) };
};

const validateAllowedQueryFields = (query = {}, allowedFields = new Set()) => {
  const unknownFields = unknownFieldsFromPayload(query, allowedFields);
  if (!unknownFields.length) return null;
  return {
    status: 400,
    body: buildErrorBody({
      code: 'UNKNOWN_QUERY_FIELDS',
      message: 'La consulta contiene parametros no permitidos.',
      details: { fields: unknownFields }
    })
  };
};

const paginateRows = (rows, page, limit) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  const total = safeRows.length;
  const start = (page - 1) * limit;
  const end = start + limit;
  return {
    items: safeRows.slice(start, end),
    total,
    page,
    limit
  };
};

const mapDbError = (err) => {
  if (!err) return null;

  if (err.code === 'PLANILLA_FN_MISSING') {
    return {
      status: 501,
      code: 'DB_FUNCTION_ERROR',
      message: 'La funcion SQL requerida no esta disponible en esta base de datos.'
    };
  }

  if (err.code === '42702') {
    return {
      status: 500,
      code: 'DB_FUNCTION_ERROR',
      message: 'La funcion SQL de planillas no esta alineada. Revisa el script de actualizacion del modulo.'
    };
  }

  return mapDbErrorToSafe(err, {
    defaultMessage: 'No se pudo procesar la solicitud de planillas.'
  });
};

const isFunctionAllowed = (name) => PLANILLA_FUNCTION_NAMES.includes(name);

const getPlanillaFunctionCatalog = async () => {
  if (!planillaFunctionCatalogPromise) {
    planillaFunctionCatalogPromise = (async () => {
      const result = await pool.query(
        `
          SELECT p.proname
          FROM pg_proc p
          INNER JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = ANY($1::text[])
        `,
        [PLANILLA_FUNCTION_NAMES]
      );

      return new Set((result.rows || []).map((row) => row.proname));
    })().catch((err) => {
      planillaFunctionCatalogPromise = null;
      throw err;
    });
  }

  return planillaFunctionCatalogPromise;
};

const ensureFunctionInstalled = async (fnName) => {
  if (!isFunctionAllowed(fnName)) {
    throw new Error(`FunciÃƒÆ’Ã‚Â³n SQL no permitida: ${fnName}`);
  }

  const catalog = await getPlanillaFunctionCatalog();
  if (!catalog.has(fnName)) {
    const error = new Error(`La funciÃƒÆ’Ã‚Â³n ${fnName} no estÃƒÆ’Ã‚Â¡ instalada en la base de datos actual.`);
    error.code = 'PLANILLA_FN_MISSING';
    throw error;
  }
};

const resolveHorasExtraIdColumn = async () => {
  if (!horasExtraIdColumnPromise) {
    horasExtraIdColumnPromise = (async () => {
      const result = await pool.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'horas_extras'
            AND column_name = ANY($1::text[])
          ORDER BY CASE
            WHEN column_name = 'id_horas_extras' THEN 1
            WHEN column_name = 'id_horas_extra' THEN 2
            ELSE 3
          END
          LIMIT 1
        `,
        [HORAS_EXTRA_ID_COLUMN_CANDIDATES]
      );

      const column = result.rows?.[0]?.column_name;
      if (!HORAS_EXTRA_ID_COLUMN_CANDIDATES.includes(column)) {
        const err = new Error(
          'La tabla horas_extras no tiene una columna de identificador compatible.'
        );
        err.status = 500;
        throw err;
      }
      return column;
    })().catch((err) => {
      horasExtraIdColumnPromise = null;
      throw err;
    });
  }

  return horasExtraIdColumnPromise;
};

const buildFunctionSql = (fnName, argCount, asScalar = false) => {
  const placeholders = Array.from({ length: argCount }, (_, idx) => `$${idx + 1}`).join(', ');
  if (asScalar) return `SELECT ${fnName}(${placeholders}) AS value`;
  return `SELECT * FROM ${fnName}(${placeholders})`;
};

const queryFunctionRows = async (fnName, args = []) => {
  await ensureFunctionInstalled(fnName);
  const sql = buildFunctionSql(fnName, args.length, false);
  const result = await pool.query(sql, args);
  return result.rows || [];
};

const queryFunctionScalar = async (fnName, args = []) => {
  await ensureFunctionInstalled(fnName);
  const sql = buildFunctionSql(fnName, args.length, true);
  const result = await pool.query(sql, args);
  return result.rows?.[0]?.value ?? null;
};

const listPlanillasFallbackRows = async () => {
  const result = await pool.query(
    `
      SELECT
        p.id_planilla,
        p.fecha_creacion,
        p.id_estado_planilla,
        COALESCE(ep.descripcion, '')::varchar AS estado_planilla,
        p.id_sucursal,
        COALESCE(s.nombre_sucursal, '')::varchar AS nombre_sucursal,
        COUNT(dp.id_detalle_planilla)::bigint AS total_empleados
      FROM planillas p
      LEFT JOIN estado_planilla ep ON ep.id_estado_planilla = p.id_estado_planilla
      LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN detalle_planilla dp ON dp.id_planilla = p.id_planilla
      GROUP BY
        p.id_planilla,
        p.fecha_creacion,
        p.id_estado_planilla,
        ep.descripcion,
        p.id_sucursal,
        s.nombre_sucursal
      ORDER BY p.fecha_creacion DESC, p.id_planilla DESC
    `
  );
  return result.rows || [];
};

const resolveEstadoPlanillaId = async (body = {}) => {
  const rawId = parsePositiveInt(body.id_estado_planilla ?? body.id_estado);
  if (rawId) {
    const rs = await pool.query(
      'SELECT id_estado_planilla, descripcion FROM estado_planilla WHERE id_estado_planilla = $1 LIMIT 1',
      [rawId]
    );
    if (!rs.rows.length) return null;
    return {
      idEstado: rs.rows[0].id_estado_planilla,
      descripcion: String(rs.rows[0].descripcion || '').trim()
    };
  }

  const estadoText = normalizeEstadoAlias(sanitizeText(body.estado, 60));
  if (!estadoText) return null;

  const rs = await pool.query(
    `
      SELECT id_estado_planilla, descripcion
      FROM estado_planilla
      WHERE UPPER(TRIM(descripcion)) = UPPER(TRIM($1))
      LIMIT 1
    `,
    [estadoText]
  );

  if (!rs.rows.length) return null;
  return {
    idEstado: rs.rows[0].id_estado_planilla,
    descripcion: String(rs.rows[0].descripcion || '').trim()
  };
};

const resolveDefaultEstadoPlanillaId = async () => {
  const preferredStates = ['BORRADOR', 'ABIERTA', 'CALCULADA'];
  for (const estado of preferredStates) {
    const rs = await pool.query(
      `
        SELECT id_estado_planilla
        FROM estado_planilla
        WHERE UPPER(TRIM(descripcion)) = UPPER(TRIM($1))
        ORDER BY id_estado_planilla ASC
        LIMIT 1
      `,
      [estado]
    );
    const id = parsePositiveInt(rs.rows?.[0]?.id_estado_planilla);
    if (id) return id;
  }

  const fallback = await pool.query(
    'SELECT id_estado_planilla FROM estado_planilla ORDER BY id_estado_planilla ASC LIMIT 1'
  );
  return parsePositiveInt(fallback.rows?.[0]?.id_estado_planilla);
};

const findExistingPlanillaIdByMonthAndSucursal = async (idSucursal, fechaPlanilla) => {
  const result = await pool.query(
    `
      SELECT id_planilla
      FROM planillas
      WHERE id_sucursal = $1
        AND date_trunc('month', fecha_creacion) = date_trunc('month', $2::timestamp)
      ORDER BY id_planilla DESC
      LIMIT 1
    `,
    [idSucursal, fechaPlanilla]
  );
  return parsePositiveInt(result.rows?.[0]?.id_planilla);
};

const resolvePlanillaScope = async (idPlanilla) => {
  const result = await pool.query(
    `
      SELECT id_planilla, id_sucursal
      FROM planillas
      WHERE id_planilla = $1
      LIMIT 1
    `,
    [idPlanilla]
  );

  if (!result.rows?.length) return null;
  return {
    id_planilla: parsePositiveInt(result.rows[0].id_planilla),
    id_sucursal: parsePositiveInt(result.rows[0].id_sucursal)
  };
};

const resolveMovimientoScope = async (idMovimiento) => {
  const result = await pool.query(
    `
      SELECT
        mp.id_movimiento_planilla,
        mp.id_detalle_planilla,
        dp.id_planilla,
        p.id_sucursal
      FROM public.movimiento_planilla mp
      INNER JOIN public.detalle_planilla dp
        ON dp.id_detalle_planilla = mp.id_detalle_planilla
      INNER JOIN public.planillas p
        ON p.id_planilla = dp.id_planilla
      WHERE mp.id_movimiento_planilla = $1
      LIMIT 1
    `,
    [idMovimiento]
  );

  if (!result.rows?.length) return null;
  return {
    id_movimiento_planilla: parsePositiveInt(result.rows[0].id_movimiento_planilla),
    id_detalle_planilla: parsePositiveInt(result.rows[0].id_detalle_planilla),
    id_planilla: parsePositiveInt(result.rows[0].id_planilla),
    id_sucursal: parsePositiveInt(result.rows[0].id_sucursal)
  };
};

const validatePlanillaSucursalScope = async (idPlanilla, rawIdSucursal, options = {}) => {
  const required = options.required !== false;
  const provided = rawIdSucursal !== undefined && rawIdSucursal !== null && String(rawIdSucursal).trim() !== '';
  if (!provided) {
    if (!required) return { ok: true };
    return {
      ok: false,
      status: 400,
      body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal es requerido.' })
    };
  }

  const idSucursal = parsePositiveInt(rawIdSucursal);
  if (!idSucursal) {
    return {
      ok: false,
      status: 400,
      body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal invalido.' })
    };
  }

  const scope = await resolvePlanillaScope(idPlanilla);
  if (!scope?.id_planilla) {
    return {
      ok: false,
      status: 404,
      body: buildErrorBody({ code: 'NOT_FOUND', message: 'La planilla indicada no existe.' })
    };
  }

  if (scope.id_sucursal !== idSucursal) {
    return {
      ok: false,
      status: 409,
      body: buildErrorBody({
        code: 'SUCURSAL_SCOPE_MISMATCH',
        message: 'La planilla seleccionada no pertenece a la sucursal activa.'
      })
    };
  }

  return { ok: true, scope, idSucursal };
};

const syncDetalleSalarioBaseFromEmpleado = async ({
  db = pool,
  idPlanilla,
  idDetallePlanilla = null
}) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  if (!safePlanillaId) return { updated: 0 };

  const safeDetalleId = idDetallePlanilla === null ? null : parsePositiveInt(idDetallePlanilla);
  if (idDetallePlanilla !== null && !safeDetalleId) return { updated: 0 };

  const result = await db.query(
    `
      UPDATE public.detalle_planilla dp
      SET salario_base = COALESCE(e.salario_base, 0)
      FROM public.empleados e
      WHERE dp.id_planilla = $1
        AND dp.id_empleado = e.id_empleado
        AND ($2::int IS NULL OR dp.id_detalle_planilla = $2::int)
        AND COALESCE(dp.salario_base, 0) IS DISTINCT FROM COALESCE(e.salario_base, 0)
      RETURNING dp.id_detalle_planilla
    `,
    [safePlanillaId, safeDetalleId]
  );

  const updatedIds = (result.rows || [])
    .map((row) => parsePositiveInt(row.id_detalle_planilla))
    .filter(Boolean);

  for (const idDetalle of updatedIds) {
    await db.query('SELECT public.fn_recalcular_detalle_planilla($1)', [idDetalle]);
  }

  return { updated: result.rowCount || 0 };
};

const recalculateDetallePlanillaRows = async ({
  db = pool,
  idPlanilla,
  idDetallePlanilla = null
}) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  if (!safePlanillaId) return { recalculated: 0 };

  const safeDetalleId = idDetallePlanilla === null ? null : parsePositiveInt(idDetallePlanilla);
  if (idDetallePlanilla !== null && !safeDetalleId) return { recalculated: 0 };

  const result = await db.query(
    `
      SELECT public.fn_recalcular_detalle_planilla(dp.id_detalle_planilla) AS neto_actualizado
      FROM public.detalle_planilla dp
      WHERE dp.id_planilla = $1
        AND ($2::int IS NULL OR dp.id_detalle_planilla = $2::int)
    `,
    [safePlanillaId, safeDetalleId]
  );

  return { recalculated: result.rowCount || 0 };
};

const PLANILLA_DETALLE_AUTO_SYNC_ALLOWED_STATES = new Set(['BORRADOR', 'CALCULADA']);
const PLANILLA_ALLOWED_ROLE_TOKENS_LIST = Object.freeze([
  'ADMINISTRADOR',
  'CAJERO',
  'MESERO',
  'SUPERVISOR',
  'GERENTE',
  'ENCARGADO',
  'JEFE COCINA',
  'JEFE DE COCINA',
  'AUXILIAR COCINA',
  'AUXILIAR DE COCINA',
  'COCINERO'
]);
const PLANILLA_ALLOWED_ROLE_TOKENS = new Set(PLANILLA_ALLOWED_ROLE_TOKENS_LIST);

const normalizePlanillaRoleToken = (value) =>
  String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const resolveEmpleadoRoleLabel = (row = {}) =>
  sanitizeText(
    row?.cargo ??
      row?.rol_nombre ??
      row?.nombre_rol ??
      row?.rol ??
      row?.puesto ??
      row?.tipo_empleado,
    120
  ) || '';

const resolveEmpleadoSalarioBase = (row = {}) => {
  const salary = Number(
    row?.salario_base ??
      row?.salario ??
      row?.sueldo_base ??
      row?.sueldo
  );
  return Number.isFinite(salary) ? salary : 0;
};

const isEmpleadoPlanillable = (row = {}) => {
  const salary = resolveEmpleadoSalarioBase(row);
  if (!(salary > 0)) return false;

  const roleToken = normalizePlanillaRoleToken(resolveEmpleadoRoleLabel(row));
  if (!roleToken) return false;
  return PLANILLA_ALLOWED_ROLE_TOKENS.has(roleToken);
};

const filterPlanillableEmpleadoRows = (rows = []) =>
  (Array.isArray(rows) ? rows : []).filter((row) => isEmpleadoPlanillable(row));

const buildResumenFromDetalleRows = (rows = []) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.reduce(
    (acc, row) => {
      const salarioBase = roundTo(Number(row?.salario_base ?? 0));
      const bonos = roundTo(Number(row?.total_bonos ?? row?.bonos ?? 0));
      const deducciones = roundTo(Number(row?.total_deducciones ?? row?.deducciones ?? 0));
      const neto = roundTo(
        Number(row?.neto_pagar ?? row?.total_neto_pagar ?? row?.neto ?? salarioBase + bonos - deducciones)
      );

      acc.total_salario_base += salarioBase;
      acc.total_bonos += bonos;
      acc.total_deducciones += deducciones;
      acc.total_neto_pagar += neto;
      acc.total_empleados += 1;
      return acc;
    },
    {
      total_salario_base: 0,
      total_bonos: 0,
      total_deducciones: 0,
      total_neto_pagar: 0,
      total_neto: 0,
      total_empleados: 0
    }
  );
};

const dedupeDetallePlanillaByEmpleado = async ({ db = pool, idPlanilla }) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  if (!safePlanillaId) {
    return { duplicated: 0, moved: 0, deleted: 0 };
  }

  const dedupeResult = await db.query(
    `
      WITH ranked AS (
        SELECT
          dp.id_detalle_planilla,
          dp.id_empleado,
          FIRST_VALUE(dp.id_detalle_planilla) OVER (
            PARTITION BY dp.id_planilla, dp.id_empleado
            ORDER BY dp.id_detalle_planilla ASC
          ) AS keep_id,
          ROW_NUMBER() OVER (
            PARTITION BY dp.id_planilla, dp.id_empleado
            ORDER BY dp.id_detalle_planilla ASC
          ) AS rn
        FROM public.detalle_planilla dp
        WHERE dp.id_planilla = $1
      ),
      duplicates AS (
        SELECT id_detalle_planilla, keep_id
        FROM ranked
        WHERE rn > 1
      ),
      moved AS (
        UPDATE public.movimiento_planilla mp
        SET id_detalle_planilla = d.keep_id
        FROM duplicates d
        WHERE mp.id_detalle_planilla = d.id_detalle_planilla
        RETURNING mp.id_movimiento_planilla
      ),
      deleted AS (
        DELETE FROM public.detalle_planilla dp
        USING duplicates d
        WHERE dp.id_detalle_planilla = d.id_detalle_planilla
        RETURNING dp.id_detalle_planilla
      )
      SELECT
        (SELECT COUNT(*) FROM duplicates) AS duplicated_count,
        (SELECT COUNT(*) FROM moved) AS moved_count,
        (SELECT COUNT(*) FROM deleted) AS deleted_count
    `,
    [safePlanillaId]
  );

  const row = dedupeResult.rows?.[0] || {};
  return {
    duplicated: Number(row.duplicated_count || 0),
    moved: Number(row.moved_count || 0),
    deleted: Number(row.deleted_count || 0)
  };
};

const cleanupDetalleNoPlanillableBySucursal = async ({ db = pool, idPlanilla, idSucursal }) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  const safeSucursalId = parsePositiveInt(idSucursal);
  if (!safePlanillaId || !safeSucursalId) return { removed: 0 };

  const result = await db.query(
    `
      WITH candidate_rows AS (
        SELECT
          dp.id_detalle_planilla
        FROM public.detalle_planilla dp
        INNER JOIN public.empleados e
          ON e.id_empleado = dp.id_empleado
        WHERE dp.id_planilla = $1
          AND (
            e.estado IS DISTINCT FROM TRUE
            OR e.id_sucursal IS DISTINCT FROM $2
            OR COALESCE(e.salario_base, 0) <= 0
            OR regexp_replace(
              translate(upper(trim(COALESCE(e.cargo, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'),
              '\\s+',
              ' ',
              'g'
            ) <> ALL($3::text[])
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.movimiento_planilla mp
            WHERE mp.id_detalle_planilla = dp.id_detalle_planilla
          )
      )
      DELETE FROM public.detalle_planilla dp
      USING candidate_rows c
      WHERE dp.id_detalle_planilla = c.id_detalle_planilla
      RETURNING dp.id_detalle_planilla
    `,
    [safePlanillaId, safeSucursalId, PLANILLA_ALLOWED_ROLE_TOKENS_LIST]
  );

  return { removed: result.rowCount || 0 };
};

const syncDetalleEmpleadosActivosBySucursal = async ({
  db = pool,
  idPlanilla,
  force = false
}) => {
  const safePlanillaId = parsePositiveInt(idPlanilla);
  if (!safePlanillaId) {
    return { inserted: 0, skipped: true, reason: 'INVALID_PLANILLA' };
  }

  const scopeResult = await db.query(
    `
      SELECT
        p.id_sucursal,
        COALESCE(ep.descripcion, '')::varchar AS estado_planilla
      FROM public.planillas p
      LEFT JOIN public.estado_planilla ep
        ON ep.id_estado_planilla = p.id_estado_planilla
      WHERE p.id_planilla = $1
      LIMIT 1
    `,
    [safePlanillaId]
  );

  const scopeRow = scopeResult.rows?.[0];
  if (!scopeRow) {
    return { inserted: 0, skipped: true, reason: 'PLANILLA_NOT_FOUND' };
  }

  const idSucursal = parsePositiveInt(scopeRow.id_sucursal);
  if (!idSucursal) {
    return { inserted: 0, skipped: true, reason: 'INVALID_SUCURSAL' };
  }

  const estadoNormalizado = normalizeEstadoAlias(scopeRow.estado_planilla);
  const canSync =
    force || !estadoNormalizado || PLANILLA_DETALLE_AUTO_SYNC_ALLOWED_STATES.has(estadoNormalizado);
  if (!canSync) {
    return {
      inserted: 0,
      skipped: true,
      reason: 'PLANILLA_STATE_LOCKED',
      estado: estadoNormalizado
    };
  }

  const dedupe = await dedupeDetallePlanillaByEmpleado({ db, idPlanilla: safePlanillaId });
  const cleanup = await cleanupDetalleNoPlanillableBySucursal({
    db,
    idPlanilla: safePlanillaId,
    idSucursal
  });

  const insertResult = await db.query(
    `
      WITH planilla_lock AS (
        SELECT p.id_planilla
        FROM public.planillas p
        WHERE p.id_planilla = $1
        FOR UPDATE
      ),
      defaults AS (
        SELECT
          COALESCE(
            (
              SELECT dp.dias_laborados
              FROM public.detalle_planilla dp
              WHERE dp.id_planilla = $1
              ORDER BY dp.id_detalle_planilla ASC
              LIMIT 1
            ),
            30
          ) AS dias_laborados_default,
          COALESCE(
            (
              SELECT dp.horas_laboradas
              FROM public.detalle_planilla dp
              WHERE dp.id_planilla = $1
              ORDER BY dp.id_detalle_planilla ASC
              LIMIT 1
            ),
            240
          ) AS horas_laboradas_default
      )
      INSERT INTO public.detalle_planilla (
        salario_base,
        dias_laborados,
        horas_laboradas,
        total_deducciones,
        total_bonos,
        neto_pagar,
        id_planilla,
        id_horas_extra,
        id_empleado,
        observaciones
      )
      SELECT
        COALESCE(e.salario_base, 0),
        d.dias_laborados_default,
        d.horas_laboradas_default,
        0,
        0,
        COALESCE(e.salario_base, 0),
        $1,
        NULL,
        e.id_empleado,
        'Sincronizado automaticamente por cambio de personal en sucursal'
      FROM public.empleados e
      CROSS JOIN defaults d
      CROSS JOIN planilla_lock pl
      WHERE e.estado = TRUE
        AND e.id_sucursal = $2
        AND COALESCE(e.salario_base, 0) > 0
        AND regexp_replace(
          translate(upper(trim(COALESCE(e.cargo, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'),
          '\\s+',
          ' ',
          'g'
        ) = ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1
          FROM public.detalle_planilla dp
          WHERE dp.id_planilla = $1
            AND dp.id_empleado = e.id_empleado
        )
      RETURNING id_detalle_planilla
    `,
    [safePlanillaId, idSucursal, PLANILLA_ALLOWED_ROLE_TOKENS_LIST]
  );

  if (dedupe.deleted > 0 || cleanup.removed > 0) {
    await db.query(
      `
        SELECT public.fn_recalcular_detalle_planilla(dp.id_detalle_planilla)
        FROM public.detalle_planilla dp
        WHERE dp.id_planilla = $1
      `,
      [safePlanillaId]
    );
  }

  return {
    inserted: insertResult.rowCount || 0,
    deduped: dedupe.deleted,
    removed_non_planillable: cleanup.removed,
    skipped: false,
    estado: estadoNormalizado,
    id_sucursal: idSucursal
  };
};

const toTimestampSafe = (value) => {
  const parsed = new Date(value ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const resolveEmpleadoDniMap = async (employeeIds = []) => {
  const safeEmployeeIds = [...new Set((employeeIds || []).map(parsePositiveInt).filter(Boolean))];
  if (!safeEmployeeIds.length) return new Map();

  try {
    const result = await pool.query(
      `
        SELECT
          e.id_empleado,
          p.dni
        FROM public.empleados e
        LEFT JOIN public.personas p
          ON p.id_persona = e.id_persona
        WHERE e.id_empleado = ANY($1::int[])
      `,
      [safeEmployeeIds]
    );

    return new Map(
      (result.rows || [])
        .map((row) => [parsePositiveInt(row.id_empleado), sanitizeText(row.dni, 40)])
        .filter(([idEmpleado]) => Boolean(idEmpleado))
    );
  } catch {
    return new Map();
  }
};

const buildMovimientosDataset = async ({
  idPlanilla,
  idDetalle = null,
  tipoPeriodo = TIPO_PERIODO.MENSUAL,
  quincena = null
} = {}) => {
  const planillaPeriodoResult = await pool.query(
    `
      SELECT
        date_trunc('month', p.fecha_creacion)::timestamp AS periodo_inicio,
        (date_trunc('month', p.fecha_creacion) + interval '1 month')::timestamp AS periodo_fin,
        p.fecha_creacion
      FROM public.planillas p
      WHERE p.id_planilla = $1
      LIMIT 1
    `,
    [idPlanilla]
  );
  const planillaPeriodoInicio = planillaPeriodoResult.rows?.[0]?.periodo_inicio || null;
  const planillaPeriodoFin = planillaPeriodoResult.rows?.[0]?.periodo_fin || null;
  const planillaPeriodoKey = toMonthKey(planillaPeriodoResult.rows?.[0]?.fecha_creacion || planillaPeriodoInicio);

  const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);

  const detalleById = new Map();
  const detalleByEmpleado = new Map();
  for (const detalleRow of detalleRows) {
    const detailId = parsePositiveInt(detalleRow.id_detalle_planilla || detalleRow.id_detalle);
    const empleadoId = parsePositiveInt(detalleRow.id_empleado);
    if (!detailId) continue;
    const normalizedRow = {
      ...detalleRow,
      id_detalle_planilla: detailId,
      id_empleado: empleadoId
    };
    detalleById.set(detailId, normalizedRow);
    if (empleadoId && !detalleByEmpleado.has(empleadoId)) {
      detalleByEmpleado.set(empleadoId, normalizedRow);
    }
  }

  if (idDetalle && !detalleById.has(idDetalle)) {
    throw createRequestError(
      'El detalle indicado no pertenece a la planilla seleccionada.',
      404,
      'NOT_FOUND'
    );
  }

  const detalleScope = idDetalle
    ? [detalleById.get(idDetalle)].filter(Boolean)
    : Array.from(detalleById.values());

  const detailIds = detalleScope
    .map((row) => parsePositiveInt(row.id_detalle_planilla))
    .filter(Boolean);

  if (!detailIds.length) return [];

  const detalleChunks = await Promise.all(
    detailIds.map((detailId) => queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.movimientos, [detailId]))
  );

  const movimientosRows = detalleChunks.flat().map((row) => ({
    ...row,
    id_planilla: idPlanilla,
    periodo_movimiento: planillaPeriodoKey || null,
    fecha_periodo: planillaPeriodoInicio,
    tipo: row.tipo || row.tipo_movimiento,
    fecha: row.fecha || row.fecha_registro,
    es_monetario: true,
    anulable: parsePositiveInt(row.id_movimiento_planilla) !== null,
    origen_movimiento: 'MOVIMIENTO',
    quincena_resuelta: resolveQuincenaFromRowContext({
      ...row,
      fecha: row.fecha || row.fecha_registro
    })
  }));

  const employeeIds = [...new Set(detalleScope.map((row) => parsePositiveInt(row.id_empleado)).filter(Boolean))];
  if (!employeeIds.length) {
    return movimientosRows.sort(
      (left, right) =>
        toTimestampSafe(right.fecha_registro || right.fecha) -
        toTimestampSafe(left.fecha_registro || left.fecha)
    );
  }

  const horasExtraIdColumn = await resolveHorasExtraIdColumn();

  const horasExtraResult = await pool.query(
    `
      SELECT
        he.${horasExtraIdColumn} AS id_horas_extra,
        he.id_empleado,
        he.fecha,
        he.horas,
        COALESCE(he.compensada, FALSE) AS compensada,
        he.fecha_compensacion,
        he.observacion
      FROM public.horas_extras he
      WHERE he.id_planilla = $1
        AND he.id_empleado = ANY($2::int[])
      ORDER BY COALESCE(he.fecha_compensacion, he.fecha) DESC, he.${horasExtraIdColumn} DESC
    `,
    [idPlanilla, employeeIds]
  );

  const horasExtraRows = (horasExtraResult.rows || []).map((row) => {
    const empleadoId = parsePositiveInt(row.id_empleado);
    const detalleEmpleado = empleadoId ? detalleByEmpleado.get(empleadoId) : null;
    const horas = Number(row.horas ?? 0);
    const isCompensada = row.compensada === true;
    const fechaMovimiento = row.fecha_compensacion || row.fecha;

    return {
      id_movimiento_planilla: null,
      id_movimiento: `he-${row.id_horas_extra}`,
      id_detalle_planilla: detalleEmpleado?.id_detalle_planilla || null,
      id_planilla: idPlanilla,
      id_empleado: empleadoId,
      tipo_movimiento: 'H.E. TIEMPO',
      tipo: 'H.E. TIEMPO',
      concepto: isCompensada
        ? 'Horas extra compensadas (tiempo x tiempo)'
        : 'Horas extra pendientes (tiempo x tiempo)',
      monto: Number.isFinite(horas) ? horas : 0,
      monto_horas: Number.isFinite(horas) ? horas : 0,
      es_monetario: false,
      observacion: sanitizeText(
        row.observacion,
        255
      ) || (isCompensada ? 'Compensada con tiempo libre.' : 'Pendiente de compensacion.'),
      periodo_movimiento: planillaPeriodoKey || null,
      fecha_periodo: planillaPeriodoInicio,
      fecha: fechaMovimiento,
      fecha_registro: fechaMovimiento,
      origen_movimiento: 'HORAS_EXTRA',
      anulable: false,
      quincena_resuelta: resolveQuincenaFromRowContext({
        observacion: row.observacion,
        fecha: fechaMovimiento
      })
    };
  });

  const adelantoQuincenaAuditMap =
    tipoPeriodo === TIPO_PERIODO.QUINCENAL ? await listQuincenaAdelantoAuditByPlanillaId(idPlanilla) : new Map();

  const adelantosResult = await pool.query(
    `
      SELECT
        aa.id_adelanto_aplicacion,
        aa.id_adelanto_salario,
        aa.monto_aplicado,
        a.id_empleado,
        a.fecha
      FROM public.adelanto_aplicacion aa
      INNER JOIN public.adelantos_salario a
        ON a.id_adelanto_salario = aa.id_adelanto_salario
      WHERE aa.id_planilla = $1
        AND a.id_empleado = ANY($2::int[])
      ORDER BY a.fecha DESC, aa.id_adelanto_aplicacion DESC
    `,
    [idPlanilla, employeeIds]
  );

  const adelantosRows = (adelantosResult.rows || []).map((row) => {
    const empleadoId = parsePositiveInt(row.id_empleado);
    const detalleEmpleado = empleadoId ? detalleByEmpleado.get(empleadoId) : null;
    const montoAplicado = Number(row.monto_aplicado ?? 0);
    const idAdelanto = parsePositiveInt(row.id_adelanto_salario);
    const quincenaAudit = idAdelanto ? normalizeQuincena(adelantoQuincenaAuditMap.get(idAdelanto)) : null;
    const quincenaResuelta = quincenaAudit || resolveQuincenaFromRowContext({ fecha: row.fecha });
    return {
      id_movimiento_planilla: null,
      id_movimiento: `ad-${row.id_adelanto_aplicacion}`,
      id_adelanto_salario: idAdelanto || null,
      id_detalle_planilla: detalleEmpleado?.id_detalle_planilla || null,
      id_planilla: idPlanilla,
      id_empleado: empleadoId,
      tipo_movimiento: 'ADELANTO',
      tipo: 'ADELANTO',
      concepto: idAdelanto
        ? `Aplicacion de adelanto de salario (AD-${idAdelanto})`
        : 'Aplicacion de adelanto de salario',
      monto: Number.isFinite(montoAplicado) ? montoAplicado : 0,
      es_monetario: true,
      observacion: 'Aplicado automaticamente al detalle de planilla.',
      periodo_movimiento: planillaPeriodoKey || null,
      fecha_periodo: planillaPeriodoInicio,
      fecha: row.fecha,
      fecha_registro: row.fecha,
      origen_movimiento: 'ADELANTO',
      anulable: false,
      quincena_resuelta: quincenaResuelta
    };
  });

  const adelantosEliminadosResult = await pool.query(
    `
      SELECT
        a.id_adelanto_salario,
        a.id_empleado,
        a.fecha,
        a.monto,
        a.saldo,
        a.estado
      FROM public.adelantos_salario a
      WHERE a.id_empleado = ANY($1::int[])
        AND (
          $2::timestamp IS NULL
          OR $3::timestamp IS NULL
          OR (a.fecha >= $2::timestamp AND a.fecha < $3::timestamp)
        )
        AND COALESCE(a.estado, FALSE) = FALSE
        AND COALESCE(a.saldo, 0) <= 0
        AND NOT EXISTS (
          SELECT 1
          FROM public.adelanto_aplicacion aa
          WHERE aa.id_adelanto_salario = a.id_adelanto_salario
        )
      ORDER BY a.fecha DESC, a.id_adelanto_salario DESC
    `,
    [employeeIds, planillaPeriodoInicio, planillaPeriodoFin]
  );

  const adelantosEliminadosRows = (adelantosEliminadosResult.rows || []).map((row) => {
    const empleadoId = parsePositiveInt(row.id_empleado);
    const detalleEmpleado = empleadoId ? detalleByEmpleado.get(empleadoId) : null;
    const idAdelanto = parsePositiveInt(row.id_adelanto_salario);
    const monto = Number(row.monto ?? 0);

    return {
      id_movimiento_planilla: null,
      id_movimiento: `ad-del-${idAdelanto || 0}`,
      id_adelanto_salario: idAdelanto || null,
      id_detalle_planilla: detalleEmpleado?.id_detalle_planilla || null,
      id_empleado: empleadoId,
      tipo_movimiento: 'ADELANTO',
      tipo: 'ADELANTO',
      concepto: idAdelanto ? `Adelanto eliminado (AD-${idAdelanto})` : 'Adelanto eliminado',
      monto: Number.isFinite(monto) ? monto : 0,
      es_monetario: true,
      observacion: '[ELIMINADO_AD] Adelanto eliminado desde historial de planilla.',
      id_planilla: idPlanilla,
      periodo_movimiento: planillaPeriodoKey || null,
      fecha_periodo: planillaPeriodoInicio,
      fecha: row.fecha,
      fecha_registro: row.fecha,
      origen_movimiento: 'ADELANTO',
      anulado: true,
      activo: false,
      anulable: false,
      quincena_resuelta: resolveQuincenaFromRowContext({ fecha: row.fecha })
    };
  });

  const mergedRows = [...movimientosRows, ...adelantosRows, ...adelantosEliminadosRows, ...horasExtraRows];
  const scopedRows = filterRowsByPeriodoContext({
    rows: mergedRows,
    tipoPeriodo,
    quincena
  });

  return scopedRows.sort(
    (left, right) =>
      toTimestampSafe(right.fecha_registro || right.fecha) -
      toTimestampSafe(left.fecha_registro || left.fecha)
  );
};

const createRequestError = (message, httpStatus = 400, code = 'VALIDATION_ERROR') => {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
};

const MONEY_VALIDATION_EPSILON = 0.000001;

const formatMoneyForMessage = (value = 0) => {
  const safe = Number.isFinite(value) ? value : 0;
  return `L ${safe.toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const resolveNetoDisponibleDetalle = async ({ db = pool, idDetallePlanilla, idPlanilla, idEmpleado }) => {
  if (!idDetallePlanilla || !idPlanilla || !idEmpleado) return null;

  const totalsResult = await db.query(
    `
      WITH bonos AS (
        SELECT COALESCE(SUM(mp.monto), 0) AS total_bonos
        FROM public.movimiento_planilla mp
        WHERE mp.id_detalle_planilla = $1
          AND UPPER(TRIM(mp.tipo_movimiento)) = 'BONO'
          AND COALESCE(mp.estado, TRUE) = TRUE
      ),
      deducciones_mov AS (
        SELECT COALESCE(SUM(mp.monto), 0) AS total_deducciones_mov
        FROM public.movimiento_planilla mp
        WHERE mp.id_detalle_planilla = $1
          AND UPPER(TRIM(mp.tipo_movimiento)) = 'DEDUCCION'
          AND COALESCE(mp.estado, TRUE) = TRUE
      ),
      adelantos AS (
        SELECT COALESCE(SUM(aa.monto_aplicado), 0) AS total_adelantos
        FROM public.adelanto_aplicacion aa
        INNER JOIN public.adelantos_salario a
          ON a.id_adelanto_salario = aa.id_adelanto_salario
        WHERE aa.id_planilla = $2
          AND a.id_empleado = $3
      )
      SELECT
        COALESCE(dp.salario_base, 0) AS salario_base,
        COALESCE(bonos.total_bonos, 0) AS total_bonos,
        COALESCE(deducciones_mov.total_deducciones_mov, 0) AS total_deducciones_mov,
        COALESCE(adelantos.total_adelantos, 0) AS total_adelantos,
        COALESCE(dp.neto_pagar, 0) AS neto_actual
      FROM public.detalle_planilla dp, bonos, deducciones_mov, adelantos
      WHERE dp.id_detalle_planilla = $1
      LIMIT 1
    `,
    [idDetallePlanilla, idPlanilla, idEmpleado]
  );

  const totals = totalsResult.rows?.[0] || null;
  if (!totals) return null;

  const salarioBase = Number(totals.salario_base ?? 0);
  const totalBonos = Number(totals.total_bonos ?? 0);
  const totalDeduccionesMov = Number(totals.total_deducciones_mov ?? 0);
  const totalAdelantos = Number(totals.total_adelantos ?? 0);
  const netoCalculado = salarioBase + totalBonos - totalDeduccionesMov - totalAdelantos;

  if (Number.isFinite(netoCalculado)) return netoCalculado;

  const netoActual = Number(totals.neto_actual ?? 0);
  return Number.isFinite(netoActual) ? netoActual : null;
};

const assertAdelantoDentroNetoDisponible = (monto, netoDisponible) => {
  const montoSafe = Number(monto ?? 0);
  const netoSafe = Number(netoDisponible ?? 0);
  if (!Number.isFinite(montoSafe) || montoSafe <= 0) return;
  const netoFinal = Number.isFinite(netoSafe) ? Math.max(0, netoSafe) : 0;
  if (montoSafe - netoFinal > MONEY_VALIDATION_EPSILON) {
    throw createRequestError(
      `El monto del adelanto no puede superar el neto a pagar disponible (${formatMoneyForMessage(netoFinal)}).`,
      409,
      'ADELANTO_NETO_INSUFICIENTE'
    );
  }
};

const applyAdelantoFallback = async ({ idAdelanto, idPlanilla, montoAplicar = null }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const adelantoResult = await client.query(
      `
        SELECT
          a.id_adelanto_salario,
          a.id_empleado,
          a.saldo,
          a.estado
        FROM public.adelantos_salario a
        WHERE a.id_adelanto_salario = $1
        FOR UPDATE
      `,
      [idAdelanto]
    );

    if (!adelantoResult.rows?.length) {
      throw createRequestError('El adelanto indicado no existe.', 404, 'NOT_FOUND');
    }

    const adelanto = adelantoResult.rows[0];
    const idEmpleado = parsePositiveInt(adelanto.id_empleado);
    const saldoActual = Number(adelanto.saldo ?? 0);
    const estadoActivo = adelanto.estado === true;

    if (!idEmpleado) {
      throw createRequestError('El adelanto no tiene empleado asociado.', 409, 'RELATION_ERROR');
    }

    if (!estadoActivo) {
      throw createRequestError('El adelanto esta inactivo o ya fue liquidado.', 409, 'ADELANTO_INACTIVO');
    }

    if (!Number.isFinite(saldoActual) || saldoActual <= 0) {
      throw createRequestError('El adelanto no tiene saldo disponible.', 409, 'ADELANTO_SIN_SALDO');
    }

    const detalleResult = await client.query(
      `
        SELECT dp.id_detalle_planilla
        FROM public.detalle_planilla dp
        WHERE dp.id_planilla = $1
          AND dp.id_empleado = $2
        LIMIT 1
      `,
      [idPlanilla, idEmpleado]
    );

    if (!detalleResult.rows?.length) {
      throw createRequestError(
        'El empleado asociado al adelanto no pertenece a la planilla seleccionada.',
        409,
        'PLANILLA_SCOPE_MISMATCH'
      );
    }

    const idDetallePlanilla = parsePositiveInt(detalleResult.rows[0].id_detalle_planilla);
    if (!idDetallePlanilla) {
      throw createRequestError(
        'No se pudo identificar el detalle de planilla del empleado para validar el adelanto.',
        409,
        'RELATION_ERROR'
      );
    }
    const montoAplicado = Number.isFinite(montoAplicar) && montoAplicar > 0 ? montoAplicar : saldoActual;

    if (!Number.isFinite(montoAplicado) || montoAplicado <= 0) {
      throw createRequestError('El monto a aplicar debe ser mayor que 0.', 400, 'VALIDATION_ERROR');
    }

    if (montoAplicado > saldoActual) {
      throw createRequestError(
        'El monto a aplicar no puede superar el saldo disponible del adelanto.',
        409,
        'ADELANTO_MONTO_INVALIDO'
      );
    }

    const netoDisponible = await resolveNetoDisponibleDetalle({
      db: client,
      idDetallePlanilla,
      idPlanilla,
      idEmpleado
    });
    assertAdelantoDentroNetoDisponible(montoAplicado, netoDisponible);

    const existing = await client.query(
      `
        SELECT aa.id_adelanto_aplicacion
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla = $1
          AND aa.id_adelanto_salario = $2
        LIMIT 1
      `,
      [idPlanilla, idAdelanto]
    );

    if (existing.rows?.length) {
      throw createRequestError(
        'Este adelanto ya fue aplicado a la planilla seleccionada.',
        409,
        'ADELANTO_DUPLICADO'
      );
    }

    await client.query(
      `
        INSERT INTO public.adelanto_aplicacion (
          id_planilla,
          id_adelanto_salario,
          monto_aplicado
        )
        VALUES ($1, $2, $3)
      `,
      [idPlanilla, idAdelanto, montoAplicado]
    );

    await client.query(
      `
        UPDATE public.adelantos_salario a
        SET
          saldo = a.saldo - $2,
          estado = CASE WHEN (a.saldo - $2) <= 0 THEN FALSE ELSE a.estado END
        WHERE a.id_adelanto_salario = $1
      `,
      [idAdelanto, montoAplicado]
    );

    let netoActualizado = null;
    try {
      await syncDetalleSalarioBaseFromEmpleado({
        db: client,
        idPlanilla,
        idDetallePlanilla
      });
      const recalc = await client.query(
        'SELECT public.fn_recalcular_detalle_planilla($1) AS neto_actualizado',
        [idDetallePlanilla]
      );
      netoActualizado = Number(recalc.rows?.[0]?.neto_actualizado ?? 0);
    } catch {
      const totalsResult = await client.query(
        `
          WITH bonos AS (
            SELECT COALESCE(SUM(mp.monto), 0) AS total_bonos
            FROM public.movimiento_planilla mp
            WHERE mp.id_detalle_planilla = $1
              AND UPPER(TRIM(mp.tipo_movimiento)) = 'BONO'
              AND COALESCE(mp.estado, TRUE) = TRUE
          ),
          deducciones_mov AS (
            SELECT COALESCE(SUM(mp.monto), 0) AS total_deducciones_mov
            FROM public.movimiento_planilla mp
            WHERE mp.id_detalle_planilla = $1
              AND UPPER(TRIM(mp.tipo_movimiento)) = 'DEDUCCION'
              AND COALESCE(mp.estado, TRUE) = TRUE
          ),
          adelantos AS (
            SELECT COALESCE(SUM(aa.monto_aplicado), 0) AS total_adelantos
            FROM public.adelanto_aplicacion aa
            INNER JOIN public.adelantos_salario a
              ON a.id_adelanto_salario = aa.id_adelanto_salario
            WHERE aa.id_planilla = $2
              AND a.id_empleado = $3
          )
          SELECT
            COALESCE(dp.salario_base, 0) AS salario_base,
            COALESCE(bonos.total_bonos, 0) AS total_bonos,
            (COALESCE(deducciones_mov.total_deducciones_mov, 0) + COALESCE(adelantos.total_adelantos, 0))
              AS total_deducciones
          FROM public.detalle_planilla dp, bonos, deducciones_mov, adelantos
          WHERE dp.id_detalle_planilla = $1
          LIMIT 1
        `,
        [idDetallePlanilla, idPlanilla, idEmpleado]
      );

      const totals = totalsResult.rows?.[0] || {};
      const salarioBase = Number(totals.salario_base ?? 0);
      const totalBonos = Number(totals.total_bonos ?? 0);
      const totalDeducciones = Number(totals.total_deducciones ?? 0);
      netoActualizado = salarioBase + totalBonos - totalDeducciones;

      await client.query(
        `
          UPDATE public.detalle_planilla
          SET
            total_bonos = $2,
            total_deducciones = $3,
            neto_pagar = $4
          WHERE id_detalle_planilla = $1
        `,
        [idDetallePlanilla, totalBonos, totalDeducciones, netoActualizado]
      );
    }

    await client.query('COMMIT');

    return {
      id_adelanto_salario: idAdelanto,
      id_planilla: idPlanilla,
      id_empleado: idEmpleado,
      monto_aplicado: montoAplicado,
      saldo_restante: saldoActual - montoAplicado,
      neto_actualizado: netoActualizado
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const getRequiredEstadoPermission = (descripcion = '') => {
  const normalized = String(descripcion || '').trim().toUpperCase();
  if (normalized === 'CALCULADA') return 'PLANILLAS_APROBAR';
  if (normalized === 'CERRADA') return 'PLANILLAS_CERRAR';
  if (normalized === 'PAGADA') return 'PLANILLAS_PAGAR';
  if (normalized === 'BORRADOR') return 'PLANILLAS_REABRIR';
  if (normalized === 'ANULADA') return 'PLANILLAS_ANULAR';
  return null;
};

const mapStatusToErrorCode = (status = 500) => {
  if (status === 400) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT_ERROR';
  return 'INTERNAL_ERROR';
};

const decodeMojibakeText = (value = '') => {
  const text = String(value ?? '');
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    const decoded = Buffer.from(text, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('�')) return decoded;
  } catch {
    // noop
  }
  return text;
};

const normalizeServiceErrorBody = (status = 500, body = null) => {
  const source = body && typeof body === 'object' ? body : {};
  const safeStatus = Number.isInteger(status) ? status : 500;
  const message = sanitizeApiErrorMessage(
    decodeMojibakeText(source.message || source.mensaje),
    safeStatus
  );
  return buildErrorBody({
    code: String(source.code || mapStatusToErrorCode(safeStatus)).trim() || mapStatusToErrorCode(safeStatus),
    message,
    details: source.details && typeof source.details === 'object' ? source.details : undefined
  });
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    const status = Number.isInteger(result?.status) ? result.status : 500;
    if (status >= 400) {
      return res.status(status).json(normalizeServiceErrorBody(status, result?.body));
    }
    return res.status(status).json(result?.body ?? { error: false });
  } catch (err) {
    const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return res.status(httpStatus).json(
        buildErrorBody({
          code: err.code || 'REQUEST_ERROR',
          message: sanitizeApiErrorMessage(err.message, httpStatus)
        })
      );
    }

    const mappedError = mapDbError(err);
    if (mappedError) {
      return res.status(mappedError.status).json(
        buildErrorBody({ code: mappedError.code, message: mappedError.message })
      );
    }

    console.error('Planillas API error:', err.message);
    return res.status(500).json(
      buildErrorBody({
        code: 'INTERNAL_ERROR',
        message: 'No se pudo procesar la solicitud de planillas.'
      })
    );
  }
};

const planillaService = {
  async list(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, LIST_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    let rows = [];
    try {
      rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.list, []);
    } catch {
      rows = await listPlanillasFallbackRows();
    }

    const idSucursal = req.query.id_sucursal === undefined ? null : parsePositiveInt(req.query.id_sucursal);
    if (req.query.id_sucursal !== undefined && !idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal invÃƒÆ’Ã‚Â¡lido' } };
    }

    const periodo = req.query.periodo === undefined ? null : normalizePeriodo(req.query.periodo);
    if (req.query.periodo !== undefined && !periodo) {
      return { status: 400, body: { error: true, message: 'periodo invÃƒÆ’Ã‚Â¡lido. Use YYYY-MM o YYYY-MM-DD' } };
    }

    const search = sanitizeText(req.query.search ?? req.query.q, 120);
    const estado = req.query.estado === undefined
      ? null
      : normalizeEstadoAlias(sanitizeText(req.query.estado, 60));
    const shouldFilterTipoPeriodo =
      req.query.tipo_periodo !== undefined &&
      req.query.tipo_periodo !== null &&
      String(req.query.tipo_periodo).trim() !== '';
    const tipoPeriodo = normalizeTipoPeriodo(req.query.tipo_periodo);
    if (req.query.tipo_periodo !== undefined && !tipoPeriodo) {
      return { status: 400, body: { error: true, message: 'tipo_periodo invalido. Use mensual o quincenal.' } };
    }
    const quincena = normalizeQuincena(req.query.quincena);
    if (req.query.quincena !== undefined && quincena === null) {
      return { status: 400, body: { error: true, message: 'quincena invalida. Use 1 o 2.' } };
    }
    if (tipoPeriodo === TIPO_PERIODO.QUINCENAL && quincena === null) {
      return { status: 400, body: { error: true, message: 'quincena es requerida para tipo_periodo quincenal.' } };
    }

    if (req.query.estado !== undefined && !estado) {
      return { status: 400, body: { error: true, message: 'estado invalido' } };
    }

    const periodoKey = periodo ? toMonthKey(periodo) : null;

    const shouldResolveQuincenaContext =
      shouldFilterTipoPeriodo && tipoPeriodo === TIPO_PERIODO.QUINCENAL;

    const filtered = rows.filter((row) => {
      if (idSucursal && parsePositiveInt(row.id_sucursal) !== idSucursal) return false;

      if (periodoKey) {
        const rowMonth = toMonthKey(row.fecha_creacion);
        if (rowMonth !== periodoKey) return false;
      }

      if (estado && !shouldResolveQuincenaContext) {
        const estadoPlanilla = normalizeEstadoAlias(row.estado_planilla ?? row.estado);
        if (estadoPlanilla !== estado) return false;
      }

      if (search) {
        const haystack = [
          row.id_planilla,
          row.nombre_sucursal,
          row.estado_planilla,
          row.fecha_creacion,
          row.total_empleados
        ]
          .map((value) => String(value ?? '').toLowerCase())
          .join(' ');

        if (!haystack.includes(search.toLowerCase())) return false;
      }

      if (shouldFilterTipoPeriodo) {
        const rowTipoPeriodo = resolveRowTipoPeriodo(row);
        const rowQuincena = resolveRowQuincena(row);

        if (tipoPeriodo === TIPO_PERIODO.QUINCENAL) {
          // Compatibilidad: la planilla fisica sigue siendo mensual.
          // Si el row no expone quincena explicita, se mantiene visible para resolver estado contextual.
          if (rowQuincena !== null && quincena !== null && rowQuincena !== quincena) return false;
        } else if (tipoPeriodo === TIPO_PERIODO.MENSUAL) {
          if (rowTipoPeriodo !== TIPO_PERIODO.MENSUAL) return false;
        }
      }

      return true;
    });

    const quincenaEstadoAuditByPlanilla = shouldResolveQuincenaContext
      ? await listQuincenaEstadoAuditByPlanillaIds(filtered.map((row) => row?.id_planilla))
      : new Map();

    const rowsWithPeriodoMeta = filtered.map((row) => {
      const rowTipoPeriodo = resolveRowTipoPeriodo(row);
      const rowQuincena = rowTipoPeriodo === TIPO_PERIODO.QUINCENAL ? resolveRowQuincena(row) : null;
      const resolvedTipoPeriodo = shouldResolveQuincenaContext
        ? TIPO_PERIODO.QUINCENAL
        : rowTipoPeriodo;
      const resolvedQuincena = shouldResolveQuincenaContext
        ? quincena
        : rowQuincena;
      const rowPeriodoMeta = buildPeriodoMeta({
        fechaPlanilla: row?.fecha_creacion,
        tipoPeriodo: resolvedTipoPeriodo,
        quincena: resolvedQuincena,
        diasLaborados: null,
        horasLaboradas: null
      });

      const baseEstado = normalizeEstadoAlias(row.estado_planilla ?? row.estado);
      const contextualEstado = shouldResolveQuincenaContext
        ? resolveContextualEstadoQuincena({
            baseEstado,
            quincena: resolvedQuincena,
            auditEstadoMap: quincenaEstadoAuditByPlanilla.get(String(parsePositiveInt(row?.id_planilla) || 0))
          })
        : { estado: baseEstado, id_estado_planilla: parsePositiveInt(row?.id_estado_planilla) };

      return {
        ...row,
        tipo_periodo: shouldResolveQuincenaContext
          ? TIPO_PERIODO.QUINCENAL
          : row?.tipo_periodo ?? rowPeriodoMeta.tipo_periodo,
        quincena: row?.quincena ?? resolvedQuincena ?? rowPeriodoMeta.quincena,
        periodo_inicio: row?.periodo_inicio ?? rowPeriodoMeta.periodo_inicio,
        periodo_fin: row?.periodo_fin ?? rowPeriodoMeta.periodo_fin,
        dias_laborados: row?.dias_laborados ?? rowPeriodoMeta.dias_laborados,
        horas_laboradas: row?.horas_laboradas ?? rowPeriodoMeta.horas_laboradas,
        factor_prorrateo: row?.factor_prorrateo ?? rowPeriodoMeta.factor_prorrateo,
        estado_planilla: contextualEstado.estado || row?.estado_planilla,
        estado: contextualEstado.estado || row?.estado,
        id_estado_planilla:
          parsePositiveInt(contextualEstado.id_estado_planilla) || parsePositiveInt(row?.id_estado_planilla) || null
      };
    });

    const finalRows =
      estado && shouldResolveQuincenaContext
        ? rowsWithPeriodoMeta.filter(
            (row) => normalizeEstadoAlias(row?.estado_planilla ?? row?.estado) === estado
          )
        : rowsWithPeriodoMeta;

    return {
      status: 200,
      body: {
        error: false,
        ...paginateRows(finalRows, pagination.page, pagination.limit)
      }
    };
  },

  async generar(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, GENERAR_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    if (!idSucursal) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_sucursal es requerido.'
        })
      };
    }

    const fechaPlanilla = normalizePeriodo(req.body?.periodo) || new Date().toISOString().slice(0, 10);
    const tipoPeriodo = normalizeTipoPeriodo(req.body?.tipo_periodo);
    if (!tipoPeriodo) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'tipo_periodo invalido. Use mensual o quincenal.'
        })
      };
    }
    const quincena = normalizeQuincena(req.body?.quincena);
    if (req.body?.quincena !== undefined && quincena === null) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'quincena invalida. Use 1 o 2.'
        })
      };
    }
    if (tipoPeriodo === TIPO_PERIODO.QUINCENAL && quincena === null) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'quincena es requerida cuando tipo_periodo es quincenal.'
        })
      };
    }
    const idEstadoPlanilla =
      parsePositiveInt(req.body?.id_estado_planilla) ||
      (await resolveDefaultEstadoPlanillaId());
    if (!idEstadoPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'No hay estados de planilla configurados en el catalogo.'
        })
      };
    }
    const monthlyDias = parsePositiveNumber(req.body?.dias_laborados) || 30;
    const monthlyHoras = parsePositiveNumber(req.body?.horas_laboradas) || 240;
    let diasLaborados = monthlyDias;
    let horasLaboradas = monthlyHoras;
    let periodoMeta = buildPeriodoMeta({
      fechaPlanilla,
      tipoPeriodo,
      quincena,
      diasLaborados,
      horasLaboradas
    });

    if (tipoPeriodo === TIPO_PERIODO.QUINCENAL) {
      const quincenaWindow = resolveQuincenaWindow(fechaPlanilla, quincena || 1);
      const factor = quincenaWindow?.factor || 0.5;
      diasLaborados = Number((monthlyDias * factor).toFixed(2));
      horasLaboradas = Number((monthlyHoras * factor).toFixed(2));
      periodoMeta = buildPeriodoMeta({
        fechaPlanilla,
        tipoPeriodo,
        quincena,
        diasLaborados,
        horasLaboradas
      });
    }

    let idPlanilla;
    try {
      idPlanilla = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.generar, [
        idSucursal,
        fechaPlanilla,
        idEstadoPlanilla,
        diasLaborados,
        horasLaboradas
      ]);
    } catch (error) {
      const rawMessage = String(error?.message || '').toLowerCase();
      if (String(error?.code || '').toUpperCase() === 'P0001' && rawMessage.includes('ya existe una planilla')) {
        const existingId = await findExistingPlanillaIdByMonthAndSucursal(idSucursal, fechaPlanilla);
        if (existingId) {
          return {
            status: 200,
            body: {
              error: false,
              message: 'La planilla ya existia para ese periodo y sucursal.',
              data: { id_planilla: existingId, existente: true, ...periodoMeta }
            }
          };
        }
      }
      throw error;
    }

    return {
      status: 201,
      body: {
        error: false,
        message: 'Planilla generada correctamente',
        data: { id_planilla: idPlanilla, ...periodoMeta }
      }
    };
  },

  async recalcularPlanilla(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, RECALCULAR_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invÃƒÆ’Ã‚Â¡lido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    await syncDetalleEmpleadosActivosBySucursal({ idPlanilla });
    await syncDetalleSalarioBaseFromEmpleado({ idPlanilla });
    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.recalcularPlanilla, [idPlanilla]);
    return {
      status: 200,
      body: { error: false, message: 'Planilla recalculada correctamente', data: rows[0] || null }
    };
  },

  async detalle(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, DETALLE_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invÃƒÆ’Ã‚Â¡lido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.query?.tipo_periodo,
      rawQuincena: req.query?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }
    const tipoPeriodoContext = periodoContext.tipo_periodo;
    const quincenaContext = periodoContext.quincena;

    await syncDetalleEmpleadosActivosBySucursal({ idPlanilla });
    await syncDetalleSalarioBaseFromEmpleado({ idPlanilla });
    await recalculateDetallePlanillaRows({ idPlanilla });

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rawRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const rows = filterPlanillableEmpleadoRows(rawRows);
    const employeeIds = [...new Set((rows || []).map((row) => parsePositiveInt(row.id_empleado)).filter(Boolean))];
    const dniMap = await resolveEmpleadoDniMap(employeeIds);

    const horasResult = await pool.query(
      `
        SELECT
          he.id_empleado,
          COALESCE(
            SUM(
              CASE
                WHEN COALESCE(he.compensada, FALSE) = FALSE THEN COALESCE(he.horas, 0)
                ELSE 0
              END
            ),
            0
          ) AS horas_pendientes
        FROM public.horas_extras he
        WHERE he.id_planilla = $1
        GROUP BY he.id_empleado
      `,
      [idPlanilla]
    );

    const horasPendientesMap = new Map(
      (horasResult.rows || [])
        .map((row) => [parsePositiveInt(row.id_empleado), Number(row.horas_pendientes ?? 0)])
        .filter(([idEmpleado]) => Boolean(idEmpleado))
    );

    const adelantosResult = await pool.query(
      `
        SELECT
          a.id_empleado,
          COALESCE(SUM(aa.monto_aplicado), 0) AS total_adelantos_aplicados
        FROM public.adelanto_aplicacion aa
        INNER JOIN public.adelantos_salario a
          ON a.id_adelanto_salario = aa.id_adelanto_salario
        WHERE aa.id_planilla = $1
        GROUP BY a.id_empleado
      `,
      [idPlanilla]
    );

    const adelantosMap = new Map(
      (adelantosResult.rows || [])
        .map((row) => [parsePositiveInt(row.id_empleado), Number(row.total_adelantos_aplicados ?? 0)])
        .filter(([idEmpleado]) => Boolean(idEmpleado))
    );

    const search = sanitizeText(req.query.search ?? req.query.q, 120);

    let enrichedRows = rows.map((row) => {
      const idEmpleado = parsePositiveInt(row.id_empleado);
      const horasPendientes = idEmpleado ? Number(horasPendientesMap.get(idEmpleado) ?? 0) : 0;
      const adelantosAplicados = idEmpleado ? Number(adelantosMap.get(idEmpleado) ?? 0) : 0;
      const resolvedDni = sanitizeText(
        row.dni || row.persona_dni || row.dni_persona || row.numero_dni || (idEmpleado ? dniMap.get(idEmpleado) : ''),
        40
      );
      return {
        ...row,
        dni: resolvedDni || null,
        persona_dni: resolvedDni || null,
        he_tiempo: Number.isFinite(horasPendientes) ? horasPendientes : 0,
        horas_extra_tiempo: Number.isFinite(horasPendientes) ? horasPendientes : 0,
        total_adelantos_aplicados: Number.isFinite(adelantosAplicados) ? adelantosAplicados : 0,
        adelantos: Number.isFinite(adelantosAplicados) ? adelantosAplicados : 0
      };
    });

    if (tipoPeriodoContext === TIPO_PERIODO.QUINCENAL) {
      const movimientosContextRows = await buildMovimientosDataset({
        idPlanilla,
        tipoPeriodo: tipoPeriodoContext,
        quincena: quincenaContext
      });
      const metricsByEmpleado = aggregateDetalleMetricsFromMovimientos({
        detalleRows: rows,
        movimientosRows: movimientosContextRows
      });

      enrichedRows = rows.map((row) => {
        const idEmpleado = parsePositiveInt(row.id_empleado);
        const resolvedDni = sanitizeText(
          row.dni ||
            row.persona_dni ||
            row.dni_persona ||
            row.numero_dni ||
            (idEmpleado ? dniMap.get(idEmpleado) : ''),
          40
        );
        const metrics = metricsByEmpleado.get(idEmpleado) || {
          bonos: 0,
          deducciones: 0,
          adelantos: 0,
          horasPendientes: 0
        };
        const salarioBase = roundTo(Number(row?.salario_base ?? 0));
        const totalBonos = roundTo(metrics.bonos);
        const totalDeduccionesSinAdelantos = roundTo(metrics.deducciones);
        const totalAdelantos = roundTo(metrics.adelantos);
        const totalDeducciones = roundTo(totalDeduccionesSinAdelantos + totalAdelantos);
        const neto = roundTo(salarioBase + totalBonos - totalDeducciones);
        const horasPendientes = roundTo(metrics.horasPendientes);

        return {
          ...row,
          dni: resolvedDni || null,
          persona_dni: resolvedDni || null,
          total_bonos: totalBonos,
          bonos: totalBonos,
          total_deducciones_sin_adelantos: totalDeduccionesSinAdelantos,
          deducciones_sin_adelantos: totalDeduccionesSinAdelantos,
          total_deducciones: totalDeducciones,
          deducciones: totalDeducciones,
          total_adelantos_aplicados: totalAdelantos,
          total_adelantos: totalAdelantos,
          adelantos: totalAdelantos,
          he_tiempo: horasPendientes,
          horas_extra_tiempo: horasPendientes,
          neto_pagar: neto,
          total_neto_pagar: neto,
          neto
        };
      });
    }

    const filtered = enrichedRows.filter((row) => {
      if (!search) return true;
      const haystack = [
        row.id_empleado,
        row.nombre_completo,
        row.dni,
        row.sucursal,
        row.cargo,
        row.salario_base,
        row.total_bonos,
        row.total_deducciones,
        row.neto_pagar,
        row.he_tiempo,
        row.total_adelantos_aplicados
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: {
        error: false,
        ...paginateRows(filtered, pagination.page, pagination.limit)
      }
    };
  },

  async resumen(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, RESUMEN_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invÃƒÆ’Ã‚Â¡lido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.query?.tipo_periodo,
      rawQuincena: req.query?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }
    const tipoPeriodoContext = periodoContext.tipo_periodo;
    const quincenaContext = periodoContext.quincena;

    await syncDetalleEmpleadosActivosBySucursal({ idPlanilla });
    await syncDetalleSalarioBaseFromEmpleado({ idPlanilla });
    await recalculateDetallePlanillaRows({ idPlanilla });

    if (tipoPeriodoContext === TIPO_PERIODO.QUINCENAL) {
      const detalleRowsRaw = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
      const detalleRows = filterPlanillableEmpleadoRows(detalleRowsRaw);
      const movimientosContextRows = await buildMovimientosDataset({
        idPlanilla,
        tipoPeriodo: tipoPeriodoContext,
        quincena: quincenaContext
      });
      const metricsByEmpleado = aggregateDetalleMetricsFromMovimientos({
        detalleRows,
        movimientosRows: movimientosContextRows
      });

      const resumenContextual = (Array.isArray(detalleRows) ? detalleRows : []).reduce(
        (acc, row) => {
          const idEmpleado = parsePositiveInt(row?.id_empleado);
          const metrics = metricsByEmpleado.get(idEmpleado) || {
            bonos: 0,
            deducciones: 0,
            adelantos: 0
          };
          const salarioBase = roundTo(Number(row?.salario_base ?? 0));
          const bonos = roundTo(metrics.bonos);
          const deduccionesSinAdelantos = roundTo(metrics.deducciones);
          const adelantos = roundTo(metrics.adelantos);
          const deducciones = roundTo(deduccionesSinAdelantos + adelantos);
          const neto = roundTo(salarioBase + bonos - deducciones);

          acc.total_salario_base += salarioBase;
          acc.total_bonos += bonos;
          acc.total_deducciones_sin_adelantos += deduccionesSinAdelantos;
          acc.total_adelantos_aplicados += adelantos;
          acc.total_deducciones += deducciones;
          acc.total_neto_pagar += neto;
          acc.total_empleados += 1;
          return acc;
        },
        {
          total_salario_base: 0,
          total_bonos: 0,
          total_deducciones_sin_adelantos: 0,
          total_adelantos_aplicados: 0,
          total_adelantos: 0,
          total_deducciones: 0,
          total_neto_pagar: 0,
          total_neto: 0,
          total_empleados: 0
        }
      );

      const data = {
        ...resumenContextual,
        total_salario_base: roundTo(resumenContextual.total_salario_base),
        total_bonos: roundTo(resumenContextual.total_bonos),
        total_deducciones_sin_adelantos: roundTo(resumenContextual.total_deducciones_sin_adelantos),
        total_adelantos_aplicados: roundTo(resumenContextual.total_adelantos_aplicados),
        total_adelantos: roundTo(resumenContextual.total_adelantos_aplicados),
        total_deducciones: roundTo(resumenContextual.total_deducciones),
        total_neto_pagar: roundTo(resumenContextual.total_neto_pagar),
        total_neto: roundTo(resumenContextual.total_neto_pagar),
        tipo_periodo: TIPO_PERIODO.QUINCENAL,
        quincena: quincenaContext
      };

      return { status: 200, body: { error: false, data } };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.resumen, [idPlanilla]);
    const resumenBase = rows[0] || {};
    const detalleRowsRaw = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleRows = filterPlanillableEmpleadoRows(detalleRowsRaw);
    const resumenDesdeDetalle = buildResumenFromDetalleRows(detalleRows);

    const adelantosResult = await pool.query(
      `
        SELECT COALESCE(SUM(aa.monto_aplicado), 0) AS total_adelantos_aplicados
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla = $1
      `,
      [idPlanilla]
    );

    const totalAdelantosAplicados = Number(adelantosResult.rows?.[0]?.total_adelantos_aplicados ?? 0);
    const data = {
      ...resumenBase,
      total_salario_base: roundTo(resumenDesdeDetalle.total_salario_base),
      total_bonos: roundTo(resumenDesdeDetalle.total_bonos),
      total_deducciones: roundTo(resumenDesdeDetalle.total_deducciones),
      total_neto_pagar: roundTo(resumenDesdeDetalle.total_neto_pagar),
      total_neto: roundTo(resumenDesdeDetalle.total_neto_pagar),
      total_empleados: resumenDesdeDetalle.total_empleados,
      total_adelantos_aplicados: Number.isFinite(totalAdelantosAplicados) ? totalAdelantosAplicados : 0,
      total_adelantos: Number.isFinite(totalAdelantosAplicados) ? totalAdelantosAplicados : 0
    };

    return { status: 200, body: { error: false, data } };
  },

  async completa(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, COMPLETA_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invÃƒÆ’Ã‚Â¡lido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    await syncDetalleEmpleadosActivosBySucursal({ idPlanilla });
    await syncDetalleSalarioBaseFromEmpleado({ idPlanilla });
    await recalculateDetallePlanillaRows({ idPlanilla });

    const data = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.completa, [idPlanilla]);
    if (data && typeof data === 'object') {
      const detailKeys = ['detalle', 'detalle_planilla', 'items', 'rows'];
      detailKeys.forEach((key) => {
        if (Array.isArray(data[key])) {
          data[key] = filterPlanillableEmpleadoRows(data[key]);
        }
      });

      const resumenKey = data?.resumen && typeof data.resumen === 'object' ? 'resumen' : null;
      if (resumenKey) {
        const sourceRows =
          (Array.isArray(data.detalle) && data.detalle) ||
          (Array.isArray(data.detalle_planilla) && data.detalle_planilla) ||
          [];
        const resumenDesdeDetalle = buildResumenFromDetalleRows(sourceRows);
        data[resumenKey] = {
          ...data[resumenKey],
          total_salario_base: roundTo(resumenDesdeDetalle.total_salario_base),
          total_bonos: roundTo(resumenDesdeDetalle.total_bonos),
          total_deducciones: roundTo(resumenDesdeDetalle.total_deducciones),
          total_neto_pagar: roundTo(resumenDesdeDetalle.total_neto_pagar),
          total_neto: roundTo(resumenDesdeDetalle.total_neto_pagar),
          total_empleados: resumenDesdeDetalle.total_empleados
        };
      }
    }
    return { status: 200, body: { error: false, data } };
  },

  async listarHorasExtra(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, HORAS_EXTRA_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla invalido.' })
      };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'page y limit deben ser enteros positivos.' })
      };
    }

    const idEmpleado = req.query.id_empleado === undefined ? null : parsePositiveInt(req.query.id_empleado);
    if (req.query.id_empleado !== undefined && !idEmpleado) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_empleado invalido.' })
      };
    }

    const estado = sanitizeText(req.query.estado, 20)?.toUpperCase() || '';
    if (estado && !['PENDIENTE', 'COMPENSADA', 'TODAS'].includes(estado)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado invalido. Use PENDIENTE o COMPENSADA.' })
      };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.query?.tipo_periodo,
      rawQuincena: req.query?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const horasExtraIdColumn = await resolveHorasExtraIdColumn();

    const rowsResult = await pool.query(
      `
        SELECT
          he.${horasExtraIdColumn} AS id_horas_extras,
          he.${horasExtraIdColumn} AS id_horas_extra,
          he.id_planilla,
          he.id_empleado,
          he.fecha,
          he.horas,
          COALESCE(he.compensada, FALSE) AS compensada,
          he.fecha_compensacion,
          he.observacion,
          p.id_sucursal,
          COALESCE(e.cargo, '')::varchar AS cargo,
          TRIM(COALESCE(pe.nombre, '') || ' ' || COALESCE(pe.apellido, '')) AS nombre_completo
        FROM public.horas_extras he
        INNER JOIN public.planillas p
          ON p.id_planilla = he.id_planilla
        LEFT JOIN public.empleados e
          ON e.id_empleado = he.id_empleado
        LEFT JOIN public.personas pe
          ON pe.id_persona = e.id_persona
        WHERE he.id_planilla = $1
          AND ($2::int IS NULL OR he.id_empleado = $2::int)
        ORDER BY he.fecha DESC, he.${horasExtraIdColumn} DESC
      `,
      [idPlanilla, idEmpleado]
    );

    const rows = rowsResult.rows || [];
    const rowsByPeriodo = filterRowsByPeriodoContext({
      rows,
      tipoPeriodo: periodoContext.tipo_periodo,
      quincena: periodoContext.quincena
    });
    const filteredRows =
      estado === 'PENDIENTE'
        ? rowsByPeriodo.filter((row) => !row.compensada)
        : estado === 'COMPENSADA'
          ? rowsByPeriodo.filter((row) => row.compensada)
          : rowsByPeriodo;

    const summary = rowsByPeriodo.reduce(
      (acc, row) => {
        const horas = Number(row?.horas ?? 0);
        if (!Number.isFinite(horas)) return acc;
        acc.total_horas += horas;
        if (row.compensada) {
          acc.compensadas_horas += horas;
          acc.compensadas_registros += 1;
        } else {
          acc.pendientes_horas += horas;
          acc.pendientes_registros += 1;
        }
        return acc;
      },
      {
        total_horas: 0,
        compensadas_horas: 0,
        pendientes_horas: 0,
        total_registros: rowsByPeriodo.length,
        compensadas_registros: 0,
        pendientes_registros: 0
      }
    );

    return {
      status: 200,
      body: {
        error: false,
        summary,
        ...paginateRows(filteredRows, pagination.page, pagination.limit)
      }
    };
  },

  async registrarHoraExtra(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, REGISTRAR_HORAS_EXTRA_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idEmpleado = parsePositiveInt(req.body?.id_empleado);
    const horas = parsePositiveNumber(req.body?.horas);
    const fecha = normalizeTimestampInput(req.body?.fecha);
    const observacionInput = sanitizeText(req.body?.observacion, 255);
    const idTipoHora = req.body?.id_tipo_hora === undefined ? null : parsePositiveInt(req.body?.id_tipo_hora);
    const idFactorHorasExtras =
      req.body?.id_factor_horas_extras === undefined
        ? null
        : parsePositiveInt(req.body?.id_factor_horas_extras);
    const tarifaBase =
      req.body?.tarifa_base === undefined || req.body?.tarifa_base === null || req.body?.tarifa_base === ''
        ? null
        : Number(req.body?.tarifa_base);

    if (!idPlanilla || !idEmpleado || !horas) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_planilla, id_empleado y horas son requeridos.'
        })
      };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.body?.tipo_periodo,
      rawQuincena: req.body?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }
    const observacion =
      periodoContext.tipo_periodo === TIPO_PERIODO.QUINCENAL
        ? appendQuincenaContextTag(observacionInput, periodoContext.quincena)
        : observacionInput;

    if (horas <= 0 || horas > 24) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Las horas extra deben estar entre 0.01 y 24.'
        })
      };
    }

    if (req.body?.fecha !== undefined && !fecha) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha enviada no es valida.'
        })
      };
    }

    if (req.body?.fecha !== undefined && fecha && isFutureDateInput(req.body?.fecha)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha no puede ser mayor al dia actual.'
        })
      };
    }

    if (req.body?.id_tipo_hora !== undefined && !idTipoHora) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_tipo_hora invalido.'
        })
      };
    }

    if (req.body?.id_factor_horas_extras !== undefined && !idFactorHorasExtras) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_factor_horas_extras invalido.'
        })
      };
    }

    if (tarifaBase !== null && (!Number.isFinite(tarifaBase) || tarifaBase < 0)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'tarifa_base invalida.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
    if (!detalleValido) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'NOT_FOUND',
          message: 'El empleado no pertenece al detalle de la planilla seleccionada.'
        })
      };
    }

    const horasExtraIdColumn = await resolveHorasExtraIdColumn();
    const insertResult = await pool.query(
      `
        INSERT INTO public.horas_extras (
          id_planilla,
          id_empleado,
          fecha,
          id_tipo_hora,
          horas,
          id_factor_horas_extras,
          tarifa_base,
          compensada,
          observacion
        )
        VALUES (
          $1,
          $2,
          COALESCE($3::timestamp, NOW()),
          $4,
          $5,
          $6,
          $7,
          FALSE,
          $8
        )
        RETURNING
          ${horasExtraIdColumn} AS id_horas_extras,
          ${horasExtraIdColumn} AS id_horas_extra,
          id_planilla,
          id_empleado,
          fecha,
          id_tipo_hora,
          horas,
          id_factor_horas_extras,
          tarifa_base,
          compensada,
          fecha_compensacion,
          observacion
      `,
      [idPlanilla, idEmpleado, fecha, idTipoHora, horas, idFactorHorasExtras, tarifaBase, observacion]
    );

    return {
      status: 201,
      body: {
        error: false,
        message: 'Hora extra registrada correctamente.',
        data: insertResult.rows?.[0] || null
      }
    };
  },

  async compensarHoraExtra(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, COMPENSAR_HORAS_EXTRA_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idHoraExtra = parsePositiveInt(req.params.id_horas_extra);

    if (!idPlanilla || !idHoraExtra) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla e id_horas_extra son requeridos.' })
      };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.body?.tipo_periodo,
      rawQuincena: req.body?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const horasExtraIdColumn = await resolveHorasExtraIdColumn();

    const currentResult = await pool.query(
      `
        SELECT
          he.${horasExtraIdColumn} AS id_horas_extras,
          he.${horasExtraIdColumn} AS id_horas_extra,
          he.id_planilla,
          he.id_empleado,
          COALESCE(he.compensada, FALSE) AS compensada
        FROM public.horas_extras he
        WHERE he.${horasExtraIdColumn} = $1
          AND he.id_planilla = $2
        LIMIT 1
      `,
      [idHoraExtra, idPlanilla]
    );

    const current = currentResult.rows?.[0];
    if (!current) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La hora extra indicada no pertenece a esta planilla.' })
      };
    }

    if (current.compensada) {
      return {
        status: 200,
        body: {
          error: false,
          message: 'La hora extra ya estaba compensada.',
          data: current
        }
      };
    }

    const observacionInput = sanitizeText(req.body?.observacion, 255);
    const observacion =
      periodoContext.tipo_periodo === TIPO_PERIODO.QUINCENAL
        ? appendQuincenaContextTag(observacionInput, periodoContext.quincena)
        : observacionInput;

    const updateResult = await pool.query(
      `
        UPDATE public.horas_extras
        SET
          compensada = TRUE,
          fecha_compensacion = COALESCE(fecha_compensacion, NOW()),
          observacion = COALESCE($1, observacion)
        WHERE ${horasExtraIdColumn} = $2
          AND id_planilla = $3
        RETURNING
          ${horasExtraIdColumn} AS id_horas_extras,
          ${horasExtraIdColumn} AS id_horas_extra,
          id_planilla,
          id_empleado,
          fecha,
          horas,
          compensada,
          fecha_compensacion,
          observacion
      `,
      [observacion, idHoraExtra, idPlanilla]
    );

    const updated = updateResult.rows?.[0] || null;

    let idDetallePlanilla = null;
    let netoActualizado = null;
    if (updated?.id_empleado) {
      const detalleResult = await pool.query(
        `
          SELECT id_detalle_planilla
          FROM public.detalle_planilla
          WHERE id_planilla = $1
            AND id_empleado = $2
          ORDER BY id_detalle_planilla DESC
          LIMIT 1
        `,
        [idPlanilla, updated.id_empleado]
      );

      idDetallePlanilla = parsePositiveInt(detalleResult.rows?.[0]?.id_detalle_planilla);
      if (idDetallePlanilla) {
        await syncDetalleSalarioBaseFromEmpleado({
          idPlanilla,
          idDetallePlanilla
        });
        netoActualizado = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.recalcularDetalle, [idDetallePlanilla]);
      }
    }

    return {
      status: 200,
      body: {
        error: false,
        message: 'Hora extra compensada correctamente.',
        data: {
          ...updated,
          id_detalle_planilla: idDetallePlanilla,
          neto_actualizado: netoActualizado
        }
      }
    };
  },

  async actualizarHoraExtra(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ACTUALIZAR_HORAS_EXTRA_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idHoraExtra = parsePositiveInt(req.params.id_horas_extra);
    const idEmpleadoPayload = parsePositiveInt(req.body?.id_empleado);
    const fecha = normalizeTimestampInput(req.body?.fecha);
    const horasPayload = req.body?.horas;
    const horas = req.body?.horas === undefined ? null : parsePositiveNumber(horasPayload);
    const observacion = sanitizeText(req.body?.observacion, 255);

    if (!idPlanilla || !idHoraExtra) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_planilla e id_horas_extra son requeridos.'
        })
      };
    }

    if (req.body?.id_empleado !== undefined && !idEmpleadoPayload) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_empleado invalido.'
        })
      };
    }

    if (req.body?.fecha !== undefined && !fecha) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha enviada no es valida.'
        })
      };
    }

    if (req.body?.fecha !== undefined && fecha && isFutureDateInput(req.body?.fecha)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha no puede ser mayor al dia actual.'
        })
      };
    }

    if (req.body?.horas !== undefined && !horas) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'horas invalido.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const horasExtraIdColumn = await resolveHorasExtraIdColumn();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentResult = await client.query(
        `
          SELECT
            he.${horasExtraIdColumn} AS id_horas_extras,
            he.${horasExtraIdColumn} AS id_horas_extra,
            he.id_planilla,
            he.id_empleado,
            he.fecha,
            he.horas,
            he.compensada,
            he.fecha_compensacion,
            he.observacion
          FROM public.horas_extras he
          WHERE he.${horasExtraIdColumn} = $1
            AND he.id_planilla = $2
          LIMIT 1
          FOR UPDATE
        `,
        [idHoraExtra, idPlanilla]
      );

      const current = currentResult.rows?.[0];
      if (!current) {
        throw createRequestError('La hora extra indicada no pertenece a esta planilla.', 404, 'NOT_FOUND');
      }

      const idEmpleado = idEmpleadoPayload || parsePositiveInt(current.id_empleado);
      if (!idEmpleado) {
        throw createRequestError('No se pudo resolver el empleado de la hora extra.', 400, 'VALIDATION_ERROR');
      }

      const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
      const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
      if (!detalleValido) {
        throw createRequestError(
          'El empleado no pertenece al detalle de la planilla seleccionada.',
          404,
          'NOT_FOUND'
        );
      }

      const updatedResult = await client.query(
        `
          UPDATE public.horas_extras
          SET
            id_empleado = $1,
            fecha = COALESCE($2::timestamp, fecha),
            horas = COALESCE($3, horas),
            observacion = COALESCE($4, observacion)
          WHERE ${horasExtraIdColumn} = $5
            AND id_planilla = $6
          RETURNING
            ${horasExtraIdColumn} AS id_horas_extras,
            ${horasExtraIdColumn} AS id_horas_extra,
            id_planilla,
            id_empleado,
            fecha,
            horas,
            compensada,
            fecha_compensacion,
            observacion
        `,
        [idEmpleado, fecha, horas, observacion, idHoraExtra, idPlanilla]
      );

      const updated = updatedResult.rows?.[0] || null;
      const affectedEmpleadoIds = Array.from(
        new Set([parsePositiveInt(current.id_empleado), parsePositiveInt(updated?.id_empleado)].filter(Boolean))
      );

      const detalleRecalculado = [];
      for (const affectedIdEmpleado of affectedEmpleadoIds) {
        const detalleResult = await client.query(
          `
            SELECT id_detalle_planilla
            FROM public.detalle_planilla
            WHERE id_planilla = $1
              AND id_empleado = $2
            ORDER BY id_detalle_planilla DESC
            LIMIT 1
          `,
          [idPlanilla, affectedIdEmpleado]
        );
        const idDetallePlanilla = parsePositiveInt(detalleResult.rows?.[0]?.id_detalle_planilla);
        if (!idDetallePlanilla) continue;

        await syncDetalleSalarioBaseFromEmpleado({
          db: client,
          idPlanilla,
          idDetallePlanilla
        });

        const netoActualizado = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.recalcularDetalle, [
          idDetallePlanilla
        ]);

        detalleRecalculado.push({
          id_empleado: affectedIdEmpleado,
          id_detalle_planilla: idDetallePlanilla,
          neto_actualizado: netoActualizado
        });
      }

      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          error: false,
          message: 'Hora extra actualizada correctamente.',
          data: {
            ...updated,
            detalle_recalculado: detalleRecalculado
          }
        }
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Horas extra actualizar rollback error:', rollbackError.message);
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async actualizarEstado(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ESTADO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla invalido.' })
      };
    }

    const hasTipoPeriodoInPayload =
      req.body?.tipo_periodo !== undefined &&
      req.body?.tipo_periodo !== null &&
      String(req.body?.tipo_periodo).trim() !== '';
    const tipoPeriodoPayload = hasTipoPeriodoInPayload
      ? normalizeTipoPeriodoStrict(req.body?.tipo_periodo)
      : null;
    if (hasTipoPeriodoInPayload && !tipoPeriodoPayload) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'tipo_periodo invalido. Use mensual o quincenal.'
        })
      };
    }
    const quincenaPayload = normalizeQuincena(req.body?.quincena);
    if (req.body?.quincena !== undefined && quincenaPayload === null) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'quincena invalida. Use 1 o 2.'
        })
      };
    }
    const isQuincenalContext = tipoPeriodoPayload === TIPO_PERIODO.QUINCENAL;
    if (isQuincenalContext && quincenaPayload === null) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'quincena es requerida cuando tipo_periodo es quincenal.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const estadoInfo = await resolveEstadoPlanillaId(req.body || {});
    if (!estadoInfo) {
      return {
        status: 400,
        body: { error: true, message: 'id_estado_planilla/estado invÃƒÆ’Ã‚Â¡lido o no existe en catÃƒÆ’Ã‚Â¡logo' }
      };
    }

    const requiredPermission = getRequiredEstadoPermission(estadoInfo.descripcion);
    if (requiredPermission) {
      const hasPermission = await requestHasAnyPermission(req, [requiredPermission]);
      if (!hasPermission) {
        return {
          status: 403,
          body: buildErrorBody({
            code: 'FORBIDDEN',
            message: `No tiene permiso ${requiredPermission} para este cambio de estado.`
          })
        };
      }
    }

    let recalcular = true;
    if (req.body?.recalcular !== undefined) {
      const parsedRecalcular = parseStrictBoolean(req.body.recalcular);
      if (parsedRecalcular === null) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'recalcular debe ser true o false.'
          })
        };
      }
      recalcular = parsedRecalcular;
    }
    if (recalcular) {
      await syncDetalleEmpleadosActivosBySucursal({ idPlanilla });
      await syncDetalleSalarioBaseFromEmpleado({ idPlanilla });
    }
    await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.actualizarEstado, [
      idPlanilla,
      estadoInfo.idEstado,
      recalcular
    ]);

    if (isQuincenalContext && quincenaPayload) {
      await registerQuincenaEstadoAudit({
        idPlanilla,
        quincena: quincenaPayload,
        estado: estadoInfo.descripcion,
        idEstadoPlanilla: estadoInfo.idEstado,
        usuarioAccion: sanitizeText(req.body?.usuario_accion, 100) || String(req.user?.id_usuario || 'sistema')
      });
    }

    return {
      status: 200,
      body: {
        error: false,
        message: `Estado de planilla actualizado a ${estadoInfo.descripcion}`
      }
    };
  },

  async anularPlanilla(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ANULAR_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_planilla invalido.' })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const usuarioAccion = sanitizeText(req.body?.usuario_accion, 100) || String(req.user?.id_usuario || 'sistema');
    await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.anularPlanilla, [idPlanilla, usuarioAccion]);

    return {
      status: 200,
      body: { error: false, message: 'Planilla anulada correctamente' }
    };
  },

  async empleadosActivos(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, EMPLEADOS_ACTIVOS_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idSucursal = parsePositiveInt(req.params.id_sucursal);
    if (!idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal invÃƒÆ’Ã‚Â¡lido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rowsRaw = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.empleadosActivos, [idSucursal]);
    const rows = filterPlanillableEmpleadoRows(rowsRaw);
    const search = sanitizeText(req.query.search ?? req.query.q, 120);
    const filtered = rows.filter((row) => {
      if (!search) return true;
      const haystack = [row.nombre_completo, row.dni, row.cargo, row.telefono, row.correo]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async adelantosPendientes(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, ADELANTOS_PENDIENTES_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idSucursal = parsePositiveInt(req.params.id_sucursal);
    if (!idSucursal) {
      return { status: 400, body: { error: true, message: 'id_sucursal invÃƒÆ’Ã‚Â¡lido' } };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    let rows = [];
    try {
      rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.adelantosPendientes, [idSucursal]);
    } catch {
      rows = [];
    }
    const periodo = req.query.periodo ? normalizePeriodo(req.query.periodo) : null;
    if (req.query.periodo && !periodo) {
      return { status: 400, body: { error: true, message: 'periodo invÃƒÆ’Ã‚Â¡lido. Use YYYY-MM o YYYY-MM-DD' } };
    }

    const periodoKey = periodo ? toMonthKey(periodo) : null;
    const search = sanitizeText(req.query.search ?? req.query.q, 120);

    const filtered = rows.filter((row) => {
      if (periodoKey && toMonthKey(row.fecha) !== periodoKey) return false;
      if (!search) return true;
      const haystack = [row.nombre_completo, row.cargo, row.monto, row.saldo, row.fecha]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(search.toLowerCase());
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async adelantosAplicables(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, ADELANTOS_APLICABLES_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invÃƒÆ’Ã‚Â¡lido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    let rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.adelantosAplicables, [idPlanilla]);

    const idDetalle = req.query.id_detalle === undefined ? null : parsePositiveInt(req.query.id_detalle);
    if (req.query.id_detalle !== undefined && !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_detalle invÃƒÆ’Ã‚Â¡lido' } };
    }

    if (idDetalle) {
      const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
      const detalle = detalleRows.find((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
      if (!detalle) {
        return { status: 404, body: { error: true, message: 'Detalle de planilla no encontrado' } };
      }

      const idEmpleado = parsePositiveInt(detalle.id_empleado);
      if (idEmpleado) {
        rows = rows.filter((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
      }
    }

    return {
      status: 200,
      body: { error: false, ...paginateRows(rows, pagination.page, pagination.limit) }
    };
  },

  async aplicarAdelanto(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, APLICAR_ADELANTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idAdelanto = parsePositiveInt(req.body?.id_adelanto ?? req.body?.id_adelanto_salario);
    const montoAplicar = parsePositiveNumber(req.body?.monto_aplicar ?? req.body?.monto);

    if (!idPlanilla || !idAdelanto) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_adelanto son requeridos' } };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.body?.tipo_periodo,
      rawQuincena: req.body?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const adelantoScopeResult = await pool.query(
      `
        SELECT
          a.id_adelanto_salario,
          a.id_empleado,
          a.saldo,
          a.estado
        FROM public.adelantos_salario a
        WHERE a.id_adelanto_salario = $1
        LIMIT 1
      `,
      [idAdelanto]
    );

    if (!adelantoScopeResult.rows?.length) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'NOT_FOUND',
          message: 'El adelanto indicado no existe.'
        })
      };
    }

    const adelantoScope = adelantoScopeResult.rows[0];
    const idEmpleadoAdelanto = parsePositiveInt(adelantoScope.id_empleado);
    const saldoActual = Number(adelantoScope.saldo ?? 0);
    const estadoActivo = adelantoScope.estado === true;

    if (!idEmpleadoAdelanto) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'RELATION_ERROR',
          message: 'El adelanto no tiene empleado asociado.'
        })
      };
    }

    if (!estadoActivo) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'ADELANTO_INACTIVO',
          message: 'El adelanto esta inactivo o ya fue liquidado.'
        })
      };
    }

    if (!Number.isFinite(saldoActual) || saldoActual <= 0) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'ADELANTO_SIN_SALDO',
          message: 'El adelanto no tiene saldo disponible.'
        })
      };
    }

    const montoAplicarEfectivo = Number.isFinite(montoAplicar) && montoAplicar > 0 ? montoAplicar : saldoActual;
    if (!Number.isFinite(montoAplicarEfectivo) || montoAplicarEfectivo <= 0) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'El monto a aplicar debe ser mayor que 0.'
        })
      };
    }

    if (montoAplicarEfectivo > saldoActual) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'ADELANTO_MONTO_INVALIDO',
          message: 'El monto a aplicar no puede superar el saldo disponible del adelanto.'
        })
      };
    }

    const detalleScopeResult = await pool.query(
      `
        SELECT dp.id_detalle_planilla
        FROM public.detalle_planilla dp
        WHERE dp.id_planilla = $1
          AND dp.id_empleado = $2
        LIMIT 1
      `,
      [idPlanilla, idEmpleadoAdelanto]
    );

    if (!detalleScopeResult.rows?.length) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'PLANILLA_SCOPE_MISMATCH',
          message: 'El empleado asociado al adelanto no pertenece a la planilla seleccionada.'
        })
      };
    }

    const idDetallePlanilla = parsePositiveInt(detalleScopeResult.rows[0].id_detalle_planilla);
    if (!idDetallePlanilla) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'RELATION_ERROR',
          message: 'No se pudo identificar el detalle de planilla del empleado para validar el adelanto.'
        })
      };
    }
    const netoDisponible = await resolveNetoDisponibleDetalle({
      db: pool,
      idDetallePlanilla,
      idPlanilla,
      idEmpleado: idEmpleadoAdelanto
    });
    try {
      assertAdelantoDentroNetoDisponible(montoAplicarEfectivo, netoDisponible);
    } catch (error) {
      if (error?.httpStatus) {
        return {
          status: error.httpStatus,
          body: buildErrorBody({
            code: error.code || 'ADELANTO_NETO_INSUFICIENTE',
            message: error.message
          })
        };
      }
      throw error;
    }

    let data = null;
    try {
      const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.aplicarAdelanto, [
        idAdelanto,
        idPlanilla,
        montoAplicarEfectivo
      ]);
      data = rows[0] || null;
    } catch (err) {
      // Fallback seguro mientras se alinea la funcion SQL en BD (caso comun: 42702 ambigua)
      if (err?.code === '42702' || err?.code === '42883') {
        data = await applyAdelantoFallback({
          idAdelanto,
          idPlanilla,
          montoAplicar: montoAplicarEfectivo
        });
      } else {
        throw err;
      }
    }

    if (periodoContext.tipo_periodo === TIPO_PERIODO.QUINCENAL && periodoContext.quincena) {
      await registerQuincenaAdelantoAudit({
        idPlanilla,
        idAdelantoSalario: idAdelanto,
        quincena: periodoContext.quincena,
        usuarioAccion: String(req.user?.id_usuario || 'sistema')
      });
    }

    return {
      status: 200,
      body: {
        error: false,
        message: 'Adelanto aplicado correctamente',
        data
      }
    };
  },

  async registrarAdelanto(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, REGISTRAR_ADELANTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idEmpleado = parsePositiveInt(req.body?.id_empleado);
    const monto = parsePositiveNumber(req.body?.monto);
    const fecha = normalizeTimestampInput(req.body?.fecha);

    if (!idPlanilla || !idEmpleado || !monto) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_planilla, id_empleado y monto son requeridos.'
        })
      };
    }

    if (req.body?.fecha !== undefined && !fecha) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha enviada no es valida.'
        })
      };
    }

    if (req.body?.fecha !== undefined && fecha && isFutureDateInput(req.body?.fecha)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha no puede ser mayor al dia actual.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
    if (!detalleValido) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'NOT_FOUND',
          message: 'El empleado no pertenece al detalle de la planilla seleccionada.'
        })
      };
    }

    const detalleEmpleado = (detalleRows || []).find((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
    const idDetallePlanilla = parsePositiveInt(detalleEmpleado?.id_detalle_planilla);
    if (!idDetallePlanilla) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'RELATION_ERROR',
          message: 'No se pudo identificar el detalle de planilla del empleado para validar el adelanto.'
        })
      };
    }
    const netoDisponible = await resolveNetoDisponibleDetalle({
      db: pool,
      idDetallePlanilla,
      idPlanilla,
      idEmpleado
    });
    try {
      assertAdelantoDentroNetoDisponible(monto, netoDisponible);
    } catch (error) {
      if (error?.httpStatus) {
        return {
          status: error.httpStatus,
          body: buildErrorBody({
            code: error.code || 'ADELANTO_NETO_INSUFICIENTE',
            message: error.message
          })
        };
      }
      throw error;
    }

    const insertResult = await pool.query(
      `
        INSERT INTO public.adelantos_salario (
          id_empleado,
          fecha,
          monto,
          saldo,
          estado
        )
        VALUES (
          $1,
          COALESCE($2::timestamp, NOW()),
          $3,
          $3,
          TRUE
        )
        RETURNING
          id_adelanto_salario,
          id_empleado,
          fecha,
          monto,
          saldo,
          estado
      `,
      [idEmpleado, fecha, monto]
    );

    return {
      status: 201,
      body: {
        error: false,
        message: 'Adelanto registrado correctamente.',
        data: insertResult.rows?.[0] || null
      }
    };
  },

  async actualizarAdelanto(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ACTUALIZAR_ADELANTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idAdelanto = parsePositiveInt(req.params.id_adelanto);
    const idEmpleadoPayload = parsePositiveInt(req.body?.id_empleado);
    const monto = parsePositiveNumber(req.body?.monto);
    const fecha = normalizeTimestampInput(req.body?.fecha);

    if (!idPlanilla || !idAdelanto || !monto) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_planilla, id_adelanto y monto son requeridos.'
        })
      };
    }

    if (req.body?.fecha !== undefined && !fecha) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha enviada no es valida.'
        })
      };
    }

    if (req.body?.fecha !== undefined && fecha && isFutureDateInput(req.body?.fecha)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La fecha no puede ser mayor al dia actual.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleEmpleadoIds = new Set(
      (detalleRows || [])
        .map((row) => parsePositiveInt(row.id_empleado))
        .filter((value) => value > 0)
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adelantoResult = await client.query(
        `
          SELECT
            a.id_adelanto_salario,
            a.id_empleado,
            a.fecha,
            a.monto,
            a.saldo,
            a.estado,
            e.id_sucursal
          FROM public.adelantos_salario a
          INNER JOIN public.empleados e
            ON e.id_empleado = a.id_empleado
          WHERE a.id_adelanto_salario = $1
          FOR UPDATE
        `,
        [idAdelanto]
      );

      if (!adelantoResult.rows?.length) {
        throw createRequestError('El adelanto indicado no existe.', 404, 'NOT_FOUND');
      }

      const adelanto = adelantoResult.rows[0];
      const idEmpleado = parsePositiveInt(adelanto.id_empleado);
      const saldoActual = Number(adelanto.saldo ?? 0);
      const estadoActual = adelanto.estado === true;
      const idSucursalAdelanto = parsePositiveInt(adelanto.id_sucursal);

      if (!idEmpleado) {
        throw createRequestError('El adelanto no tiene empleado asociado.', 409, 'RELATION_ERROR');
      }

      if (idEmpleadoPayload && idEmpleadoPayload !== idEmpleado) {
        throw createRequestError(
          'No se puede cambiar el empleado de un adelanto ya registrado.',
          409,
          'ADELANTO_EMPLEADO_INMUTABLE'
        );
      }

      if (!detalleEmpleadoIds.has(idEmpleado)) {
        throw createRequestError(
          'El empleado del adelanto no pertenece al detalle de la planilla seleccionada.',
          409,
          'PLANILLA_SCOPE_MISMATCH'
        );
      }

      const detalleEmpleado = (detalleRows || []).find((row) => parsePositiveInt(row.id_empleado) === idEmpleado);
      const idDetallePlanilla = parsePositiveInt(detalleEmpleado?.id_detalle_planilla);
      if (!idDetallePlanilla) {
        throw createRequestError(
          'No se pudo identificar el detalle de planilla del empleado para validar el adelanto.',
          409,
          'RELATION_ERROR'
        );
      }
      const netoDisponible = await resolveNetoDisponibleDetalle({
        db: client,
        idDetallePlanilla,
        idPlanilla,
        idEmpleado
      });
      assertAdelantoDentroNetoDisponible(monto, netoDisponible);

      if (scopeValidation.idSucursal && idSucursalAdelanto && scopeValidation.idSucursal !== idSucursalAdelanto) {
        throw createRequestError(
          'El adelanto no pertenece a la sucursal activa.',
          409,
          'SUCURSAL_SCOPE_MISMATCH'
        );
      }

      if (!estadoActual || !Number.isFinite(saldoActual) || saldoActual <= 0) {
        throw createRequestError(
          'Solo se pueden editar adelantos pendientes con saldo disponible.',
          409,
          'ADELANTO_NO_EDITABLE'
        );
      }

      const aplicacionesResult = await client.query(
        `
          SELECT
            COALESCE(SUM(aa.monto_aplicado), 0) AS total_aplicado
          FROM public.adelanto_aplicacion aa
          WHERE aa.id_adelanto_salario = $1
        `,
        [idAdelanto]
      );

      const totalAplicado = Number(aplicacionesResult.rows?.[0]?.total_aplicado ?? 0);
      if (Number.isFinite(totalAplicado) && totalAplicado > monto) {
        throw createRequestError(
          `El monto no puede ser menor a lo ya aplicado (${totalAplicado.toFixed(2)}).`,
          409,
          'ADELANTO_MONTO_INVALIDO'
        );
      }

      const nuevoSaldo = Math.max(0, monto - (Number.isFinite(totalAplicado) ? totalAplicado : 0));
      const nuevoEstado = nuevoSaldo > 0;

      const updateResult = await client.query(
        `
          UPDATE public.adelantos_salario
          SET
            monto = $2,
            saldo = $3,
            estado = $4,
            fecha = COALESCE($5::timestamp, fecha)
          WHERE id_adelanto_salario = $1
          RETURNING
            id_adelanto_salario,
            id_empleado,
            fecha,
            monto,
            saldo,
            estado
        `,
        [idAdelanto, monto, nuevoSaldo, nuevoEstado, fecha]
      );

      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          error: false,
          message: 'Adelanto pendiente actualizado correctamente.',
          data: updateResult.rows?.[0] || null
        }
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async anularAdelanto(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ANULAR_ADELANTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idAdelanto = parsePositiveInt(req.params.id_adelanto);
    if (!idPlanilla || !idAdelanto) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_planilla e id_adelanto son requeridos.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleEmpleadoIds = new Set(
      (detalleRows || [])
        .map((row) => parsePositiveInt(row.id_empleado))
        .filter((value) => value > 0)
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const adelantoResult = await client.query(
        `
          SELECT
            a.id_adelanto_salario,
            a.id_empleado,
            a.fecha,
            a.monto,
            a.saldo,
            a.estado,
            e.id_sucursal
          FROM public.adelantos_salario a
          INNER JOIN public.empleados e
            ON e.id_empleado = a.id_empleado
          WHERE a.id_adelanto_salario = $1
          FOR UPDATE
        `,
        [idAdelanto]
      );

      if (!adelantoResult.rows?.length) {
        throw createRequestError('El adelanto indicado no existe.', 404, 'NOT_FOUND');
      }

      const adelanto = adelantoResult.rows[0];
      const idEmpleado = parsePositiveInt(adelanto.id_empleado);
      const saldoActual = Number(adelanto.saldo ?? 0);
      const estadoActual = adelanto.estado === true;
      const idSucursalAdelanto = parsePositiveInt(adelanto.id_sucursal);

      if (!idEmpleado) {
        throw createRequestError('El adelanto no tiene empleado asociado.', 409, 'RELATION_ERROR');
      }

      if (!detalleEmpleadoIds.has(idEmpleado)) {
        throw createRequestError(
          'El empleado del adelanto no pertenece al detalle de la planilla seleccionada.',
          409,
          'PLANILLA_SCOPE_MISMATCH'
        );
      }

      if (scopeValidation.idSucursal && idSucursalAdelanto && scopeValidation.idSucursal !== idSucursalAdelanto) {
        throw createRequestError(
          'El adelanto no pertenece a la sucursal activa.',
          409,
          'SUCURSAL_SCOPE_MISMATCH'
        );
      }

      if (!estadoActual || !Number.isFinite(saldoActual) || saldoActual <= 0) {
        throw createRequestError(
          'Solo se pueden eliminar adelantos pendientes con saldo disponible.',
          409,
          'ADELANTO_NO_ELIMINABLE'
        );
      }

      const aplicacionesResult = await client.query(
        `
          SELECT
            COUNT(*)::int AS total_aplicaciones,
            COALESCE(SUM(aa.monto_aplicado), 0) AS total_aplicado
          FROM public.adelanto_aplicacion aa
          WHERE aa.id_adelanto_salario = $1
        `,
        [idAdelanto]
      );

      const totalAplicaciones = Number(aplicacionesResult.rows?.[0]?.total_aplicaciones ?? 0);
      const totalAplicado = Number(aplicacionesResult.rows?.[0]?.total_aplicado ?? 0);
      if ((Number.isFinite(totalAplicaciones) && totalAplicaciones > 0) || (Number.isFinite(totalAplicado) && totalAplicado > 0)) {
        throw createRequestError(
          'No se puede eliminar el adelanto porque ya tiene aplicaciones registradas.',
          409,
          'ADELANTO_CON_APLICACIONES'
        );
      }

      const updateResult = await client.query(
        `
          UPDATE public.adelantos_salario
          SET
            saldo = 0,
            estado = FALSE
          WHERE id_adelanto_salario = $1
          RETURNING
            id_adelanto_salario,
            id_empleado,
            fecha,
            monto,
            saldo,
            estado
        `,
        [idAdelanto]
      );

      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          error: false,
          message: 'Adelanto eliminado correctamente.',
          data: updateResult.rows?.[0] || null
        }
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async registrarMovimiento(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, MOVIMIENTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.body?.id_detalle ?? req.body?.id_detalle_planilla);
    const tipo = sanitizeText(req.body?.tipo ?? req.body?.tipo_movimiento, 20);
    const concepto = sanitizeText(req.body?.concepto, 100);
    const monto = parsePositiveNumber(req.body?.monto);
    const observacionInput = sanitizeText(req.body?.observacion, 255);

    if (!idPlanilla || !idDetalle || !tipo || !concepto || !monto) {
      return {
        status: 400,
        body: { error: true, message: 'id_planilla, id_detalle, tipo, concepto y monto son requeridos' }
      };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.body?.tipo_periodo,
      rawQuincena: req.body?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }
    const observacion =
      periodoContext.tipo_periodo === TIPO_PERIODO.QUINCENAL
        ? appendQuincenaContextTag(observacionInput, periodoContext.quincena)
        : observacionInput;

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
    if (!detalleValido) {
      return {
        status: 404,
        body: { error: true, message: 'El detalle indicado no pertenece a la planilla seleccionada' }
      };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.registrarMovimiento, [
      idDetalle,
      tipo.toUpperCase(),
      concepto,
      monto,
      observacion
    ]);

    return {
      status: 201,
      body: {
        error: false,
        message: 'Movimiento registrado correctamente',
        data: rows[0] || null
      }
    };
  },

  async listarMovimientos(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, MOVIMIENTOS_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invalido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.query?.tipo_periodo,
      rawQuincena: req.query?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const idDetalle = req.query.id_detalle === undefined ? null : parsePositiveInt(req.query.id_detalle);
    if (req.query.id_detalle !== undefined && !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_detalle invalido' } };
    }

    const rows = await buildMovimientosDataset({
      idPlanilla,
      idDetalle,
      tipoPeriodo: periodoContext.tipo_periodo,
      quincena: periodoContext.quincena
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(rows, pagination.page, pagination.limit) }
    };
  },

  async listarMovimientosDetalle(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, MOVIMIENTOS_DETALLE_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.params.id_detalle);

    if (!idPlanilla || !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_detalle son requeridos' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }
    const periodoContext = resolvePeriodoContextInput({
      rawTipoPeriodo: req.query?.tipo_periodo,
      rawQuincena: req.query?.quincena
    });
    if (periodoContext.error) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: periodoContext.error
        })
      };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const rows = await buildMovimientosDataset({
      idPlanilla,
      idDetalle,
      tipoPeriodo: periodoContext.tipo_periodo,
      quincena: periodoContext.quincena
    });
    const filtered = rows.filter((row) => parsePositiveInt(row.id_planilla) === idPlanilla);

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async anularMovimiento(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, ANULAR_MOVIMIENTO_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idMovimiento = parsePositiveInt(req.params.id_movimiento);
    const idPlanilla = parsePositiveInt(req.body?.id_planilla);
    if (!idMovimiento || !idPlanilla) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_movimiento e id_planilla son requeridos.'
        })
      };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const movimientoScope = await resolveMovimientoScope(idMovimiento);
    if (!movimientoScope?.id_movimiento_planilla) {
      return {
        status: 404,
        body: buildErrorBody({
          code: 'NOT_FOUND',
          message: 'El movimiento indicado no existe.'
        })
      };
    }

    if (movimientoScope.id_planilla !== idPlanilla) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'PLANILLA_SCOPE_MISMATCH',
          message: 'El movimiento no pertenece a la planilla seleccionada.'
        })
      };
    }

    if (scopeValidation.idSucursal && movimientoScope.id_sucursal !== scopeValidation.idSucursal) {
      return {
        status: 409,
        body: buildErrorBody({
          code: 'SUCURSAL_SCOPE_MISMATCH',
          message: 'El movimiento no pertenece a la sucursal activa.'
        })
      };
    }

    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.anularMovimiento, [idMovimiento]);

    return {
      status: 200,
      body: {
        error: false,
        message: 'Movimiento anulado correctamente',
        data: rows[0] || null
      }
    };
  },

  async auditoria(req) {
    const invalidQuery = validateAllowedQueryFields(req.query, AUDITORIA_QUERY_ALLOWED_FIELDS);
    if (invalidQuery) return invalidQuery;

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    if (!idPlanilla) {
      return { status: 400, body: { error: true, message: 'id_planilla invalido' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.query?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const pagination = parsePagination(req.query || {});
    if (!pagination) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const entidad = sanitizeText(req.query.entidad, 50);
    const rows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.auditoria, [entidad]);

    const planillaNeedle = `planilla ${idPlanilla}`;
    const planillaNeedleAlt = `planilla: ${idPlanilla}`;

    const filtered = rows.filter((row) => {
      if (parsePositiveInt(row.id_referencia) === idPlanilla) return true;
      const desc = String(row.descripcion || '').toLowerCase();
      return desc.includes(planillaNeedle) || desc.includes(planillaNeedleAlt);
    });

    return {
      status: 200,
      body: { error: false, ...paginateRows(filtered, pagination.page, pagination.limit) }
    };
  },

  async recalcularDetalle(req) {
    const unknownFields = unknownFieldsFromPayload(req.body, RECALCULAR_DETALLE_ALLOWED_FIELDS);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const idPlanilla = parsePositiveInt(req.params.id_planilla);
    const idDetalle = parsePositiveInt(req.params.id_detalle);

    if (!idPlanilla || !idDetalle) {
      return { status: 400, body: { error: true, message: 'id_planilla e id_detalle son requeridos' } };
    }

    const scopeValidation = await validatePlanillaSucursalScope(idPlanilla, req.body?.id_sucursal);
    if (!scopeValidation.ok) {
      return { status: scopeValidation.status, body: scopeValidation.body };
    }

    const detalleRows = await queryFunctionRows(PLANILLA_ENDPOINT_CONTRACT.detalle, [idPlanilla]);
    const detalleValido = detalleRows.some((row) => parsePositiveInt(row.id_detalle_planilla) === idDetalle);
    if (!detalleValido) {
      return {
        status: 404,
        body: { error: true, message: 'El detalle indicado no pertenece a la planilla seleccionada' }
      };
    }

    await syncDetalleSalarioBaseFromEmpleado({
      idPlanilla,
      idDetallePlanilla: idDetalle
    });
    const netoActualizado = await queryFunctionScalar(PLANILLA_ENDPOINT_CONTRACT.recalcularDetalle, [idDetalle]);

    return {
      status: 200,
      body: {
        error: false,
        message: 'Detalle recalculado correctamente',
        data: { id_planilla: idPlanilla, id_detalle_planilla: idDetalle, neto_actualizado: netoActualizado }
      }
    };
  }
};

router.get('/planillas', checkPermission(PLANILLAS_VIEW_PERMISSIONS), asyncHandler(planillaService.list));
router.post('/planillas/generar', checkPermission(PLANILLAS_GENERATE_PERMISSIONS), asyncHandler(planillaService.generar));
router.post('/planillas/:id_planilla/recalcular', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.recalcularPlanilla));
router.get('/planillas/:id_planilla/detalle', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.detalle));
router.get('/planillas/:id_planilla/resumen', checkPermission([...PLANILLAS_DETAIL_PERMISSIONS, ...PLANILLAS_SUMMARY_COSTS_PERMISSIONS]), asyncHandler(planillaService.resumen));
router.get('/planillas/:id_planilla/completa', checkPermission([...PLANILLAS_DETAIL_PERMISSIONS, ...PLANILLAS_SUMMARY_COSTS_PERMISSIONS]), asyncHandler(planillaService.completa));
router.get('/planillas/:id_planilla/horas-extra', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.listarHorasExtra));
router.post('/planillas/:id_planilla/horas-extra/registrar', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.registrarHoraExtra));
router.post('/planillas/:id_planilla/horas-extra/:id_horas_extra/compensar', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.compensarHoraExtra));
router.post('/planillas/:id_planilla/horas-extra/:id_horas_extra/actualizar', checkPermission(PLANILLAS_MOVIMIENTO_EDIT_PERMISSIONS), asyncHandler(planillaService.actualizarHoraExtra));
router.put('/planillas/:id_planilla/estado', checkPermission(PLANILLAS_ESTADO_PERMISSIONS), asyncHandler(planillaService.actualizarEstado));
router.post('/planillas/:id_planilla/anular', checkPermission(['PLANILLAS_ANULAR']), asyncHandler(planillaService.anularPlanilla));
router.get('/planillas/sucursales/:id_sucursal/empleados-activos', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.empleadosActivos));
router.get('/planillas/sucursales/:id_sucursal/adelantos-pendientes', checkPermission(PLANILLAS_ADELANTOS_APLICAR_PERMISSIONS), asyncHandler(planillaService.adelantosPendientes));
router.get('/planillas/:id_planilla/adelantos-aplicables', checkPermission(PLANILLAS_ADELANTOS_APLICAR_PERMISSIONS), asyncHandler(planillaService.adelantosAplicables));
router.post('/planillas/:id_planilla/adelantos/registrar', checkPermission(PLANILLAS_ADELANTOS_REGISTRAR_PERMISSIONS), asyncHandler(planillaService.registrarAdelanto));
router.post('/planillas/:id_planilla/adelantos/aplicar', checkPermission(PLANILLAS_ADELANTOS_APLICAR_PERMISSIONS), asyncHandler(planillaService.aplicarAdelanto));
router.post('/planillas/:id_planilla/adelantos/:id_adelanto/actualizar', checkPermission(PLANILLAS_ADELANTOS_REGISTRAR_PERMISSIONS), asyncHandler(planillaService.actualizarAdelanto));
router.post('/planillas/:id_planilla/adelantos/:id_adelanto/anular', checkPermission(PLANILLAS_ADELANTOS_ANULAR_PERMISSIONS), asyncHandler(planillaService.anularAdelanto));
router.post('/planillas/:id_planilla/movimientos', checkPermission(PLANILLAS_MOVIMIENTO_REGISTER_PERMISSIONS), asyncHandler(planillaService.registrarMovimiento));
router.get('/planillas/:id_planilla/movimientos', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.listarMovimientos));
router.get('/planillas/:id_planilla/movimientos/:id_detalle', checkPermission(PLANILLAS_DETAIL_PERMISSIONS), asyncHandler(planillaService.listarMovimientosDetalle));
router.post('/planillas/movimientos/:id_movimiento/anular', checkPermission(PLANILLAS_MOVIMIENTO_ANULAR_PERMISSIONS), asyncHandler(planillaService.anularMovimiento));
router.get('/planillas/:id_planilla/auditoria', checkPermission(PLANILLAS_AUDITORIA_PERMISSIONS), asyncHandler(planillaService.auditoria));
router.post('/planillas/:id_planilla/detalle/:id_detalle/recalcular', checkPermission(PLANILLAS_RECALCULAR_PERMISSIONS), asyncHandler(planillaService.recalcularDetalle));
router.get('/planillas/:id_planilla/export', checkPermission(PLANILLAS_EXPORT_PERMISSIONS), asyncHandler(planillaService.completa));

export default router;

