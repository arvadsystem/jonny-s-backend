import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { autoPublishNewProduct } from '../services/menuAutoPublicationService.js';
import {
  isCatalogoMaestroReadsEnabled,
  isCatalogoMaestroViewMissingError,
  logCatalogoMaestroViewMissing,
  queryCatalogoMaestroView,
  sendCatalogoMaestroViewMissingResponse
} from '../services/catalogoMaestroReadService.js';

const router = express.Router();
const PRODUCTOS_LIST_PERMISSIONS = ['INVENTARIO_PRODUCTOS_VER', 'INVENTARIO_PRODUCTOS_DETALLE_VER'];
const PRODUCTOS_CREATE_PERMISSIONS = ['INVENTARIO_PRODUCTOS_CREAR'];
const PRODUCTOS_EDIT_PERMISSIONS = ['INVENTARIO_PRODUCTOS_EDITAR'];
const PRODUCTOS_DELETE_PERMISSIONS = ['INVENTARIO_PRODUCTOS_ELIMINAR', 'INVENTARIO_PRODUCTOS_ESTADO_CAMBIAR'];

// NUEVO: allowlist de campos para prevenir updates/inserts arbitrarios
const CAMPOS_PERMITIDOS_PRODUCTOS = new Set([
  'nombre_producto',
  'precio',
  'costo_compra',
  'cantidad',
  'stock_minimo',
  'descripcion_producto',
  'fecha_ingreso_producto',
  'fecha_caducidad',
  'id_categoria_producto',
  'id_almacen',
  'id_tipo_departamento',
  'id_archivo_imagen_principal',
  'estado'
]);

// AM: allowlist extendida solo para altas masivas por multi-almacen.
// AM: mantiene el contrato original (`id_almacen`) y agrega `id_almacenes` sin abrir campos arbitrarios.
const CAMPOS_PERMITIDOS_PRODUCTOS_POST = new Set([
  ...CAMPOS_PERMITIDOS_PRODUCTOS,
  'id_almacenes'
]);
const PRODUCTOS_UPDATE_FIELD_COLUMN_MAP = Object.freeze({
  nombre_producto: 'nombre_producto',
  precio: 'precio',
  costo_compra: 'costo_compra',
  stock_minimo: 'stock_minimo',
  descripcion_producto: 'descripcion_producto',
  fecha_ingreso_producto: 'fecha_ingreso_producto',
  fecha_caducidad: 'fecha_caducidad',
  id_categoria_producto: 'id_categoria_producto',
  id_almacen: 'id_almacen',
  id_tipo_departamento: 'id_tipo_departamento',
  id_archivo_imagen_principal: 'id_archivo_imagen_principal',
  estado: 'estado'
});

// NUEVO: codigos de conflicto SQL para responder 409 en constraints
const CODIGOS_CONFLICTO_CONSTRAINT = new Set(['23503', '23505', '23514', '23502']);
// NEW: codigo SQLSTATE de PostgreSQL para numeric/integer out of range.
// WHY: identificar y sanitizar respuestas cuando un valor excede el rango del tipo de la BD.
// IMPACT: solo manejo de errores en el router de Productos; no cambia consultas exitosas.
const CODIGO_SQL_OUT_OF_RANGE = '22003';
// NEW: limite superior de INTEGER (int4) usado por IDs en la BD/SPs actuales.
// WHY: bloquear IDs fuera de rango antes de ejecutar updates/deletes en SQL.
// IMPACT: valida requests invalidos y responde 400 en lugar de dejar que fallen con 500.
const MAX_INT32_DB_ID = 2147483647;
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const SQLSTATE_UNDEFINED_COLUMN = '42703';
const PRODUCTOS_DUPLICATE_CONSTRAINT = 'uq_productos_nombre_categoria_almacen_norm';
const PRODUCTOS_DUPLICATE_CONSTRAINT_LEGACY = 'uq_productos_nombre_categoria_departamento_norm';
const PRODUCTOS_DUPLICATE_MESSAGE = 'Ya existe un producto activo con el mismo nombre y categoria en este almacen.';
const PRODUCTOS_DUPLICATE_CODE = 'PRODUCT_DUPLICATE_IN_WAREHOUSE';
const PRODUCTOS_DATE_ORDER_MESSAGE = 'La fecha de caducidad no puede ser menor que la fecha de ingreso del producto.';
const SINGLE_ALMACEN_TEMP_MESSAGE = 'Temporalmente solo se permite un almacen por producto o insumo.';
const PRODUCTOS_DELETE_BLOCKED_MESSAGE = 'No se puede inactivar el producto porque esta siendo utilizado en otros modulos del sistema.';
const PRODUCTOS_DELETE_BLOCKING_OC_STATES = ['PENDIENTE', 'APROBADA', 'EN_COMPRA'];
const PRODUCTOS_DEPENDENCY_ITEMS_LIMIT = 10;
// NEW: query param opt-in para incluir inactivos en listados administrativos.
// WHY: el GET de productos debe devolver activos por defecto tras adoptar soft delete.
// IMPACT: mantiene compatibilidad con `?incluir_inactivos=1` sin crear endpoint nuevo.
const PRODUCTOS_SCOPE_FORBIDDEN_MESSAGE = 'No tiene permisos para operar sobre recursos fuera de su sucursal.';
const PRODUCTOS_SCOPE_MISSING_BRANCHES_MESSAGE = 'El empleado no tiene sucursales asignadas.';
const PRODUCTOS_NOT_FOUND_MESSAGE = 'Producto no encontrado.';
const ALMACEN_NOT_FOUND_MESSAGE = 'Almacen no encontrado.';
const PRODUCTOS_DEFAULT_PAGE = 1;
const PRODUCTOS_DEFAULT_PAGE_SIZE = 10;
const PRODUCTOS_MAX_PAGE_SIZE = 100;
const PRODUCTOS_SORT_ALLOWLIST = Object.freeze({
  recientes: 'p.id_producto DESC',
  nombre_asc: 'LOWER(COALESCE(p.nombre_producto, \'\')) ASC, p.id_producto DESC',
  nombre_desc: 'LOWER(COALESCE(p.nombre_producto, \'\')) DESC, p.id_producto DESC',
  precio_asc: 'COALESCE(p.precio, 0) ASC, p.id_producto DESC',
  precio_desc: 'COALESCE(p.precio, 0) DESC, p.id_producto DESC',
  stock_asc: 'COALESCE(p.cantidad, 0) ASC, p.id_producto DESC',
  stock_desc: 'COALESCE(p.cantidad, 0) DESC, p.id_producto DESC'
});
const PRODUCTOS_MAESTRO_SORT_ALLOWLIST = Object.freeze({
  recientes: 'v.id_producto_legacy DESC',
  nombre_asc: 'LOWER(COALESCE(v.nombre_producto, \'\')) ASC, v.id_producto_legacy DESC',
  nombre_desc: 'LOWER(COALESCE(v.nombre_producto, \'\')) DESC, v.id_producto_legacy DESC',
  precio_asc: 'COALESCE(v.precio_legacy, 0) ASC, v.id_producto_legacy DESC',
  precio_desc: 'COALESCE(v.precio_legacy, 0) DESC, v.id_producto_legacy DESC',
  stock_asc: 'COALESCE(v.cantidad, 0) ASC, v.id_producto_legacy DESC',
  stock_desc: 'COALESCE(v.cantidad, 0) DESC, v.id_producto_legacy DESC'
});
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// AM: parse opcional de IDs positivos para filtros de catalogo por sucursal/almacen.
const parseOptionalPositiveId = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return esEnteroPositivoInt32(parsed) ? parsed : null;
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

const parseEstadoFiltroProductos = (query) => {
  const raw = String(query?.estado ?? '').trim().toLowerCase();
  if (!raw) {
    return shouldIncludeInactive(query) ? 'todos' : 'activo';
  }

  if (raw === 'todos' || raw === 'all') return 'todos';
  if (raw === 'activo' || raw === 'activos' || raw === 'true' || raw === '1') return 'activo';
  if (raw === 'inactivo' || raw === 'inactivos' || raw === 'false' || raw === '0') return 'inactivo';
  return null;
};

const parseStockFiltroProductos = (query) => {
  const raw = String(query?.stock ?? '').trim().toLowerCase();
  if (!raw || raw === 'todos' || raw === 'all') return 'todos';
  if (raw === 'con_stock' || raw === 'constock') return 'con_stock';
  if (raw === 'sin_stock' || raw === 'sinstock') return 'sin_stock';
  return null;
};

const parseSortProductos = (query) => {
  const raw = String(query?.sort ?? query?.sortBy ?? '').trim().toLowerCase();
  if (!raw) return 'recientes';
  if (!Object.prototype.hasOwnProperty.call(PRODUCTOS_SORT_ALLOWLIST, raw)) return null;
  return raw;
};

function normalizeScopeSucursalIds(rawIds) {
  return Array.from(
    new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );
}

async function getAllowedBranchIdsForUser(req, db = pool) {
  if (req?.__productosSucursalScope) {
    return req.__productosSucursalScope;
  }

  const scope = await resolveRequestUserSucursalScope(req, db);
  const payload = {
    isSuperAdmin: Boolean(scope?.isSuperAdmin),
    allowedSucursalIds: normalizeScopeSucursalIds(scope?.allowedSucursalIds)
  };

  if (req) req.__productosSucursalScope = payload;
  return payload;
}

async function assertAlmacenesInScope(req, rawAlmacenes, db = pool) {
  const idAlmacenes = Array.from(
    new Set(
      (Array.isArray(rawAlmacenes) ? rawAlmacenes : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );

  if (idAlmacenes.length === 0) {
    return { ok: false, status: 400, message: 'Debe seleccionar al menos un id_almacen.' };
  }

  const scope = await getAllowedBranchIdsForUser(req, db);
  if (!scope.isSuperAdmin && scope.allowedSucursalIds.length === 0) {
    return { ok: false, status: 403, message: PRODUCTOS_SCOPE_MISSING_BRANCHES_MESSAGE };
  }

  const almacenesResult = await db.query(
    `
      SELECT a.id_almacen, a.id_sucursal
      FROM public.almacenes a
      WHERE a.id_almacen = ANY($1::int[])
    `,
    [idAlmacenes]
  );

  if (almacenesResult.rowCount !== idAlmacenes.length) {
    return { ok: false, status: 404, message: ALMACEN_NOT_FOUND_MESSAGE };
  }

  if (!scope.isSuperAdmin) {
    const allowedSet = new Set(scope.allowedSucursalIds);
    const hasUnauthorizedWarehouse = (almacenesResult.rows || []).some((row) => {
      const idSucursal = Number.parseInt(String(row?.id_sucursal ?? ''), 10);
      return !esEnteroPositivoInt32(idSucursal) || !allowedSet.has(idSucursal);
    });

    if (hasUnauthorizedWarehouse) {
      return { ok: false, status: 403, message: PRODUCTOS_SCOPE_FORBIDDEN_MESSAGE };
    }
  }

  return { ok: true, status: 200, rows: almacenesResult.rows || [] };
}

async function assertProductoInScope(req, idProducto, db = pool) {
  const producto = await getProductoById(idProducto, db);
  if (!producto) {
    return { ok: false, status: 404, message: PRODUCTOS_NOT_FOUND_MESSAGE };
  }

  const scope = await getAllowedBranchIdsForUser(req, db);
  if (!scope.isSuperAdmin && scope.allowedSucursalIds.length === 0) {
    return { ok: false, status: 403, message: PRODUCTOS_SCOPE_MISSING_BRANCHES_MESSAGE };
  }

  if (!scope.isSuperAdmin) {
    const idSucursal = Number.parseInt(String(producto?.id_sucursal ?? ''), 10);
    if (!esEnteroPositivoInt32(idSucursal) || !scope.allowedSucursalIds.includes(idSucursal)) {
      return { ok: false, status: 403, message: PRODUCTOS_SCOPE_FORBIDDEN_MESSAGE };
    }
  }

  return { ok: true, status: 200, producto };
}

function isSkippableDependencySchemaError(err) {
  return err?.code === SQLSTATE_UNDEFINED_TABLE || err?.code === SQLSTATE_UNDEFINED_COLUMN;
}

async function safeDependencyCount({ label, query, params }, db = pool) {
  try {
    const result = await db.query(query, Array.isArray(params) ? params : []);
    const total = Number.parseInt(String(result.rows?.[0]?.total ?? '0'), 10);
    return {
      label,
      checked: true,
      total: Number.isNaN(total) ? 0 : total
    };
  } catch (err) {
    if (isSkippableDependencySchemaError(err)) {
      console.warn(`[productos] dependencia omitida (${label}):`, err.message);
      return { label, checked: false, total: 0 };
    }
    throw err;
  }
}

// AM: obtiene muestra de dependencias por modulo (max 10) para mensaje humano de bloqueo.
async function safeDependencyItems({ label, query, params, mapRow }, db = pool) {
  try {
    const result = await db.query(query, Array.isArray(params) ? params : []);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    return {
      label,
      checked: true,
      items: rows.map((row) => (typeof mapRow === 'function' ? mapRow(row) : row))
    };
  } catch (err) {
    if (isSkippableDependencySchemaError(err)) {
      console.warn(`[productos] detalle dependencia omitida (${label}):`, err.message);
      return { label, checked: false, items: [] };
    }
    throw err;
  }
}

async function getProductoDependencySummary(idProducto, db = pool) {
  const [counts, details] = await Promise.all([
    Promise.all([
      safeDependencyCount(
        {
          label: 'menu_publicado',
          params: [idProducto],
          query: `
            SELECT COUNT(*)::int AS total
            FROM public.detalle_menu dm
            INNER JOIN public.menu m ON m.id_menu = dm.id_menu
            WHERE dm.id_producto = $1
              AND COALESCE(dm.estado, true) = true
              AND COALESCE(m.estado, true) = true
          `
        },
        db
      ),
      safeDependencyCount(
        {
          label: 'ordenes_compra_en_proceso',
          params: [idProducto, PRODUCTOS_DELETE_BLOCKING_OC_STATES],
          query: `
            SELECT COUNT(*)::int AS total
            FROM public.detalle_orden_compras doc
            INNER JOIN public.orden_compras oc
              ON oc.id_orden_compra = doc.id_orden_compra
            WHERE doc.id_producto = $1
              AND UPPER(COALESCE(oc.estado_flujo, '')) = ANY($2::text[])
          `
        },
        db
      ),
      safeDependencyCount(
        {
          label: 'stock_disponible',
          params: [idProducto],
          query: `
            SELECT COUNT(*)::int AS total
            FROM public.productos p
            WHERE p.id_producto = $1
              AND COALESCE(p.cantidad, 0) > 0
          `
        },
        db
      )
    ]),
    Promise.all([
      safeDependencyItems(
        {
          label: 'menu_publicado',
          params: [idProducto, PRODUCTOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT DISTINCT
              m.id_menu,
              COALESCE(NULLIF(TRIM(COALESCE(m.nombre_menu, m.nombre, '')), ''), CONCAT('Menu #', m.id_menu::text)) AS nombre
            FROM public.detalle_menu dm
            INNER JOIN public.menu m ON m.id_menu = dm.id_menu
            WHERE dm.id_producto = $1
              AND COALESCE(dm.estado, true) = true
              AND COALESCE(m.estado, true) = true
            ORDER BY m.id_menu ASC
            LIMIT $2
          `,
          mapRow: (row) => ({
            id_menu: Number(row.id_menu),
            nombre: String(row.nombre ?? `Menu #${row.id_menu}`)
          })
        },
        db
      ),
      safeDependencyItems(
        {
          label: 'ordenes_compra_en_proceso',
          params: [idProducto, PRODUCTOS_DELETE_BLOCKING_OC_STATES, PRODUCTOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT DISTINCT
              oc.id_orden_compra,
              COALESCE(NULLIF(TRIM(COALESCE(oc.codigo_orden_compra, oc.codigo, '')), ''), CONCAT('OC #', oc.id_orden_compra::text)) AS codigo,
              UPPER(COALESCE(oc.estado_flujo, '')) AS estado
            FROM public.detalle_orden_compras doc
            INNER JOIN public.orden_compras oc
              ON oc.id_orden_compra = doc.id_orden_compra
            WHERE doc.id_producto = $1
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
      ),
      safeDependencyItems(
        {
          label: 'stock_disponible',
          params: [idProducto, PRODUCTOS_DEPENDENCY_ITEMS_LIMIT],
          query: `
            SELECT
              a.id_sucursal,
              COALESCE(NULLIF(TRIM(COALESCE(s.nombre_sucursal, s.nombre, '')), ''), CONCAT('Sucursal #', a.id_sucursal::text)) AS sucursal,
              p.id_almacen,
              COALESCE(NULLIF(TRIM(COALESCE(a.nombre_almacen, a.nombre, '')), ''), CONCAT('Almacen #', p.id_almacen::text)) AS almacen,
              COALESCE(p.cantidad, 0)::numeric AS stock
            FROM public.productos p
            LEFT JOIN public.almacenes a ON a.id_almacen = p.id_almacen
            LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
            WHERE p.id_producto = $1
              AND COALESCE(p.cantidad, 0) > 0
            ORDER BY p.id_producto ASC
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
      blocking_modules: blocking.map((row) => ({
        modulo: row.modulo,
        total: row.total,
        items: row.items,
        remaining: row.remaining
      })),
      checks: normalizedChecks
    }
  };
}

async function assertProductoCanBeDeactivated(idProducto, db = pool) {
  const dependencySummary = await getProductoDependencySummary(idProducto, db);
  if (dependencySummary.hasBlockingDependencies) {
    return {
      ok: false,
      status: 409,
      message: PRODUCTOS_DELETE_BLOCKED_MESSAGE,
      summary: dependencySummary.summary
    };
  }

  return { ok: true, status: 200 };
}

// NUEVO: helper para detectar valores vacios en campos opcionales
const esVacio = (valor) =>
  valor === undefined ||
  valor === null ||
  (typeof valor === 'string' && valor.trim() === '');

// NUEVO: normaliza estado aceptando boolean, string y 1/0
function normalizarBoolean(valor) {
  if (valor === true || valor === false) return { valido: true, valor };
  if (valor === 1 || valor === 0) return { valido: true, valor: valor === 1 };

  if (typeof valor === 'string') {
    const limpio = valor.trim().toLowerCase();
    if (limpio === 'true' || limpio === '1') return { valido: true, valor: true };
    if (limpio === 'false' || limpio === '0') return { valido: true, valor: false };
  }

  return { valido: false };
}

// NEW: valida IDs enteros positivos compatibles con INT32 de PostgreSQL.
// WHY: `Number.isInteger` en JS acepta valores como Date.now() que luego fallan al castear a integer en la BD.
// IMPACT: prevencion temprana en PUT/DELETE de Productos; payloads validos siguen igual.
function esEnteroPositivoInt32(valor) {
  return Number.isSafeInteger(valor) && valor > 0 && valor <= MAX_INT32_DB_ID;
}

// AM: normaliza `id_almacen` / `id_almacenes` para soportar asignacion a uno o varios almacenes.
// AM: se usa en create/edit multi para mantener compatibilidad con payloads legacy.
function parseIdAlmacenes(rawSingle, rawMulti) {
  const source = Array.isArray(rawMulti) ? rawMulti : (rawMulti === undefined || rawMulti === null ? [] : [rawMulti]);
  const out = [];

  for (const raw of source) {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!esEnteroPositivoInt32(parsed)) {
      return { ok: false, message: 'id_almacenes contiene un id_almacen invalido.' };
    }
    if (!out.includes(parsed)) out.push(parsed);
  }

  if (out.length > 1) {
    return { ok: false, message: SINGLE_ALMACEN_TEMP_MESSAGE };
  }
  if (out.length > 0) return { ok: true, ids: out };

  const parsedSingle = Number.parseInt(String(rawSingle ?? '').trim(), 10);
  if (esEnteroPositivoInt32(parsedSingle)) {
    return { ok: true, ids: [parsedSingle] };
  }

  return { ok: false, message: 'Debe seleccionar al menos un id_almacen.' };
}

// AM: convierte valores Date/Timestamp a `YYYY-MM-DD` para reutilizarlos en payloads de edicion.
function toDateOnlyString(value) {
  if (!value) return '';
  const raw = String(value);
  if (raw.includes('T')) return raw.split('T')[0];
  if (raw.length >= 10) return raw.slice(0, 10);
  return raw;
}

// NEW: helper para interpretar `estado` aunque venga como string/number.
// WHY: `function_select` puede serializar booleans de forma distinta segun el entorno.
// IMPACT: solo afecta filtrado del GET /productos.
function isRowActive(row) {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
}

// NUEVO: valida formato de fecha y coherencia de calendario (yyyy-mm-dd)
function esFechaValida(valor) {
  if (typeof valor !== 'string') return false;

  const limpio = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limpio)) return false;

  const fecha = new Date(`${limpio}T00:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return false;

  return fecha.toISOString().slice(0, 10) === limpio;
}

function validarCoherenciaFechasProducto({ fechaIngreso, fechaCaducidad }) {
  const ingreso = typeof fechaIngreso === 'string' ? fechaIngreso.trim() : '';
  const caducidad = typeof fechaCaducidad === 'string' ? fechaCaducidad.trim() : '';

  if (!ingreso || !caducidad) {
    return { ok: true };
  }

  if (!esFechaValida(ingreso) || !esFechaValida(caducidad)) {
    return { ok: true };
  }

  const ingresoTime = new Date(`${ingreso}T00:00:00Z`).getTime();
  const caducidadTime = new Date(`${caducidad}T00:00:00Z`).getTime();
  if (caducidadTime < ingresoTime) {
    return { ok: false, message: PRODUCTOS_DATE_ORDER_MESSAGE };
  }

  return { ok: true };
}

// NUEVO: valida y normaliza cada campo permitido de productos
function validarCampoProducto(campo, valor) {
  if (campo === 'nombre_producto') {
    // VALIDACION: nombre_producto string con longitud 2..50
    if (typeof valor !== 'string') {
      return { valido: false, message: 'nombre_producto debe ser un texto.' };
    }

    const limpio = valor.trim();
    if (limpio.length < 2 || limpio.length > 50) {
      return { valido: false, message: 'nombre_producto debe tener entre 2 y 50 caracteres.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'descripcion_producto') {
    // VALIDACION: descripcion_producto string <= 250 si viene
    if (typeof valor !== 'string') {
      return { valido: false, message: 'descripcion_producto debe ser un texto.' };
    }

    const limpio = valor.trim();
    if (limpio.length > 250) {
      return { valido: false, message: 'descripcion_producto no puede exceder 250 caracteres.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'precio') {
    // VALIDACION: precio numerico >= 0
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) {
      return { valido: false, message: 'precio debe ser un numero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'costo_compra') {
    // AM: costo_compra es opcional; null representa costo no definido.
    if (esVacio(valor)) {
      return { valido: true, valor: null };
    }

    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) {
      return { valido: false, message: 'costo_compra debe ser un numero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'cantidad') {
    // VALIDACION: cantidad entero >= 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 0) {
      return { valido: false, message: 'cantidad debe ser un entero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'stock_minimo') {
    // VALIDACION: stock_minimo entero >= 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 0) {
      return { valido: false, message: 'stock_minimo debe ser un entero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'fecha_ingreso_producto' || campo === 'fecha_caducidad') {
    // VALIDACION: fechas en formato valido yyyy-mm-dd
    if (!esFechaValida(valor)) {
      return { valido: false, message: `${campo} debe tener formato de fecha valido (YYYY-MM-DD).` };
    }

    return { valido: true, valor: String(valor).trim() };
  }

  if (campo === 'id_categoria_producto' || campo === 'id_almacen') {
    // VALIDACION: FK obligatorias enteras > 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: `${campo} debe ser un entero mayor a 0.` };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'id_tipo_departamento') {
    // VALIDACION: id_tipo_departamento puede ser null/vacio o entero > 0
    if (esVacio(valor)) {
      return { valido: true, valor: null };
    }

    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: 'id_tipo_departamento debe ser un entero mayor a 0 o null/vacio.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'id_archivo_imagen_principal') {
    // NEW: imagen principal opcional referenciando `archivos.id_archivo`.
    // WHY: permitir asociar o limpiar la imagen principal sin crear endpoints extra de productos.
    // IMPACT: POST/PUT aceptan la FK real y mantienen el contrato actual del resto de campos.
    if (esVacio(valor)) {
      return { valido: true, valor: null };
    }

    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: 'id_archivo_imagen_principal debe ser un entero mayor a 0 o null/vacio.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'estado') {
    // VALIDACION: estado boolean normalizado
    const bool = normalizarBoolean(valor);
    if (!bool.valido) {
      return { valido: false, message: 'estado debe ser boolean (true/false, "true"/"false" o 1/0).' };
    }

    return { valido: true, valor: bool.valor };
  }

  return { valido: false, message: `El campo ${campo} no esta permitido.` };
}

// NUEVO: valida existencia FK para integridad referencial previa
async function validarExistenciaFk(campo, valor, db = pool) {
  if (campo === 'id_categoria_producto') {
    const r = await db.query(
      'SELECT 1 FROM categorias_productos WHERE id_categoria_producto = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_almacen') {
    const r = await db.query(
      'SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_tipo_departamento') {
    if (valor === null) return true;

    const r = await db.query(
      'SELECT 1 FROM tipo_departamento WHERE id_tipo_departamento = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_archivo_imagen_principal') {
    if (valor === null) return true;

    const r = await db.query(
      'SELECT 1 FROM archivos WHERE id_archivo = $1 AND COALESCE(estado, true) = true LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  return true;
}

async function validarAlmacenOperativo(idAlmacen, db = pool) {
  const r = await db.query(
    `
      SELECT id_almacen, COALESCE(estado, true) AS estado
      FROM almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [idAlmacen]
  );

  if (r.rowCount === 0) {
    return { ok: false, message: `id_almacen ${idAlmacen} no existe en almacenes.` };
  }

  if (!Boolean(r.rows?.[0]?.estado)) {
    return { ok: false, message: 'El almacen seleccionado esta inactivo.' };
  }

  return { ok: true };
}

// AM: carga snapshot completo del producto para soportar edicion multi-almacen sin perder campos opcionales.
async function getProductoById(idProducto, db = pool) {
  const r = await db.query(
    `SELECT
      p.id_producto,
      p.nombre_producto,
      p.precio,
      p.costo_compra,
      p.cantidad,
      p.stock_minimo,
      p.descripcion_producto,
      p.fecha_ingreso_producto,
      p.fecha_caducidad,
      p.id_categoria_producto,
      p.id_almacen,
      p.id_tipo_departamento,
      p.estado,
      p.id_archivo_imagen_principal,
      a.id_sucursal
    FROM productos p
    LEFT JOIN public.almacenes a ON a.id_almacen = p.id_almacen
    WHERE p.id_producto = $1
    LIMIT 1`,
    [idProducto]
  );
  return r.rows[0] || null;
}

async function getHydratedProductoById(req, idProducto, db = pool) {
  const producto = await getProductoById(idProducto, db);
  if (!producto) return null;
  const rowsWithAlmacenes = await attachProductoAlmacenes([producto], db);
  const rowsWithImagen = await attachImagenPrincipalUrls(db, req, rowsWithAlmacenes);
  return rowsWithImagen?.[0] || producto;
}

// AM: valida duplicado activo por llave operativa real (nombre + categoria + almacen).
async function findProductoByWarehouseKey(
  {
    nombre_producto,
    id_categoria_producto,
    id_almacen,
    excludeId = null
  },
  db = pool
) {
  const params = [
    String(nombre_producto ?? '').trim().toLowerCase(),
    id_categoria_producto,
    id_almacen
  ];

  let sql = `
    SELECT id_producto
    FROM productos
    WHERE lower(trim(nombre_producto)) = $1
      AND id_categoria_producto = $2
      AND id_almacen = $3
      AND COALESCE(estado, true) = true
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_producto <> $4';
  }

  sql += ' ORDER BY id_producto ASC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows?.[0] || null;
}

// AM: sincroniza las asignaciones multi-almacen del producto sin duplicar filas de productos por sucursal.
async function syncProductoAlmacenes(idProducto, idAlmacenes, db = pool) {
  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(idAlmacenes) ? idAlmacenes : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );

  if (uniqueIds.length === 0) return;

  const primaryAlmacen = uniqueIds[0];
  const singleAlmacenIds = [primaryAlmacen];
  await db.query('UPDATE public.productos SET id_almacen = $1 WHERE id_producto = $2', [primaryAlmacen, idProducto]);

  try {
    await db.query(
      `
        INSERT INTO public.productos_almacenes (id_producto, id_almacen)
        SELECT $1, UNNEST($2::int[])
        ON CONFLICT (id_producto, id_almacen) DO NOTHING
      `,
      [idProducto, singleAlmacenIds]
    );

    await db.query(
      `
        DELETE FROM public.productos_almacenes
        WHERE id_producto = $1
          AND id_almacen <> ALL($2::int[])
      `,
      [idProducto, singleAlmacenIds]
    );
  } catch (error) {
    // AM: fallback legacy cuando la tabla de asignaciones aun no existe.
    if (error?.code !== SQLSTATE_UNDEFINED_TABLE) throw error;
  }
}

// AM: asegura que GET /productos incluya `id_almacenes` sin romper compatibilidad con `id_almacen`.
async function attachProductoAlmacenes(rows, db = pool) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;

  const ids = Array.from(
    new Set(
      list
        .map((row) => Number.parseInt(String(row?.id_producto ?? ''), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );

  if (ids.length === 0) {
    return list.map((row) => ({ ...row, id_almacenes: [] }));
  }

  try {
    const assignmentsResult = await db.query(
      `
        SELECT pa.id_producto, ARRAY_AGG(pa.id_almacen ORDER BY pa.id_almacen) AS id_almacenes
        FROM public.productos_almacenes pa
        WHERE pa.id_producto = ANY($1::int[])
        GROUP BY pa.id_producto
      `,
      [ids]
    );

    const map = new Map(
      assignmentsResult.rows.map((row) => [
        Number(row.id_producto),
        (Array.isArray(row.id_almacenes) ? row.id_almacenes : [])
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => esEnteroPositivoInt32(id))
      ])
    );

    return list.map((row) => {
      const idProducto = Number.parseInt(String(row?.id_producto ?? ''), 10);
      const fromMap = map.get(idProducto) || [];
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      const idAlmacenesBase =
        fromMap.length > 0
          ? fromMap
          : esEnteroPositivoInt32(fallbackSingle)
          ? [fallbackSingle]
          : [];
      const idAlmacenes = idAlmacenesBase;
      const primaryAlmacen = esEnteroPositivoInt32(fallbackSingle)
        ? fallbackSingle
        : (idAlmacenes[0] ?? null);

      return {
        ...row,
        id_almacen: primaryAlmacen,
        id_almacenes: idAlmacenes
      };
    });
  } catch (error) {
    if (error?.code !== SQLSTATE_UNDEFINED_TABLE) throw error;
    return list.map((row) => {
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      return {
        ...row,
        id_almacenes: esEnteroPositivoInt32(fallbackSingle) ? [fallbackSingle] : []
      };
    });
  }
}

// AM: update explicito de todo el registro para sincronizacion multi-almacen.
// AM: evita encadenar multiples updates parciales y mantiene una sola transaccion atomica.
async function updateProductoCompleto(idProducto, data, db = pool) {
  await db.query(
    `UPDATE productos
     SET
       nombre_producto = $1,
       precio = $2,
       costo_compra = $3,
       stock_minimo = $4,
       descripcion_producto = $5,
       fecha_ingreso_producto = $6,
       fecha_caducidad = $7,
       id_categoria_producto = $8,
       id_almacen = $9,
       id_tipo_departamento = $10,
       estado = $11,
       id_archivo_imagen_principal = $12
     WHERE id_producto = $13`,
    [
      data.nombre_producto,
      data.precio,
      data.costo_compra ?? null,
      data.stock_minimo,
      data.descripcion_producto || '',
      data.fecha_ingreso_producto || null,
      data.fecha_caducidad || null,
      data.id_categoria_producto,
      data.id_almacen,
      data.id_tipo_departamento ?? null,
      data.estado,
      data.id_archivo_imagen_principal ?? null,
      idProducto
    ]
  );
}

// NEW: persistencia explicita por campo para PUT /productos sin procedimientos genericos.
// WHY: mejorar trazabilidad y seguridad en un modulo sensible de inventario.
// IMPACT: reemplaza `pa_update` con SQL parametrizado y allowlist de columnas.
async function updateProductoField(idProducto, campo, valor, db = pool) {
  const column = PRODUCTOS_UPDATE_FIELD_COLUMN_MAP[campo];
  if (!column) {
    return { ok: false, updated: false };
  }

  const result = await db.query(
    `UPDATE public.productos
     SET ${column} = $1
     WHERE id_producto = $2
     RETURNING id_producto`,
    [valor, idProducto]
  );

  return { ok: true, updated: result.rowCount > 0 };
}

// NUEVO: helper para clasificar errores SQL de constraint como conflicto
function esErrorConflictoConstraint(err) {
  return Boolean(err?.code && CODIGOS_CONFLICTO_CONSTRAINT.has(err.code));
}

function getProductosConstraintConflictMessage(err) {
  if (!err || err.code !== '23505') return '';
  const trace = String(err?.constraint || err?.detail || err?.message || '').toLowerCase();
  const hasDuplicateConstraint =
    trace.includes(PRODUCTOS_DUPLICATE_CONSTRAINT.toLowerCase()) ||
    trace.includes(PRODUCTOS_DUPLICATE_CONSTRAINT_LEGACY.toLowerCase());
  if (!hasDuplicateConstraint) return '';
  return PRODUCTOS_DUPLICATE_MESSAGE;
}

function isProductosDuplicateConstraintError(err) {
  const trace = String(err?.constraint || err?.detail || err?.message || '').toLowerCase();
  return (
    trace.includes(PRODUCTOS_DUPLICATE_CONSTRAINT.toLowerCase()) ||
    trace.includes(PRODUCTOS_DUPLICATE_CONSTRAINT_LEGACY.toLowerCase())
  );
}

// NEW: sanitiza mensajes internos de BD para respuestas HTTP del router de Productos.
// WHY: evitar exponer detalles como `out of range for type integer` al frontend/usuario.
// IMPACT: solo cambia el texto de errores internos; status codes y logging del servidor se mantienen.
function getSafeProductosServerErrorMessage(err, fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') {
  const raw = String(err?.message || '').toLowerCase();
  if (err?.code === CODIGO_SQL_OUT_OF_RANGE) return fallback;
  if (raw.includes('out of range') && raw.includes('integer')) return fallback;
  return String(err?.message || fallback);
}

const mapProductoMaestroRow = (row) => {
  const idAlmacen = Number.parseInt(String(row?.id_almacen ?? ''), 10);
  return {
    ...row,
    id_producto: row.id_producto == null ? row.id_producto : Number(row.id_producto),
    id_producto_maestro: row.id_producto_maestro == null ? null : Number(row.id_producto_maestro),
    id_almacen: esEnteroPositivoInt32(idAlmacen) ? idAlmacen : row.id_almacen,
    id_sucursal: row.id_sucursal == null ? null : Number(row.id_sucursal),
    id_almacenes: esEnteroPositivoInt32(idAlmacen) ? [idAlmacen] : []
  };
};

async function listProductosDesdeCatalogoMaestro({
  req,
  queryPayload,
  scope,
  requestedSucursal,
  requestedAlmacen,
  requestedCategoria,
  requestedDeptoHasValue,
  requestedDeptoIsNullFilter,
  requestedDepto,
  estadoFiltro,
  stockFiltro,
  sortKey,
  search,
  wantsPaginated,
  page,
  pageSize
}) {
  const whereClauses = [];
  const whereParams = [];

  if (estadoFiltro === 'activo') whereClauses.push('(v.estado_global IS TRUE AND v.estado_local IS TRUE)');
  if (estadoFiltro === 'inactivo') whereClauses.push('NOT (v.estado_global IS TRUE AND v.estado_local IS TRUE)');
  if (requestedCategoria !== null) {
    whereParams.push(requestedCategoria);
    whereClauses.push(`v.id_categoria_producto = $${whereParams.length}`);
  }
  if (requestedAlmacen !== null) {
    whereParams.push(requestedAlmacen);
    whereClauses.push(`v.id_almacen = $${whereParams.length}`);
  }
  if (requestedDeptoHasValue) {
    if (requestedDeptoIsNullFilter) {
      whereClauses.push('v.id_tipo_departamento IS NULL');
    } else {
      whereParams.push(requestedDepto);
      whereClauses.push(`v.id_tipo_departamento = $${whereParams.length}`);
    }
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
  if (search) {
    const like = `%${search}%`;
    whereParams.push(like);
    const p = whereParams.length;
    whereClauses.push(`
      (
        COALESCE(v.nombre_producto, '') ILIKE $${p}
        OR COALESCE(v.descripcion_producto, '') ILIKE $${p}
        OR COALESCE(cp.nombre_categoria, '') ILIKE $${p}
        OR COALESCE(a.nombre, '') ILIKE $${p}
      )
    `);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const fromSql = `
    FROM public.vw_productos_maestros_almacen v
    LEFT JOIN public.almacenes a
      ON a.id_almacen = v.id_almacen
    LEFT JOIN public.categorias_productos cp
      ON cp.id_categoria_producto = v.id_categoria_producto
    ${whereSql}
  `;
  const orderBySql = PRODUCTOS_MAESTRO_SORT_ALLOWLIST[sortKey] || PRODUCTOS_MAESTRO_SORT_ALLOWLIST.recientes;

  let total = 0;
  if (wantsPaginated) {
    const totalResult = await queryCatalogoMaestroView(
      pool,
      'public.vw_productos_maestros_almacen',
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
    'public.vw_productos_maestros_almacen',
    `
      SELECT
        v.id_producto_legacy AS id_producto,
        v.id_producto_maestro,
        v.nombre_producto,
        v.precio_legacy AS precio,
        v.costo_compra,
        v.cantidad,
        v.stock_minimo,
        v.descripcion_producto,
        v.fecha_ingreso_producto,
        v.fecha_caducidad,
        v.id_categoria_producto,
        v.id_almacen,
        v.id_sucursal,
        v.id_tipo_departamento,
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

  const rows = (dataResult.rows || []).map(mapProductoMaestroRow);
  const items = await attachImagenPrincipalUrls(pool, req, rows);

  if (!wantsPaginated) {
    return { paginated: false, items };
  }

  return {
    paginated: true,
    payload: {
      error: false,
      items,
      total,
      page,
      pageSize,
      totalPages: total === 0 ? 1 : Math.ceil(total / pageSize)
    }
  };
}

// GET: Obtener productos
router.get('/productos', checkPermission(PRODUCTOS_LIST_PERMISSIONS), async (req, res) => {
  try {
    const queryPayload = { ...req.query };
    const scope = await getAllowedBranchIdsForUser(req, pool);
    if (!scope.isSuperAdmin && scope.allowedSucursalIds.length === 0) {
      return res.status(403).json({ error: true, message: PRODUCTOS_SCOPE_MISSING_BRANCHES_MESSAGE });
    }

    const requestedSucursalHasValue = hasQueryKey(queryPayload, 'id_sucursal');
    const requestedSucursal = parseOptionalPositiveId(queryPayload.id_sucursal);
    if (requestedSucursalHasValue && requestedSucursal === null) {
      return res.status(400).json({ error: true, message: 'id_sucursal invalido.' });
    }

    if (!scope.isSuperAdmin && requestedSucursal && !scope.allowedSucursalIds.includes(requestedSucursal)) {
      return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
    }

    const requestedAlmacenHasValue = hasQueryKey(queryPayload, 'id_almacen');
    const requestedAlmacen = parseOptionalPositiveId(queryPayload.id_almacen);
    if (requestedAlmacenHasValue && requestedAlmacen === null) {
      return res.status(400).json({ error: true, message: 'id_almacen invalido.' });
    }

    const requestedCategoriaHasValue =
      hasQueryKey(queryPayload, 'id_categoria_producto') || hasQueryKey(queryPayload, 'id_categoria');
    const requestedCategoria = parseOptionalPositiveId(
      queryPayload.id_categoria_producto ?? queryPayload.id_categoria
    );
    if (requestedCategoriaHasValue && requestedCategoria === null) {
      return res.status(400).json({ error: true, message: 'id_categoria_producto invalido.' });
    }

    const requestedDeptoHasValue = hasQueryKey(queryPayload, 'id_tipo_departamento');
    const requestedDeptoRaw = String(queryPayload.id_tipo_departamento ?? '').trim().toLowerCase();
    const requestedDeptoIsNullFilter =
      requestedDeptoHasValue &&
      (requestedDeptoRaw === 'null' || requestedDeptoRaw === 'sin_departamento' || requestedDeptoRaw === 'none');
    const requestedDepto = requestedDeptoIsNullFilter
      ? null
      : parseOptionalPositiveId(queryPayload.id_tipo_departamento);
    if (requestedDeptoHasValue && !requestedDeptoIsNullFilter && requestedDepto === null) {
      return res.status(400).json({ error: true, message: 'id_tipo_departamento invalido.' });
    }

    const estadoFiltro = parseEstadoFiltroProductos(queryPayload);
    if (!estadoFiltro) {
      return res.status(400).json({ error: true, message: 'estado invalido. Use activo, inactivo o todos.' });
    }

    const stockFiltro = parseStockFiltroProductos(queryPayload);
    if (!stockFiltro) {
      return res.status(400).json({ error: true, message: 'stock invalido. Use con_stock, sin_stock o todos.' });
    }

    const sortKey = parseSortProductos(queryPayload);
    if (!sortKey) {
      return res.status(400).json({ error: true, message: 'sort invalido.' });
    }

    const rawSearch = queryPayload.q ?? queryPayload.search ?? queryPayload.busqueda ?? '';
    const search = String(rawSearch ?? '').trim();

    const wantsPaginated =
      hasQueryKey(queryPayload, 'page') ||
      hasQueryKey(queryPayload, 'pageSize') ||
      hasQueryKey(queryPayload, 'page_size') ||
      hasQueryKey(queryPayload, 'limit');

    const pageParsed = parsePositiveIntParam(
      queryPayload.page,
      PRODUCTOS_DEFAULT_PAGE,
      1,
      100000
    );
    if (!pageParsed.ok) {
      return res.status(400).json({ error: true, message: 'page invalido.' });
    }

    const pageSizeParsed = parsePositiveIntParam(
      queryPayload.pageSize ?? queryPayload.page_size ?? queryPayload.limit,
      PRODUCTOS_DEFAULT_PAGE_SIZE,
      1,
      PRODUCTOS_MAX_PAGE_SIZE
    );
    if (!pageSizeParsed.ok) {
      return res.status(400).json({
        error: true,
        message: `pageSize invalido. Debe estar entre 1 y ${PRODUCTOS_MAX_PAGE_SIZE}.`
      });
    }

    const page = pageParsed.value;
    const pageSize = pageSizeParsed.value;

    if (isCatalogoMaestroReadsEnabled()) {
      const result = await listProductosDesdeCatalogoMaestro({
        req,
        queryPayload,
        scope,
        requestedSucursal,
        requestedAlmacen,
        requestedCategoria,
        requestedDeptoHasValue,
        requestedDeptoIsNullFilter,
        requestedDepto,
        estadoFiltro,
        stockFiltro,
        sortKey,
        search,
        wantsPaginated,
        page,
        pageSize
      });

      if (!result.paginated) {
        return res.status(200).json(result.items);
      }
      return res.status(200).json(result.payload);
    }

    const whereClauses = [];
    const whereParams = [];

    if (estadoFiltro === 'activo') whereClauses.push('COALESCE(p.estado, true) = true');
    if (estadoFiltro === 'inactivo') whereClauses.push('COALESCE(p.estado, true) = false');
    if (requestedCategoria !== null) {
      whereParams.push(requestedCategoria);
      whereClauses.push(`p.id_categoria_producto = $${whereParams.length}`);
    }
    if (requestedAlmacen !== null) {
      whereParams.push(requestedAlmacen);
      whereClauses.push(`p.id_almacen = $${whereParams.length}`);
    }
    if (requestedDeptoHasValue) {
      if (requestedDeptoIsNullFilter) {
        whereClauses.push('p.id_tipo_departamento IS NULL');
      } else {
        whereParams.push(requestedDepto);
        whereClauses.push(`p.id_tipo_departamento = $${whereParams.length}`);
      }
    }
    if (stockFiltro === 'con_stock') whereClauses.push('COALESCE(p.cantidad, 0) > 0');
    if (stockFiltro === 'sin_stock') whereClauses.push('COALESCE(p.cantidad, 0) <= 0');
    if (requestedSucursal !== null) {
      whereParams.push(requestedSucursal);
      whereClauses.push(`a.id_sucursal = $${whereParams.length}`);
    } else if (!scope.isSuperAdmin) {
      whereParams.push(scope.allowedSucursalIds);
      whereClauses.push(`a.id_sucursal = ANY($${whereParams.length}::int[])`);
    }
    if (search) {
      const like = `%${search}%`;
      whereParams.push(like);
      const p = whereParams.length;
      whereClauses.push(`
        (
          COALESCE(p.nombre_producto, '') ILIKE $${p}
          OR COALESCE(p.descripcion_producto, '') ILIKE $${p}
          OR COALESCE(cp.nombre_categoria, '') ILIKE $${p}
          OR COALESCE(a.nombre, '') ILIKE $${p}
        )
      `);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const fromSql = `
      FROM public.productos p
      LEFT JOIN public.almacenes a
        ON a.id_almacen = p.id_almacen
      LEFT JOIN public.categorias_productos cp
        ON cp.id_categoria_producto = p.id_categoria_producto
      ${whereSql}
    `;
    const orderBySql = PRODUCTOS_SORT_ALLOWLIST[sortKey] || PRODUCTOS_SORT_ALLOWLIST.recientes;

    let total = 0;
    if (wantsPaginated) {
      const totalResult = await pool.query(
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

    const dataResult = await pool.query(
      `
        SELECT
          p.id_producto,
          p.nombre_producto,
          p.precio,
          p.costo_compra,
          p.cantidad,
          p.stock_minimo,
          p.descripcion_producto,
          p.fecha_ingreso_producto,
          p.fecha_caducidad,
          p.id_categoria_producto,
          p.id_almacen,
          p.id_tipo_departamento,
          p.estado,
          p.id_archivo_imagen_principal
        ${fromSql}
        ORDER BY ${orderBySql}
        ${paginationSql}
      `,
      dataParams
    );

    const rows = dataResult.rows || [];
    const rowsWithAlmacenes = await attachProductoAlmacenes(rows, pool);
    const items = await attachImagenPrincipalUrls(pool, req, rowsWithAlmacenes);

    if (!wantsPaginated) {
      return res.status(200).json(items);
    }

    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
    return res.status(200).json({
      error: false,
      items,
      total,
      page,
      pageSize,
      totalPages
    });

  } catch (err) {
    if (isCatalogoMaestroViewMissingError(err)) {
      logCatalogoMaestroViewMissing('GET /productos', err);
      return sendCatalogoMaestroViewMissingResponse(res);
    }
    if (isCatalogoMaestroReadsEnabled()) {
      console.error('Error al obtener productos desde catalogo maestro:', err.message);
      return res.status(500).json({ error: true, message: 'No se pudieron cargar los productos.' });
    }
    console.error('Error al obtener productos:', err.message);
    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err, 'No se pudieron cargar los productos.') });
  }
});

// POST: Crear producto
router.post('/productos', checkPermission(PRODUCTOS_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const datosEntrada = req.body;

    // VALIDACION: body debe ser objeto valido
    if (!datosEntrada || typeof datosEntrada !== 'object' || Array.isArray(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido para crear producto.' });
    }

    const keys = Object.keys(datosEntrada);

    // VALIDACION: allowlist de campos aceptados
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_PRODUCTOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    // VALIDACION: requeridos para alta de producto
    const camposRequeridos = [
      'nombre_producto',
      'precio',
      'id_categoria_producto'
    ];

    const faltantes = camposRequeridos.filter((campo) => esVacio(datosEntrada[campo]));
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    // NUEVO: normalizacion unificada del payload antes de persistir
    const datosNormalizados = {};

    for (const campo of keys) {
      if (campo === 'id_almacenes' || campo === 'cantidad') continue;
      const resultado = validarCampoProducto(campo, datosEntrada[campo]);
      if (!resultado.valido) {
        return res.status(400).json({ error: true, message: resultado.message });
      }
      datosNormalizados[campo] = resultado.valor;
    }

    // NEW: el CRUD de catalogo no debe aceptar ni persistir stock operativo desde el cliente.
    // WHY: separar alta de producto vs movimientos de inventario/kardex.
    // IMPACT: altas nuevas siempre inician con cantidad 0 sin depender del payload del frontend.
    datosNormalizados.cantidad = 0;

    // AJUSTE: stock_minimo opcional con default 0 si no viene
    if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'stock_minimo')) {
      datosNormalizados.stock_minimo = 0;
    }

    const fechasCreateValidation = validarCoherenciaFechasProducto({
      fechaIngreso: datosNormalizados.fecha_ingreso_producto,
      fechaCaducidad: datosNormalizados.fecha_caducidad
    });
    if (!fechasCreateValidation.ok) {
      return res.status(400).json({
        error: true,
        message: fechasCreateValidation.message
      });
    }

    // VALIDACION: existencia FK categoria
    if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_categoria_producto')) {
      return res.status(400).json({ error: true, message: 'id_categoria_producto es obligatorio.' });
    }
    const existeCategoria = await validarExistenciaFk('id_categoria_producto', datosNormalizados.id_categoria_producto, client);
    if (!existeCategoria) {
      return res.status(400).json({
        error: true,
        message: 'id_categoria_producto no existe en categorias_productos.'
      });
    }

    // VALIDACION: existencia FK almacen
    const almacenesParse = parseIdAlmacenes(datosEntrada?.id_almacen, datosEntrada?.id_almacenes);
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }

    const idAlmacenes = almacenesParse.ids;
    datosNormalizados.id_almacen = idAlmacenes[0];

    const almacenesScopeValidation = await assertAlmacenesInScope(req, idAlmacenes, client);
    if (!almacenesScopeValidation.ok) {
      return res.status(almacenesScopeValidation.status).json({
        error: true,
        message: almacenesScopeValidation.message
      });
    }

    // VALIDACION: existencia FK tipo_departamento solo si viene con valor
    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_tipo_departamento')) {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', datosNormalizados.id_tipo_departamento, client);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    // NEW: valida la imagen principal cuando el payload incluye FK a `archivos`.
    // WHY: evitar referencias a archivos inexistentes y fallos de FK mas tarde en la BD.
    // IMPACT: solo rechaza payloads invalidos; altas validas se mantienen intactas.
    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo_imagen_principal')) {
      const existeArchivo = await validarExistenciaFk(
        'id_archivo_imagen_principal',
        datosNormalizados.id_archivo_imagen_principal,
        client
      );
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    await client.query('BEGIN');

    for (const idAlmacen of idAlmacenes) {
      const almacenOperativo = await validarAlmacenOperativo(idAlmacen, client);
      if (!almacenOperativo.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: true,
          message: almacenOperativo.message
        });
      }
    }

    const duplicadoGeneral = await findProductoByWarehouseKey(
      {
        nombre_producto: datosNormalizados.nombre_producto,
        id_categoria_producto: datosNormalizados.id_categoria_producto,
        id_almacen: idAlmacenes[0]
      },
      client
    );

    if (duplicadoGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        code: PRODUCTOS_DUPLICATE_CODE,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    const payloadPrimary = {
      ...datosNormalizados,
      id_almacen: idAlmacenes[0]
    };

    const insertResult = await client.query(
      `
        INSERT INTO public.productos (
          nombre_producto,
          precio,
          costo_compra,
          cantidad,
          stock_minimo,
          descripcion_producto,
          fecha_ingreso_producto,
          fecha_caducidad,
          id_categoria_producto,
          id_almacen,
          id_tipo_departamento,
          estado,
          id_archivo_imagen_principal
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
        RETURNING id_producto
      `,
      [
        payloadPrimary.nombre_producto,
        payloadPrimary.precio,
        payloadPrimary.costo_compra ?? null,
        0,
        payloadPrimary.stock_minimo ?? 0,
        payloadPrimary.descripcion_producto ?? '',
        payloadPrimary.fecha_ingreso_producto ?? null,
        payloadPrimary.fecha_caducidad ?? null,
        payloadPrimary.id_categoria_producto,
        payloadPrimary.id_almacen,
        payloadPrimary.id_tipo_departamento ?? null,
        payloadPrimary.estado ?? true,
        payloadPrimary.id_archivo_imagen_principal ?? null
      ]
    );

    const idProductoCreado = Number.parseInt(String(insertResult.rows?.[0]?.id_producto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProductoCreado)) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: true,
        message: 'No se pudo resolver el ID del producto creado.'
      });
    }

    await syncProductoAlmacenes(idProductoCreado, idAlmacenes, client);
    await autoPublishNewProduct({
      client,
      idProducto: idProductoCreado,
      idCategoriaProducto: payloadPrimary.id_categoria_producto,
      idAlmacen: payloadPrimary.id_almacen,
      estadoItem: payloadPrimary.estado ?? true
    });

    const productoResponse = await getHydratedProductoById(req, idProductoCreado, client);
    if (!productoResponse) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: true,
        message: 'No se pudo cargar el producto recien creado.'
      });
    }

    await client.query('COMMIT');

    res.status(201).json({
      error: false,
      message: 'Producto creado exitosamente.',
      id_producto: idProductoCreado,
      producto: productoResponse
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear producto:', err.message);

    if (isProductosDuplicateConstraintError(err)) {
      return res.status(409).json({
        error: true,
        code: PRODUCTOS_DUPLICATE_CODE,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      const duplicateMessage = getProductosConstraintConflictMessage(err);
      return res.status(409).json({
        error: true,
        code: duplicateMessage ? PRODUCTOS_DUPLICATE_CODE : undefined,
        message: duplicateMessage || 'No se pudo crear el producto por una restriccion de datos.'
      });
    }

    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// AM: endpoint legado de compatibilidad para sincronizacion multi-almacen.
// AM: el flujo principal actual de UI opera en mono-almacen y usa `PUT /productos` por campo.
router.put('/productos/multi-almacen', checkPermission(PRODUCTOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idProducto = Number.parseInt(String(req.body?.id_producto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({ error: true, message: 'id_producto invalido.' });
    }

    const productoScopeValidation = await assertProductoInScope(req, idProducto, client);
    if (!productoScopeValidation.ok) {
      return res.status(productoScopeValidation.status).json({
        error: true,
        message: productoScopeValidation.message
      });
    }
    const actual = productoScopeValidation.producto;
    if (!isRowActive(actual)) {
      return res.status(400).json({ error: true, message: 'El producto esta inactivo.' });
    }

    const datosEntrada = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    delete datosEntrada.id_producto;

    if (Object.prototype.hasOwnProperty.call(datosEntrada, 'cantidad')) {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede modificarse desde el catálogo de productos.'
      });
    }

    const keys = Object.keys(datosEntrada);
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_PRODUCTOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const merged = {
      nombre_producto: datosEntrada.nombre_producto ?? actual.nombre_producto,
      precio: datosEntrada.precio ?? actual.precio,
      costo_compra: Object.prototype.hasOwnProperty.call(datosEntrada, 'costo_compra')
        ? datosEntrada.costo_compra
        : actual.costo_compra,
      cantidad: actual.cantidad,
      stock_minimo: datosEntrada.stock_minimo ?? actual.stock_minimo ?? 0,
      descripcion_producto: datosEntrada.descripcion_producto ?? actual.descripcion_producto ?? '',
      fecha_ingreso_producto: datosEntrada.fecha_ingreso_producto ?? toDateOnlyString(actual.fecha_ingreso_producto),
      fecha_caducidad: datosEntrada.fecha_caducidad ?? toDateOnlyString(actual.fecha_caducidad),
      id_categoria_producto: datosEntrada.id_categoria_producto ?? actual.id_categoria_producto,
      id_tipo_departamento: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_tipo_departamento')
        ? datosEntrada.id_tipo_departamento
        : actual.id_tipo_departamento,
      id_archivo_imagen_principal: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_archivo_imagen_principal')
        ? datosEntrada.id_archivo_imagen_principal
        : actual.id_archivo_imagen_principal,
      estado: Object.prototype.hasOwnProperty.call(datosEntrada, 'estado')
        ? datosEntrada.estado
        : (actual.estado ?? true),
      id_almacen: datosEntrada.id_almacen ?? actual.id_almacen
    };

    const datosNormalizados = {};
    for (const [campo, valorRaw] of Object.entries(merged)) {
      if ((campo === 'fecha_ingreso_producto' || campo === 'fecha_caducidad') && esVacio(valorRaw)) {
        continue;
      }
      const resultado = validarCampoProducto(campo, valorRaw);
      if (!resultado.valido) {
        return res.status(400).json({ error: true, message: resultado.message });
      }
      datosNormalizados[campo] = resultado.valor;
    }

    // AM: evita bypass de inactivacion en flujo multi-almacen aplicando la misma validacion de DELETE.
    if (datosNormalizados.estado === false) {
      const dependencyValidation = await assertProductoCanBeDeactivated(idProducto, client);
      if (!dependencyValidation.ok) {
        return res.status(dependencyValidation.status).json({
          error: true,
          code: 'PRODUCT_IN_USE',
          message: dependencyValidation.message,
          dependency_summary: dependencyValidation.summary
        });
      }
    }

    const fechasEditMultiValidation = validarCoherenciaFechasProducto({
      fechaIngreso: datosNormalizados.fecha_ingreso_producto,
      fechaCaducidad: datosNormalizados.fecha_caducidad
    });
    if (!fechasEditMultiValidation.ok) {
      return res.status(400).json({
        error: true,
        message: fechasEditMultiValidation.message
      });
    }

    const camposRequeridos = ['nombre_producto', 'precio', 'stock_minimo', 'id_categoria_producto'];
    const faltantes = camposRequeridos.filter((campo) => !Object.prototype.hasOwnProperty.call(datosNormalizados, campo));
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    const almacenesParse = parseIdAlmacenes(
      datosEntrada.id_almacen ?? actual.id_almacen,
      datosEntrada.id_almacenes
    );
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }
    const idAlmacenes = almacenesParse.ids;

    const almacenesScopeValidation = await assertAlmacenesInScope(req, idAlmacenes, client);
    if (!almacenesScopeValidation.ok) {
      return res.status(almacenesScopeValidation.status).json({
        error: true,
        message: almacenesScopeValidation.message
      });
    }

    const existeCategoria = await validarExistenciaFk('id_categoria_producto', datosNormalizados.id_categoria_producto, client);
    if (!existeCategoria) {
      return res.status(400).json({
        error: true,
        message: 'id_categoria_producto no existe en categorias_productos.'
      });
    }

    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_tipo_departamento')) {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', datosNormalizados.id_tipo_departamento, client);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo_imagen_principal')) {
      const existeArchivo = await validarExistenciaFk(
        'id_archivo_imagen_principal',
        datosNormalizados.id_archivo_imagen_principal,
        client
      );
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    for (const idAlmacen of idAlmacenes) {
      const almacenOperativo = await validarAlmacenOperativo(idAlmacen, client);
      if (!almacenOperativo.ok) {
        return res.status(400).json({
          error: true,
          message: almacenOperativo.message
        });
      }
    }

    await client.query('BEGIN');

    const duplicateGeneral = await findProductoByWarehouseKey(
      {
        nombre_producto: datosNormalizados.nombre_producto,
        id_categoria_producto: datosNormalizados.id_categoria_producto,
        id_almacen: idAlmacenes[0],
        excludeId: idProducto
      },
      client
    );

    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        code: PRODUCTOS_DUPLICATE_CODE,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    const primaryAlmacen = idAlmacenes[0];
    const payloadPrimary = { ...datosNormalizados, id_almacen: primaryAlmacen };
    await updateProductoCompleto(idProducto, payloadPrimary, client);
    await syncProductoAlmacenes(idProducto, idAlmacenes, client);

    await client.query('COMMIT');
    return res.status(200).json({
      message: `Producto actualizado y asignado en ${idAlmacenes.length} almacen(es).`,
      id_producto: idProducto,
      id_almacenes: idAlmacenes
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error en PUT /productos/multi-almacen:', err.message);
    if (isProductosDuplicateConstraintError(err)) {
      return res.status(409).json({
        error: true,
        code: PRODUCTOS_DUPLICATE_CODE,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }
    if (esErrorConflictoConstraint(err)) {
      const duplicateMessage = getProductosConstraintConflictMessage(err);
      return res.status(409).json({
        error: true,
        code: duplicateMessage ? PRODUCTOS_DUPLICATE_CODE : undefined,
        message: duplicateMessage || 'No se pudo sincronizar el producto por una restriccion de datos.'
      });
    }
    return res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// PUT: Actualizar producto (1 campo)
router.put('/productos', checkPermission(PRODUCTOS_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txStarted = false;
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    // VALIDACION: id_campo fijo para evitar updates arbitrarios
    if (id_campo !== 'id_producto') {
      return res.status(400).json({
        error: true,
        message: 'id_campo invalido. Debe ser exactamente id_producto.'
      });
    }

    // VALIDACION: campo de actualizacion dentro de allowlist
    if (!CAMPOS_PERMITIDOS_PRODUCTOS.has(campo)) {
      return res.status(400).json({
        error: true,
        message: `Campo no permitido para actualizar: ${campo}`
      });
    }

    if (campo === 'cantidad') {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede modificarse desde el catálogo de productos.'
      });
    }

    if (campo === 'id_almacen') {
      return res.status(409).json({
        error: true,
        message: 'El almacén del producto no puede modificarse desde la edición de catálogo.'
      });
    }

    // VALIDACION: id objetivo valido
    const idProducto = Number(id_valor);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({
        error: true,
        message: 'id_valor debe ser un entero positivo dentro del rango permitido.'
      });
    }

    const productoScopeValidation = await assertProductoInScope(req, idProducto, client);
    if (!productoScopeValidation.ok) {
      return res.status(productoScopeValidation.status).json({
        error: true,
        message: productoScopeValidation.message
      });
    }
    const productoActual = productoScopeValidation.producto;

    const resultado = validarCampoProducto(campo, valor);
    if (!resultado.valido) {
      return res.status(400).json({ error: true, message: resultado.message });
    }

    // AM: evita bypass de inactivacion por PUT campo=estado usando la misma regla de DELETE.
    if (campo === 'estado' && resultado.valor === false) {
      const dependencyValidation = await assertProductoCanBeDeactivated(idProducto, client);
      if (!dependencyValidation.ok) {
        return res.status(dependencyValidation.status).json({
          error: true,
          code: 'PRODUCT_IN_USE',
          message: dependencyValidation.message,
          dependency_summary: dependencyValidation.summary
        });
      }
    }

    if (campo === 'fecha_ingreso_producto' || campo === 'fecha_caducidad') {
      const fechasPutValidation = validarCoherenciaFechasProducto({
        fechaIngreso:
          campo === 'fecha_ingreso_producto'
            ? resultado.valor
            : toDateOnlyString(productoActual.fecha_ingreso_producto),
        fechaCaducidad:
          campo === 'fecha_caducidad'
            ? resultado.valor
            : toDateOnlyString(productoActual.fecha_caducidad)
      });
      if (!fechasPutValidation.ok) {
        return res.status(400).json({
          error: true,
          message: fechasPutValidation.message
        });
      }
    }

    // VALIDACION: FK categoria si se actualiza
    if (campo === 'id_categoria_producto') {
      const existeCategoria = await validarExistenciaFk('id_categoria_producto', resultado.valor, client);
      if (!existeCategoria) {
        return res.status(400).json({
          error: true,
          message: 'id_categoria_producto no existe en categorias_productos.'
        });
      }
    }

    // VALIDACION: FK tipo_departamento solo cuando trae valor
    if (campo === 'id_tipo_departamento') {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', resultado.valor, client);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    if (campo === 'id_archivo_imagen_principal') {
      const existeArchivo = await validarExistenciaFk('id_archivo_imagen_principal', resultado.valor, client);
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    if (campo === 'nombre_producto' || campo === 'id_categoria_producto' || campo === 'id_tipo_departamento') {
      const duplicateGeneral = await findProductoByWarehouseKey(
        {
          nombre_producto: campo === 'nombre_producto' ? resultado.valor : productoActual.nombre_producto,
          id_categoria_producto: campo === 'id_categoria_producto' ? resultado.valor : productoActual.id_categoria_producto,
          id_almacen: productoActual.id_almacen,
          excludeId: idProducto
        },
        client
      );

      if (duplicateGeneral) {
        return res.status(409).json({
          error: true,
          code: PRODUCTOS_DUPLICATE_CODE,
          message: PRODUCTOS_DUPLICATE_MESSAGE
        });
      }
    }

    await client.query('BEGIN');
    txStarted = true;

    const updateResult = await updateProductoField(idProducto, campo, resultado.valor, client);
    if (!updateResult.ok) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(400).json({
        error: true,
        message: `Campo no permitido para actualizar: ${campo}`
      });
    }
    if (!updateResult.updated) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(404).json({
        error: true,
        message: PRODUCTOS_NOT_FOUND_MESSAGE
      });
    }

    const productoResponse = await getHydratedProductoById(req, idProducto, client);
    if (!productoResponse) {
      await client.query('ROLLBACK');
      txStarted = false;
      return res.status(500).json({
        error: true,
        message: 'No se pudo cargar el producto actualizado.'
      });
    }

    await client.query('COMMIT');
    txStarted = false;
    res.status(200).json({
      error: false,
      message: 'Producto actualizado correctamente.',
      producto: productoResponse
    });

  } catch (err) {
    if (txStarted) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('Error al actualizar producto:', {
      code: err?.code ?? null,
      constraint: err?.constraint ?? null,
      detail: err?.detail ?? null,
      message: err?.message ?? null
    });

    if (isProductosDuplicateConstraintError(err)) {
      return res.status(409).json({
        error: true,
        code: PRODUCTOS_DUPLICATE_CODE,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      const duplicateMessage = getProductosConstraintConflictMessage(err);
      return res.status(409).json({
        error: true,
        code: duplicateMessage ? PRODUCTOS_DUPLICATE_CODE : undefined,
        message: duplicateMessage || 'No se pudo actualizar el producto por una restriccion de datos.'
      });
    }

    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// DELETE: Inactivar producto (soft delete)
router.delete('/productos', checkPermission(PRODUCTOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    // NEW: fallback compatible para obtener id del producto desde body/query/params sin romper firmas actuales.
    // WHY: evita `ReferenceError` y tolera clientes legacy que envian distintos nombres del ID.
    // IMPACT: mantiene el endpoint DELETE /productos y amplia la lectura del ID de forma retrocompatible.
    const rawIdProducto =
      req.body?.idProducto ?? req.body?.id_producto ??
      req.query?.idProducto ?? req.query?.id_producto ??
      req.params?.idProducto ?? req.params?.id_producto ??
      req.body?.valor_id ?? req.query?.valor_id;

    // NEW: fallback compatible para columna_id con default seguro.
    // WHY: conservar compatibilidad con la firma actual (`columna_id`,`valor_id`) sin exigirla a otros callers.
    // IMPACT: si no llega `columna_id`, se asume `id_producto`; payloads existentes siguen funcionando.
    const columna_id =
      req.body?.columna_id ?? req.query?.columna_id ?? req.params?.columna_id ?? 'id_producto';

    // VALIDACION: columna_id fijo para evitar deletes arbitrarios
    if (columna_id !== 'id_producto') {
      return res.status(400).json({
        error: true,
        code: 'INVALID_PRODUCT_ID',
        message: 'ID de producto invalido.'
      });
    }

    // VALIDACION: id del producto a eliminar
    const idProducto = Number.parseInt(String(rawIdProducto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_PRODUCT_ID',
        message: 'ID de producto invalido.'
      });
    }

    const productoScopeValidation = await assertProductoInScope(req, idProducto, pool);
    if (!productoScopeValidation.ok) {
      const code = productoScopeValidation.status === 404 ? 'PRODUCT_NOT_FOUND' : 'FORBIDDEN';
      return res.status(productoScopeValidation.status).json({
        error: true,
        code,
        message: productoScopeValidation.message
      });
    }

    const dependencyValidation = await assertProductoCanBeDeactivated(idProducto, pool);
    if (!dependencyValidation.ok) {
      return res.status(dependencyValidation.status).json({
        error: true,
        code: 'PRODUCT_IN_USE',
        message: dependencyValidation.message,
        dependency_summary: dependencyValidation.summary
      });
    }

    const softDeleteResult = await pool.query(
      `
        UPDATE public.productos
        SET estado = false
        WHERE id_producto = $1
        RETURNING id_producto
      `,
      [idProducto]
    );

    if (softDeleteResult.rowCount === 0) {
      return res.status(404).json({
        error: true,
        code: 'PRODUCT_NOT_FOUND',
        message: PRODUCTOS_NOT_FOUND_MESSAGE
      });
    }

    return res.status(200).json({ error: false, message: 'Producto inactivado.' });

  } catch (err) {
    console.error('Error al inactivar producto:', err.message);
    // NEW: respuesta 500 estandarizada para no exponer detalles internos (ej. ReferenceError / SQL).
    // WHY: el cliente no debe recibir mensajes crudos como `idProducto is not defined`.
    // IMPACT: solo cambia el payload de error en DELETE /productos; logging del servidor se conserva.
    return res.status(500).json({
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'No se pudo completar la accion. Intenta de nuevo.'
    });
  }
});

export default router;

