import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();

const TABLA_PROVEEDORES = 'public.proveedores';
const PROVEEDORES_VIEW_PERMISSIONS = ['INVENTARIO_PROVEEDORES_VER', 'INVENTARIO_PROVEEDORES_DETALLE_VER'];
const PROVEEDORES_CREATE_PERMISSIONS = ['INVENTARIO_PROVEEDORES_CREAR'];
const PROVEEDORES_EDIT_PERMISSIONS = ['INVENTARIO_PROVEEDORES_EDITAR'];
const PROVEEDORES_DELETE_PERMISSIONS = ['INVENTARIO_PROVEEDORES_ELIMINAR'];
const PROVEEDORES_STATE_PERMISSIONS = ['INVENTARIO_PROVEEDORES_ESTADO_CAMBIAR'];
const PROVEEDOR_ACTIVE_ORDER_STATES = Object.freeze(['PENDIENTE', 'APROBADA', 'EN_COMPRA']);
const PROVEEDOR_DELETE_HISTORY_BLOCK_MESSAGE =
  'El proveedor no puede eliminarse porque ya tiene historial operativo (compras u ordenes de compra).';
const PROVEEDOR_DEACTIVATE_ACTIVE_PROCESS_BLOCK_MESSAGE =
  'El proveedor no puede inactivarse porque mantiene ordenes de compra activas.';
const PROVEEDOR_PHYSICAL_DELETE_DISABLED_MESSAGE =
  'Los proveedores no se eliminan fisicamente. Deben inactivarse para preservar la trazabilidad.';
const PROVEEDOR_CONCURRENCY_CONFLICT_MESSAGE =
  'El proveedor fue modificado por otro usuario. Recarga la informacion antes de guardar.';
const PROVEEDORES_SCOPE_FORBIDDEN_MESSAGE =
  'No tiene permisos para operar sobre recursos fuera de su sucursal.';
const PROVEEDORES_SCOPE_MISSING_BRANCHES_MESSAGE = 'El empleado no tiene sucursales asignadas.';
const PROVEEDORES_NOT_FOUND_MESSAGE = 'Proveedor no encontrado.';
const PROVEEDOR_EDITABLE_FIELDS = new Set([
  'nombre_proveedor',
  'id_persona',
  'id_empresa',
  'correo_electronico',
  'telefono_principal',
  'telefono_secundario',
  'contacto_principal',
  'direccion',
  'ciudad',
  'rtn',
  'plazo_pago_dias',
  'observaciones',
  'estado'
]);

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

const sendNotFoundError = (res, message) =>
  sendError(res, 404, 'NOT_FOUND', message);

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
  console.error('[proveedores] error', {
    category,
    context: safeContext,
    ...safeError
  });
};

const sendInternalError = (
  res,
  context,
  error,
  publicMessage = 'No se pudo completar la operacion de proveedores.'
) => {
  logRouterError(context, error, { category: 'INTERNAL_ERROR' });
  return sendError(res, 500, 'INTERNAL_ERROR', publicMessage);
};

const isMissingSchemaEntityError = (error) =>
  ['42P01', '42703', '42883'].includes(String(error?.code || '').trim());

const uniqueNonEmptyStrings = (values) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const normalized = [];
  for (const rawValue of values) {
    const value = String(rawValue ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
};

const buildProveedorLifecycleDecision = ({
  comprasCount = 0,
  ordenesHistorialCount = 0,
  ordenesActivasCount = 0
} = {}) => {
  const hasOperationalHistory = Number(comprasCount) > 0 || Number(ordenesHistorialCount) > 0;
  const hasActiveProcesses = Number(ordenesActivasCount) > 0;

  const deleteBlockingReasons = hasOperationalHistory ? [PROVEEDOR_DELETE_HISTORY_BLOCK_MESSAGE] : [];
  const deactivateBlockingReasons = hasActiveProcesses ? [PROVEEDOR_DEACTIVATE_ACTIVE_PROCESS_BLOCK_MESSAGE] : [];

  return {
    hasOperationalHistory,
    hasActiveProcesses,
    canDelete: !hasOperationalHistory,
    canDeactivate: !hasActiveProcesses,
    deleteBlockingReasons,
    deactivateBlockingReasons,
    blockingReasons: uniqueNonEmptyStrings([...deleteBlockingReasons, ...deactivateBlockingReasons])
  };
};

const fetchProveedorOrderCountsMap = async (queryable, proveedorIds) => {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(proveedorIds) ? proveedorIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (!normalizedIds.length) {
    return { available: true, map: new Map() };
  }

  try {
    const result = await queryable.query(
      `
        SELECT
          doc.id_proveedor_sugerido::int AS id_proveedor,
          COUNT(DISTINCT doc.id_orden_compra)::int AS ordenes_historial_count,
          COUNT(
            DISTINCT CASE
              WHEN UPPER(COALESCE(oc.estado_flujo, '')) = ANY($2::text[])
              THEN doc.id_orden_compra
              ELSE NULL
            END
          )::int AS ordenes_activas_count
        FROM public.detalle_orden_compras doc
        INNER JOIN public.orden_compras oc
          ON oc.id_orden_compra = doc.id_orden_compra
        WHERE doc.id_proveedor_sugerido = ANY($1::int[])
        GROUP BY doc.id_proveedor_sugerido
      `,
      [normalizedIds, PROVEEDOR_ACTIVE_ORDER_STATES]
    );

    const map = new Map();
    for (const row of result.rows || []) {
      const idProveedor = Number(row?.id_proveedor ?? 0);
      if (!idProveedor) continue;
      map.set(idProveedor, {
        ordenes_historial_count: Number(row?.ordenes_historial_count ?? 0),
        ordenes_activas_count: Number(row?.ordenes_activas_count ?? 0)
      });
    }

    return { available: true, map };
  } catch (error) {
    if (!isMissingSchemaEntityError(error)) throw error;
    return { available: false, map: new Map() };
  }
};

const enrichProveedorRowWithLifecycle = (
  row,
  orderCountsRow,
  { orderCountsAvailable = true } = {}
) => {
  const comprasCount = Number(row?.compras_count ?? 0);
  const cuentasBancariasCount = Number(row?.cuentas_bancarias_count ?? 0);
  const ordenesHistorialCount = Number(
    orderCountsRow?.ordenes_historial_count ?? row?.ordenes_historial_count ?? 0
  );
  const ordenesActivasCount = Number(
    orderCountsRow?.ordenes_activas_count ?? row?.ordenes_activas_count ?? 0
  );

  const lifecycle = buildProveedorLifecycleDecision({
    comprasCount,
    ordenesHistorialCount,
    ordenesActivasCount
  });

  return {
    ...(row || {}),
    compras_count: comprasCount,
    cuentas_bancarias_count: cuentasBancariasCount,
    ordenes_historial_count: ordenesHistorialCount,
    ordenes_activas_count: ordenesActivasCount,
    has_operational_history: lifecycle.hasOperationalHistory,
    has_active_processes: lifecycle.hasActiveProcesses,
    can_delete: lifecycle.canDelete,
    can_deactivate: lifecycle.canDeactivate,
    delete_blocking_reasons: lifecycle.deleteBlockingReasons,
    deactivate_blocking_reasons: lifecycle.deactivateBlockingReasons,
    blocking_reasons: lifecycle.blockingReasons,
    dependency_checks: {
      ordenes_compra_disponible: orderCountsAvailable
    }
  };
};

const enrichProveedorRowsWithLifecycle = async (queryable, rows) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return safeRows;

  const ids = safeRows.map((row) => Number(row?.id_proveedor ?? 0));
  const orderCounts = await fetchProveedorOrderCountsMap(queryable, ids);

  return safeRows.map((row) => {
    const idProveedor = Number(row?.id_proveedor ?? 0);
    const orderCountsRow = idProveedor ? orderCounts.map.get(idProveedor) : null;
    return enrichProveedorRowWithLifecycle(row, orderCountsRow, {
      orderCountsAvailable: orderCounts.available
    });
  });
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

const resolveConcurrencyTokenFromPayload = (payload) =>
  payload?.concurrency_token ??
  payload?.row_version ??
  payload?.version ??
  payload?.xmin ??
  null;

const parseOptionalPositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return { ok: false, error: `${fieldName} debe ser un entero mayor a 0.` };
  }
  return { ok: true, value: normalizedValue };
};

const normalizeScopeSucursalIds = (rawIds) =>
  Array.from(
    new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

const getRequestProveedoresScope = async (req, queryable = pool) => {
  if (req?.__proveedoresScope) return req.__proveedoresScope;

  const resolvedScope = await resolveRequestUserSucursalScope(req, queryable);
  const scope = {
    isSuperAdmin: Boolean(resolvedScope?.isSuperAdmin),
    allowedSucursalIds: normalizeScopeSucursalIds(resolvedScope?.allowedSucursalIds)
  };

  if (req) req.__proveedoresScope = scope;
  return scope;
};

const ensureProveedoresScopeAvailable = (res, scope) => {
  if (scope?.isSuperAdmin) return true;
  if (Array.isArray(scope?.allowedSucursalIds) && scope.allowedSucursalIds.length > 0) return true;

  sendError(res, 403, 'FORBIDDEN', PROVEEDORES_SCOPE_MISSING_BRANCHES_MESSAGE);
  return false;
};

const hasSucursalScopeIntersection = (scopeIds, allowedIds) => {
  const allowedSet = new Set(
    (Array.isArray(allowedIds) ? allowedIds : [])
      .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  );
  if (allowedSet.size === 0) return false;

  return (Array.isArray(scopeIds) ? scopeIds : []).some((value) => {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isInteger(parsed) && allowedSet.has(parsed);
  });
};

const fetchProveedoresOperationalScopeMap = async (queryable, proveedorIds) => {
  const normalizedIds = Array.from(
    new Set(
      (Array.isArray(proveedorIds) ? proveedorIds : [])
        .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

  if (!normalizedIds.length) {
    return { available: true, map: new Map() };
  }

  try {
    const result = await queryable.query(
      `
        WITH doc_scope AS (
          SELECT
            doc.id_proveedor_sugerido::int AS id_proveedor,
            COALESCE(a_doc.id_sucursal, a_item.id_sucursal) AS id_sucursal
          FROM public.detalle_orden_compras doc
          LEFT JOIN public.almacenes a_doc
            ON a_doc.id_almacen = doc.id_almacen_destino
          LEFT JOIN public.productos p
            ON p.id_producto = doc.id_producto
          LEFT JOIN public.insumos i
            ON i.id_insumo = doc.id_insumo
          LEFT JOIN public.almacenes a_item
            ON a_item.id_almacen = COALESCE(p.id_almacen, i.id_almacen)
          WHERE doc.id_proveedor_sugerido = ANY($1::int[])
        ),
        compra_scope AS (
          SELECT
            c.id_proveedor::int AS id_proveedor,
            COALESCE(a_doc.id_sucursal, a_item.id_sucursal) AS id_sucursal
          FROM public.compras c
          LEFT JOIN public.detalle_orden_compras doc
            ON doc.id_orden_compra = c.id_orden_compra
          LEFT JOIN public.almacenes a_doc
            ON a_doc.id_almacen = doc.id_almacen_destino
          LEFT JOIN public.productos p
            ON p.id_producto = doc.id_producto
          LEFT JOIN public.insumos i
            ON i.id_insumo = doc.id_insumo
          LEFT JOIN public.almacenes a_item
            ON a_item.id_almacen = COALESCE(p.id_almacen, i.id_almacen)
          WHERE c.id_proveedor = ANY($1::int[])
        ),
        scope_rows AS (
          SELECT id_proveedor, id_sucursal
          FROM doc_scope
          UNION ALL
          SELECT id_proveedor, id_sucursal
          FROM compra_scope
        )
        SELECT
          id_proveedor,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT id_sucursal::int), NULL) AS sucursales
        FROM scope_rows
        WHERE id_proveedor IS NOT NULL
        GROUP BY id_proveedor
      `,
      [normalizedIds]
    );

    const map = new Map();
    for (const row of result.rows || []) {
      const idProveedor = Number.parseInt(String(row?.id_proveedor ?? '').trim(), 10);
      if (!Number.isInteger(idProveedor) || idProveedor <= 0) continue;
      map.set(idProveedor, normalizeScopeSucursalIds(row?.sucursales));
    }

    return { available: true, map };
  } catch (error) {
    if (!isMissingSchemaEntityError(error)) throw error;
    return { available: false, map: new Map() };
  }
};

const filterProveedoresByScope = async (queryable, rows, scope) => {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (scope?.isSuperAdmin) return safeRows;
  if (!Array.isArray(scope?.allowedSucursalIds) || scope.allowedSucursalIds.length === 0) {
    return [];
  }

  const scopeMapResult = await fetchProveedoresOperationalScopeMap(
    queryable,
    safeRows.map((row) => row?.id_proveedor)
  );

  if (!scopeMapResult.available) {
    // AM: fallback conservador compatible con modelos legacy sin traza de sucursal en proveedores.
    return safeRows;
  }

  return safeRows.filter((row) => {
    const idProveedor = Number.parseInt(String(row?.id_proveedor ?? '').trim(), 10);
    if (!Number.isInteger(idProveedor) || idProveedor <= 0) return false;
    const scopedSucursales = scopeMapResult.map.get(idProveedor) || [];
    if (scopedSucursales.length === 0) {
      // AM: sin evidencia de sucursal operativa no se puede aislar con mayor precision.
      return true;
    }
    return hasSucursalScopeIntersection(scopedSucursales, scope.allowedSucursalIds);
  });
};

const assertProveedorInScope = async (
  req,
  res,
  idProveedor,
  { queryable = pool, maskAsNotFound = true } = {}
) => {
  const scope = await getRequestProveedoresScope(req, queryable);
  if (!ensureProveedoresScopeAvailable(res, scope)) {
    return { ok: false, scope };
  }

  const providerExists = await queryable.query(
    `
      SELECT id_proveedor
      FROM ${TABLA_PROVEEDORES}
      WHERE id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );

  if (!providerExists.rows?.length) {
    sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    return { ok: false, scope };
  }

  if (scope.isSuperAdmin) {
    return { ok: true, scope };
  }

  const scopeMapResult = await fetchProveedoresOperationalScopeMap(queryable, [idProveedor]);
  if (!scopeMapResult.available) {
    return { ok: true, scope };
  }

  const scopedSucursales = scopeMapResult.map.get(idProveedor) || [];
  if (scopedSucursales.length === 0) {
    return { ok: true, scope };
  }

  if (!hasSucursalScopeIntersection(scopedSucursales, scope.allowedSucursalIds)) {
    if (maskAsNotFound) {
      sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    } else {
      sendError(res, 403, 'FORBIDDEN', PROVEEDORES_SCOPE_FORBIDDEN_MESSAGE);
    }
    return { ok: false, scope };
  }

  return { ok: true, scope };
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

const parseBooleanState = (rawValue, fieldName = 'estado') => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  if (rawValue === true || rawValue === 1 || rawValue === '1') return { ok: true, value: true };
  if (rawValue === false || rawValue === 0 || rawValue === '0') return { ok: true, value: false };

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false, error: `${fieldName} invalido.` };
};

const parseOptionalText = (rawValue, fieldName, { max = 255 } = {}) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const value = String(rawValue).trim();
  if (!value) return { ok: true, value: null };
  if (value.length > max) {
    return { ok: false, error: `${fieldName} no puede superar ${max} caracteres.` };
  }
  return { ok: true, value };
};

const parseNombreProveedor = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: false, error: 'nombre_proveedor es obligatorio.' };
  const value = String(rawValue).trim();
  if (value.length < 2) return { ok: false, error: 'nombre_proveedor debe tener al menos 2 caracteres.' };
  if (value.length > 120) return { ok: false, error: 'nombre_proveedor no puede superar 120 caracteres.' };
  return { ok: true, value };
};

const parseOptionalEmail = (rawValue) => {
  const parsed = parseOptionalText(rawValue, 'correo_electronico', { max: 160 });
  if (!parsed.ok || !parsed.value) return parsed;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(parsed.value)) {
    return { ok: false, error: 'correo_electronico no tiene un formato valido.' };
  }
  return parsed;
};

const parsePlazoPago = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
    return { ok: false, error: 'plazo_pago_dias debe ser un entero mayor o igual a 0.' };
  }
  if (normalizedValue > 3650) {
    return { ok: false, error: 'plazo_pago_dias no puede superar 3650 dias.' };
  }
  return { ok: true, value: normalizedValue };
};

const CUENTA_TIPOS_VALIDOS = new Set(['AHORRO', 'CHEQUES', 'OTRA']);
const CUENTA_MONEDAS_VALIDAS = new Set(['HNL', 'USD']);

// AM: valida y normaliza una cuenta bancaria de proveedor.
const normalizeCuentaBancariaPayload = (rawCuenta, index) => {
  const cuenta = rawCuenta && typeof rawCuenta === 'object' ? rawCuenta : {};
  const errors = {};
  const cuentaIdParsed = parseOptionalPositiveInt(cuenta?.id_cuenta_bancaria, 'id_cuenta_bancaria');

  const banco = String(cuenta?.banco ?? '').trim();
  const tipoCuenta = String(cuenta?.tipo_cuenta ?? '').trim().toUpperCase();
  const numeroCuenta = String(cuenta?.numero_cuenta ?? '').trim();
  const nombreTitular = parseOptionalText(cuenta?.nombre_titular, 'nombre_titular', { max: 120 });
  const identificacionTitular = parseOptionalText(cuenta?.identificacion_titular, 'identificacion_titular', {
    max: 60
  });
  const monedaRaw = String(cuenta?.moneda ?? 'HNL').trim().toUpperCase();
  const esPrincipalParsed = parseBooleanState(cuenta?.es_principal, 'es_principal');
  const observacion = parseOptionalText(cuenta?.observacion, 'observacion', { max: 255 });

  if (!banco) errors.banco = `cuentas_bancarias[${index}].banco es obligatorio.`;
  else if (banco.length > 120) errors.banco = `cuentas_bancarias[${index}].banco no puede superar 120 caracteres.`;

  if (!tipoCuenta) errors.tipo_cuenta = `cuentas_bancarias[${index}].tipo_cuenta es obligatorio.`;
  else if (!CUENTA_TIPOS_VALIDOS.has(tipoCuenta)) {
    errors.tipo_cuenta = `cuentas_bancarias[${index}].tipo_cuenta debe ser AHORRO, CHEQUES u OTRA.`;
  }

  if (!numeroCuenta) errors.numero_cuenta = `cuentas_bancarias[${index}].numero_cuenta es obligatorio.`;
  else if (numeroCuenta.length > 80) {
    errors.numero_cuenta = `cuentas_bancarias[${index}].numero_cuenta no puede superar 80 caracteres.`;
  }

  if (!CUENTA_MONEDAS_VALIDAS.has(monedaRaw)) {
    errors.moneda = `cuentas_bancarias[${index}].moneda debe ser HNL o USD.`;
  }

  if (!cuentaIdParsed.ok) {
    errors.id_cuenta_bancaria = `cuentas_bancarias[${index}].${cuentaIdParsed.error}`;
  }
  if (!nombreTitular.ok) errors.nombre_titular = `cuentas_bancarias[${index}].${nombreTitular.error}`;
  if (!identificacionTitular.ok) {
    errors.identificacion_titular = `cuentas_bancarias[${index}].${identificacionTitular.error}`;
  }
  if (!esPrincipalParsed.ok) errors.es_principal = `cuentas_bancarias[${index}].${esPrincipalParsed.error}`;
  if (!observacion.ok) errors.observacion = `cuentas_bancarias[${index}].${observacion.error}`;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    cuenta: {
      id_cuenta_bancaria: cuentaIdParsed.value ?? null,
      banco,
      tipo_cuenta: tipoCuenta,
      numero_cuenta: numeroCuenta,
      nombre_titular: nombreTitular.value ?? null,
      identificacion_titular: identificacionTitular.value ?? null,
      moneda: monedaRaw,
      es_principal: esPrincipalParsed.value === true,
      estado: parseBooleanState(cuenta?.estado, 'estado').value !== false,
      observacion: observacion.value ?? null
    }
  };
};

// AM: valida arreglo de cuentas bancarias para alta/edicion de proveedor.
const normalizeCuentasBancariasPayload = (rawCuentas) => {
  if (rawCuentas === undefined) return { ok: true, cuentas: [], provided: false };
  if (rawCuentas === null) return { ok: true, cuentas: [], provided: true };
  if (!Array.isArray(rawCuentas)) {
    return {
      ok: false,
      errors: {
        cuentas_bancarias: 'cuentas_bancarias debe ser un arreglo.'
      }
    };
  }

  const normalized = [];
  const errors = {};
  const accountKeys = new Set();
  const accountIds = new Set();
  let principalCount = 0;

  rawCuentas.forEach((cuenta, index) => {
    const parsed = normalizeCuentaBancariaPayload(cuenta, index);
    if (!parsed.ok) {
      Object.assign(errors, parsed.errors);
      return;
    }

    const accountKey = `${parsed.cuenta.numero_cuenta}`.toUpperCase();
    if (accountKeys.has(accountKey)) {
      errors[`cuentas_bancarias_${index}_duplicado`] = `cuentas_bancarias[${index}] repite numero_cuenta.`;
      return;
    }

    const accountId = Number(parsed.cuenta.id_cuenta_bancaria ?? 0);
    if (accountId > 0) {
      if (accountIds.has(accountId)) {
        errors[`cuentas_bancarias_${index}_id_duplicado`] =
          `cuentas_bancarias[${index}] repite id_cuenta_bancaria.`;
        return;
      }
      accountIds.add(accountId);
    }

    accountKeys.add(accountKey);
    if (parsed.cuenta.es_principal) principalCount += 1;
    normalized.push(parsed.cuenta);
  });

  if (principalCount > 1) {
    errors.cuentas_bancarias = 'Solo se permite una cuenta principal por proveedor.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    cuentas: normalized,
    provided: true
  };
};

const findProveedorById = async (queryable, idProveedor) => {
  const result = await queryable.query(
    `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        p.xmin::text AS concurrency_token,
        p.nombre_proveedor,
        p.id_persona,
        p.id_empresa,
        p.correo_electronico,
        p.telefono_principal,
        p.telefono_secundario,
        p.contacto_principal,
        p.direccion,
        p.ciudad,
        p.rtn,
        p.plazo_pago_dias,
        p.observaciones,
        COALESCE(p.estado, true) AS estado,
        p.fecha_registro,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count,
        (
          COALESCE(cd.compras_count, 0) = 0
          AND COALESCE(kd.cuentas_bancarias_count, 0) = 0
        ) AS can_delete
      FROM public.proveedores p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE p.id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );
  const row = result.rows?.[0] || null;
  if (!row) return null;

  const [enriched] = await enrichProveedorRowsWithLifecycle(queryable, [row]);
  return enriched || row;
};

const listCuentasBancariasByProveedor = async (queryable, idProveedor) => {
  const result = await queryable.query(
    `
      SELECT
        id_cuenta_bancaria,
        id_proveedor,
        banco,
        UPPER(tipo_cuenta) AS tipo_cuenta,
        numero_cuenta,
        nombre_titular,
        identificacion_titular,
        UPPER(moneda) AS moneda,
        COALESCE(es_principal, false) AS es_principal,
        COALESCE(estado, true) AS estado,
        observacion,
        fecha_registro
      FROM public.proveedores_cuentas_bancarias
      WHERE id_proveedor = $1
      ORDER BY COALESCE(es_principal, false) DESC, id_cuenta_bancaria ASC
    `,
    [idProveedor]
  );

  return result.rows || [];
};

const insertCuentaBancariaProveedor = async (queryable, idProveedor, cuenta) => {
  await queryable.query(
    `
      INSERT INTO public.proveedores_cuentas_bancarias (
        id_proveedor,
        banco,
        tipo_cuenta,
        numero_cuenta,
        nombre_titular,
        identificacion_titular,
        moneda,
        es_principal,
        estado,
        observacion
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `,
    [
      idProveedor,
      cuenta.banco,
      cuenta.tipo_cuenta,
      cuenta.numero_cuenta,
      cuenta.nombre_titular ?? null,
      cuenta.identificacion_titular ?? null,
      cuenta.moneda,
      cuenta.es_principal === true,
      cuenta.estado !== false,
      cuenta.observacion ?? null
    ]
  );
};

const insertCuentasBancariasProveedor = async (queryable, idProveedor, cuentas) => {
  for (const cuenta of Array.isArray(cuentas) ? cuentas : []) {
    await insertCuentaBancariaProveedor(queryable, idProveedor, cuenta);
  }
};

const syncCuentasBancariasProveedor = async (queryable, idProveedor, cuentas) => {
  const cuentasPayload = Array.isArray(cuentas) ? cuentas : [];
  const existingRows = await listCuentasBancariasByProveedor(queryable, idProveedor);

  const existingById = new Map();
  const existingByNumero = new Map();
  for (const row of existingRows) {
    const accountId = Number(row?.id_cuenta_bancaria ?? 0);
    if (accountId > 0) {
      existingById.set(accountId, row);
    }

    const numeroKey = String(row?.numero_cuenta ?? '').trim().toUpperCase();
    if (numeroKey && !existingByNumero.has(numeroKey)) {
      existingByNumero.set(numeroKey, row);
    }
  }

  const retainedIds = new Set();
  const summary = {
    inserted: 0,
    updated: 0,
    inactivated: 0
  };

  for (const cuenta of cuentasPayload) {
    const payloadId = Number(cuenta?.id_cuenta_bancaria ?? 0);
    const numeroKey = String(cuenta?.numero_cuenta ?? '').trim().toUpperCase();

    let targetRow = null;
    if (payloadId > 0) {
      targetRow = existingById.get(payloadId) || null;
      if (!targetRow) {
        return {
          ok: false,
          reason: 'ACCOUNT_NOT_OWNED',
          accountId: payloadId
        };
      }
    } else if (numeroKey && existingByNumero.has(numeroKey)) {
      const matchedByNumero = existingByNumero.get(numeroKey);
      const matchedAccountId = Number(matchedByNumero?.id_cuenta_bancaria ?? 0);
      if (matchedAccountId > 0 && !retainedIds.has(matchedAccountId)) {
        targetRow = matchedByNumero;
      }
    }

    if (targetRow) {
      const targetAccountId = Number(targetRow?.id_cuenta_bancaria ?? 0);
      if (!targetAccountId) {
        return {
          ok: false,
          reason: 'ACCOUNT_NOT_OWNED',
          accountId: payloadId || null
        };
      }
      if (retainedIds.has(targetAccountId)) {
        return {
          ok: false,
          reason: 'DUPLICATED_ACCOUNT_ID',
          accountId: targetAccountId
        };
      }

      retainedIds.add(targetAccountId);
      const updateCuentaResult = await queryable.query(
        `
          UPDATE public.proveedores_cuentas_bancarias
          SET
            banco = $3,
            tipo_cuenta = $4,
            numero_cuenta = $5,
            nombre_titular = $6,
            identificacion_titular = $7,
            moneda = $8,
            es_principal = $9,
            estado = $10,
            observacion = $11
          WHERE id_proveedor = $1
            AND id_cuenta_bancaria = $2
        `,
        [
          idProveedor,
          targetAccountId,
          cuenta.banco,
          cuenta.tipo_cuenta,
          cuenta.numero_cuenta,
          cuenta.nombre_titular ?? null,
          cuenta.identificacion_titular ?? null,
          cuenta.moneda,
          cuenta.es_principal === true,
          cuenta.estado !== false,
          cuenta.observacion ?? null
        ]
      );
      if (!updateCuentaResult.rows?.length && Number(updateCuentaResult.rowCount ?? 0) === 0) {
        return {
          ok: false,
          reason: 'ACCOUNT_NOT_OWNED',
          accountId: targetAccountId
        };
      }
      summary.updated += 1;
      continue;
    }

    await insertCuentaBancariaProveedor(queryable, idProveedor, cuenta);
    summary.inserted += 1;
  }

  const removedIds = Array.from(existingById.keys()).filter((accountId) => !retainedIds.has(accountId));
  if (removedIds.length > 0) {
    const inactivateResult = await queryable.query(
      `
        UPDATE public.proveedores_cuentas_bancarias
        SET
          estado = false,
          es_principal = false
        WHERE id_proveedor = $1
          AND id_cuenta_bancaria = ANY($2::int[])
          AND (
            COALESCE(estado, true) = true
            OR COALESCE(es_principal, false) = true
          )
      `,
      [idProveedor, removedIds]
    );
    summary.inactivated = Number(inactivateResult.rowCount ?? 0);
  }

  return {
    ok: true,
    summary
  };
};

// AM: normaliza payload de proveedores para create/update con validacion de tipos y longitudes.
const normalizeProveedorPayload = (rawPayload, { partial = false } = {}) => {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const cleaned = {};
  const errors = {};

  const assignIfPresent = (key, parser) => {
    if (!partial || Object.prototype.hasOwnProperty.call(payload, key)) {
      const parsed = parser(payload[key]);
      if (!parsed.ok) {
        errors[key] = parsed.error;
      } else if (parsed.value !== null) {
        cleaned[key] = parsed.value;
      } else if (partial) {
        cleaned[key] = null;
      }
    }
  };

  assignIfPresent('nombre_proveedor', parseNombreProveedor);
  assignIfPresent('id_persona', (value) => parseOptionalPositiveInt(value, 'id_persona'));
  assignIfPresent('id_empresa', (value) => parseOptionalPositiveInt(value, 'id_empresa'));
  assignIfPresent('correo_electronico', parseOptionalEmail);
  assignIfPresent('telefono_principal', (value) =>
    parseOptionalText(value, 'telefono_principal', { max: 30 })
  );
  assignIfPresent('telefono_secundario', (value) =>
    parseOptionalText(value, 'telefono_secundario', { max: 30 })
  );
  assignIfPresent('contacto_principal', (value) =>
    parseOptionalText(value, 'contacto_principal', { max: 120 })
  );
  assignIfPresent('direccion', (value) => parseOptionalText(value, 'direccion', { max: 240 }));
  assignIfPresent('ciudad', (value) => parseOptionalText(value, 'ciudad', { max: 120 }));
  assignIfPresent('rtn', (value) => parseOptionalText(value, 'rtn', { max: 30 }));
  assignIfPresent('plazo_pago_dias', parsePlazoPago);
  assignIfPresent('observaciones', (value) => parseOptionalText(value, 'observaciones', { max: 500 }));
  assignIfPresent('estado', (value) => parseBooleanState(value, 'estado'));

  if (!partial && !Object.prototype.hasOwnProperty.call(cleaned, 'estado')) {
    cleaned.estado = true;
  }

  if (!partial && !Object.prototype.hasOwnProperty.call(cleaned, 'plazo_pago_dias')) {
    cleaned.plazo_pago_dias = 0;
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    cleaned
  };
};

const getProveedorDependenciasById = async (idProveedor) => {
  const dependencyResult = await pool.query(
    `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        p.xmin::text AS concurrency_token,
        COALESCE(p.estado, true) AS estado,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count
      FROM public.proveedores p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE p.id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );

  const row = dependencyResult.rows?.[0];
  if (!row) return { exists: false };
  const [enriched] = await enrichProveedorRowsWithLifecycle(pool, [row]);

  const counts = {
    compras: Number(enriched?.compras_count ?? 0),
    cuentas_bancarias: Number(enriched?.cuentas_bancarias_count ?? 0),
    ordenes_historial: Number(enriched?.ordenes_historial_count ?? 0),
    ordenes_activas: Number(enriched?.ordenes_activas_count ?? 0)
  };

  return {
    exists: true,
    id_proveedor: Number(row.id_proveedor),
    concurrency_token: String(row.concurrency_token || ''),
    estado: Boolean(row.estado),
    counts,
    canDelete: Boolean(enriched?.can_delete),
    canDeactivate: Boolean(enriched?.can_deactivate),
    hasOperationalHistory: Boolean(enriched?.has_operational_history),
    hasActiveProcesses: Boolean(enriched?.has_active_processes),
    blockingReasons: uniqueNonEmptyStrings(enriched?.blocking_reasons || []),
    deleteBlockingReasons: uniqueNonEmptyStrings(enriched?.delete_blocking_reasons || []),
    deactivateBlockingReasons: uniqueNonEmptyStrings(enriched?.deactivate_blocking_reasons || []),
    checks: enriched?.dependency_checks || {
      ordenes_compra_disponible: true
    }
  };
};

const normalizeProveedorMutationError = (error) => {
  switch (error?.code) {
    case '23503':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Existe un valor relacionado que no esta registrado en catalogos.'
      };
    case '23505':
      if (String(error?.constraint || '').trim() === 'uq_prov_numero_cuenta') {
        return {
          status: 409,
          code: 'CONFLICT',
          message: 'No se puede repetir numero_cuenta para el mismo proveedor.'
        };
      }
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'Ya existe un proveedor con los datos enviados.'
      };
    case '22P02':
    case '22003':
    case '23514':
    case '428C9':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Los datos enviados no son validos.'
      };
    default:
      return null;
  }
};

const sendProveedorMutationError = (res, context, error) => {
  const normalized = normalizeProveedorMutationError(error);
  if (normalized) {
    logRouterError(context, error, { category: 'MUTATION_ERROR' });
    return sendError(res, normalized.status, normalized.code, normalized.message);
  }
  return sendInternalError(res, context, error);
};

const executeProveedorUpdate = async (
  idProveedor,
  cleanedFields,
  { queryable = pool, concurrencyToken = null } = {}
) => {
  const entries = Object.entries(cleanedFields).filter(([field]) => PROVEEDOR_EDITABLE_FIELDS.has(field));
  if (!entries.length) return { updated: false, reason: 'NO_FIELDS' };

  const setParts = [];
  const values = [idProveedor];
  let paramIndex = 2;

  for (const [field, value] of entries) {
    setParts.push(`${field} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  }

  let whereClause = 'id_proveedor = $1';
  if (concurrencyToken !== null && concurrencyToken !== undefined) {
    whereClause += ` AND xmin::text = $${paramIndex}`;
    values.push(String(concurrencyToken));
    paramIndex += 1;
  }

  const query = `
    UPDATE ${TABLA_PROVEEDORES}
    SET ${setParts.join(', ')}
    WHERE ${whereClause}
    RETURNING
      id_proveedor,
      xmin::text AS concurrency_token,
      nombre_proveedor,
      id_persona,
      id_empresa,
      correo_electronico,
      telefono_principal,
      telefono_secundario,
      contacto_principal,
      direccion,
      ciudad,
      rtn,
      plazo_pago_dias,
      observaciones,
      COALESCE(estado, true) AS estado,
      fecha_registro
  `;

  const result = await queryable.query(query, values);
  if (!result.rows?.length) {
    const currentResult = await queryable.query(
      `
        SELECT id_proveedor, xmin::text AS concurrency_token
        FROM ${TABLA_PROVEEDORES}
        WHERE id_proveedor = $1
        LIMIT 1
      `,
      [idProveedor]
    );
    const currentRow = currentResult.rows?.[0] || null;
    if (!currentRow) return { updated: false, reason: 'NOT_FOUND' };

    if (concurrencyToken !== null && concurrencyToken !== undefined) {
      return {
        updated: false,
        reason: 'CONCURRENCY_CONFLICT',
        currentConcurrencyToken: String(currentRow.concurrency_token || '')
      };
    }

    return { updated: false, reason: 'NOT_FOUND' };
  }

  return { updated: true, row: result.rows[0] };
};

const touchProveedorByConcurrency = async (idProveedor, concurrencyToken, queryable = pool) => {
  const touchResult = await queryable.query(
    `
      UPDATE ${TABLA_PROVEEDORES}
      SET nombre_proveedor = nombre_proveedor
      WHERE id_proveedor = $1
        AND xmin::text = $2
      RETURNING id_proveedor, xmin::text AS concurrency_token
    `,
    [idProveedor, String(concurrencyToken)]
  );

  if (touchResult.rows?.length) {
    return { touched: true, concurrencyToken: String(touchResult.rows[0].concurrency_token || '') };
  }

  const currentResult = await queryable.query(
    `
      SELECT id_proveedor, xmin::text AS concurrency_token
      FROM ${TABLA_PROVEEDORES}
      WHERE id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );
  const currentRow = currentResult.rows?.[0] || null;
  if (!currentRow) {
    return { touched: false, reason: 'NOT_FOUND' };
  }

  return {
    touched: false,
    reason: 'CONCURRENCY_CONFLICT',
    currentConcurrencyToken: String(currentRow.concurrency_token || '')
  };
};

const executeProveedorDelete = async (idProveedor) => {
  const dependency = await getProveedorDependenciasById(idProveedor);
  if (!dependency.exists) return { deleted: false, reason: 'NOT_FOUND' };
  if (!dependency.canDelete) {
    return {
      deleted: false,
      reason: 'DEPENDENCIES',
      dependency
    };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // AM: si no hay historial operativo, limpiar cuentas bancarias para permitir eliminacion segura.
    if (Number(dependency?.counts?.cuentas_bancarias ?? 0) > 0) {
      await client.query('DELETE FROM public.proveedores_cuentas_bancarias WHERE id_proveedor = $1', [idProveedor]);
    }

    const deleteResult = await client.query(
      `
        DELETE FROM ${TABLA_PROVEEDORES}
        WHERE id_proveedor = $1
        RETURNING id_proveedor, nombre_proveedor
      `,
      [idProveedor]
    );

    if (!deleteResult.rows?.length) {
      await client.query('ROLLBACK');
      return { deleted: false, reason: 'NOT_FOUND' };
    }

    await client.query('COMMIT');
    return { deleted: true, row: deleteResult.rows[0] };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    throw error;
  } finally {
    client.release();
  }
};

// GET: listado operativo de proveedores (con dependencias y opcion de incluir inactivos).
router.get('/proveedores', checkPermission(PROVEEDORES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(req.query?.include_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const scope = await getRequestProveedoresScope(req);
    if (!ensureProveedoresScopeAvailable(res, scope)) {
      return;
    }

    const query = `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        p.xmin::text AS concurrency_token,
        p.nombre_proveedor,
        p.id_persona,
        p.id_empresa,
        p.correo_electronico,
        p.telefono_principal,
        p.telefono_secundario,
        p.contacto_principal,
        p.direccion,
        p.ciudad,
        p.rtn,
        p.plazo_pago_dias,
        p.observaciones,
        COALESCE(p.estado, true) AS estado,
        p.fecha_registro,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count,
        (
          COALESCE(cd.compras_count, 0) = 0
          AND COALESCE(kd.cuentas_bancarias_count, 0) = 0
        ) AS can_delete
      FROM ${TABLA_PROVEEDORES} p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE ($1::boolean = true OR COALESCE(p.estado, true) = true)
      ORDER BY p.id_proveedor ASC
    `;

    const result = await pool.query(query, [includeInactivosResult.value]);
    const enrichedRows = await enrichProveedorRowsWithLifecycle(pool, result.rows || []);
    const scopedRows = await filterProveedoresByScope(pool, enrichedRows, scope);
    return res.status(200).json(scopedRows);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener proveedores', error);
  }
});

// GET: dependencias por proveedor (para decidir eliminar vs inactivar).
router.get('/proveedores/:id/dependencias', checkPermission(PROVEEDORES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;

    const dependency = await getProveedorDependenciasById(idResult.value);
    if (!dependency.exists) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);

    return res.status(200).json({
      ok: true,
      id_proveedor: dependency.id_proveedor,
      concurrency_token: dependency.concurrency_token,
      estado: dependency.estado,
      counts: dependency.counts,
      canDelete: dependency.canDelete,
      canDeactivate: dependency.canDeactivate,
      hasOperationalHistory: dependency.hasOperationalHistory,
      hasActiveProcesses: dependency.hasActiveProcesses,
      blockingReasons: dependency.blockingReasons,
      deleteBlockingReasons: dependency.deleteBlockingReasons,
      deactivateBlockingReasons: dependency.deactivateBlockingReasons,
      checks: dependency.checks
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener dependencias de proveedor', error);
  }
});

// AM: detalle operativo por proveedor con todas sus cuentas bancarias.
router.get('/proveedores/:id', checkPermission(PROVEEDORES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;

    const proveedor = await findProveedorById(pool, idResult.value);
    if (!proveedor) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);

    const cuentas = await listCuentasBancariasByProveedor(pool, idResult.value);

    return res.status(200).json({
      ok: true,
      data: {
        ...proveedor,
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener detalle de proveedor', error);
  }
});

// POST: crear proveedor.
router.post('/proveedores', checkPermission(PROVEEDORES_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const scope = await getRequestProveedoresScope(req, client);
    if (!ensureProveedoresScopeAvailable(res, scope)) {
      return;
    }

    const cuentasValidation = normalizeCuentasBancariasPayload(req.body?.cuentas_bancarias);
    if (!cuentasValidation.ok) {
      return sendValidationError(
        res,
        'Datos invalidos en cuentas bancarias del proveedor.',
        cuentasValidation.errors
      );
    }

    const validation = normalizeProveedorPayload(req.body, { partial: false });
    if (!validation.ok) {
      return sendValidationError(res, 'Datos invalidos para crear proveedor.', validation.errors);
    }

    await client.query('BEGIN');
    const proveedor = validation.cleaned;
    const insertResult = await client.query(
      `
        INSERT INTO ${TABLA_PROVEEDORES} (
          nombre_proveedor,
          id_persona,
          id_empresa,
          correo_electronico,
          telefono_principal,
          telefono_secundario,
          contacto_principal,
          direccion,
          ciudad,
          rtn,
          plazo_pago_dias,
          observaciones,
          estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING
          id_proveedor,
          xmin::text AS concurrency_token,
          nombre_proveedor,
          id_persona,
          id_empresa,
          correo_electronico,
          telefono_principal,
          telefono_secundario,
          contacto_principal,
          direccion,
          ciudad,
          rtn,
          plazo_pago_dias,
          observaciones,
          COALESCE(estado, true) AS estado,
          fecha_registro
      `,
      [
        proveedor.nombre_proveedor,
        proveedor.id_persona ?? null,
        proveedor.id_empresa ?? null,
        proveedor.correo_electronico ?? null,
        proveedor.telefono_principal ?? null,
        proveedor.telefono_secundario ?? null,
        proveedor.contacto_principal ?? null,
        proveedor.direccion ?? null,
        proveedor.ciudad ?? null,
        proveedor.rtn ?? null,
        proveedor.plazo_pago_dias ?? 0,
        proveedor.observaciones ?? null,
        proveedor.estado ?? true
      ]
    );

    const idProveedor = Number(insertResult.rows?.[0]?.id_proveedor ?? 0);

    // AM: guarda cuentas bancarias en la misma transaccion para mantener integridad.
    if (cuentasValidation.provided) {
      await insertCuentasBancariasProveedor(client, idProveedor, cuentasValidation.cuentas);
    }

    const cuentas = await listCuentasBancariasByProveedor(client, idProveedor);

    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: 'Proveedor creado correctamente.',
      data: {
        ...(insertResult.rows?.[0] || {}),
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    return sendProveedorMutationError(res, 'Error al crear proveedor', error);
  } finally {
    client.release();
  }
});

// PUT moderno: actualizar proveedor por id.
router.put('/proveedores/:id', checkPermission(PROVEEDORES_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: client,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;
    const concurrencyTokenResult = parseConcurrencyToken(
      resolveConcurrencyTokenFromPayload(req.body),
      'concurrency_token'
    );
    if (!concurrencyTokenResult.ok) {
      return sendValidationError(res, concurrencyTokenResult.error);
    }

    const cuentasValidation = normalizeCuentasBancariasPayload(req.body?.cuentas_bancarias);
    if (!cuentasValidation.ok) {
      return sendValidationError(
        res,
        'Datos invalidos en cuentas bancarias del proveedor.',
        cuentasValidation.errors
      );
    }

    const validation = normalizeProveedorPayload(req.body, { partial: true });
    if (!validation.ok) {
      return sendValidationError(res, 'Datos invalidos para actualizar proveedor.', validation.errors);
    }

    const hasProveedorFields = Object.keys(validation.cleaned).length > 0;
    const hasCuentasPayload = cuentasValidation.provided;

    if (!hasProveedorFields && !hasCuentasPayload) {
      return sendValidationError(res, 'Debes enviar al menos un campo editable o cuentas_bancarias.');
    }

    await client.query('BEGIN');

    let updateResult = { updated: true, row: null };

    if (hasProveedorFields) {
      updateResult = await executeProveedorUpdate(idResult.value, validation.cleaned, {
        queryable: client,
        concurrencyToken: concurrencyTokenResult.value
      });
      if (!updateResult.updated && updateResult.reason === 'NO_FIELDS') {
        await client.query('ROLLBACK');
        return sendValidationError(res, 'No se detectaron campos editables para actualizar.');
      }
      if (!updateResult.updated && updateResult.reason === 'NOT_FOUND') {
        await client.query('ROLLBACK');
        return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
      }
      if (!updateResult.updated && updateResult.reason === 'CONCURRENCY_CONFLICT') {
        await client.query('ROLLBACK');
        return sendConcurrencyConflictError(res, PROVEEDOR_CONCURRENCY_CONFLICT_MESSAGE, {
          id_proveedor: idResult.value,
          current_concurrency_token: updateResult.currentConcurrencyToken || ''
        });
      }
    } else {
      const touchResult = await touchProveedorByConcurrency(
        idResult.value,
        concurrencyTokenResult.value,
        client
      );
      if (!touchResult.touched && touchResult.reason === 'NOT_FOUND') {
        await client.query('ROLLBACK');
        return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
      }
      if (!touchResult.touched && touchResult.reason === 'CONCURRENCY_CONFLICT') {
        await client.query('ROLLBACK');
        return sendConcurrencyConflictError(res, PROVEEDOR_CONCURRENCY_CONFLICT_MESSAGE, {
          id_proveedor: idResult.value,
          current_concurrency_token: touchResult.currentConcurrencyToken || ''
        });
      }
    }

    if (hasCuentasPayload) {
      const syncResult = await syncCuentasBancariasProveedor(
        client,
        idResult.value,
        cuentasValidation.cuentas
      );
      if (!syncResult.ok && syncResult.reason === 'ACCOUNT_NOT_OWNED') {
        await client.query('ROLLBACK');
        return sendValidationError(
          res,
          'Una o mas cuentas bancarias no pertenecen al proveedor indicado.',
          { id_cuenta_bancaria: syncResult.accountId ?? null }
        );
      }
      if (!syncResult.ok && syncResult.reason === 'DUPLICATED_ACCOUNT_ID') {
        await client.query('ROLLBACK');
        return sendValidationError(
          res,
          'No se permite repetir id_cuenta_bancaria dentro del mismo proveedor.',
          { id_cuenta_bancaria: syncResult.accountId ?? null }
        );
      }
      if (!syncResult.ok) {
        await client.query('ROLLBACK');
        return sendValidationError(res, 'No se pudo validar el cambio de cuentas bancarias del proveedor.');
      }
    }

    const proveedor = await findProveedorById(client, idResult.value);
    const cuentas = await listCuentasBancariasByProveedor(client, idResult.value);

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Proveedor actualizado correctamente.',
      data: {
        ...(proveedor || updateResult.row || {}),
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    return sendProveedorMutationError(res, 'Error al actualizar proveedor', error);
  } finally {
    client.release();
  }
});

// PUT legacy: actualizacion de un solo campo con contrato previo.
router.put('/proveedores', checkPermission(PROVEEDORES_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const payloadRaw = req.body && typeof req.body === 'object' ? req.body : {};
    const { campo, valor, id_campo, id_valor } = payloadRaw;
    if (!hasValue(campo) || !hasValue(id_campo) || !hasValue(id_valor)) {
      return sendValidationError(res, 'Faltan campos obligatorios para el formato legacy.');
    }

    if (String(id_campo).trim() !== 'id_proveedor') {
      return sendValidationError(res, "id_campo debe ser 'id_proveedor'.");
    }

    if (!PROVEEDOR_EDITABLE_FIELDS.has(String(campo).trim())) {
      return sendValidationError(res, `Campo no permitido para actualizar: ${campo}.`);
    }

    const idResult = parsePositiveInt(id_valor, 'id_valor');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;
    const concurrencyTokenResult = parseConcurrencyToken(
      resolveConcurrencyTokenFromPayload(payloadRaw),
      'concurrency_token'
    );
    if (!concurrencyTokenResult.ok) {
      return sendValidationError(res, concurrencyTokenResult.error);
    }

    const payload = { [String(campo).trim()]: valor };
    const validation = normalizeProveedorPayload(payload, { partial: true });
    if (!validation.ok) {
      return sendValidationError(res, 'Valor invalido para el campo solicitado.', validation.errors);
    }

    const updateResult = await executeProveedorUpdate(idResult.value, validation.cleaned, {
      concurrencyToken: concurrencyTokenResult.value
    });
    if (!updateResult.updated && updateResult.reason === 'NOT_FOUND') {
      return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    }
    if (!updateResult.updated && updateResult.reason === 'NO_FIELDS') {
      return sendValidationError(res, 'No se detectaron campos validos para actualizar.');
    }
    if (!updateResult.updated && updateResult.reason === 'CONCURRENCY_CONFLICT') {
      return sendConcurrencyConflictError(res, PROVEEDOR_CONCURRENCY_CONFLICT_MESSAGE, {
        id_proveedor: idResult.value,
        current_concurrency_token: updateResult.currentConcurrencyToken || ''
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Proveedor actualizado correctamente.',
      data: updateResult.row
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al actualizar proveedor (legacy)', error);
  }
});

// PATCH: inactivar proveedor.
router.patch('/proveedores/:id/inactivar', checkPermission(PROVEEDORES_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;

    const current = await pool.query(
      `SELECT id_proveedor, COALESCE(estado, true) AS estado
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );

    if (!current.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    const wasActive = Boolean(current.rows[0].estado);

    if (wasActive) {
      const dependency = await getProveedorDependenciasById(idResult.value);
      if (!dependency.exists) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);

      if (!dependency.canDeactivate) {
        return sendConflictError(
          res,
          dependency.deactivateBlockingReasons?.[0] || PROVEEDOR_DEACTIVATE_ACTIVE_PROCESS_BLOCK_MESSAGE,
          {
            counts: dependency.counts,
            canDeactivate: dependency.canDeactivate,
            hasActiveProcesses: dependency.hasActiveProcesses,
            blockingReasons: dependency.deactivateBlockingReasons?.length
              ? dependency.deactivateBlockingReasons
              : dependency.blockingReasons,
            checks: dependency.checks
          }
        );
      }

      const updateResult = await pool.query(
        `UPDATE ${TABLA_PROVEEDORES}
         SET estado = false
         WHERE id_proveedor = $1
         RETURNING id_proveedor`,
        [idResult.value]
      );

      if (!updateResult.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    }

    return res.status(200).json({
      ok: true,
      id_proveedor: idResult.value,
      estado: false,
      message: wasActive ? 'Proveedor inactivado correctamente.' : 'El proveedor ya estaba inactivo.'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al inactivar proveedor', error);
  }
});

// PATCH: reactivar proveedor.
router.patch('/proveedores/:id/reactivar', checkPermission(PROVEEDORES_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;

    const current = await pool.query(
      `SELECT id_proveedor, COALESCE(estado, true) AS estado
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );

    if (!current.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    const wasActive = Boolean(current.rows[0].estado);

    if (!wasActive) {
      const updateResult = await pool.query(
        `UPDATE ${TABLA_PROVEEDORES}
         SET estado = true
         WHERE id_proveedor = $1
         RETURNING id_proveedor`,
        [idResult.value]
      );

      if (!updateResult.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);
    }

    return res.status(200).json({
      ok: true,
      id_proveedor: idResult.value,
      estado: true,
      message: wasActive ? 'El proveedor ya estaba activo.' : 'Proveedor reactivado correctamente.'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al reactivar proveedor', error);
  }
});

// DELETE moderno: no operativo para borrado fisico de proveedores.
router.delete('/proveedores/:id', checkPermission(PROVEEDORES_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;
    const current = await pool.query(
      `SELECT id_proveedor
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );
    if (!current.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);

    return sendConflictError(res, PROVEEDOR_PHYSICAL_DELETE_DISABLED_MESSAGE, {
      id_proveedor: idResult.value,
      suggestedAction: 'inactivar'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al eliminar proveedor', error);
  }
});

// DELETE legacy: no operativo para borrado fisico de proveedores.
router.delete('/proveedores', checkPermission(PROVEEDORES_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};
    if (!hasValue(columna_id) || !hasValue(valor_id)) {
      return sendValidationError(res, 'Faltan datos para eliminar (formato legacy).');
    }
    if (String(columna_id).trim() !== 'id_proveedor') {
      return sendValidationError(res, "columna_id debe ser 'id_proveedor'.");
    }

    const idResult = parsePositiveInt(valor_id, 'valor_id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);
    const scopeCheck = await assertProveedorInScope(req, res, idResult.value, {
      queryable: pool,
      maskAsNotFound: true
    });
    if (!scopeCheck.ok) return;
    const current = await pool.query(
      `SELECT id_proveedor
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );
    if (!current.rows?.length) return sendNotFoundError(res, PROVEEDORES_NOT_FOUND_MESSAGE);

    return sendConflictError(res, PROVEEDOR_PHYSICAL_DELETE_DISABLED_MESSAGE, {
      id_proveedor: idResult.value,
      suggestedAction: 'inactivar'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al eliminar proveedor (legacy)', error);
  }
});

export default router;
