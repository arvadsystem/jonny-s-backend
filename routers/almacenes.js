import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();

const TABLA_ALMACENES = 'almacenes';
const ALMACENES_VIEW_PERMISSIONS = ['INVENTARIO_ALMACENES_VER', 'INVENTARIO_ALMACENES_DETALLE_VER'];
const ALMACENES_CREATE_PERMISSIONS = ['INVENTARIO_ALMACENES_CREAR'];
const ALMACENES_EDIT_PERMISSIONS = ['INVENTARIO_ALMACENES_EDITAR'];
const ALMACENES_STATE_PERMISSIONS = ['INVENTARIO_ALMACENES_ESTADO_CAMBIAR'];
const ALMACENES_DELETE_COMPAT_PERMISSIONS = [
  'INVENTARIO_ALMACENES_ESTADO_CAMBIAR',
  'INVENTARIO_ALMACENES_ELIMINAR'
];
const EDITABLE_FIELDS = new Set(['nombre', 'id_sucursal']);
const CREATE_ALLOWED_FIELDS = new Set(['nombre', 'id_sucursal']);
const ALMACEN_INACTIVATION_RECENT_MOVEMENTS_DAYS = 30;
const ALMACEN_INACTIVATION_BLOCK_MESSAGES = Object.freeze({
  STOCK_DISPONIBLE:
    'No se puede inactivar el almacén porque tiene stock disponible.',
  MOVIMIENTOS_RECIENTES:
    `No se puede inactivar el almacén porque registra movimientos en los últimos ${ALMACEN_INACTIVATION_RECENT_MOVEMENTS_DAYS} días.`,
  DEPENDENCIAS_ACTIVAS:
    'No se puede inactivar el almacén porque mantiene dependencias operativas activas de productos o insumos.',
  ORDENES_COMPRA_ABIERTAS:
    'No se puede inactivar el almacén porque tiene órdenes de compra en curso asociadas.'
});
const DELETE_OPERATION_BLOCKED_MESSAGE =
  'Los almacenes no se eliminan; se inactivan para preservar la trazabilidad del inventario.';
const ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE =
  'No se puede cambiar la sucursal de este almacen porque ya tiene historial operativo. Para preservar la trazabilidad, crea un nuevo almacen en la sucursal correcta.';
const ALMACEN_SUCURSAL_CHANGE_BLOCK_MESSAGES = Object.freeze({
  MOVIMIENTOS_REGISTRADOS:
    'No se puede cambiar la sucursal de este almacen porque ya registra movimientos de inventario.',
  STOCK_DISPONIBLE:
    'No se puede cambiar la sucursal de este almacen porque tiene stock disponible.',
  DEPENDENCIAS_OPERATIVAS:
    'No se puede cambiar la sucursal de este almacen porque mantiene productos o insumos vinculados.',
  ORDENES_COMPRA_ABIERTAS:
    'No se puede cambiar la sucursal de este almacen porque tiene ordenes de compra en curso asociadas.'
});
const ALMACEN_CONCURRENCY_CONFLICT_MESSAGE =
  'El almacen fue modificado por otro usuario. Recarga la informacion antes de guardar.';
const ALMACENES_SCOPE_FORBIDDEN_MESSAGE =
  'No tiene permisos para operar sobre recursos fuera de su sucursal.';
const ALMACENES_SCOPE_MISSING_BRANCHES_MESSAGE = 'El empleado no tiene sucursales asignadas.';
const ALMACENES_NOT_FOUND_MESSAGE = 'Almacen no encontrado.';

const hasValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({
    ok: false,
    error: true,
    code,
    message,
    ...extra
  });

const sendValidationError = (res, message, details) =>
  sendError(res, 400, 'VALIDATION_ERROR', message, details ? { details } : {});

const sendConflictError = (res, message, extra = {}) =>
  sendError(res, 409, 'CONFLICT', message, extra);

const sendConcurrencyConflictError = (res, message, extra = {}) =>
  sendConflictError(res, message, {
    conflict_type: 'CONCURRENCY',
    ...extra
  });

const SHOULD_INCLUDE_ERROR_STACK = ['development', 'dev', 'local'].includes(
  String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase()
);

const truncateLogValue = (value, maxLength = 280) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
};

const looksSensitiveErrorMessage = (message) =>
  /\b(select|insert|update|delete|from|where|join)\b/i.test(String(message || '')) ||
  /public\./i.test(String(message || ''));

const sanitizeErrorForLog = (error) => {
  const rawMessage = truncateLogValue(error?.message || 'Unexpected error');
  const safeMessage = looksSensitiveErrorMessage(rawMessage)
    ? 'Database error details hidden.'
    : rawMessage;

  const safeError = {
    name: truncateLogValue(error?.name || 'Error', 120) || 'Error',
    code: truncateLogValue(error?.code || '', 80) || null,
    message: safeMessage
  };

  if (SHOULD_INCLUDE_ERROR_STACK && typeof error?.stack === 'string') {
    safeError.stack = truncateLogValue(
      error.stack
        .split('\n')
        .slice(0, 6)
        .join('\n'),
      1200
    );
  }

  return safeError;
};

const logRouterError = (context, error, { category = 'INTERNAL_ERROR' } = {}) => {
  const safeContext = truncateLogValue(context || 'Unhandled context', 160) || 'Unhandled context';
  const safeError = sanitizeErrorForLog(error);
  console.error('[almacenes] error', {
    category,
    context: safeContext,
    ...safeError
  });
};

const sendInternalError = (
  res,
  context,
  error,
  publicMessage = 'Error interno al procesar almacenes.'
) => {
  logRouterError(context, error, { category: 'INTERNAL_ERROR' });
  return sendError(res, 500, 'INTERNAL_ERROR', publicMessage);
};

const parsePositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: `${fieldName} es obligatorio.` };
  }

  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return { ok: false, error: `${fieldName} debe ser un entero mayor a 0.` };
  }

  return { ok: true, value: normalizedValue };
};

const parseConcurrencyToken = (rawValue, fieldName = 'concurrency_token') => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: `${fieldName} es obligatorio para guardar cambios.` };
  }

  const normalizedValue = String(rawValue).trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return { ok: false, error: `${fieldName} invalido.` };
  }

  return { ok: true, value: normalizedValue };
};

const parseOptionalPositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null, error: null };
  }

  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return {
      provided: true,
      value: null,
      error: `${fieldName} debe ser un entero mayor a 0.`
    };
  }

  return { provided: true, value: normalizedValue, error: null };
};

const normalizeScopeSucursalIds = (rawIds) =>
  Array.from(
    new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

const getRequestAlmacenesScope = async (req, db = pool) => {
  if (req?.__almacenesScope) return req.__almacenesScope;

  const resolvedScope = await resolveRequestUserSucursalScope(req, db);
  const scope = {
    isSuperAdmin: Boolean(resolvedScope?.isSuperAdmin),
    allowedSucursalIds: normalizeScopeSucursalIds(resolvedScope?.allowedSucursalIds)
  };

  if (req) req.__almacenesScope = scope;
  return scope;
};

const ensureSucursalScopeAvailable = (res, scope) => {
  if (scope?.isSuperAdmin) return true;
  if (Array.isArray(scope?.allowedSucursalIds) && scope.allowedSucursalIds.length > 0) return true;

  sendError(res, 403, 'FORBIDDEN', ALMACENES_SCOPE_MISSING_BRANCHES_MESSAGE);
  return false;
};

const ensureSucursalInScope = (res, scope, idSucursal) => {
  if (scope?.isSuperAdmin) return true;
  if (!Array.isArray(scope?.allowedSucursalIds) || scope.allowedSucursalIds.length === 0) {
    sendError(res, 403, 'FORBIDDEN', ALMACENES_SCOPE_MISSING_BRANCHES_MESSAGE);
    return false;
  }

  if (!scope.allowedSucursalIds.includes(Number(idSucursal))) {
    sendError(res, 403, 'FORBIDDEN', ALMACENES_SCOPE_FORBIDDEN_MESSAGE);
    return false;
  }

  return true;
};

const assertAlmacenInScope = async (
  req,
  res,
  idAlmacen,
  { db = pool, notFoundMessage = ALMACENES_NOT_FOUND_MESSAGE } = {}
) => {
  const rowResult = await db.query(
    `
      SELECT id_almacen, id_sucursal
      FROM public.almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [idAlmacen]
  );

  const row = rowResult.rows?.[0] || null;
  if (!row) {
    sendError(res, 404, 'NOT_FOUND', notFoundMessage);
    return { ok: false, row: null, scope: null };
  }

  const scope = await getRequestAlmacenesScope(req, db);
  if (scope.isSuperAdmin) {
    return { ok: true, row, scope };
  }

  if (!Array.isArray(scope.allowedSucursalIds) || scope.allowedSucursalIds.length === 0) {
    sendError(res, 403, 'FORBIDDEN', ALMACENES_SCOPE_MISSING_BRANCHES_MESSAGE);
    return { ok: false, row: null, scope };
  }

  const idSucursal = Number.parseInt(String(row?.id_sucursal ?? '').trim(), 10);
  if (!Number.isInteger(idSucursal) || !scope.allowedSucursalIds.includes(idSucursal)) {
    // AM: responde 404 para no exponer existencia de almacenes fuera de alcance.
    sendError(res, 404, 'NOT_FOUND', notFoundMessage);
    return { ok: false, row: null, scope };
  }

  return { ok: true, row, scope };
};

const resolveConcurrencyTokenFromPayload = (payload) =>
  payload?.concurrency_token ??
  payload?.row_version ??
  payload?.version ??
  payload?.xmin ??
  null;

const parseNombre = (rawValue, fieldName = 'nombre') => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: `${fieldName} es obligatorio.` };
  }

  const normalizedValue = String(rawValue).trim();
  if (normalizedValue.length < 2) {
    return { ok: false, error: `${fieldName} debe tener al menos 2 caracteres.` };
  }

  if (normalizedValue.length > 80) {
    return { ok: false, error: `${fieldName} no puede superar 80 caracteres.` };
  }

  return { ok: true, value: normalizedValue };
};

const parseIncludeInactivos = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: true, value: false };

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return { ok: true, value: true };
  if (normalized === '0' || normalized === 'false') return { ok: true, value: false };

  return {
    ok: false,
    error: "include_inactivos invalido. Use '1', '0', 'true' o 'false'."
  };
};

const isMissingSchemaEntityError = (error) =>
  ['42P01', '42703', '42883'].includes(String(error?.code || '').trim());

const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
};

const buildAlmacenInactivationDecision = ({
  stockTotal = 0,
  movimientosRecientes = 0,
  productosActivos = 0,
  insumosActivos = 0,
  ordenesCompraAbiertas = 0,
  recentMovementsAvailable = true,
  openOrdersAvailable = true
}) => {
  const reasonCodes = [];
  const reasons = [];

  if (stockTotal > 0) {
    reasonCodes.push('STOCK_DISPONIBLE');
    reasons.push(ALMACEN_INACTIVATION_BLOCK_MESSAGES.STOCK_DISPONIBLE);
  }

  if (recentMovementsAvailable && movimientosRecientes > 0) {
    reasonCodes.push('MOVIMIENTOS_RECIENTES');
    reasons.push(ALMACEN_INACTIVATION_BLOCK_MESSAGES.MOVIMIENTOS_RECIENTES);
  }

  if (productosActivos > 0 || insumosActivos > 0) {
    reasonCodes.push('DEPENDENCIAS_ACTIVAS');
    reasons.push(ALMACEN_INACTIVATION_BLOCK_MESSAGES.DEPENDENCIAS_ACTIVAS);
  }

  if (openOrdersAvailable && ordenesCompraAbiertas > 0) {
    reasonCodes.push('ORDENES_COMPRA_ABIERTAS');
    reasons.push(ALMACEN_INACTIVATION_BLOCK_MESSAGES.ORDENES_COMPRA_ABIERTAS);
  }

  const canInactivate = reasons.length === 0;
  const hasStock = stockTotal > 0;
  const hasActiveOperationalDependencies =
    (recentMovementsAvailable && movimientosRecientes > 0) ||
    productosActivos > 0 ||
    insumosActivos > 0 ||
    (openOrdersAvailable && ordenesCompraAbiertas > 0);

  return {
    canInactivate,
    canDeactivate: canInactivate,
    hasStock,
    hasActiveOperationalDependencies,
    blockingReasonCodes: reasonCodes,
    blockingReasons: reasons
  };
};

const buildAlmacenSucursalChangeDecision = ({
  movimientos = 0,
  stockTotal = 0,
  productos = 0,
  insumos = 0,
  ordenesCompraAbiertas = 0,
  openOrdersAvailable = true
}) => {
  const reasonCodes = [];
  const reasons = [];

  if (movimientos > 0) {
    reasonCodes.push('MOVIMIENTOS_REGISTRADOS');
    reasons.push(ALMACEN_SUCURSAL_CHANGE_BLOCK_MESSAGES.MOVIMIENTOS_REGISTRADOS);
  }

  if (stockTotal > 0) {
    reasonCodes.push('STOCK_DISPONIBLE');
    reasons.push(ALMACEN_SUCURSAL_CHANGE_BLOCK_MESSAGES.STOCK_DISPONIBLE);
  }

  if (productos > 0 || insumos > 0) {
    reasonCodes.push('DEPENDENCIAS_OPERATIVAS');
    reasons.push(ALMACEN_SUCURSAL_CHANGE_BLOCK_MESSAGES.DEPENDENCIAS_OPERATIVAS);
  }

  if (openOrdersAvailable && ordenesCompraAbiertas > 0) {
    reasonCodes.push('ORDENES_COMPRA_ABIERTAS');
    reasons.push(ALMACEN_SUCURSAL_CHANGE_BLOCK_MESSAGES.ORDENES_COMPRA_ABIERTAS);
  }

  const canChangeSucursal = reasons.length === 0;

  return {
    canChangeSucursal,
    canChangeBranch: canChangeSucursal,
    canUpdateSucursal: canChangeSucursal,
    hasOperationalHistory: !canChangeSucursal,
    sucursalChangeBlockingReasonCodes: reasonCodes,
    sucursalChangeBlockingReasons: reasons
  };
};

const fetchAlmacenCoreDependencies = async (idAlmacen) => {
  try {
    const modernResult = await pool.query(
      `
        SELECT
          a.id_almacen,
          a.id_sucursal,
          a.xmin::text AS concurrency_token,
          COALESCE(a.estado, true) AS estado,
          COALESCE((
            SELECT COUNT(*)
            FROM public.movimientos_inventario m
            WHERE m.id_almacen = a.id_almacen
          ), 0)::int AS movimientos_total,
          COALESCE((
            SELECT COUNT(DISTINCT pa.id_producto)
            FROM public.productos_almacenes pa
            WHERE pa.id_almacen = a.id_almacen
          ), 0)::int AS productos_total,
          COALESCE((
            SELECT COUNT(DISTINCT pa.id_producto)
            FROM public.productos_almacenes pa
            INNER JOIN public.productos p
              ON p.id_producto = pa.id_producto
            WHERE pa.id_almacen = a.id_almacen
              AND COALESCE(p.estado, true) = true
          ), 0)::int AS productos_activos,
          COALESCE((
            SELECT COUNT(DISTINCT ia.id_insumo)
            FROM public.insumos_almacenes ia
            WHERE ia.id_almacen = a.id_almacen
          ), 0)::int AS insumos_total,
          COALESCE((
            SELECT COUNT(DISTINCT ia.id_insumo)
            FROM public.insumos_almacenes ia
            INNER JOIN public.insumos i
              ON i.id_insumo = ia.id_insumo
            WHERE ia.id_almacen = a.id_almacen
              AND COALESCE(i.estado, true) = true
          ), 0)::int AS insumos_activos,
          COALESCE((
            SELECT SUM(GREATEST(COALESCE(p.cantidad, 0), 0)::numeric)
            FROM public.productos_almacenes pa
            INNER JOIN public.productos p
              ON p.id_producto = pa.id_producto
            WHERE pa.id_almacen = a.id_almacen
              AND COALESCE(p.estado, true) = true
          ), 0)::numeric AS stock_productos_total,
          COALESCE((
            SELECT SUM(GREATEST(COALESCE(i.cantidad, 0), 0)::numeric)
            FROM public.insumos_almacenes ia
            INNER JOIN public.insumos i
              ON i.id_insumo = ia.id_insumo
            WHERE ia.id_almacen = a.id_almacen
              AND COALESCE(i.estado, true) = true
          ), 0)::numeric AS stock_insumos_total
        FROM public.almacenes a
        WHERE a.id_almacen = $1
        LIMIT 1
      `,
      [idAlmacen]
    );

    return modernResult.rows?.[0] || null;
  } catch (error) {
    if (!isMissingSchemaEntityError(error)) throw error;

    // AM: fallback legacy cuando aun no existen tablas pivote *_almacenes.
    const legacyResult = await pool.query(
      `
        SELECT
          a.id_almacen,
          a.id_sucursal,
          a.xmin::text AS concurrency_token,
          COALESCE(a.estado, true) AS estado,
          COALESCE((
            SELECT COUNT(*)
            FROM public.movimientos_inventario m
            WHERE m.id_almacen = a.id_almacen
          ), 0)::int AS movimientos_total,
          COALESCE((
            SELECT COUNT(*)
            FROM public.productos p
            WHERE p.id_almacen = a.id_almacen
          ), 0)::int AS productos_total,
          COALESCE((
            SELECT COUNT(*)
            FROM public.productos p
            WHERE p.id_almacen = a.id_almacen
              AND COALESCE(p.estado, true) = true
          ), 0)::int AS productos_activos,
          COALESCE((
            SELECT COUNT(*)
            FROM public.insumos i
            WHERE i.id_almacen = a.id_almacen
          ), 0)::int AS insumos_total,
          COALESCE((
            SELECT COUNT(*)
            FROM public.insumos i
            WHERE i.id_almacen = a.id_almacen
              AND COALESCE(i.estado, true) = true
          ), 0)::int AS insumos_activos,
          COALESCE((
            SELECT SUM(GREATEST(COALESCE(p.cantidad, 0), 0)::numeric)
            FROM public.productos p
            WHERE p.id_almacen = a.id_almacen
              AND COALESCE(p.estado, true) = true
          ), 0)::numeric AS stock_productos_total,
          COALESCE((
            SELECT SUM(GREATEST(COALESCE(i.cantidad, 0), 0)::numeric)
            FROM public.insumos i
            WHERE i.id_almacen = a.id_almacen
              AND COALESCE(i.estado, true) = true
          ), 0)::numeric AS stock_insumos_total
        FROM public.almacenes a
        WHERE a.id_almacen = $1
        LIMIT 1
      `,
      [idAlmacen]
    );

    return legacyResult.rows?.[0] || null;
  }
};

const fetchRecentMovimientosCount = async (idAlmacen) => {
  try {
    const result = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM public.movimientos_inventario m
        WHERE m.id_almacen = $1
          AND m.fecha_mov >= ((now() AT TIME ZONE 'America/Tegucigalpa') - ($2::int * INTERVAL '1 day'))
      `,
      [idAlmacen, ALMACEN_INACTIVATION_RECENT_MOVEMENTS_DAYS]
    );

    return {
      available: true,
      total: Number(result.rows?.[0]?.total ?? 0)
    };
  } catch (error) {
    if (!isMissingSchemaEntityError(error)) throw error;
    return { available: false, total: 0 };
  }
};

const fetchOpenPurchaseOrdersCount = async (idAlmacen) => {
  try {
    const result = await pool.query(
      `
        SELECT COUNT(DISTINCT doc.id_orden_compra)::int AS total
        FROM public.detalle_orden_compras doc
        INNER JOIN public.orden_compras oc
          ON oc.id_orden_compra = doc.id_orden_compra
        WHERE doc.id_almacen_destino = $1
          AND UPPER(COALESCE(oc.estado_flujo, '')) IN ('PENDIENTE', 'APROBADA', 'EN_COMPRA')
      `,
      [idAlmacen]
    );

    return {
      available: true,
      total: Number(result.rows?.[0]?.total ?? 0)
    };
  } catch (error) {
    if (!isMissingSchemaEntityError(error)) throw error;
    return { available: false, total: 0 };
  }
};

const getAlmacenDependenciasById = async (idAlmacen) => {
  const row = await fetchAlmacenCoreDependencies(idAlmacen);
  if (!row) return { exists: false };

  const recentMovimientos = await fetchRecentMovimientosCount(idAlmacen);
  const openPurchaseOrders = await fetchOpenPurchaseOrdersCount(idAlmacen);

  const stock = {
    productos: parseNonNegativeNumber(row.stock_productos_total),
    insumos: parseNonNegativeNumber(row.stock_insumos_total)
  };
  stock.total = stock.productos + stock.insumos;

  const counts = {
    movimientos: Number(row.movimientos_total ?? 0),
    movimientos_recientes: Number(recentMovimientos.total ?? 0),
    productos: Number(row.productos_total ?? 0),
    productos_activos: Number(row.productos_activos ?? 0),
    insumos: Number(row.insumos_total ?? 0),
    insumos_activos: Number(row.insumos_activos ?? 0),
    ordenes_compra_abiertas: Number(openPurchaseOrders.total ?? 0)
  };

  const canDelete = counts.movimientos === 0 && counts.productos === 0 && counts.insumos === 0;
  const inactivationDecision = buildAlmacenInactivationDecision({
    stockTotal: stock.total,
    movimientosRecientes: counts.movimientos_recientes,
    productosActivos: counts.productos_activos,
    insumosActivos: counts.insumos_activos,
    ordenesCompraAbiertas: counts.ordenes_compra_abiertas,
    recentMovementsAvailable: recentMovimientos.available,
    openOrdersAvailable: openPurchaseOrders.available
  });
  const sucursalChangeDecision = buildAlmacenSucursalChangeDecision({
    movimientos: counts.movimientos,
    stockTotal: stock.total,
    productos: counts.productos,
    insumos: counts.insumos,
    ordenesCompraAbiertas: counts.ordenes_compra_abiertas,
    openOrdersAvailable: openPurchaseOrders.available
  });

  return {
    exists: true,
    id_almacen: Number(row.id_almacen),
    id_sucursal: Number(row.id_sucursal),
    concurrency_token: String(row.concurrency_token || ''),
    estado: Boolean(row.estado),
    counts,
    canDelete,
    stock,
    ...inactivationDecision,
    ...sucursalChangeDecision,
    inactivationPolicy: {
      recent_movements_days: ALMACEN_INACTIVATION_RECENT_MOVEMENTS_DAYS,
      checks: {
        movimientos_recientes_disponible: recentMovimientos.available,
        ordenes_compra_disponible: openPurchaseOrders.available
      }
    },
    sucursalChangePolicy: {
      checks: {
        ordenes_compra_disponible: openPurchaseOrders.available
      },
      guidance: ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE
    }
  };
};

const evaluateSucursalChangeRequest = ({ dependency, nextSucursalId }) => {
  const currentSucursalId = Number(dependency?.id_sucursal ?? 0);
  const parsedNextSucursalId = Number(nextSucursalId);
  const normalizedNextSucursalId =
    Number.isInteger(parsedNextSucursalId) && parsedNextSucursalId > 0 ? parsedNextSucursalId : null;

  if (!normalizedNextSucursalId || !currentSucursalId || normalizedNextSucursalId === currentSucursalId) {
    return {
      requested: false,
      blocked: false,
      currentSucursalId,
      nextSucursalId: normalizedNextSucursalId
    };
  }

  const blockingReasons = Array.isArray(dependency?.sucursalChangeBlockingReasons)
    ? dependency.sucursalChangeBlockingReasons.filter(Boolean)
    : [];
  const blockingReasonCodes = Array.isArray(dependency?.sucursalChangeBlockingReasonCodes)
    ? dependency.sucursalChangeBlockingReasonCodes.filter(Boolean)
    : [];

  return {
    requested: true,
    blocked: dependency?.canChangeSucursal === false,
    currentSucursalId,
    nextSucursalId: normalizedNextSucursalId,
    blockingReasons,
    blockingReasonCodes
  };
};

const normalizeAlmacenMutationError = (error) => {
  switch (error?.code) {
    case '23505':
      return { status: 409, code: 'CONFLICT', message: 'Ya existe un almacen con los datos proporcionados.' };
    case '23503':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'La sucursal seleccionada no existe o no esta disponible.'
      };
    case '22P02':
    case '22003':
    case '23514':
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Los datos enviados no son validos.' };
    case 'P0001':
      if (String(error?.message || '').toLowerCase().includes('sucursal')) {
        return { status: 409, code: 'CONFLICT', message: ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE };
      }
      return { status: 409, code: 'CONFLICT', message: 'La operacion entra en conflicto con reglas de negocio.' };
    default:
      return null;
  }
};

const sendMutationError = (res, context, error) => {
  const normalized = normalizeAlmacenMutationError(error);
  if (normalized) {
    logRouterError(context, error, { category: 'MUTATION_ERROR' });
    return sendError(res, normalized.status, normalized.code, normalized.message);
  }

  return sendInternalError(res, context, error);
};

// GET: Obtener almacenes
router.get('/almacenes', checkPermission(ALMACENES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(req.query?.include_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const scope = await getRequestAlmacenesScope(req);
    if (!ensureSucursalScopeAvailable(res, scope)) {
      return;
    }

    if (
      idSucursalFilter.provided &&
      !ensureSucursalInScope(res, scope, idSucursalFilter.value)
    ) {
      return;
    }

    const whereConditions = ['($1::boolean = true OR COALESCE(a.estado, true) = true)'];
    const params = [includeInactivosResult.value];

    if (idSucursalFilter.provided) {
      params.push(idSucursalFilter.value);
      whereConditions.push(`a.id_sucursal = $${params.length}`);
    }

    if (!scope.isSuperAdmin) {
      params.push(scope.allowedSucursalIds);
      whereConditions.push(`a.id_sucursal = ANY($${params.length}::int[])`);
    }

    const query = `
      WITH inventario_items AS (
        SELECT
          pa.id_almacen,
          p.id_producto AS item_id,
          p.cantidad,
          p.stock_minimo,
          p.estado
        FROM public.productos_almacenes pa
        INNER JOIN public.productos p
          ON p.id_producto = pa.id_producto
        UNION ALL
        SELECT
          ia.id_almacen,
          i.id_insumo AS item_id,
          i.cantidad,
          i.stock_minimo,
          i.estado
        FROM public.insumos_almacenes ia
        INNER JOIN public.insumos i
          ON i.id_insumo = ia.id_insumo
      ),
      movimientos_hoy AS (
        SELECT
          k.id_almacen,
          COUNT(*)::int AS movimientos_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'ENTRADA')::int AS entradas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'SALIDA')::int AS salidas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'AJUSTE')::int AS ajustes_hoy
        FROM public.v_kardex_detalle k
        WHERE k.fecha_mov::date = ((now() AT TIME ZONE 'America/Tegucigalpa')::date)
        GROUP BY k.id_almacen
      ),
      dep_movimientos AS (
        SELECT m.id_almacen, COUNT(*)::int AS movimientos_count
        FROM public.movimientos_inventario m
        GROUP BY m.id_almacen
      ),
      dep_productos AS (
        SELECT pa.id_almacen, COUNT(DISTINCT pa.id_producto)::int AS productos_count
        FROM public.productos_almacenes pa
        GROUP BY pa.id_almacen
      ),
      dep_insumos AS (
        SELECT ia.id_almacen, COUNT(DISTINCT ia.id_insumo)::int AS insumos_count
        FROM public.insumos_almacenes ia
        GROUP BY ia.id_almacen
      )
      SELECT
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        a.xmin::text AS concurrency_token,
        COALESCE(a.estado, true) AS estado,
        s.nombre_sucursal,
        s.estado AS sucursal_estado,
        COALESCE(dm.movimientos_count, 0)::int AS movimientos_count,
        COALESCE(dp.productos_count, 0)::int AS productos_count,
        COALESCE(di.insumos_count, 0)::int AS insumos_count,
        (
          COALESCE(dm.movimientos_count, 0) = 0
          AND COALESCE(dp.productos_count, 0) = 0
          AND COALESCE(di.insumos_count, 0) = 0
        ) AS can_delete,
        COUNT(*) FILTER (WHERE ii.item_id IS NOT NULL)::int AS total_items,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
        )::int AS total_items_activos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = false
        )::int AS total_items_inactivos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
            AND ii.cantidad <= COALESCE(ii.stock_minimo, 0)
        )::int AS alertas_stock,
        COALESCE(mh.movimientos_hoy, 0)::int AS movimientos_hoy,
        COALESCE(mh.entradas_hoy, 0)::int AS entradas_hoy,
        COALESCE(mh.salidas_hoy, 0)::int AS salidas_hoy,
        COALESCE(mh.ajustes_hoy, 0)::int AS ajustes_hoy
      FROM public.almacenes a
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      LEFT JOIN inventario_items ii
        ON ii.id_almacen = a.id_almacen
      LEFT JOIN movimientos_hoy mh
        ON mh.id_almacen = a.id_almacen
      LEFT JOIN dep_movimientos dm
        ON dm.id_almacen = a.id_almacen
      LEFT JOIN dep_productos dp
        ON dp.id_almacen = a.id_almacen
      LEFT JOIN dep_insumos di
        ON di.id_almacen = a.id_almacen
      WHERE ${whereConditions.join('\n        AND ')}
      GROUP BY
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        a.xmin,
        a.estado,
        s.nombre_sucursal,
        s.estado,
        dm.movimientos_count,
        dp.productos_count,
        di.insumos_count,
        mh.movimientos_hoy,
        mh.entradas_hoy,
        mh.salidas_hoy,
        mh.ajustes_hoy
      ORDER BY a.id_almacen ASC
    `;

    const result = await pool.query(query, params);
    res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener almacenes', error);
  }
});

// AM: catalogo liviano de almacenes para formularios create/edit (sin dependencias de vistas agregadas).
// AM: se usa como respaldo cuando el dashboard completo de `/almacenes` falla por objetos SQL no disponibles.
router.get('/almacenes/catalogo', checkPermission(ALMACENES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(req.query?.include_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const scope = await getRequestAlmacenesScope(req);
    if (!ensureSucursalScopeAvailable(res, scope)) {
      return;
    }
    if (
      idSucursalFilter.provided &&
      !ensureSucursalInScope(res, scope, idSucursalFilter.value)
    ) {
      return;
    }

    const whereConditions = ['($1::boolean = true OR COALESCE(a.estado, true) = true)'];
    const params = [includeInactivosResult.value];

    if (idSucursalFilter.provided) {
      params.push(idSucursalFilter.value);
      whereConditions.push(`a.id_sucursal = $${params.length}`);
    }

    if (!scope.isSuperAdmin) {
      params.push(scope.allowedSucursalIds);
      whereConditions.push(`a.id_sucursal = ANY($${params.length}::int[])`);
    }

    const result = await pool.query(
      `
        SELECT
          a.id_almacen,
          a.id_sucursal,
          a.nombre,
          a.xmin::text AS concurrency_token,
          COALESCE(a.estado, true) AS estado
        FROM public.almacenes a
        WHERE ${whereConditions.join('\n          AND ')}
        ORDER BY a.id_almacen ASC
      `,
      params
    );

    return res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener catalogo de almacenes', error);
  }
});

// GET: Dependencias del almacen para consulta operativa y trazabilidad.
router.get('/almacenes/:id/dependencias', checkPermission(ALMACENES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const scopeCheck = await assertAlmacenInScope(req, res, idResult.value);
    if (!scopeCheck.ok) return;

    const dependency = await getAlmacenDependenciasById(idResult.value);
    if (!dependency.exists) {
      return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
    }

    return res.status(200).json({
      ok: true,
      id_almacen: dependency.id_almacen,
      id_sucursal: dependency.id_sucursal,
      concurrency_token: dependency.concurrency_token,
      counts: dependency.counts,
      canDelete: dependency.canDelete,
      canInactivate: dependency.canInactivate,
      canDeactivate: dependency.canDeactivate,
      canChangeSucursal: dependency.canChangeSucursal,
      canChangeBranch: dependency.canChangeBranch,
      canUpdateSucursal: dependency.canUpdateSucursal,
      hasOperationalHistory: dependency.hasOperationalHistory,
      hasStock: dependency.hasStock,
      hasActiveOperationalDependencies: dependency.hasActiveOperationalDependencies,
      stock: dependency.stock,
      blockingReasonCodes: dependency.blockingReasonCodes,
      blockingReasons: dependency.blockingReasons,
      inactivationPolicy: dependency.inactivationPolicy,
      sucursalChangeBlockingReasonCodes: dependency.sucursalChangeBlockingReasonCodes,
      sucursalChangeBlockingReasons: dependency.sucursalChangeBlockingReasons,
      sucursalChangePolicy: dependency.sucursalChangePolicy
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener dependencias de almacen', error);
  }
});

// PATCH: Inactivar almacen (soft-delete idempotente).
router.patch('/almacenes/:id/inactivar', checkPermission(ALMACENES_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const scopeCheck = await assertAlmacenInScope(req, res, idResult.value);
    if (!scopeCheck.ok) return;

    const _motivo = hasValue(req.body?.motivo) ? String(req.body.motivo).trim() : null;
    void _motivo;

    const dependency = await getAlmacenDependenciasById(idResult.value);
    if (!dependency.exists) {
      return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
    }

    const wasActive = Boolean(dependency.estado);
    if (wasActive) {
      if (!dependency.canInactivate) {
        const conflictMessage =
          dependency.blockingReasons?.[0] ||
          'No se puede inactivar el almacén porque mantiene dependencias operativas activas.';
        return sendConflictError(res, conflictMessage, {
          id_almacen: dependency.id_almacen,
          counts: dependency.counts,
          hasStock: dependency.hasStock,
          hasActiveOperationalDependencies: dependency.hasActiveOperationalDependencies,
          blockingReasonCodes: dependency.blockingReasonCodes,
          blockingReasons: dependency.blockingReasons,
          canInactivate: dependency.canInactivate,
          canDeactivate: dependency.canDeactivate,
          stock: dependency.stock,
          inactivationPolicy: dependency.inactivationPolicy
        });
      }

      const updateResult = await pool.query(
        'UPDATE public.almacenes SET estado = false WHERE id_almacen = $1 RETURNING id_almacen',
        [idResult.value]
      );

      if (!updateResult.rows?.length) {
        return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
      }
    }

    return res.status(200).json({
      ok: true,
      id_almacen: idResult.value,
      estado: false,
      message: wasActive ? 'Almacen inactivado correctamente.' : 'El almacen ya estaba inactivo.'
    });
  } catch (error) {
    return sendInternalError(res, 'Error al inactivar almacen', error);
  }
});

// PATCH: Reactivar almacen (idempotente).
router.patch('/almacenes/:id/reactivar', checkPermission(ALMACENES_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const scopeCheck = await assertAlmacenInScope(req, res, idResult.value);
    if (!scopeCheck.ok) return;

    const current = await pool.query(
      'SELECT id_almacen, COALESCE(estado, true) AS estado FROM public.almacenes WHERE id_almacen = $1 LIMIT 1',
      [idResult.value]
    );

    if (!current.rows?.length) {
      return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
    }

    const wasActive = Boolean(current.rows[0].estado);
    if (!wasActive) {
      const updateResult = await pool.query(
        'UPDATE public.almacenes SET estado = true WHERE id_almacen = $1 RETURNING id_almacen',
        [idResult.value]
      );

      if (!updateResult.rows?.length) {
        return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
      }
    }

    return res.status(200).json({
      ok: true,
      id_almacen: idResult.value,
      estado: true,
      message: wasActive ? 'El almacen ya estaba activo.' : 'Almacen reactivado correctamente.'
    });
  } catch (error) {
    return sendInternalError(res, 'Error al reactivar almacen', error);
  }
});

// POST: Crear almacén
router.post('/almacenes', checkPermission(ALMACENES_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const extraKeys = Object.keys(payload).filter((key) => !CREATE_ALLOWED_FIELDS.has(key));
    if (extraKeys.length) {
      return sendValidationError(res, `Campos no permitidos: ${extraKeys.join(', ')}`);
    }

    const nombreResult = parseNombre(payload.nombre);
    const sucursalResult = parsePositiveInt(payload.id_sucursal, 'id_sucursal');
    const errors = [nombreResult.error, sucursalResult.error].filter(Boolean);

    if (errors.length) {
      return sendValidationError(res, errors[0], errors);
    }

    const scope = await getRequestAlmacenesScope(req);
    if (!ensureSucursalScopeAvailable(res, scope)) {
      return;
    }
    if (!ensureSucursalInScope(res, scope, sucursalResult.value)) {
      return;
    }

    await pool.query(
      `
        INSERT INTO public.almacenes (
          nombre,
          id_sucursal
        )
        VALUES ($1, $2)
      `,
      [nombreResult.value, sucursalResult.value]
    );

    return res.status(201).json({ ok: true, message: 'Almacen creado exitosamente.' });
  } catch (error) {
    return sendMutationError(res, 'Error al crear almacen', error);
  }
});

// PUT legacy: Actualizar almacén (1 campo) manteniendo compatibilidad de clientes existentes.
router.put('/almacenes', checkPermission(ALMACENES_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const { campo, valor, id_campo, id_valor } = payload;

    if (!hasValue(campo) || valor === undefined || !hasValue(id_campo) || id_valor === undefined) {
      return sendValidationError(res, 'Faltan campos obligatorios.');
    }

    if (String(id_campo).trim() !== 'id_almacen') {
      return sendValidationError(res, "id_campo invalido. Debe ser 'id_almacen'.");
    }

    const normalizedField = String(campo).trim();
    if (!EDITABLE_FIELDS.has(normalizedField)) {
      return sendValidationError(res, `campo invalido. Permitidos: ${Array.from(EDITABLE_FIELDS).join(', ')}`);
    }

    const idResult = parsePositiveInt(id_valor, 'id_valor');
    if (!idResult.ok) {
      return sendValidationError(res, idResult.error);
    }
    const scopeCheck = await assertAlmacenInScope(req, res, idResult.value);
    if (!scopeCheck.ok) {
      return;
    }
    const concurrencyTokenResult = parseConcurrencyToken(
      resolveConcurrencyTokenFromPayload(payload),
      'concurrency_token'
    );
    if (!concurrencyTokenResult.ok) {
      return sendValidationError(res, concurrencyTokenResult.error);
    }

    let normalizedValue;
    if (normalizedField === 'nombre') {
      const nombreResult = parseNombre(valor, 'valor');
      if (!nombreResult.ok) return sendValidationError(res, nombreResult.error);
      normalizedValue = nombreResult.value;
    } else {
      const sucursalResult = parsePositiveInt(valor, 'valor');
      if (!sucursalResult.ok) return sendValidationError(res, sucursalResult.error);
      normalizedValue = sucursalResult.value;
      if (!ensureSucursalInScope(res, scopeCheck.scope, normalizedValue)) {
        return;
      }

      const dependency = await getAlmacenDependenciasById(idResult.value);
      if (!dependency.exists) {
        return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
      }

      const sucursalChange = evaluateSucursalChangeRequest({
        dependency,
        nextSucursalId: normalizedValue
      });
      if (sucursalChange.requested && sucursalChange.blocked) {
        return sendConflictError(res, ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE, {
          id_almacen: dependency.id_almacen,
          id_sucursal_actual: sucursalChange.currentSucursalId,
          id_sucursal_solicitada: sucursalChange.nextSucursalId,
          canChangeSucursal: dependency.canChangeSucursal,
          canChangeBranch: dependency.canChangeBranch,
          hasOperationalHistory: dependency.hasOperationalHistory,
          hasStock: dependency.hasStock,
          counts: dependency.counts,
          stock: dependency.stock,
          primaryBlockingReason:
            sucursalChange.blockingReasons?.[0] ||
            ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE,
          sucursalChangeBlockingReasons: sucursalChange.blockingReasons,
          sucursalChangeBlockingReasonCodes: sucursalChange.blockingReasonCodes
        });
      }
    }

    let updateResult;
    if (normalizedField === 'nombre') {
      updateResult = await pool.query(
        `
          UPDATE public.almacenes
          SET nombre = $1
          WHERE id_almacen = $2
            AND xmin::text = $3
          RETURNING id_almacen, xmin::text AS concurrency_token
        `,
        [normalizedValue, idResult.value, concurrencyTokenResult.value]
      );
    } else {
      updateResult = await pool.query(
        `
          UPDATE public.almacenes
          SET id_sucursal = $1
          WHERE id_almacen = $2
            AND xmin::text = $3
          RETURNING id_almacen, xmin::text AS concurrency_token
        `,
        [normalizedValue, idResult.value, concurrencyTokenResult.value]
      );
    }

    if (!updateResult.rows?.length) {
      const currentResult = await pool.query(
        `
          SELECT id_almacen, xmin::text AS concurrency_token
          FROM public.almacenes
          WHERE id_almacen = $1
          LIMIT 1
        `,
        [idResult.value]
      );

      if (!currentResult.rows?.length) {
        return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
      }

      return sendConcurrencyConflictError(res, ALMACEN_CONCURRENCY_CONFLICT_MESSAGE, {
        id_almacen: idResult.value,
        current_concurrency_token: String(currentResult.rows[0].concurrency_token || '')
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Almacen actualizado correctamente.',
      concurrency_token: String(updateResult.rows[0].concurrency_token || '')
    });
  } catch (error) {
    return sendMutationError(res, 'Error al actualizar almacen (legacy)', error);
  }
});

// PUT atómico: actualización multi-campo en una sola transacción.
router.put('/almacenes/:id', checkPermission(ALMACENES_EDIT_PERMISSIONS), async (req, res) => {
  const idResult = parsePositiveInt(req.params?.id, 'id');
  if (!idResult.ok) {
    return sendValidationError(res, idResult.error);
  }
  const scopeCheck = await assertAlmacenInScope(req, res, idResult.value);
  if (!scopeCheck.ok) {
    return;
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const allowedFields = ['nombre', 'id_sucursal', 'concurrency_token', 'row_version', 'version', 'xmin'];
  const extraKeys = Object.keys(payload).filter((key) => !allowedFields.includes(key));
  if (extraKeys.length) {
    return sendValidationError(res, `Campos no permitidos: ${extraKeys.join(', ')}`);
  }
  const concurrencyTokenResult = parseConcurrencyToken(
    resolveConcurrencyTokenFromPayload(payload),
    'concurrency_token'
  );
  if (!concurrencyTokenResult.ok) {
    return sendValidationError(res, concurrencyTokenResult.error);
  }

  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'nombre')) {
    const nombreResult = parseNombre(payload.nombre);
    if (!nombreResult.ok) return sendValidationError(res, nombreResult.error);
    updates.nombre = nombreResult.value;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'id_sucursal')) {
    const sucursalResult = parsePositiveInt(payload.id_sucursal, 'id_sucursal');
    if (!sucursalResult.ok) return sendValidationError(res, sucursalResult.error);
    if (!ensureSucursalInScope(res, scopeCheck.scope, sucursalResult.value)) {
      return;
    }
    updates.id_sucursal = sucursalResult.value;
  }

  if (!Object.keys(updates).length) {
    return sendValidationError(res, 'Debe enviar al menos un campo editable (nombre o id_sucursal).');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'id_sucursal')) {
    const dependency = await getAlmacenDependenciasById(idResult.value);
    if (!dependency.exists) {
      return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
    }

    const sucursalChange = evaluateSucursalChangeRequest({
      dependency,
      nextSucursalId: updates.id_sucursal
    });
    if (sucursalChange.requested && sucursalChange.blocked) {
      return sendConflictError(res, ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE, {
        id_almacen: dependency.id_almacen,
        id_sucursal_actual: sucursalChange.currentSucursalId,
        id_sucursal_solicitada: sucursalChange.nextSucursalId,
        canChangeSucursal: dependency.canChangeSucursal,
        canChangeBranch: dependency.canChangeBranch,
        hasOperationalHistory: dependency.hasOperationalHistory,
        hasStock: dependency.hasStock,
        counts: dependency.counts,
        stock: dependency.stock,
        primaryBlockingReason:
          sucursalChange.blockingReasons?.[0] ||
          ALMACEN_SUCURSAL_CHANGE_CONFLICT_MESSAGE,
        sucursalChangeBlockingReasons: sucursalChange.blockingReasons,
        sucursalChangeBlockingReasonCodes: sucursalChange.blockingReasonCodes
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const setParts = [];
    const values = [idResult.value, concurrencyTokenResult.value];
    let paramIndex = 3;

    if (Object.prototype.hasOwnProperty.call(updates, 'nombre')) {
      setParts.push(`nombre = $${paramIndex}`);
      values.push(updates.nombre);
      paramIndex += 1;
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'id_sucursal')) {
      setParts.push(`id_sucursal = $${paramIndex}`);
      values.push(updates.id_sucursal);
      paramIndex += 1;
    }

    const updateResult = await client.query(
      `
        UPDATE public.almacenes
        SET ${setParts.join(', ')}
        WHERE id_almacen = $1
          AND xmin::text = $2
        RETURNING id_almacen, xmin::text AS concurrency_token
      `,
      values
    );

    if (!updateResult.rows?.length) {
      const currentResult = await client.query(
        `
          SELECT id_almacen, xmin::text AS concurrency_token
          FROM public.almacenes
          WHERE id_almacen = $1
          LIMIT 1
        `,
        [idResult.value]
      );

      await client.query('ROLLBACK');
      if (!currentResult.rows?.length) {
        return sendError(res, 404, 'NOT_FOUND', ALMACENES_NOT_FOUND_MESSAGE);
      }

      return sendConcurrencyConflictError(res, ALMACEN_CONCURRENCY_CONFLICT_MESSAGE, {
        id_almacen: idResult.value,
        current_concurrency_token: String(currentResult.rows[0].concurrency_token || '')
      });
    }

    await client.query('COMMIT');
    return res.status(200).json({
      ok: true,
      message: 'Almacen actualizado correctamente.',
      concurrency_token: String(updateResult.rows[0].concurrency_token || '')
    });
  } catch (error) {
    await client.query('ROLLBACK');
    return sendMutationError(res, 'Error al actualizar almacen (atomico)', error);
  } finally {
    client.release();
  }
});

// DELETE compat: mantenido solo para clientes legacy, bloqueado por politica operativa.
router.delete('/almacenes', checkPermission(ALMACENES_DELETE_COMPAT_PERMISSIONS), (_req, res) =>
  sendConflictError(res, DELETE_OPERATION_BLOCKED_MESSAGE)
);

export default router;
