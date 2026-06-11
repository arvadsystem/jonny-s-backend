import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';
import { validarYDescontarPedido } from '../services/inventarioPedidoService.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import {
  isCatalogoMaestroReadsEnabled,
  isCatalogoMaestroViewMissingError,
  logCatalogoMaestroViewMissing,
  queryCatalogoMaestroView,
  sendCatalogoMaestroViewMissingResponse
} from '../services/catalogoMaestroReadService.js';
import {
  buildCatalogoMaestroWriteStructureMissingResponse,
  completeInsumoCatalogoMaestroWrite,
  isCatalogoMaestroWriteStructureMissingError
} from '../services/catalogoMaestroWriteService.js';

const router = express.Router();
const INSUMOS_LIST_PERMISSIONS = ['INVENTARIO_INSUMOS_VER', 'INVENTARIO_INSUMOS_DETALLE_VER'];
const INSUMOS_CREATE_PERMISSIONS = ['INVENTARIO_INSUMOS_CREAR'];
const INSUMOS_EDIT_PERMISSIONS = ['INVENTARIO_INSUMOS_EDITAR'];
const INSUMOS_STATE_PERMISSIONS = ['INVENTARIO_INSUMOS_ESTADO_CAMBIAR'];
const INSUMOS_DELETE_PERMISSIONS = ['INVENTARIO_INSUMOS_ELIMINAR'];
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const INSUMOS_ALMACENES_TABLE_MISSING_CODE = 'INSUMOS_ALMACENES_TABLE_MISSING';
const INSUMOS_ALMACENES_TABLE_MISSING_MESSAGE = 'Falta una estructura requerida del sistema: tabla public.insumos_almacenes. Aplica las migraciones pendientes.';
const INSUMOS_DUPLICATE_CONSTRAINT = 'uq_insumos_nombre_categoria_unidad_norm';
const INSUMOS_DUPLICATE_MESSAGE = 'Ya existe un insumo con ese nombre en el almacÃ©n seleccionado.';
const SINGLE_ALMACEN_TEMP_MESSAGE = 'Temporalmente solo se permite un almacÃ©n por producto o insumo.';

// AM: allowlist de campos permitidos para alta/edicion controlada de insumos.
// AM: mantiene payload legacy (`id_almacen`) y habilita `id_almacenes` para asignacion multi-sucursal.
const INSUMO_IN_USE_CODE = 'INSUMO_IN_USE';
const INSUMO_IN_USE_MESSAGE = 'No se puede inactivar el insumo porque esta siendo utilizado en otros modulos del sistema.';
const INSUMOS_DEPENDENCY_ITEMS_LIMIT = 10;
const INSUMOS_DELETE_BLOCKING_OC_STATES = ['PENDIENTE', 'APROBADA', 'EN_COMPRA'];
const SQLSTATE_UNDEFINED_COLUMN = '42703';
const INSUMOS_SCOPE_MISSING_BRANCHES_MESSAGE = 'El empleado no tiene sucursales asignadas.';
const INSUMOS_DEFAULT_PAGE = 1;
const INSUMOS_DEFAULT_PAGE_SIZE = 10;
const INSUMOS_MAX_PAGE_SIZE = 100;
const INSUMOS_MAESTRO_SORT_ALLOWLIST = Object.freeze({
  recientes: 'v.id_insumo_legacy DESC',
  nombre_asc: 'LOWER(COALESCE(v.nombre_insumo, \'\')) ASC, v.id_insumo_legacy DESC',
  nombre_desc: 'LOWER(COALESCE(v.nombre_insumo, \'\')) DESC, v.id_insumo_legacy DESC',
  precio_asc: 'COALESCE(v.precio_compra, 0) ASC, v.id_insumo_legacy DESC',
  precio_desc: 'COALESCE(v.precio_compra, 0) DESC, v.id_insumo_legacy DESC',
  stock_asc: 'COALESCE(v.cantidad, 0) ASC, v.id_insumo_legacy DESC',
  stock_desc: 'COALESCE(v.cantidad, 0) DESC, v.id_insumo_legacy DESC'
});
const CAMPOS_PERMITIDOS_INSUMOS_POST = new Set([
  'nombre_insumo',
  'precio',
  'cantidad',
  'stock_minimo',
  'fecha_ingreso_insumo',
  'id_almacen',
  'id_almacenes',
  'id_categoria_insumo',
  'id_unidad_medida',
  'fecha_caducidad',
  'descripcion',
  'id_archivo_imagen_principal'
]);
const CAMPOS_PERMITIDOS_INSUMOS_PUT_EDICION = new Set([
  'nombre_insumo',
  'precio',
  'stock_minimo',
  'fecha_ingreso_insumo',
  'id_almacen',
  'id_categoria_insumo',
  'id_unidad_medida',
  'fecha_caducidad',
  'descripcion',
  'id_archivo_imagen_principal',
  'id_insumo'
]);

// NEW: permite incluir inactivos solo cuando el cliente lo solicita explicitamente.
// WHY: el listado por defecto debe devolver solo registros activos tras migrar a soft delete.
// IMPACT: mantiene compatibilidad agregando soporte opt-in `?incluir_inactivos=1`.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// AM: parse opcional de IDs positivos para filtros de catalogo por sucursal/almacen.
const parseOptionalPositiveId = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return isPositiveIntegerId(parsed) ? parsed : null;
};

const hasQueryKey = (query, key) =>
  Object.prototype.hasOwnProperty.call(query || {}, key) &&
  query[key] !== undefined &&
  query[key] !== null &&
  String(query[key]).trim() !== '';

const parsePositiveIntParam = (raw, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: true, value: fallback };
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, value: null };
  }
  return { ok: true, value: parsed };
};

const parseEstadoFiltroInsumos = (query) => {
  const raw = String(query?.estado ?? '').trim().toLowerCase();
  if (!raw) {
    return shouldIncludeInactive(query) ? 'todos' : 'activo';
  }

  if (raw === 'todos' || raw === 'all') return 'todos';
  if (raw === 'activo' || raw === 'activos' || raw === 'true' || raw === '1') return 'activo';
  if (raw === 'inactivo' || raw === 'inactivos' || raw === 'false' || raw === '0') return 'inactivo';
  return null;
};

const parseStockFiltroInsumos = (query) => {
  const raw = String(query?.stock ?? '').trim().toLowerCase();
  if (!raw || raw === 'todos' || raw === 'all') return 'todos';
  if (raw === 'con_stock' || raw === 'constock') return 'con_stock';
  if (raw === 'sin_stock' || raw === 'sinstock') return 'sin_stock';
  return null;
};

const parseSortInsumos = (query) => {
  const raw = String(query?.sort ?? query?.sortBy ?? '').trim().toLowerCase();
  if (!raw) return 'recientes';
  if (!Object.prototype.hasOwnProperty.call(INSUMOS_MAESTRO_SORT_ALLOWLIST, raw)) return null;
  return raw;
};

// NEW: normaliza el valor de `estado` para soportar boolean/string/number.
// WHY: `function_select` puede serializar booleans de distintas formas segun el entorno.
// IMPACT: solo afecta el filtrado del GET /insumos.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper para validar IDs enteros positivos.
// WHY: evitar llamadas a BD/SP con IDs invalidos y responder 400/404 de forma consistente.
// IMPACT: solo endurece requests mal formados; requests validos no cambian.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

const normalizeScopeSucursalIds = (rawIds) => Array.from(
  new Set(
    (Array.isArray(rawIds) ? rawIds : [])
      .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
      .filter((id) => isPositiveIntegerId(id))
  )
);

const getAllowedBranchIdsForInsumosUser = async (req, db = pool) => {
  if (req?.__insumosSucursalScope) {
    return req.__insumosSucursalScope;
  }

  const scope = await resolveRequestUserSucursalScope(req, db);
  const payload = {
    isSuperAdmin: Boolean(scope?.isSuperAdmin),
    allowedSucursalIds: normalizeScopeSucursalIds(scope?.allowedSucursalIds)
  };

  if (req) req.__insumosSucursalScope = payload;
  return payload;
};

// AM: normaliza lista de almacenes del item usando pivote (id_almacenes) o fallback legacy (id_almacen).
const resolveRowAlmacenes = (row) => {
  const fromArray = Array.isArray(row?.id_almacenes)
    ? row.id_almacenes
      .map((id) => Number.parseInt(String(id ?? ''), 10))
      .filter((id) => isPositiveIntegerId(id))
    : [];
  if (fromArray.length > 0) return Array.from(new Set(fromArray));

  const fallback = Number.parseInt(String(row?.id_almacen ?? ''), 10);
  return isPositiveIntegerId(fallback) ? [fallback] : [];
};

// AM: aplica filtros opcionales por id_sucursal/id_almacen para catalogos de OC sin romper contratos legacy.
const filterInsumosByCatalogScope = async (rows, query, db = pool) => {
  const idAlmacen = parseOptionalPositiveId(query?.id_almacen);
  const idSucursal = parseOptionalPositiveId(query?.id_sucursal);

  if ((query?.id_almacen ?? '') !== '' && query?.id_almacen !== undefined && idAlmacen === null) {
    return { ok: false, message: 'id_almacen invalido.' };
  }
  if ((query?.id_sucursal ?? '') !== '' && query?.id_sucursal !== undefined && idSucursal === null) {
    return { ok: false, message: 'id_sucursal invalido.' };
  }

  if (!idAlmacen && !idSucursal) return { ok: true, rows };

  let allowedWarehouseSet = null;
  if (idSucursal) {
    const allowed = await db.query(
      `
        SELECT a.id_almacen
        FROM public.almacenes a
        WHERE a.id_sucursal = $1
          AND COALESCE(a.estado, true) = true
      `,
      [idSucursal]
    );
    allowedWarehouseSet = new Set(
      (allowed.rows || [])
        .map((row) => Number.parseInt(String(row?.id_almacen ?? ''), 10))
        .filter((id) => isPositiveIntegerId(id))
    );
  }

  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
    const rowAlmacenes = resolveRowAlmacenes(row);
    if (rowAlmacenes.length === 0) return false;
    if (idAlmacen && !rowAlmacenes.includes(idAlmacen)) return false;
    if (allowedWarehouseSet && !rowAlmacenes.some((id) => allowedWarehouseSet.has(id))) return false;
    return true;
  });

  return { ok: true, rows: filtered };
};

// AM: normaliza la seleccion de almacenes (uno o varios) para create/edit multi-almacen.
const parseIdAlmacenes = (rawSingle, rawMulti) => {
  const source = Array.isArray(rawMulti) ? rawMulti : (rawMulti === undefined || rawMulti === null ? [] : [rawMulti]);
  const out = [];

  for (const raw of source) {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!isPositiveIntegerId(parsed)) {
      return { ok: false, message: 'id_almacenes contiene un id_almacen invalido.' };
    }
    if (!out.includes(parsed)) out.push(parsed);
  }

  if (out.length > 1) {
    return { ok: false, message: SINGLE_ALMACEN_TEMP_MESSAGE };
  }
  if (out.length > 0) return { ok: true, ids: out };

  const parsedSingle = Number.parseInt(String(rawSingle ?? '').trim(), 10);
  if (isPositiveIntegerId(parsedSingle)) {
    return { ok: true, ids: [parsedSingle] };
  }

  return { ok: false, message: 'Debe seleccionar al menos un id_almacen.' };
};

// AM: normaliza Date/Timestamp a `YYYY-MM-DD` para reusar datos actuales en edicion multi.
const toDateOnlyString = (value) => {
  if (!value) return '';
  const raw = String(value);
  if (raw.includes('T')) return raw.split('T')[0];
  if (raw.length >= 10) return raw.slice(0, 10);
  return raw;
};

const sanitizeOptionalText = (value) => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

// AM: parser decimal no negativo para cantidad/stock_minimo en insumos.
const parseNonNegativeDecimal = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
};

const validateOptionalDateInput = (rawValue, fieldName) => {
  const value = sanitizeOptionalText(rawValue);
  if (value === '') return { ok: true, value: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { ok: false, message: `${fieldName} debe tener formato YYYY-MM-DD.` };
  }

  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  const isValid =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === (month - 1) &&
    probe.getUTCDate() === day;
  if (!isValid) {
    return { ok: false, message: `${fieldName} no es una fecha valida.` };
  }

  return { ok: true, value };
};

// NEW: mensaje seguro para no exponer errores crudos de BD.
// WHY: alinear manejo de errores con UX y evitar detalles internos.
// IMPACT: no cambia contratos exitosos ni status codes de validacion.
const safeServerErrorMessage = (fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') => fallback;

const mapInsumoMaestroRow = (row) => {
  const idAlmacen = Number.parseInt(String(row?.id_almacen ?? ''), 10);
  return {
    ...row,
    id_insumo: row.id_insumo == null ? row.id_insumo : Number(row.id_insumo),
    id_insumo_maestro: row.id_insumo_maestro == null ? null : Number(row.id_insumo_maestro),
    id_almacen: isPositiveIntegerId(idAlmacen) ? idAlmacen : row.id_almacen,
    id_sucursal: row.id_sucursal == null ? null : Number(row.id_sucursal),
    id_almacenes: isPositiveIntegerId(idAlmacen) ? [idAlmacen] : []
  };
};

const listInsumosDesdeCatalogoMaestro = async (req) => {
  const queryPayload = { ...req.query };
  const scope = await getAllowedBranchIdsForInsumosUser(req, pool);
  if (!scope.isSuperAdmin && scope.allowedSucursalIds.length === 0) {
    return {
      status: 403,
      body: { error: true, message: INSUMOS_SCOPE_MISSING_BRANCHES_MESSAGE }
    };
  }

  const requestedSucursalHasValue = hasQueryKey(queryPayload, 'id_sucursal');
  const requestedSucursal = parseOptionalPositiveId(queryPayload.id_sucursal);
  if (requestedSucursalHasValue && requestedSucursal === null) {
    return { status: 400, body: { error: true, message: 'id_sucursal invalido.' } };
  }

  if (!scope.isSuperAdmin && requestedSucursal && !scope.allowedSucursalIds.includes(requestedSucursal)) {
    return { status: 403, body: { error: true, message: 'No tiene acceso a la sucursal solicitada.' } };
  }

  const requestedAlmacenHasValue = hasQueryKey(queryPayload, 'id_almacen');
  const requestedAlmacen = parseOptionalPositiveId(queryPayload.id_almacen);
  if (requestedAlmacenHasValue && requestedAlmacen === null) {
    return { status: 400, body: { error: true, message: 'id_almacen invalido.' } };
  }

  const requestedCategoriaHasValue =
    hasQueryKey(queryPayload, 'id_categoria_insumo') || hasQueryKey(queryPayload, 'id_categoria');
  const requestedCategoria = parseOptionalPositiveId(queryPayload.id_categoria_insumo ?? queryPayload.id_categoria);
  if (requestedCategoriaHasValue && requestedCategoria === null) {
    return { status: 400, body: { error: true, message: 'id_categoria_insumo invalido.' } };
  }

  const estadoFiltro = parseEstadoFiltroInsumos(queryPayload);
  if (!estadoFiltro) {
    return { status: 400, body: { error: true, message: 'estado invalido. Use activo, inactivo o todos.' } };
  }

  const stockFiltro = parseStockFiltroInsumos(queryPayload);
  if (!stockFiltro) {
    return { status: 400, body: { error: true, message: 'stock invalido. Use con_stock, sin_stock o todos.' } };
  }

  const sortKey = parseSortInsumos(queryPayload);
  if (!sortKey) {
    return { status: 400, body: { error: true, message: 'sort invalido.' } };
  }

  const wantsPaginated =
    hasQueryKey(queryPayload, 'page') ||
    hasQueryKey(queryPayload, 'pageSize') ||
    hasQueryKey(queryPayload, 'page_size') ||
    hasQueryKey(queryPayload, 'limit');

  const pageParsed = parsePositiveIntParam(queryPayload.page, INSUMOS_DEFAULT_PAGE, 1, 100000);
  if (!pageParsed.ok) {
    return { status: 400, body: { error: true, message: 'page invalido.' } };
  }

  const pageSizeParsed = parsePositiveIntParam(
    queryPayload.pageSize ?? queryPayload.page_size ?? queryPayload.limit,
    INSUMOS_DEFAULT_PAGE_SIZE,
    1,
    INSUMOS_MAX_PAGE_SIZE
  );
  if (!pageSizeParsed.ok) {
    return {
      status: 400,
      body: { error: true, message: `pageSize invalido. Debe estar entre 1 y ${INSUMOS_MAX_PAGE_SIZE}.` }
    };
  }

  const whereClauses = [];
  const whereParams = [];

  if (estadoFiltro === 'activo') whereClauses.push('(v.estado_global IS TRUE AND v.estado_local IS TRUE)');
  if (estadoFiltro === 'inactivo') whereClauses.push('NOT (v.estado_global IS TRUE AND v.estado_local IS TRUE)');
  if (requestedCategoria !== null) {
    whereParams.push(requestedCategoria);
    whereClauses.push(`v.id_categoria_insumo = $${whereParams.length}`);
  }
  if (requestedAlmacen !== null) {
    whereParams.push(requestedAlmacen);
    whereClauses.push(`v.id_almacen = $${whereParams.length}`);
  }
  if (stockFiltro === 'con_stock') whereClauses.push('COALESCE(v.cantidad, 0) > 0');
  if (stockFiltro === 'sin_stock') whereClauses.push('COALESCE(v.cantidad, 0) <= 0');
  if (requestedSucursal !== null) {
    whereParams.push(requestedSucursal);
    whereClauses.push(`v.id_sucursal = $${whereParams.length}`);
  } else if (!scope.isSuperAdmin) {
    whereParams.push(scope.allowedSucursalIds);
    whereClauses.push(`v.id_sucursal = ANY($${whereParams.length}::int[])`);
  }

  const rawSearch = queryPayload.q ?? queryPayload.search ?? queryPayload.busqueda ?? '';
  const search = String(rawSearch ?? '').trim();
  if (search) {
    const like = `%${search}%`;
    whereParams.push(like);
    const p = whereParams.length;
    whereClauses.push(`
      (
        COALESCE(v.nombre_insumo, '') ILIKE $${p}
        OR COALESCE(v.descripcion, '') ILIKE $${p}
        OR COALESCE(a.nombre, '') ILIKE $${p}
      )
    `);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const fromSql = `
    FROM public.vw_insumos_maestros_almacen v
    LEFT JOIN public.almacenes a
      ON a.id_almacen = v.id_almacen
    ${whereSql}
  `;
  const orderBySql = INSUMOS_MAESTRO_SORT_ALLOWLIST[sortKey] || INSUMOS_MAESTRO_SORT_ALLOWLIST.recientes;
  const page = pageParsed.value;
  const pageSize = pageSizeParsed.value;

  let total = 0;
  if (wantsPaginated) {
    const totalResult = await queryCatalogoMaestroView(
      pool,
      'public.vw_insumos_maestros_almacen',
      `SELECT COUNT(*)::int AS total ${fromSql}`,
      whereParams
    );
    total = Number.parseInt(String(totalResult.rows?.[0]?.total ?? '0'), 10) || 0;
  }

  const dataParams = [...whereParams];
  const paginationSql = wantsPaginated
    ? (() => {
        dataParams.push(pageSize);
        dataParams.push((page - 1) * pageSize);
        return `LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
      })()
    : '';

  const dataResult = await queryCatalogoMaestroView(
    pool,
    'public.vw_insumos_maestros_almacen',
    `
      SELECT
        v.id_insumo_legacy AS id_insumo,
        v.id_insumo_maestro,
        v.nombre_insumo,
        v.precio_compra AS precio,
        v.cantidad,
        v.stock_minimo,
        v.fecha_ingreso_insumo,
        v.id_almacen,
        v.id_sucursal,
        v.id_categoria_insumo,
        v.id_unidad_medida,
        v.fecha_caducidad,
        v.descripcion,
        v.id_archivo_imagen_principal,
        (v.estado_global IS TRUE AND v.estado_local IS TRUE) AS estado,
        v.estado_global,
        v.estado_local,
        v.estado_migracion
      ${fromSql}
      ORDER BY ${orderBySql}
      ${paginationSql}
    `,
    dataParams
  );

  const rows = (dataResult.rows || []).map(mapInsumoMaestroRow);
  const items = await attachImagenPrincipalUrls(pool, req, rows);

  if (!wantsPaginated) {
    return { status: 200, body: items };
  }

  return {
    status: 200,
    body: {
      error: false,
      items,
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 1 : Math.ceil(total / pageSize)
    }
  };
};

const isMissingInsumosAlmacenesTableError = (error) => {
  if (error?.code !== SQLSTATE_UNDEFINED_TABLE) return false;
  const trace = String(error?.table || error?.message || error?.detail || '').toLowerCase();
  return trace.includes('insumos_almacenes');
};

const isSkippableDependencySchemaError = (error) =>
  error?.code === SQLSTATE_UNDEFINED_TABLE || error?.code === SQLSTATE_UNDEFINED_COLUMN;

// AM: conteo seguro de dependencias para no romper si hay drift de esquema.
const safeDependencyCount = async ({ label, query, params }, db = pool) => {
  try {
    const result = await db.query(query, Array.isArray(params) ? params : []);
    const total = Number.parseInt(String(result.rows?.[0]?.total ?? '0'), 10);
    return {
      label,
      checked: true,
      total: Number.isNaN(total) ? 0 : total
    };
  } catch (error) {
    if (isSkippableDependencySchemaError(error)) {
      console.warn(`[insumos] dependencia omitida (${label}):`, error.message);
      return { label, checked: false, total: 0 };
    }
    throw error;
  }
};

// AM: detalle seguro de dependencias (max 10 items) para mensajes humanos.
const safeDependencyItems = async ({ label, query, params, mapRow }, db = pool) => {
  try {
    const result = await db.query(query, Array.isArray(params) ? params : []);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return {
      label,
      checked: true,
      items: rows.map((row) => (typeof mapRow === 'function' ? mapRow(row) : row))
    };
  } catch (error) {
    if (isSkippableDependencySchemaError(error)) {
      console.warn(`[insumos] detalle dependencia omitida (${label}):`, error.message);
      return { label, checked: false, items: [] };
    }
    throw error;
  }
};

const getInsumoDependencySummary = async (idInsumo, db = pool) => {
  const [counts, details] = await Promise.all([
    Promise.all([
      safeDependencyCount(
        {
          label: 'recetas_activas',
          params: [idInsumo],
          query: `
            SELECT COUNT(DISTINCT dr.id_receta)::int AS total
            FROM public.detalle_receta dr
            INNER JOIN public.recetas r ON r.id_receta = dr.id_receta
            WHERE dr.id_insumo = $1
              AND COALESCE(dr.estado, true) = true
              AND COALESCE(r.estado, true) = true
          `
        },
        db
      ),
      safeDependencyCount(
        {
          label: 'stock_disponible',
          params: [idInsumo],
          query: `
            SELECT COUNT(*)::int AS total
            FROM public.insumos i
            WHERE i.id_insumo = $1
              AND COALESCE(i.cantidad, 0) > 0
          `
        },
        db
      ),
      safeDependencyCount(
        {
          label: 'ordenes_compra_en_proceso',
          params: [idInsumo, INSUMOS_DELETE_BLOCKING_OC_STATES],
          query: `
            SELECT COUNT(*)::int AS total
            FROM public.detalle_orden_compras doc
            INNER JOIN public.orden_compras oc
              ON oc.id_orden_compra = doc.id_orden_compra
            WHERE doc.id_insumo = $1
              AND UPPER(COALESCE(oc.estado_flujo, '')) = ANY($2::text[])
          `
        },
        db
      )
    ]),
    Promise.all([
      safeDependencyItems(
        {
          label: 'recetas_activas',
          params: [idInsumo, INSUMOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT DISTINCT
              r.id_receta,
              COALESCE(NULLIF(TRIM(COALESCE(r.nombre_receta, r.nombre, '')), ''), CONCAT('Receta #', r.id_receta::text)) AS nombre
            FROM public.detalle_receta dr
            INNER JOIN public.recetas r ON r.id_receta = dr.id_receta
            WHERE dr.id_insumo = $1
              AND COALESCE(dr.estado, true) = true
              AND COALESCE(r.estado, true) = true
            ORDER BY r.id_receta ASC
            LIMIT $2
          `,
          mapRow: (row) => ({
            id_receta: Number(row.id_receta),
            nombre: String(row.nombre ?? `Receta #${row.id_receta}`)
          })
        },
        db
      ),
      safeDependencyItems(
        {
          label: 'stock_disponible',
          params: [idInsumo, INSUMOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT
              a.id_sucursal,
              COALESCE(NULLIF(TRIM(COALESCE(s.nombre_sucursal, s.nombre, '')), ''), CONCAT('Sucursal #', a.id_sucursal::text)) AS sucursal,
              i.id_almacen,
              COALESCE(NULLIF(TRIM(COALESCE(a.nombre_almacen, a.nombre, '')), ''), CONCAT('Almacen #', i.id_almacen::text)) AS almacen,
              COALESCE(i.cantidad, 0)::numeric AS stock
            FROM public.insumos i
            LEFT JOIN public.almacenes a ON a.id_almacen = i.id_almacen
            LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
            WHERE i.id_insumo = $1
              AND COALESCE(i.cantidad, 0) > 0
            ORDER BY i.id_insumo ASC
            LIMIT $2
          `,
          mapRow: (row) => ({
            id_sucursal: row.id_sucursal == null ? null : Number(row.id_sucursal),
            sucursal: String(
              row.sucursal
              ?? (row.id_sucursal == null ? 'Sucursal sin asignar' : `Sucursal #${row.id_sucursal}`)
            ),
            id_almacen: row.id_almacen == null ? null : Number(row.id_almacen),
            almacen: String(
              row.almacen
              ?? (row.id_almacen == null ? 'Almacen sin asignar' : `Almacen #${row.id_almacen}`)
            ),
            stock: Number(row.stock ?? 0)
          })
        },
        db
      ),
      safeDependencyItems(
        {
          label: 'ordenes_compra_en_proceso',
          params: [idInsumo, INSUMOS_DELETE_BLOCKING_OC_STATES, INSUMOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT DISTINCT
              oc.id_orden_compra,
              COALESCE(NULLIF(TRIM(COALESCE(oc.codigo_orden_compra, oc.codigo, '')), ''), CONCAT('OC #', oc.id_orden_compra::text)) AS codigo,
              UPPER(COALESCE(oc.estado_flujo, '')) AS estado
            FROM public.detalle_orden_compras doc
            INNER JOIN public.orden_compras oc
              ON oc.id_orden_compra = doc.id_orden_compra
            WHERE doc.id_insumo = $1
              AND UPPER(COALESCE(oc.estado_flujo, '')) = ANY($2::text[])
            ORDER BY oc.id_orden_compra ASC
            LIMIT $3
          `,
          mapRow: (row) => ({
            id_orden_compra: Number(row.id_orden_compra),
            codigo: String(row.codigo ?? `OC #${row.id_orden_compra}`),
            estado: String(row.estado ?? '')
          })
        },
        db
      )
    ])
  ]);

  const detailByLabel = new Map(details.map((row) => [row.label, row]));
  const checks = counts.map((row) => {
    const detail = detailByLabel.get(row.label);
    const items = detail?.checked ? (detail.items || []) : [];
    return {
      label: row.label,
      checked: row.checked,
      total: row.total,
      items,
      remaining: Math.max(0, row.total - items.length)
    };
  });

  const normalizedChecks = checks.map((row) => ({
    modulo: row.label,
    checked: row.checked,
    total: row.total,
    items: row.items,
    remaining: row.remaining
  }));

  const blocking = normalizedChecks.filter((row) => row.checked && row.total > 0);
  return {
    hasBlockingDependencies: blocking.length > 0,
    summary: {
      entity: 'insumo',
      blocking_modules: blocking.map((row) => ({
        modulo: row.modulo,
        total: row.total,
        items: row.items,
        remaining: row.remaining
      })),
      checks: normalizedChecks
    }
  };
};

const assertInsumoCanBeDeactivated = async (idInsumo, db = pool) => {
  const dependencySummary = await getInsumoDependencySummary(idInsumo, db);
  if (dependencySummary.hasBlockingDependencies) {
    return {
      ok: false,
      status: 409,
      code: INSUMO_IN_USE_CODE,
      message: INSUMO_IN_USE_MESSAGE,
      summary: dependencySummary.summary
    };
  }
  return { ok: true, status: 200 };
};
const buildInsumosAlmacenesTableMissingError = (error) => {
  const wrapped = new Error(INSUMOS_ALMACENES_TABLE_MISSING_MESSAGE);
  wrapped.code = INSUMOS_ALMACENES_TABLE_MISSING_CODE;
  wrapped.status = 500;
  wrapped.cause = error;
  return wrapped;
};

const getInsumosConstraintConflictMessage = (err) => {
  if (!err || err.code !== '23505') return '';
  const trace = String(err?.constraint || err?.detail || err?.message || '').toLowerCase();
  if (!trace.includes(INSUMOS_DUPLICATE_CONSTRAINT.toLowerCase())) return '';
  return INSUMOS_DUPLICATE_MESSAGE;
};

// Endpoint interno para descuentos de inventario por pedido.
// -----------------------------------------------------------
// QUE HACE:
// - Recibe `id_sucursal`, `id_pedido` e `items`.
// - Delega toda la logica atomica al servicio `validarYDescontarPedido`.
// - Devuelve faltantes claros cuando no hay stock/configuracion suficiente.
//
// POR QUE ESTA AQUI:
// - Este router ya es el punto de entrada natural del modulo INSUMOS.
// - Se evita tocar VENTAS y otros dominios en esta etapa.
router.post('/inventario/descontar-por-pedido', checkPermission(INSUMOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const result = await validarYDescontarPedido(req.body || {}, {
      id_usuario: req?.user?.id_usuario
    });

    if (!result?.ok) {
      return res.status(409).json({
        ok: false,
        error: true,
        code: result.code || 'STOCK_O_CONFIG_INSUFICIENTE',
        message: result.message || 'No se pudo descontar inventario para el pedido.',
        id_pedido: result.id_pedido,
        id_sucursal: result.id_sucursal,
        faltantes: Array.isArray(result.faltantes) ? result.faltantes : []
      });
    }

    return res.status(200).json({
      ok: true,
      message: result.message || 'Inventario descontado correctamente.',
      data: result
    });
  } catch (error) {
    const httpStatus = Number(error?.httpStatus || 500);
    const code = String(error?.code || (httpStatus >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'));

    return res.status(httpStatus).json({
      ok: false,
      error: true,
      code,
      message: error?.message || safeServerErrorMessage(),
      details: error?.details || undefined
    });
  }
});

// NEW: helper para validar `id_categoria_insumo` y asegurar que exista/este activa.
// WHY: evitar guardar insumos apuntando a categorias inexistentes o inactivas.
// IMPACT: agrega validacion 400 opcional en POST/PUT cuando se envia `id_categoria_insumo`.
const validateCategoriaInsumoActiva = async (rawCategoriaId, db = pool) => {
  const hasValue = !(rawCategoriaId === undefined || rawCategoriaId === null || String(rawCategoriaId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const categoriaId = Number.parseInt(String(rawCategoriaId), 10);
  if (!isPositiveIntegerId(categoriaId)) {
    return { ok: false, status: 400, code: 'INVALID_INSUMO_CATEGORY_ID', message: 'id_categoria_insumo debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
    'SELECT estado FROM categorias_insumos WHERE id_categoria_insumo = $1 LIMIT 1',
    [categoriaId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_INSUMO_CATEGORY_ID', message: 'La categorÃ­a de insumo no existe.' };
  }

  const row = result.rows?.[0] || {};
  if (!isRowActive(row)) {
    return { ok: false, status: 400, code: 'INACTIVE_INSUMO_CATEGORY', message: 'La categorÃ­a de insumo estÃ¡ inactiva.' };
  }

  return { ok: true, id: categoriaId };
};

// NEW: valida FK opcional a `unidades_medida`.
// WHY: `insumos.id_unidad_medida` ya existe en la BD real y debe concordar con el formulario.
// IMPACT: POST/PUT de insumos aceptan la unidad cuando existe y rechazan IDs invalidos con 400.
const validateUnidadMedida = async (rawUnidadId, db = pool) => {
  const hasValue = !(rawUnidadId === undefined || rawUnidadId === null || String(rawUnidadId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const unidadId = Number.parseInt(String(rawUnidadId), 10);
  if (!isPositiveIntegerId(unidadId)) {
    return { ok: false, status: 400, code: 'INVALID_UNIDAD_MEDIDA_ID', message: 'id_unidad_medida debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
    'SELECT 1 FROM unidades_medida WHERE id_unidad_medida = $1 LIMIT 1',
    [unidadId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_UNIDAD_MEDIDA_ID', message: 'La unidad de medida no existe.' };
  }

  return { ok: true, id: unidadId };
};

// NEW: valida FK opcional a `archivos.id_archivo` para imagen principal.
// WHY: garantizar que la imagen asociada ya exista antes de persistir el insumo.
// IMPACT: evita errores de FK crudos y habilita el flujo de imagenes en Inventario.
const validateArchivoImagen = async (rawArchivoId, db = pool) => {
  const hasValue = !(rawArchivoId === undefined || rawArchivoId === null || String(rawArchivoId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const archivoId = Number.parseInt(String(rawArchivoId), 10);
  if (!isPositiveIntegerId(archivoId)) {
    return { ok: false, status: 400, code: 'INVALID_ARCHIVO_ID', message: 'id_archivo_imagen_principal debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
    'SELECT 1 FROM archivos WHERE id_archivo = $1 LIMIT 1',
    [archivoId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_ARCHIVO_ID', message: 'La imagen seleccionada no existe.' };
  }

  return { ok: true, id: archivoId };
};

const validateAlmacenActivo = async (rawAlmacenId, db = pool) => {
  const almacenId = Number.parseInt(String(rawAlmacenId ?? ''), 10);
  if (!isPositiveIntegerId(almacenId)) {
    return { ok: false, status: 400, message: 'id_almacen debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
    `
      SELECT id_almacen, COALESCE(estado, true) AS estado
      FROM almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [almacenId]
  );

  if (result.rowCount === 0) {
    return { ok: false, status: 400, message: `id_almacen ${almacenId} no existe en almacenes.` };
  }

  if (!Boolean(result.rows?.[0]?.estado)) {
    return { ok: false, status: 400, message: 'El almacen seleccionado esta inactivo.' };
  }

  return { ok: true, id: almacenId };
};

// NEW: actualiza FKs opcionales a SQL NULL real sin pasar por `pa_update`.
// WHY: `pa_update` serializa `null` como texto y PostgreSQL rechaza `"null"` en columnas integer.
// IMPACT: permite limpiar imagen/unidad/categoria opcional desde el frontend sin romper el PUT generico.
const updateNullableInsumoFieldToNull = async (rawInsumoId, campo) => {
  const insumoId = Number.parseInt(String(rawInsumoId ?? ''), 10);
  if (!isPositiveIntegerId(insumoId)) return false;

  if (campo === 'id_categoria_insumo') {
    await pool.query('UPDATE insumos SET id_categoria_insumo = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  if (campo === 'id_unidad_medida') {
    await pool.query('UPDATE insumos SET id_unidad_medida = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  if (campo === 'id_archivo_imagen_principal') {
    await pool.query('UPDATE insumos SET id_archivo_imagen_principal = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  return false;
};

// AM: snapshot completo del insumo para edicion multi-almacen sin perder campos opcionales existentes.
const getInsumoById = async (insumoId, db = pool) => {
  const result = await db.query(
    `SELECT
      id_insumo,
      nombre_insumo,
      precio,
      cantidad,
      stock_minimo,
      fecha_ingreso_insumo,
      id_almacen,
      id_categoria_insumo,
      id_unidad_medida,
      fecha_caducidad,
      descripcion,
      estado,
      id_archivo_imagen_principal
    FROM insumos
    WHERE id_insumo = $1
    LIMIT 1`,
    [insumoId]
  );
  return result.rows[0] || null;
};

// AM: llave operativa para detectar/actualizar insumos equivalentes por almacen en flujo multi.
const findInsumoByUniqueKey = async (
  {
    nombre_insumo,
    id_almacen,
    excludeId = null
  },
  db = pool
) => {
  const params = [
    String(nombre_insumo ?? '').trim().toLowerCase(),
    id_almacen
  ];

  let sql = `
    SELECT id_insumo
    FROM insumos
    WHERE lower(trim(nombre_insumo)) = $1
      AND id_almacen = $2
      AND COALESCE(estado, true) = true
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_insumo <> $3';
  }

  sql += ' ORDER BY id_insumo DESC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows[0] || null;
};

// AM: busca insumo general (sin amarrarlo a almacen) para evitar duplicados por sucursal en modelo multi-asignacion.
const findInsumoByGeneralKey = async (
  {
    nombre_insumo,
    id_categoria_insumo,
    id_unidad_medida,
    excludeId = null
  },
  db = pool
) => {
  const params = [
    String(nombre_insumo ?? '').trim().toLowerCase(),
    id_categoria_insumo ?? null,
    id_unidad_medida ?? null
  ];

  let sql = `
    SELECT id_insumo
    FROM insumos
    WHERE lower(trim(nombre_insumo)) = $1
      AND (
        (id_categoria_insumo IS NULL AND $2::integer IS NULL)
        OR id_categoria_insumo = $2::integer
      )
      AND (
        (id_unidad_medida IS NULL AND $3::integer IS NULL)
        OR id_unidad_medida = $3::integer
      )
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_insumo <> $4';
  }

  sql += ' ORDER BY id_insumo ASC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows?.[0] || null;
};

// AM: sincroniza las asignaciones multi-almacen del insumo sin duplicar filas de `insumos`.
const syncInsumoAlmacenes = async (idInsumo, idAlmacenes, db = pool) => {
  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(idAlmacenes) ? idAlmacenes : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => isPositiveIntegerId(id))
    )
  );

  if (uniqueIds.length === 0) return;

  const primaryAlmacen = uniqueIds[0];
  const singleAlmacenIds = [primaryAlmacen];
  await db.query('UPDATE public.insumos SET id_almacen = $1 WHERE id_insumo = $2', [primaryAlmacen, idInsumo]);

  try {
    await db.query(
      `
        INSERT INTO public.insumos_almacenes (id_insumo, id_almacen)
        SELECT $1, UNNEST($2::int[])
        ON CONFLICT (id_insumo, id_almacen) DO NOTHING
      `,
      [idInsumo, singleAlmacenIds]
    );

    await db.query(
      `
        DELETE FROM public.insumos_almacenes
        WHERE id_insumo = $1
          AND id_almacen <> ALL($2::int[])
      `,
      [idInsumo, singleAlmacenIds]
    );
  } catch (error) {
    if (isMissingInsumosAlmacenesTableError(error)) {
      throw buildInsumosAlmacenesTableMissingError(error);
    }
    throw error;
  }
};

// AM: incluye `id_almacenes` en el GET de insumos manteniendo `id_almacen` para contratos legacy.
const attachInsumoAlmacenes = async (rows, db = pool) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;

  const ids = Array.from(
    new Set(
      list
        .map((row) => Number.parseInt(String(row?.id_insumo ?? ''), 10))
        .filter((id) => isPositiveIntegerId(id))
    )
  );
  if (ids.length === 0) {
    return list.map((row) => ({ ...row, id_almacenes: [] }));
  }

  try {
    const assignmentsResult = await db.query(
      `
        SELECT ia.id_insumo, ARRAY_AGG(ia.id_almacen ORDER BY ia.id_almacen) AS id_almacenes
        FROM public.insumos_almacenes ia
        WHERE ia.id_insumo = ANY($1::int[])
        GROUP BY ia.id_insumo
      `,
      [ids]
    );

    const map = new Map(
      assignmentsResult.rows.map((row) => [
        Number(row.id_insumo),
        (Array.isArray(row.id_almacenes) ? row.id_almacenes : [])
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => isPositiveIntegerId(id))
      ])
    );

    return list.map((row) => {
      const idInsumo = Number.parseInt(String(row?.id_insumo ?? ''), 10);
      const fromMap = map.get(idInsumo) || [];
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      const idAlmacenesBase =
        fromMap.length > 0
          ? fromMap
          : isPositiveIntegerId(fallbackSingle)
          ? [fallbackSingle]
          : [];
      const idAlmacenes = idAlmacenesBase;
      const primaryAlmacen = isPositiveIntegerId(fallbackSingle)
        ? fallbackSingle
        : (idAlmacenes[0] ?? null);

      return {
        ...row,
        id_almacen: primaryAlmacen,
        id_almacenes: idAlmacenes
      };
    });
  } catch (error) {
    if (isMissingInsumosAlmacenesTableError(error)) {
      throw buildInsumosAlmacenesTableMissingError(error);
    }
    throw error;
  }
};

// AM: update completo para sincronizar insumo en varios almacenes en una transaccion.
const updateInsumoCompleto = async (insumoId, data, db = pool) => {
  await db.query(
    `UPDATE insumos
     SET
      nombre_insumo = $1,
      precio = $2,
      stock_minimo = $3,
      fecha_ingreso_insumo = $4,
      id_almacen = $5,
      id_categoria_insumo = $6,
      id_unidad_medida = $7,
      fecha_caducidad = $8,
      descripcion = $9,
      estado = $10,
      id_archivo_imagen_principal = $11
     WHERE id_insumo = $12`,
    [
      data.nombre_insumo,
      data.precio,
      data.stock_minimo,
      data.fecha_ingreso_insumo || null,
      data.id_almacen,
      data.id_categoria_insumo ?? null,
      data.id_unidad_medida ?? null,
      data.fecha_caducidad || null,
      data.descripcion || '',
      data.estado,
      data.id_archivo_imagen_principal ?? null,
      insumoId
    ]
  );
};

// GET: Obtener insumos
router.get('/insumos', checkPermission(INSUMOS_LIST_PERMISSIONS), async (req, res) => {
  try {
    if (isCatalogoMaestroReadsEnabled()) {
      const result = await listInsumosDesdeCatalogoMaestro(req);
      return res.status(result.status).json(result.body);
    }

    const tabla = 'insumos';

    // COMENTARIO EN MAYUSCULAS: SE AGREGA stock_minimo PARA ALERTAS
    const columnas =
      'id_insumo, nombre_insumo, precio, cantidad, stock_minimo, fecha_ingreso_insumo, id_almacen, id_categoria_insumo, id_unidad_medida, fecha_caducidad, descripcion, estado, id_archivo_imagen_principal';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows[0].resultado || [];
    // NEW: por defecto devuelve solo activos; admin puede pedir todos con query param.
    // WHY: alinear el GET con la regla de soft delete basada en `estado`.
    // IMPACT: `?incluir_inactivos=1` mantiene soporte administrativo sin endpoint nuevo.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    const datosConAlmacenes = await attachInsumoAlmacenes(datos, pool);
    const scopedFilter = await filterInsumosByCatalogScope(datosConAlmacenes, req.query, pool);
    if (!scopedFilter.ok) {
      return res.status(400).json({ error: true, message: scopedFilter.message || 'Filtros de catalogo invalidos.' });
    }
    const datosConImagen = await attachImagenPrincipalUrls(pool, req, scopedFilter.rows || []);
    res.status(200).json(datosConImagen);

  } catch (err) {
    if (isCatalogoMaestroViewMissingError(err)) {
      logCatalogoMaestroViewMissing('GET /insumos', err);
      return sendCatalogoMaestroViewMissingResponse(res);
    }
    console.error('Error al obtener insumos:', err.message);
    if (err?.code === INSUMOS_ALMACENES_TABLE_MISSING_CODE) {
      return res.status(500).json({ error: true, message: INSUMOS_ALMACENES_TABLE_MISSING_MESSAGE });
    }
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar los insumos.') });
  }
});

// POST: Crear insumo
router.post('/insumos', checkPermission(INSUMOS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const datos = req.body && typeof req.body === 'object' ? { ...req.body } : null;
    if (!datos || Array.isArray(datos)) {
      return res.status(400).json({ error: true, message: 'Payload invalido para crear insumo.' });
    }

    if (Object.prototype.hasOwnProperty.call(datos, 'estado')) {
      return res.status(400).json({
        error: true,
        message: 'El estado no puede enviarse en este formulario. Use el flujo de activacion/inactivacion.'
      });
    }

    const keys = Object.keys(datos);
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_INSUMOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const almacenesParse = parseIdAlmacenes(datos?.id_almacen, datos?.id_almacenes);
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }
    const idAlmacenes = almacenesParse.ids;

    const payloadBase = { ...datos };
    delete payloadBase.id_almacenes;
    payloadBase.id_almacen = idAlmacenes[0];

    const nombreInsumo = sanitizeOptionalText(payloadBase?.nombre_insumo);
    if (nombreInsumo === '') {
      return res.status(400).json({ error: true, message: 'nombre_insumo es obligatorio.' });
    }
    if (nombreInsumo.length < 2 || nombreInsumo.length > 80) {
      return res.status(400).json({ error: true, message: 'nombre_insumo debe tener entre 2 y 80 caracteres.' });
    }

    const precioRaw = payloadBase?.precio;
    if (precioRaw === undefined || precioRaw === null || String(precioRaw).trim() === '') {
      return res.status(400).json({ error: true, message: 'precio es obligatorio.' });
    }
    const precio = Number(precioRaw);
    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: true, message: 'precio debe ser un numero mayor o igual a 0.' });
    }

    const cantidadRaw = payloadBase?.cantidad;
    if (cantidadRaw === undefined || cantidadRaw === null || String(cantidadRaw).trim() === '') {
      return res.status(400).json({ error: true, message: 'cantidad es obligatoria.' });
    }
    const cantidad = parseNonNegativeDecimal(cantidadRaw);
    if (cantidad === null) {
      return res.status(400).json({ error: true, message: 'cantidad debe ser un numero mayor o igual a 0.' });
    }

    const stockMinimoRaw = payloadBase?.stock_minimo;
    if (stockMinimoRaw === undefined || stockMinimoRaw === null || String(stockMinimoRaw).trim() === '') {
      return res.status(400).json({ error: true, message: 'stock_minimo es obligatorio.' });
    }
    const stockMinimo = parseNonNegativeDecimal(stockMinimoRaw);
    if (stockMinimo === null) {
      return res.status(400).json({ error: true, message: 'stock_minimo debe ser un numero mayor o igual a 0.' });
    }

    const fechaIngresoValidation = validateOptionalDateInput(payloadBase?.fecha_ingreso_insumo, 'fecha_ingreso_insumo');
    if (!fechaIngresoValidation.ok) {
      return res.status(400).json({ error: true, message: fechaIngresoValidation.message });
    }
    const fechaCaducidadValidation = validateOptionalDateInput(payloadBase?.fecha_caducidad, 'fecha_caducidad');
    if (!fechaCaducidadValidation.ok) {
      return res.status(400).json({ error: true, message: fechaCaducidadValidation.message });
    }
    const hasDescripcion = Object.prototype.hasOwnProperty.call(payloadBase, 'descripcion');
    const descripcion = hasDescripcion ? sanitizeOptionalText(payloadBase?.descripcion) : undefined;

    // NEW: valida categoria de insumo si el frontend la envia en alta.
    // WHY: proteger integridad de referencia sin depender solo de la FK.
    // IMPACT: solo bloquea payloads invalidos; altas validas mantienen el mismo flujo.
    const categoriaValidation = await validateCategoriaInsumoActiva(payloadBase?.id_categoria_insumo, client);
    if (!categoriaValidation.ok) {
      return res.status(categoriaValidation.status).json({
        error: true,
        code: categoriaValidation.code,
        message: categoriaValidation.message
      });
    }

    const unidadValidation = await validateUnidadMedida(payloadBase?.id_unidad_medida, client);
    if (!unidadValidation.ok) {
      return res.status(unidadValidation.status).json({
        error: true,
        code: unidadValidation.code,
        message: unidadValidation.message
      });
    }

    const archivoValidation = await validateArchivoImagen(payloadBase?.id_archivo_imagen_principal, client);
    if (!archivoValidation.ok) {
      return res.status(archivoValidation.status).json({
        error: true,
        code: archivoValidation.code,
        message: archivoValidation.message
      });
    }

    const payload = { ...payloadBase };
    payload.nombre_insumo = nombreInsumo;
    payload.precio = precio;
    payload.estado = true;
    payload.cantidad = cantidad;
    payload.stock_minimo = stockMinimo;
    if (Object.prototype.hasOwnProperty.call(payloadBase, 'fecha_ingreso_insumo')) {
      if (fechaIngresoValidation.value === '') delete payload.fecha_ingreso_insumo;
      else payload.fecha_ingreso_insumo = fechaIngresoValidation.value;
    }
    if (Object.prototype.hasOwnProperty.call(payloadBase, 'fecha_caducidad')) {
      if (fechaCaducidadValidation.value === '') delete payload.fecha_caducidad;
      else payload.fecha_caducidad = fechaCaducidadValidation.value;
    }
    if (hasDescripcion) payload.descripcion = descripcion;
    if (categoriaValidation.id === null) delete payload.id_categoria_insumo;
    else payload.id_categoria_insumo = categoriaValidation.id;
    if (unidadValidation.id === null) delete payload.id_unidad_medida;
    else payload.id_unidad_medida = unidadValidation.id;
    if (archivoValidation.id === null) delete payload.id_archivo_imagen_principal;
    else payload.id_archivo_imagen_principal = archivoValidation.id;

    await client.query('BEGIN');

    for (const idAlmacen of idAlmacenes) {
      const almacenValidation = await validateAlmacenActivo(idAlmacen, client);
      if (!almacenValidation.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: true,
          message: almacenValidation.message
        });
      }
    }

    const duplicateGeneral = await findInsumoByUniqueKey(
      {
        nombre_insumo: payload.nombre_insumo,
        id_almacen: idAlmacenes[0]
      },
      client
    );

    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: INSUMOS_DUPLICATE_MESSAGE
      });
    }

    const primaryPayload = { ...payload, id_almacen: idAlmacenes[0] };
    const INSERT_COLUMN_ORDER = [
      'nombre_insumo',
      'precio',
      'cantidad',
      'stock_minimo',
      'fecha_ingreso_insumo',
      'id_almacen',
      'id_categoria_insumo',
      'id_unidad_medida',
      'fecha_caducidad',
      'descripcion',
      'estado',
      'id_archivo_imagen_principal'
    ];
    const insertColumns = INSERT_COLUMN_ORDER.filter((column) =>
      Object.prototype.hasOwnProperty.call(primaryPayload, column)
    );
    const insertValues = insertColumns.map((column) => primaryPayload[column]);
    const insertPlaceholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
    const insertQuery = `
      INSERT INTO public.insumos (${insertColumns.join(', ')})
      VALUES (${insertPlaceholders})
      RETURNING id_insumo
    `;
    const inserted = await client.query(insertQuery, insertValues);
    const idInsumoCreado = Number.parseInt(String(inserted?.rows?.[0]?.id_insumo ?? ''), 10);
    if (!isPositiveIntegerId(idInsumoCreado)) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: true,
        message: 'No se pudo resolver el ID del insumo creado.'
      });
    }

    await syncInsumoAlmacenes(idInsumoCreado, idAlmacenes, client);
    await completeInsumoCatalogoMaestroWrite({
      client,
      idInsumo: idInsumoCreado,
      idAlmacen: primaryPayload.id_almacen,
      cantidad,
      stockMinimo,
      precioCompra: precio,
      fechaCaducidad: primaryPayload.fecha_caducidad ?? null
    });
    await client.query('COMMIT');

    res.status(201).json({
      message: 'Insumo creado exitosamente.',
      id_insumo: idInsumoCreado,
      id_almacenes: idAlmacenes
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear insumo:', err.message);
    if (isCatalogoMaestroWriteStructureMissingError(err) || err?.code === INSUMOS_ALMACENES_TABLE_MISSING_CODE) {
      console.error('CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING insumo:', err.cause?.message || err.message);
      return res.status(500).json(buildCatalogoMaestroWriteStructureMissingResponse());
    }
    if (err?.code === '23505') {
      const duplicateMessage = getInsumosConstraintConflictMessage(err);
      if (duplicateMessage) {
        return res.status(409).json({ error: true, message: duplicateMessage });
      }
      return res.status(409).json({ error: true, message: 'No se pudo crear el insumo por una restriccion de datos.' });
    }
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  } finally {
    client.release();
  }
});

// OBSOLETO: endpoint descontinuado de forma controlada (no eliminar por compatibilidad externa no confirmada).
router.put('/insumos/multi-almacen', checkPermission(INSUMOS_EDIT_PERMISSIONS), async (_req, res) => {
  return res.status(410).json({
    error: true,
    message: 'Este endpoint ha sido descontinuado. El sistema actual de Insumos ya no soporta multi-almacÃ©n.'
  });
});

router.put('/insumos/edicion', checkPermission(INSUMOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const datosEntrada = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : null;
    if (!datosEntrada) {
      return res.status(400).json({ error: true, message: 'Payload invalido para editar insumo.' });
    }

    const keys = Object.keys(datosEntrada);
    const keysDesconocidas = keys.filter((k) => k !== 'estado' && !CAMPOS_PERMITIDOS_INSUMOS_PUT_EDICION.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const idInsumo = Number.parseInt(String(datosEntrada.id_insumo ?? ''), 10);
    if (!isPositiveIntegerId(idInsumo)) {
      return res.status(400).json({ error: true, message: 'id_insumo invalido.' });
    }

    if (Object.prototype.hasOwnProperty.call(datosEntrada, 'estado')) {
      return res.status(400).json({
        error: true,
        message: 'El estado no puede editarse desde este modulo. Use el flujo de activacion/inactivacion.'
      });
    }

    if (Object.prototype.hasOwnProperty.call(datosEntrada, 'id_almacen')) {
      return res.status(400).json({
        error: true,
        message: 'El almacÃ©n no puede modificarse desde la ediciÃ³n del insumo. Use un flujo de traslado o reasignaciÃ³n controlada.'
      });
    }

    if (Object.prototype.hasOwnProperty.call(datosEntrada, 'cantidad')) {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede editarse desde este mÃ³dulo. Use movimientos de inventario.'
      });
    }

    const actual = await getInsumoById(idInsumo, client);
    if (!actual) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    const merged = {
      nombre_insumo: datosEntrada.nombre_insumo ?? actual.nombre_insumo,
      precio: datosEntrada.precio ?? actual.precio,
      cantidad: actual.cantidad,
      stock_minimo: datosEntrada.stock_minimo ?? actual.stock_minimo ?? 0,
      fecha_ingreso_insumo: Object.prototype.hasOwnProperty.call(datosEntrada, 'fecha_ingreso_insumo')
        ? datosEntrada.fecha_ingreso_insumo
        : toDateOnlyString(actual.fecha_ingreso_insumo),
      id_almacen: datosEntrada.id_almacen ?? actual.id_almacen,
      id_categoria_insumo: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_categoria_insumo')
        ? datosEntrada.id_categoria_insumo
        : actual.id_categoria_insumo,
      id_unidad_medida: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_unidad_medida')
        ? datosEntrada.id_unidad_medida
        : actual.id_unidad_medida,
      fecha_caducidad: Object.prototype.hasOwnProperty.call(datosEntrada, 'fecha_caducidad')
        ? datosEntrada.fecha_caducidad
        : toDateOnlyString(actual.fecha_caducidad),
      descripcion: Object.prototype.hasOwnProperty.call(datosEntrada, 'descripcion')
        ? datosEntrada.descripcion
        : (actual.descripcion ?? ''),
      estado: actual.estado ?? true,
      id_archivo_imagen_principal: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_archivo_imagen_principal')
        ? datosEntrada.id_archivo_imagen_principal
        : actual.id_archivo_imagen_principal
    };

    const required = ['nombre_insumo', 'precio', 'stock_minimo'];
    const faltantes = required.filter((campo) => {
      const raw = merged[campo];
      return raw === undefined || raw === null || String(raw).trim() === '';
    });
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    const nombreInsumo = String(merged.nombre_insumo ?? '').trim();
    const precio = Number(merged.precio);
    const cantidad = parseNonNegativeDecimal(merged.cantidad);
    const stockMinimo = parseNonNegativeDecimal(merged.stock_minimo);
    if (nombreInsumo.length < 2 || nombreInsumo.length > 80) {
      return res.status(400).json({ error: true, message: 'nombre_insumo debe tener entre 2 y 80 caracteres.' });
    }
    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: true, message: 'precio debe ser un numero mayor o igual a 0.' });
    }
    if (cantidad === null) {
      return res.status(400).json({ error: true, message: 'cantidad debe ser un numero mayor o igual a 0.' });
    }
    if (stockMinimo === null) {
      return res.status(400).json({ error: true, message: 'stock_minimo debe ser un numero mayor o igual a 0.' });
    }
    const fechaIngresoValidation = validateOptionalDateInput(merged.fecha_ingreso_insumo, 'fecha_ingreso_insumo');
    if (!fechaIngresoValidation.ok) {
      return res.status(400).json({ error: true, message: fechaIngresoValidation.message });
    }
    const fechaCaducidadValidation = validateOptionalDateInput(merged.fecha_caducidad, 'fecha_caducidad');
    if (!fechaCaducidadValidation.ok) {
      return res.status(400).json({ error: true, message: fechaCaducidadValidation.message });
    }

    const categoriaValidation = await validateCategoriaInsumoActiva(merged.id_categoria_insumo, client);
    if (!categoriaValidation.ok) {
      return res.status(categoriaValidation.status).json({
        error: true,
        code: categoriaValidation.code,
        message: categoriaValidation.message
      });
    }

    const unidadValidation = await validateUnidadMedida(merged.id_unidad_medida, client);
    if (!unidadValidation.ok) {
      return res.status(unidadValidation.status).json({
        error: true,
        code: unidadValidation.code,
        message: unidadValidation.message
      });
    }

    const archivoValidation = await validateArchivoImagen(merged.id_archivo_imagen_principal, client);
    if (!archivoValidation.ok) {
      return res.status(archivoValidation.status).json({
        error: true,
        code: archivoValidation.code,
        message: archivoValidation.message
      });
    }

    const idAlmacen = Number.parseInt(String(merged.id_almacen ?? ''), 10);
    const almacenValidation = await validateAlmacenActivo(idAlmacen, client);
    if (!almacenValidation.ok) {
      return res.status(almacenValidation.status || 400).json({
        error: true,
        message: almacenValidation.message
      });
    }

    const normalized = {
      nombre_insumo: nombreInsumo,
      precio,
      cantidad,
      stock_minimo: stockMinimo,
      fecha_ingreso_insumo: fechaIngresoValidation.value,
      id_almacen: almacenValidation.id,
      id_categoria_insumo: categoriaValidation.id,
      id_unidad_medida: unidadValidation.id,
      fecha_caducidad: fechaCaducidadValidation.value,
      descripcion: String(merged.descripcion ?? '').trim(),
      estado: merged.estado === true || merged.estado === 'true' || merged.estado === 1 || merged.estado === '1',
      id_archivo_imagen_principal: archivoValidation.id
    };

    await client.query('BEGIN');

    const duplicateGeneral = await findInsumoByUniqueKey(
      {
        nombre_insumo: normalized.nombre_insumo,
        id_almacen: normalized.id_almacen,
        excludeId: idInsumo
      },
      client
    );
    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: INSUMOS_DUPLICATE_MESSAGE
      });
    }

    await updateInsumoCompleto(idInsumo, normalized, client);
    await syncInsumoAlmacenes(idInsumo, [normalized.id_almacen], client);

    await client.query('COMMIT');
    return res.status(200).json({
      message: 'Insumo actualizado correctamente.',
      id_insumo: idInsumo
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error en PUT /insumos/edicion:', err.message);
    if (err?.code === INSUMOS_ALMACENES_TABLE_MISSING_CODE) {
      return res.status(500).json({ error: true, message: INSUMOS_ALMACENES_TABLE_MISSING_MESSAGE });
    }
    if (err?.code === '23505') {
      const duplicateMessage = getInsumosConstraintConflictMessage(err);
      if (duplicateMessage) {
        return res.status(409).json({ error: true, message: duplicateMessage });
      }
      return res.status(409).json({ error: true, message: 'No se pudo actualizar el insumo por una restriccion de datos.' });
    }
    return res.status(500).json({ error: true, message: safeServerErrorMessage() });
  } finally {
    client.release();
  }
});

// PUT: Actualizar insumo (1 campo)
router.put('/insumos', checkPermission(INSUMOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};
    const CAMPOS_GENERICOS_ACTUALIZABLES = new Set([
      'nombre_insumo',
      'precio',
      'stock_minimo',
      'fecha_ingreso_insumo',
      'id_categoria_insumo',
      'id_unidad_medida',
      'fecha_caducidad',
      'descripcion',
      'id_archivo_imagen_principal'
    ]);
    const ID_CAMPOS_PERMITIDOS = new Set(['id_insumo']);

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    if (campo === 'cantidad') {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede editarse desde este mÃ³dulo. Use movimientos de inventario.'
      });
    }

    // NEW: valida categoria de insumo solo cuando se intenta actualizar ese campo.
    // WHY: mantener PUT genÃ©rico pero asegurando coherencia con `categorias_insumos.estado`.
    // IMPACT: no afecta updates de otros campos.
    if (campo === 'estado') {
      return res.status(400).json({
        error: true,
        message: 'El estado no puede editarse desde este modulo. Use el flujo de activacion/inactivacion.'
      });
    }

    if (campo === 'id_almacen') {
      return res.status(400).json({
        error: true,
        message: 'El almacÃ©n no puede modificarse desde la ediciÃ³n del insumo. Use un flujo de traslado o reasignaciÃ³n controlada.'
      });
    }

    let valorNormalizado = valor;

    if (campo === 'nombre_insumo') {
      const nombreInsumo = sanitizeOptionalText(valorNormalizado);
      if (nombreInsumo === '') {
        return res.status(400).json({ error: true, message: 'nombre_insumo es obligatorio.' });
      }
      if (nombreInsumo.length < 2 || nombreInsumo.length > 80) {
        return res.status(400).json({ error: true, message: 'nombre_insumo debe tener entre 2 y 80 caracteres.' });
      }
      valorNormalizado = nombreInsumo;
    }

    if (campo === 'precio') {
      const precioRaw = valorNormalizado;
      if (precioRaw === undefined || precioRaw === null || String(precioRaw).trim() === '') {
        return res.status(400).json({ error: true, message: 'precio debe ser un numero mayor o igual a 0.' });
      }
      const precio = Number(precioRaw);
      if (!Number.isFinite(precio) || precio < 0) {
        return res.status(400).json({ error: true, message: 'precio debe ser un numero mayor o igual a 0.' });
      }
      valorNormalizado = precio;
    }

    if (campo === 'stock_minimo') {
      const stockMinimoRaw = valorNormalizado;
      if (stockMinimoRaw === undefined || stockMinimoRaw === null || String(stockMinimoRaw).trim() === '') {
        return res.status(400).json({ error: true, message: 'stock_minimo debe ser un numero mayor o igual a 0.' });
      }
      const stockMinimo = parseNonNegativeDecimal(stockMinimoRaw);
      if (stockMinimo === null) {
        return res.status(400).json({ error: true, message: 'stock_minimo debe ser un numero mayor o igual a 0.' });
      }
      valorNormalizado = stockMinimo;
    }

    if (campo === 'fecha_ingreso_insumo') {
      const fechaIngresoValidation = validateOptionalDateInput(valorNormalizado, 'fecha_ingreso_insumo');
      if (!fechaIngresoValidation.ok) {
        return res.status(400).json({ error: true, message: fechaIngresoValidation.message });
      }
      valorNormalizado = fechaIngresoValidation.value === '' ? null : fechaIngresoValidation.value;
    }

    if (campo === 'fecha_caducidad') {
      const fechaCaducidadValidation = validateOptionalDateInput(valorNormalizado, 'fecha_caducidad');
      if (!fechaCaducidadValidation.ok) {
        return res.status(400).json({ error: true, message: fechaCaducidadValidation.message });
      }
      valorNormalizado = fechaCaducidadValidation.value === '' ? null : fechaCaducidadValidation.value;
    }

    if (campo === 'id_categoria_insumo') {
      const categoriaValidation = await validateCategoriaInsumoActiva(valor);
      if (!categoriaValidation.ok) {
        return res.status(categoriaValidation.status).json({
          error: true,
          code: categoriaValidation.code,
          message: categoriaValidation.message
        });
      }
      valorNormalizado = categoriaValidation.id;
    }

    if (campo === 'id_unidad_medida') {
      const unidadValidation = await validateUnidadMedida(valor);
      if (!unidadValidation.ok) {
        return res.status(unidadValidation.status).json({
          error: true,
          code: unidadValidation.code,
          message: unidadValidation.message
        });
      }
      valorNormalizado = unidadValidation.id;
    }

    if (campo === 'id_archivo_imagen_principal') {
      const archivoValidation = await validateArchivoImagen(valor);
      if (!archivoValidation.ok) {
        return res.status(archivoValidation.status).json({
          error: true,
          code: archivoValidation.code,
          message: archivoValidation.message
        });
      }
      valorNormalizado = archivoValidation.id;
    }

    if (campo === 'nombre_insumo') {
      const idInsumo = Number.parseInt(String(id_valor ?? ''), 10);
      if (isPositiveIntegerId(idInsumo)) {
        const insumoActualParaDuplicado = await getInsumoById(idInsumo, pool);
        if (insumoActualParaDuplicado) {
          const nombreFinal = String(valorNormalizado ?? '');
          const idAlmacenFinal = Number.parseInt(String(insumoActualParaDuplicado.id_almacen ?? ''), 10);

          if (String(nombreFinal).trim() !== '' && isPositiveIntegerId(idAlmacenFinal)) {
            const duplicateByNombreAlmacen = await findInsumoByUniqueKey(
              {
                nombre_insumo: nombreFinal,
                id_almacen: idAlmacenFinal,
                excludeId: idInsumo
              },
              pool
            );
            if (duplicateByNombreAlmacen) {
              return res.status(409).json({ error: true, message: INSUMOS_DUPLICATE_MESSAGE });
            }
          }
        }
      }
    }

    // NEW: cuando una FK opcional se limpia, se persiste `NULL` real para mantener coherencia con la BD.
    // WHY: corrige el bug de quitar imagen y evita el mismo fallo en categoria/unidad opcionales.
    // IMPACT: los clientes siguen usando el mismo payload `valor: null`; solo cambia la persistencia interna.
    if (valorNormalizado === null && await updateNullableInsumoFieldToNull(id_valor, campo)) {
      return res.status(200).json({ message: 'Insumo actualizado correctamente.' });
    }

    if (!CAMPOS_GENERICOS_ACTUALIZABLES.has(campo)) {
      return res.status(400).json({ error: true, message: 'campo no permitido para actualizacion.' });
    }
    if (!ID_CAMPOS_PERMITIDOS.has(id_campo)) {
      return res.status(400).json({ error: true, message: 'id_campo no permitido para actualizacion.' });
    }

    const query = `UPDATE public.insumos SET ${campo} = $1 WHERE ${id_campo} = $2`;
    await pool.query(query, [valorNormalizado, id_valor]);

    res.status(200).json({ message: 'Insumo actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar insumo:', err.message);
    if (err?.code === INSUMOS_ALMACENES_TABLE_MISSING_CODE) {
      return res.status(500).json({ error: true, message: INSUMOS_ALMACENES_TABLE_MISSING_MESSAGE });
    }
    if (err?.code === '23505') {
      const duplicateMessage = getInsumosConstraintConflictMessage(err);
      if (duplicateMessage) {
        return res.status(409).json({ error: true, message: duplicateMessage });
      }
      return res.status(409).json({ error: true, message: 'No se pudo actualizar el insumo por una restriccion de datos.' });
    }
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// PATCH: Cambiar estado de insumo (flujo dedicado activar/inactivar)
router.patch('/insumos/estado', checkPermission(INSUMOS_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idInsumo = Number.parseInt(String(req.body?.id_insumo ?? ''), 10);
    if (!isPositiveIntegerId(idInsumo)) {
      return res.status(400).json({ error: true, message: 'id_insumo invalido.' });
    }

    const rawEstado = req.body?.estado;
    if (rawEstado === undefined || rawEstado === null || String(rawEstado).trim() === '') {
      return res.status(400).json({ error: true, message: 'estado es obligatorio.' });
    }

    const rawEstadoText = String(rawEstado).trim().toLowerCase();
    let nextEstado = null;
    if (rawEstado === true || rawEstado === 1 || rawEstado === '1' || rawEstadoText === 'true') nextEstado = true;
    if (rawEstado === false || rawEstado === 0 || rawEstado === '0' || rawEstadoText === 'false') nextEstado = false;
    if (nextEstado === null) {
      return res.status(400).json({ error: true, message: 'estado debe ser boolean (true/false o 1/0).' });
    }
    const actual = await getInsumoById(idInsumo, pool);
    if (!actual) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    if (nextEstado === false) {
      // AM: centraliza bloqueo de inactivacion para evitar bypass por PATCH estado.
      const dependencyValidation = await assertInsumoCanBeDeactivated(idInsumo, pool);
      if (!dependencyValidation.ok) {
        return res.status(dependencyValidation.status).json({
          error: true,
          code: dependencyValidation.code,
          message: dependencyValidation.message,
          dependency_summary: dependencyValidation.summary
        });
      }
    }

    const query = 'UPDATE public.insumos SET estado = $1 WHERE id_insumo = $2';
    await pool.query(query, [nextEstado, idInsumo]);

    return res.status(200).json({
      message: nextEstado ? 'Insumo activado.' : 'Insumo inactivado.'
    });
  } catch (err) {
    console.error('Error al actualizar estado de insumo:', err.message);
    return res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// DELETE: Inactivar insumo (soft delete)
router.delete('/insumos', checkPermission(INSUMOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene el contrato actual del DELETE pero restringe la columna esperada.
    // WHY: evitar operaciones arbitrarias y dejar el endpoint retrocompatible.
    // IMPACT: solo responde 400 en requests malformed.
    if (columna_id !== 'id_insumo') {
      return res.status(400).json({ error: true, message: 'columna_id invalido. Debe ser exactamente id_insumo.' });
    }

    const insumoId = Number(valor_id);
    if (!isPositiveIntegerId(insumoId)) {
      return res.status(400).json({ error: true, message: 'valor_id debe ser un entero mayor a 0.' });
    }

    // NEW: 404 explicito antes de inactivar.
    // WHY: estandarizar respuestas y evitar "exito" sobre IDs inexistentes.
    // IMPACT: no cambia el flujo de IDs validos.
    const existe = await pool.query('SELECT 1 FROM insumos WHERE id_insumo = $1 LIMIT 1', [insumoId]);
    if (existe.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    // AM: centraliza bloqueo de inactivacion para evitar bypass por DELETE.
    const dependencyValidation = await assertInsumoCanBeDeactivated(insumoId, pool);
    if (!dependencyValidation.ok) {
      return res.status(dependencyValidation.status).json({
        error: true,
        code: dependencyValidation.code,
        message: dependencyValidation.message,
        dependency_summary: dependencyValidation.summary
      });
    }

    const query = 'UPDATE public.insumos SET estado = false WHERE id_insumo = $1';
    await pool.query(query, [insumoId]);

    res.status(200).json({ error: false, message: 'Insumo inactivado.' });

  } catch (err) {
    console.error('Error al inactivar insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

export default router;



