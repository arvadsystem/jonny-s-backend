import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveMenuDepartmentIds } from './menu_departamentos.js';
import { syncExistingBranchProductsIntoMenu } from '../services/menuAutoPublicationService.js';
import {
  getPublicMenuHeroCarouselConfig,
  savePublicMenuHeroCarouselConfig
} from '../services/publicMenuHeroCarouselConfigService.js';

const router = express.Router();
// AM: transicion segura a permisos granulares sin romper el acceso actual mientras se alinea BD/roles.
const MENU_PUBLICACION_VIEW_PERMISSIONS = ['MENU_PUBLICACION_VER', 'MENU_VER'];
const MENU_PUBLICACION_SAVE_PERMISSIONS = ['MENU_PUBLICACION_GUARDAR', 'MENU_VER'];
const MENU_TEMPORADA_CREATE_PERMISSIONS = ['MENU_TEMPORADA_CREAR', 'MENU_VER'];

const ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  COMBO: 'COMBO'
});

// Fallback por categoria de inventario cuando el producto no trae id_tipo_departamento esperado.
const MENU_PRODUCT_CATEGORY_ALIASES = Object.freeze([
  'cervezas',
  'cerveza',
  'refrescos/agua',
  'refrescos / agua',
  'gaseosas y refrescos',
  'gaseosas/refrescos',
  'aguas, isotónicos y energéticas',
  'aguas, isotonicos y energeticas',
  'helados sarita',
  'snacks',
  'snack'
]);

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toNullableMoney = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return NaN;
  return Number(parsed.toFixed(2));
};

const toNullablePositiveInt = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return NaN;
  return parsed;
};

const parseBoolean = (value) => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;

  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 't', 'yes', 'y', 'si', 'sí', 'on'].includes(normalized)) return true;
  if (['false', 'f', 'no', 'n', 'off'].includes(normalized)) return false;

  return Boolean(value);
};

const normalizeItemType = (value) => {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === ITEM_TYPES.PRODUCTO) return ITEM_TYPES.PRODUCTO;
  if (normalized === ITEM_TYPES.RECETA) return ITEM_TYPES.RECETA;
  if (normalized === ITEM_TYPES.COMBO) return ITEM_TYPES.COMBO;
  return '';
};

const buildItemKey = (tipoItem, idItemOrigen) => `${tipoItem}:${idItemOrigen}`;

const hasColumn = async (tableName, columnName) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1;
    `,
    [tableName, columnName]
  );
  return result.rowCount > 0;
};

const getDetalleMenuCapabilities = async () => {
  const [hasIdReceta, hasIdCombo, hasVisible, hasPrecioPublico, hasOrden] = await Promise.all([
    hasColumn('detalle_menu', 'id_receta'),
    hasColumn('detalle_menu', 'id_combo'),
    hasColumn('detalle_menu', 'visible'),
    hasColumn('detalle_menu', 'precio_publico'),
    hasColumn('detalle_menu', 'orden')
  ]);

  return {
    hasIdReceta,
    hasIdCombo,
    hasVisible,
    hasPrecioPublico,
    hasOrden
  };
};

const getActiveMenuByBranch = async (idSucursal) => {
  const result = await pool.query(
    `
      SELECT
        mv.id_menu_vigente,
        mv.id_sucursal,
        mv.id_menu,
        mv.fecha_inicio,
        m.nombre_menu,
        m.descripcion AS menu_descripcion,
        s.nombre_sucursal
      FROM menu_vigente mv
      INNER JOIN menu m ON m.id_menu = mv.id_menu
      INNER JOIN sucursales s ON s.id_sucursal = mv.id_sucursal
      WHERE mv.id_sucursal = $1
        AND COALESCE(mv.estado, true) = true
        AND COALESCE(m.estado, true) = true
        AND COALESCE(mv.fecha_inicio, NOW()) <= NOW()
      ORDER BY mv.fecha_inicio DESC, mv.id_menu_vigente DESC
      LIMIT 1;
    `,
    [idSucursal]
  );

  return result.rows?.[0] || null;
};

const mapMenuSummary = (row) => ({
  id_menu_vigente: row.id_menu_vigente ? Number(row.id_menu_vigente) : null,
  id_menu: Number(row.id_menu),
  id_sucursal: Number(row.id_sucursal),
  nombre_menu: row.nombre_menu || 'Menu',
  descripcion_menu: row.menu_descripcion || '',
  nombre_sucursal: row.nombre_sucursal || '',
  fecha_inicio: row.fecha_inicio || null
});
const SHARED_MENU_WARNING_PREFIX = 'Atencion: este menu esta compartido entre sucursales.';

const toDateTimeOrNull = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const getMenusForProgramming = async () => {
  const result = await pool.query(
    `
      SELECT
        m.id_menu,
        m.nombre_menu,
        COALESCE(m.descripcion, '') AS descripcion,
        COALESCE(m.estado, true) AS estado
      FROM menu m
      WHERE COALESCE(m.estado, true) = true
      ORDER BY m.id_menu ASC;
    `
  );

  return (result.rows || []).map((row) => ({
    id_menu: Number(row.id_menu),
    nombre_menu: row.nombre_menu || `Menu #${row.id_menu}`,
    descripcion: row.descripcion || '',
    estado: parseBoolean(row.estado)
  }));
};

const existsActiveBranch = async (idSucursal) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM sucursales
      WHERE id_sucursal = $1
        AND COALESCE(estado, true) = true
      LIMIT 1;
    `,
    [idSucursal]
  );

  return result.rowCount > 0;
};

const existsActiveMenu = async (idMenu) => {
  const result = await pool.query(
    `
      SELECT 1
      FROM menu
      WHERE id_menu = $1
        AND COALESCE(estado, true) = true
      LIMIT 1;
    `,
    [idMenu]
  );

  return result.rowCount > 0;
};

const getMenuById = async (idMenu) => {
  const result = await pool.query(
    `
      SELECT
        id_menu,
        nombre_menu,
        COALESCE(descripcion, '') AS descripcion,
        COALESCE(estado, true) AS estado
      FROM menu
      WHERE id_menu = $1
      LIMIT 1;
    `,
    [idMenu]
  );

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    id_menu: Number(row.id_menu),
    nombre_menu: row.nombre_menu || `Menu #${row.id_menu}`,
    descripcion: row.descripcion || '',
    estado: parseBoolean(row.estado)
  };
};

const getMenuUsageSummary = async (idMenu) => {
  const result = await pool.query(
    `
      SELECT
        EXISTS(
          SELECT 1
          FROM menu_vigente mv
          WHERE mv.id_menu = $1
        ) AS has_vigencias,
        EXISTS(
          SELECT 1
          FROM detalle_menu dm
          WHERE dm.id_menu = $1
            AND COALESCE(dm.estado, true) = true
        ) AS has_detalle_menu,
        EXISTS(
          SELECT 1
          FROM recetas r
          WHERE r.id_menu = $1
            AND COALESCE(r.estado, true) = true
        ) AS has_recetas,
        EXISTS(
          SELECT 1
          FROM combos c
          WHERE c.id_menu = $1
            AND COALESCE(c.estado, true) = true
        ) AS has_combos;
    `,
    [idMenu]
  );

  const row = result.rows?.[0] || {};
  return {
    has_vigencias: parseBoolean(row.has_vigencias),
    has_detalle_menu: parseBoolean(row.has_detalle_menu),
    has_recetas: parseBoolean(row.has_recetas),
    has_combos: parseBoolean(row.has_combos)
  };
};

const canDeactivateMenu = (usage = {}) =>
  !usage.has_vigencias &&
  !usage.has_detalle_menu &&
  !usage.has_recetas &&
  !usage.has_combos;

const buildMenuUsageBlockers = (usage = {}) => {
  const blockers = [];
  if (usage.has_vigencias) blockers.push('tiene vigencias registradas');
  if (usage.has_detalle_menu) blockers.push('tiene publicaciones activas en detalle_menu');
  if (usage.has_recetas) blockers.push('tiene recetas activas asociadas');
  if (usage.has_combos) blockers.push('tiene combos activos asociados');
  return blockers;
};

const getBranchById = async (idSucursal) => {
  const result = await pool.query(
    `
      SELECT
        id_sucursal,
        nombre_sucursal,
        COALESCE(estado, true) AS estado
      FROM sucursales
      WHERE id_sucursal = $1
      LIMIT 1;
    `,
    [idSucursal]
  );

  const row = result.rows?.[0];
  if (!row) return null;

  return {
    id_sucursal: Number(row.id_sucursal),
    nombre_sucursal: row.nombre_sucursal || `Sucursal #${row.id_sucursal}`,
    estado: parseBoolean(row.estado)
  };
};

const getAuthenticatedUserId = (req) => toPositiveInt(req?.user?.id_usuario);

const getBranchesForPublication = async () => {
  const result = await pool.query(
    `
      SELECT
        s.id_sucursal,
        s.nombre_sucursal,
        COALESCE(s.estado, true) AS estado,
        COALESCE(vsi.texto_direccion, '') AS direccion,
        mv.id_menu_vigente,
        mv.id_menu,
        mv.fecha_inicio
      FROM sucursales s
      LEFT JOIN v_sucursales_info vsi
        ON vsi.id_sucursal = s.id_sucursal
      LEFT JOIN LATERAL (
        SELECT
          mvv.id_menu_vigente,
          mvv.id_menu,
          mvv.fecha_inicio
        FROM menu_vigente mvv
        INNER JOIN menu m
          ON m.id_menu = mvv.id_menu
        WHERE mvv.id_sucursal = s.id_sucursal
          AND COALESCE(mvv.estado, true) = true
          AND COALESCE(m.estado, true) = true
          AND COALESCE(mvv.fecha_inicio, NOW()) <= NOW()
        ORDER BY mvv.fecha_inicio DESC, mvv.id_menu_vigente DESC
        LIMIT 1
      ) mv ON true
      ORDER BY s.id_sucursal ASC;
    `
  );

  return (result.rows || []).map((row) => ({
    id_sucursal: Number(row.id_sucursal),
    nombre_sucursal: row.nombre_sucursal,
    estado: parseBoolean(row.estado),
    direccion: row.direccion || '',
    tiene_menu_vigente: Number(row.id_menu_vigente || 0) > 0,
    id_menu_vigente: row.id_menu_vigente ? Number(row.id_menu_vigente) : null,
    id_menu: row.id_menu ? Number(row.id_menu) : null,
    fecha_inicio_menu: row.fecha_inicio || null
  }));
};

// Detecta en cuantas sucursales esta activo actualmente un menu.
// Esto permite advertir impacto transversal al editar publicacion.
const getActiveBranchesByMenu = async (idMenu) => {
  const result = await pool.query(
    `
      SELECT
        s.id_sucursal,
        s.nombre_sucursal,
        COALESCE(vsi.texto_direccion, '') AS direccion,
        mv.id_menu_vigente,
        mv.fecha_inicio
      FROM sucursales s
      LEFT JOIN v_sucursales_info vsi
        ON vsi.id_sucursal = s.id_sucursal
      INNER JOIN LATERAL (
        SELECT
          mvv.id_menu_vigente,
          mvv.id_menu,
          mvv.fecha_inicio
        FROM menu_vigente mvv
        INNER JOIN menu m
          ON m.id_menu = mvv.id_menu
        WHERE mvv.id_sucursal = s.id_sucursal
          AND COALESCE(mvv.estado, true) = true
          AND COALESCE(m.estado, true) = true
          AND COALESCE(mvv.fecha_inicio, NOW()) <= NOW()
        ORDER BY mvv.fecha_inicio DESC, mvv.id_menu_vigente DESC
        LIMIT 1
      ) mv ON true
      WHERE mv.id_menu = $1
        AND COALESCE(s.estado, true) = true
      ORDER BY s.id_sucursal ASC;
    `,
    [idMenu]
  );

  return (result.rows || []).map((row) => ({
    id_sucursal: Number(row.id_sucursal),
    nombre_sucursal: row.nombre_sucursal || `Sucursal #${row.id_sucursal}`,
    direccion: row.direccion || '',
    id_menu_vigente: Number(row.id_menu_vigente),
    fecha_inicio_menu: row.fecha_inicio || null
  }));
};

const buildSharedMenuImpact = ({ idMenu, idSucursal, branches = [] }) => {
  const normalizedBranches = Array.isArray(branches) ? branches : [];
  const currentSucursalId = toPositiveInt(idSucursal);
  const totalBranches = normalizedBranches.length;
  const isShared = totalBranches > 1;

  const currentBranch = currentSucursalId
    ? normalizedBranches.find((branch) => Number(branch.id_sucursal) === currentSucursalId) || null
    : null;
  const otherBranches = currentSucursalId
    ? normalizedBranches.filter((branch) => Number(branch.id_sucursal) !== currentSucursalId)
    : normalizedBranches;

  const warningMessage = isShared
    ? `${SHARED_MENU_WARNING_PREFIX} Cambios en menu #${idMenu} impactan ${totalBranches} sucursales activas.`
    : '';

  return {
    id_menu: Number(idMenu),
    is_shared: isShared,
    total_sucursales_activas: totalBranches,
    sucursal_actual_en_scope: Boolean(currentBranch),
    sucursal_actual: currentBranch,
    sucursales_activas: normalizedBranches,
    sucursales_activas_excluyendo_actual: otherBranches,
    warning_message: warningMessage
  };
};

const getCatalogImageCapabilities = async () => {
  const [hasProductoArchivoImagen] = await Promise.all([
    hasColumn('productos', 'id_archivo_imagen_principal')
  ]);

  return {
    hasProductoArchivoImagen
  };
};

const resolveSharedMenuImpact = async ({ idMenu, idSucursal }) => {
  const safeMenuId = toPositiveInt(idMenu);
  if (!safeMenuId) {
    return {
      id_menu: null,
      is_shared: false,
      total_sucursales_activas: 0,
      sucursal_actual_en_scope: false,
      sucursal_actual: null,
      sucursales_activas: [],
      sucursales_activas_excluyendo_actual: [],
      warning_message: ''
    };
  }

  const branches = await getActiveBranchesByMenu(safeMenuId);
  return buildSharedMenuImpact({
    idMenu: safeMenuId,
    idSucursal,
    branches
  });
};

const fetchBaseCatalogByMenu = async (idMenu, idSucursal, departmentIds, imageCapabilities = {}) => {
  const recipeExcludedDepartmentIds = Array.isArray(departmentIds?.recipeExcludedDepartmentIds)
    ? departmentIds.recipeExcludedDepartmentIds
    : [];
  const comboDepartmentId = Number.isInteger(departmentIds?.comboDepartmentId)
    ? departmentIds.comboDepartmentId
    : null;
  const productCategoryAliases = [...MENU_PRODUCT_CATEGORY_ALIASES];
  const hasProductoArchivoImagen = Boolean(imageCapabilities?.hasProductoArchivoImagen);
  const productImageSelect = hasProductoArchivoImagen
    ? 'a_producto.url_publica::text AS url_imagen_publica'
    : 'NULL::text AS url_imagen_publica';
  const productImageJoin = hasProductoArchivoImagen
    ? `
      LEFT JOIN archivos a_producto
        ON a_producto.id_archivo = p.id_archivo_imagen_principal
       AND (a_producto.estado = true OR a_producto.estado IS NULL)
    `
    : '';

  const result = await pool.query(
    `
      SELECT
        '${ITEM_TYPES.RECETA}'::text AS tipo_item,
        r.id_receta::int AS id_item_origen,
        r.nombre_receta::text AS nombre_item,
        COALESCE(r.estado, true) AS estado_item,
        r.precio::numeric AS precio_base,
        a_receta.url_publica::text AS url_imagen_publica
      FROM recetas r
      LEFT JOIN archivos a_receta
        ON a_receta.id_archivo = r.id_archivo
       AND (a_receta.estado = true OR a_receta.estado IS NULL)
      WHERE r.id_menu = $1
        AND r.id_tipo_departamento IS NOT NULL
        AND r.id_tipo_departamento <> ALL($2::int[])

      UNION ALL

      SELECT
        '${ITEM_TYPES.COMBO}'::text AS tipo_item,
        c.id_combo::int AS id_item_origen,
        COALESCE(NULLIF(c.nombre_combo, ''), NULLIF(c.descripcion, ''), CONCAT('Combo #', c.id_combo::text))::text AS nombre_item,
        COALESCE(c.estado, true) AS estado_item,
        c.precio::numeric AS precio_base,
        a_combo.url_publica::text AS url_imagen_publica
      FROM combos c
      LEFT JOIN archivos a_combo
        ON a_combo.id_archivo = c.id_archivo
       AND (a_combo.estado = true OR a_combo.estado IS NULL)
      WHERE c.id_menu = $1
        AND c.id_tipo_departamento = $3

      UNION ALL

      SELECT
        '${ITEM_TYPES.PRODUCTO}'::text AS tipo_item,
        p.id_producto::int AS id_item_origen,
        p.nombre_producto::text AS nombre_item,
        COALESCE(p.estado, true) AS estado_item,
        p.precio::numeric AS precio_base,
        ${productImageSelect}
      FROM productos p
      LEFT JOIN categorias_productos cp
        ON cp.id_categoria_producto = p.id_categoria_producto
      INNER JOIN public.productos_almacenes pa
        ON pa.id_producto = p.id_producto
       AND COALESCE(pa.estado, true) = true
      INNER JOIN almacenes ap
        ON ap.id_almacen = pa.id_almacen
       AND COALESCE(ap.estado, true) = true
      ${productImageJoin}
      WHERE COALESCE(cp.estado, true) = true
        AND ap.id_sucursal = $5
        AND (
          LOWER(REGEXP_REPLACE(TRIM(COALESCE(cp.nombre_categoria, '')), '\\s*/\\s*', '/', 'g')) = ANY($4::text[])
          OR EXISTS (
            SELECT 1
            FROM detalle_menu dm_catalogo
            WHERE dm_catalogo.id_menu = $1
              AND dm_catalogo.id_producto = p.id_producto
              AND COALESCE(dm_catalogo.estado, true) = true
          )
        )

      ORDER BY tipo_item, nombre_item ASC;
    `,
    [
      idMenu,
      recipeExcludedDepartmentIds,
      comboDepartmentId,
      productCategoryAliases,
      idSucursal
    ]
  );

  return result.rows || [];
};

const fetchDetalleRowsByMenu = async ({ idMenu, idSucursal, capabilities }) => {
  const selectIdReceta = capabilities.hasIdReceta ? 'dm.id_receta' : 'NULL::integer AS id_receta';
  const selectIdCombo = capabilities.hasIdCombo ? 'dm.id_combo' : 'NULL::integer AS id_combo';
  const selectVisible = capabilities.hasVisible ? 'COALESCE(dm.visible, true) AS visible' : 'true AS visible';
  const selectPrecioPublico = capabilities.hasPrecioPublico ? 'dm.precio_publico' : 'NULL::numeric AS precio_publico';
  const selectOrden = capabilities.hasOrden ? 'dm.orden' : 'NULL::integer AS orden';

  const result = await pool.query(
    `
      SELECT
        dm.id_detalle_menu,
        dm.id_menu,
        dm.id_producto,
        ${selectIdReceta},
        ${selectIdCombo},
        ${selectVisible},
        ${selectPrecioPublico},
        ${selectOrden},
        COALESCE(dm.estado, true) AS estado
      FROM detalle_menu dm
      LEFT JOIN LATERAL (
        SELECT MIN(pm.id_producto_maestro)::int AS id_producto_maestro
        FROM public.productos_mapeo_maestro pm
        WHERE pm.id_producto_legacy = dm.id_producto
           OR pm.id_producto_maestro = dm.id_producto
      ) pmr ON dm.id_producto IS NOT NULL
      LEFT JOIN public.productos p
        ON p.id_producto = COALESCE(pmr.id_producto_maestro, dm.id_producto)
      LEFT JOIN LATERAL (
        SELECT a.id_sucursal
        FROM public.productos_almacenes pa
        INNER JOIN public.almacenes a
          ON a.id_almacen = pa.id_almacen
         AND COALESCE(a.estado, true) = true
        WHERE pa.id_producto = p.id_producto
          AND COALESCE(pa.estado, true) = true
          AND a.id_sucursal = $2
        ORDER BY pa.id_almacen ASC
        LIMIT 1
      ) ap ON dm.id_producto IS NOT NULL
      WHERE dm.id_menu = $1
        AND COALESCE(dm.estado, true) = true
        AND (
          dm.id_producto IS NULL
          OR ap.id_sucursal = $2
        )
      ORDER BY dm.id_detalle_menu ASC;
    `,
    [idMenu, idSucursal]
  );

  return result.rows || [];
};

const resolveDetailRowKey = (row) => {
  if (Number(row?.id_producto || 0) > 0) {
    return buildItemKey(ITEM_TYPES.PRODUCTO, Number(row.id_producto));
  }
  if (Number(row?.id_receta || 0) > 0) {
    return buildItemKey(ITEM_TYPES.RECETA, Number(row.id_receta));
  }
  if (Number(row?.id_combo || 0) > 0) {
    return buildItemKey(ITEM_TYPES.COMBO, Number(row.id_combo));
  }
  return '';
};

const buildDetailRowsByKey = (rows) => {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = resolveDetailRowKey(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

const mapCatalogForAdmin = ({ baseRows, detailRowsByKey }) => {
  const items = [];
  const duplicateKeys = [];

  for (const row of Array.isArray(baseRows) ? baseRows : []) {
    const tipoItem = normalizeItemType(row.tipo_item);
    const idItemOrigen = Number(row.id_item_origen || 0);
    if (!tipoItem || idItemOrigen <= 0) continue;

    const key = buildItemKey(tipoItem, idItemOrigen);
    const detailRows = detailRowsByKey.get(key) || [];
    if (detailRows.length > 1) duplicateKeys.push(key);
    const detail = detailRows[0] || null;

    items.push({
      item_key: key,
      tipo_item: tipoItem,
      id_item_origen: idItemOrigen,
      nombre_item: row.nombre_item || `${tipoItem} #${idItemOrigen}`,
      categoria_nombre: row.categoria_nombre || tipoItem,
      estado_item: parseBoolean(row.estado_item),
      // Conserva URL de imagen para panel tecnico y validaciones de publicacion.
      url_imagen_publica: String(row?.url_imagen_publica || '').trim(),
      precio_base: row.precio_base !== null ? Number(row.precio_base) : null,
      id_detalle_menu: detail?.id_detalle_menu ? Number(detail.id_detalle_menu) : null,
      publicado: Boolean(detail),
      visible: detail ? parseBoolean(detail.visible) : false,
      precio_publico: detail?.precio_publico !== null && detail?.precio_publico !== undefined
        ? Number(detail.precio_publico)
        : null,
      orden: detail?.orden !== null && detail?.orden !== undefined
        ? Number(detail.orden)
        : null
    });
  }

  return {
    items,
    duplicateKeys
  };
};

const mapPreviewItemFromAdminCatalog = (item) => {
  const publicPrice = item?.precio_publico !== null && item?.precio_publico !== undefined
    ? Number(item.precio_publico)
    : null;
  const basePrice = item?.precio_base !== null && item?.precio_base !== undefined
    ? Number(item.precio_base)
    : null;
  const finalPrice = publicPrice ?? basePrice;
  const hasValidPrice = Number.isFinite(finalPrice) && finalPrice >= 0;
  const isAvailable = Boolean(item?.estado_item) && hasValidPrice;

  return {
    id_detalle_menu: item?.id_detalle_menu || null,
    tipo_item: item?.tipo_item || 'ITEM',
    id_item_base: Number(item?.id_item_origen || 0) || null,
    nombre: item?.nombre_item || 'Item sin nombre',
    imagen_url: String(item?.url_imagen_publica || '').trim(),
    categoria: {
      id_tipo_departamento: null,
      nombre: item?.categoria_nombre || item?.tipo_item || 'Sin categoria'
    },
    precio: {
      base: Number.isFinite(basePrice) ? basePrice : null,
      public: Number.isFinite(publicPrice) ? publicPrice : null,
      final: hasValidPrice ? Number(finalPrice) : null
    },
    disponibilidad: {
      available: isAvailable,
      reasonCode: isAvailable ? null : 'NO_DISPONIBLE_ADMIN',
      message: isAvailable ? 'Disponible' : 'No disponible'
    },
    visible: Boolean(item?.visible),
    orden: Number(item?.orden || 0)
  };
};

const normalizeDraftItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debes enviar al menos un item para guardar publicaciÃƒÂ³n.', data: [] };
  }

  const normalized = [];
  const seenKeys = new Set();

  for (const raw of items) {
    const tipoItem = normalizeItemType(raw?.tipo_item);
    const idItemOrigen = toPositiveInt(raw?.id_item_origen);
    if (!tipoItem || !idItemOrigen) {
      return { ok: false, message: 'Cada item requiere tipo_item vÃƒÂ¡lido e id_item_origen positivo.', data: [] };
    }

    const visible = parseBoolean(raw?.visible);
    const precioPublico = toNullableMoney(raw?.precio_publico);
    if (Number.isNaN(precioPublico)) {
      return { ok: false, message: `precio_publico invÃƒÂ¡lido para ${tipoItem} #${idItemOrigen}.`, data: [] };
    }

    const orden = toNullablePositiveInt(raw?.orden);
    if (Number.isNaN(orden)) {
      return { ok: false, message: `orden invÃƒÂ¡lido para ${tipoItem} #${idItemOrigen}.`, data: [] };
    }

    const key = buildItemKey(tipoItem, idItemOrigen);
    if (seenKeys.has(key)) {
      return { ok: false, message: `No se permiten items duplicados en payload: ${key}.`, data: [] };
    }
    seenKeys.add(key);

    normalized.push({
      key,
      tipo_item: tipoItem,
      id_item_origen: idItemOrigen,
      id_detalle_menu: toPositiveInt(raw?.id_detalle_menu),
      visible,
      precio_publico: precioPublico,
      orden
    });
  }

  return { ok: true, data: normalized };
};

const fetchDraftStateByType = async ({ idMenu, idSucursal, normalizedItems }) => {
  const recipeIds = [];
  const comboIds = [];
  const productIds = [];

  for (const item of normalizedItems) {
    if (item.tipo_item === ITEM_TYPES.RECETA) recipeIds.push(item.id_item_origen);
    if (item.tipo_item === ITEM_TYPES.COMBO) comboIds.push(item.id_item_origen);
    if (item.tipo_item === ITEM_TYPES.PRODUCTO) productIds.push(item.id_item_origen);
  }

  const resultMap = new Map();

  if (recipeIds.length > 0) {
    const result = await pool.query(
      `
        SELECT id_receta AS id_item_origen, COALESCE(estado, true) AS estado_item, precio
        FROM recetas
        WHERE id_menu = $1
          AND id_receta = ANY($2::int[]);
      `,
      [idMenu, [...new Set(recipeIds)]]
    );
    for (const row of result.rows || []) {
      resultMap.set(buildItemKey(ITEM_TYPES.RECETA, Number(row.id_item_origen)), {
        estado_item: parseBoolean(row.estado_item),
        precio_base: row.precio !== null ? Number(row.precio) : null
      });
    }
  }

  if (comboIds.length > 0) {
    const result = await pool.query(
      `
        SELECT id_combo AS id_item_origen, COALESCE(estado, true) AS estado_item, precio
        FROM combos
        WHERE id_menu = $1
          AND id_combo = ANY($2::int[]);
      `,
      [idMenu, [...new Set(comboIds)]]
    );
    for (const row of result.rows || []) {
      resultMap.set(buildItemKey(ITEM_TYPES.COMBO, Number(row.id_item_origen)), {
        estado_item: parseBoolean(row.estado_item),
        precio_base: row.precio !== null ? Number(row.precio) : null
      });
    }
  }

  if (productIds.length > 0) {
    const result = await pool.query(
      `
        SELECT
          p.id_producto AS id_item_origen,
          COALESCE(p.estado, true) AS estado_item,
          p.precio
        FROM public.productos p
        INNER JOIN public.productos_almacenes pa
          ON pa.id_producto = p.id_producto
         AND COALESCE(pa.estado, true) = true
        INNER JOIN public.almacenes ap
          ON ap.id_almacen = pa.id_almacen
         AND COALESCE(ap.estado, true) = true
        WHERE p.id_producto = ANY($1::int[])
          AND ap.id_sucursal = $2;
      `,
      [[...new Set(productIds)], idSucursal]
    );
    for (const row of result.rows || []) {
      resultMap.set(buildItemKey(ITEM_TYPES.PRODUCTO, Number(row.id_item_origen)), {
        estado_item: parseBoolean(row.estado_item),
        precio_base: row.precio !== null ? Number(row.precio) : null
      });
    }
  }

  return resultMap;
};

const fetchCrossBranchDetalleRowsByMenu = async ({ idMenu, idSucursal }) => {
  const safeMenuId = toPositiveInt(idMenu);
  const safeSucursalId = toPositiveInt(idSucursal);
  if (!safeMenuId || !safeSucursalId) return [];

  const result = await pool.query(
    `
      SELECT
        dm.id_detalle_menu,
        dm.id_producto,
        p.nombre_producto,
        ap.id_sucursal AS id_sucursal_producto
      FROM detalle_menu dm
      INNER JOIN LATERAL (
        SELECT MIN(pm.id_producto_maestro)::int AS id_producto_maestro
        FROM public.productos_mapeo_maestro pm
        WHERE pm.id_producto_legacy = dm.id_producto
           OR pm.id_producto_maestro = dm.id_producto
      ) pmr ON dm.id_producto IS NOT NULL
      INNER JOIN productos p
        ON p.id_producto = COALESCE(pmr.id_producto_maestro, dm.id_producto)
      INNER JOIN public.productos_almacenes pa
        ON pa.id_producto = p.id_producto
       AND COALESCE(pa.estado, true) = true
      INNER JOIN almacenes ap
        ON ap.id_almacen = pa.id_almacen
       AND COALESCE(ap.estado, true) = true
      WHERE dm.id_menu = $1
        AND COALESCE(dm.estado, true) = true
        AND ap.id_sucursal <> $2
      ORDER BY dm.id_detalle_menu ASC;
    `,
    [safeMenuId, safeSucursalId]
  );

  return result.rows || [];
};

// AM: Agrupa actualizaciones para evitar un round-trip SQL por cada item.
const updateDetalleRowsBatch = async ({ client, entries, capabilities }) => {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const updates = capabilities.hasVisible
    ? ['visible = input.visible', 'estado = true']
    : ['estado = input.visible'];

  if (capabilities.hasPrecioPublico) {
    updates.push('precio_publico = input.precio_publico');
  }
  if (capabilities.hasOrden) {
    updates.push('orden = COALESCE(input.orden, dm.orden)');
  }

  const payload = entries.map(({ rowId, item }) => ({
    id_detalle_menu: rowId,
    visible: item.visible,
    precio_publico: item.precio_publico,
    orden: item.orden
  }));

  await client.query(
    `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS value(
          id_detalle_menu integer,
          visible boolean,
          precio_publico numeric,
          orden integer
        )
      )
      UPDATE detalle_menu dm
      SET ${updates.join(', ')}
      FROM input
      WHERE dm.id_detalle_menu = input.id_detalle_menu;
    `,
    [JSON.stringify(payload)]
  );
};

// AM: Inserta publicaciones nuevas en una sola operacion SQL.
const insertDetalleRowsBatch = async ({ client, idMenu, items, capabilities }) => {
  if (!Array.isArray(items) || items.length === 0) return;

  const columns = ['id_menu', 'estado', 'id_producto'];
  const selectValues = ['$2', 'true', 'input.id_producto'];

  if (capabilities.hasIdReceta) {
    columns.push('id_receta');
    selectValues.push('input.id_receta');
  }
  if (capabilities.hasIdCombo) {
    columns.push('id_combo');
    selectValues.push('input.id_combo');
  }
  if (capabilities.hasVisible) {
    columns.push('visible');
    selectValues.push('input.visible');
  }
  if (capabilities.hasPrecioPublico) {
    columns.push('precio_publico');
    selectValues.push('input.precio_publico');
  }
  if (capabilities.hasOrden) {
    columns.push('orden');
    selectValues.push('input.orden');
  }

  const payload = items.map((item) => ({
    id_producto: item.tipo_item === ITEM_TYPES.PRODUCTO ? item.id_item_origen : null,
    id_receta: item.tipo_item === ITEM_TYPES.RECETA ? item.id_item_origen : null,
    id_combo: item.tipo_item === ITEM_TYPES.COMBO ? item.id_item_origen : null,
    visible: item.visible,
    precio_publico: item.precio_publico,
    orden: item.orden
  }));

  await client.query(
    `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS value(
          id_producto integer,
          id_receta integer,
          id_combo integer,
          visible boolean,
          precio_publico numeric,
          orden integer
        )
      )
      INSERT INTO detalle_menu (${columns.join(', ')})
      SELECT ${selectValues.join(', ')}
      FROM input;
    `,
    [JSON.stringify(payload), idMenu]
  );
};

const getVisibleCountByMenu = async ({ idMenu, idSucursal, capabilities, client }) => {
  const countVisibleExpr = capabilities.hasVisible ? 'AND COALESCE(visible, true) = true' : '';
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM detalle_menu dm
      LEFT JOIN LATERAL (
        SELECT MIN(pm.id_producto_maestro)::int AS id_producto_maestro
        FROM public.productos_mapeo_maestro pm
        WHERE pm.id_producto_legacy = dm.id_producto
           OR pm.id_producto_maestro = dm.id_producto
      ) pmr ON dm.id_producto IS NOT NULL
      LEFT JOIN public.productos p
        ON p.id_producto = COALESCE(pmr.id_producto_maestro, dm.id_producto)
      LEFT JOIN LATERAL (
        SELECT a.id_sucursal
        FROM public.productos_almacenes pa
        INNER JOIN public.almacenes a
          ON a.id_almacen = pa.id_almacen
         AND COALESCE(a.estado, true) = true
        WHERE pa.id_producto = p.id_producto
          AND COALESCE(pa.estado, true) = true
          AND a.id_sucursal = $2
        ORDER BY pa.id_almacen ASC
        LIMIT 1
      ) ap ON dm.id_producto IS NOT NULL
      WHERE dm.id_menu = $1
        AND COALESCE(dm.estado, true) = true
        AND (
          dm.id_producto IS NULL
          OR ap.id_sucursal = $2
        )
        ${countVisibleExpr};
    `,
    [idMenu, idSucursal]
  );
  return Number(result.rows?.[0]?.total || 0);
};

// Lista sucursales operativas para el selector de publicaciÃƒÂ³n.
router.get('/sucursales', checkPermission(MENU_PUBLICACION_VIEW_PERMISSIONS), async (_req, res) => {
  try {
    const rows = await getBranchesForPublication();
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('admin_menu_publicacion /sucursales:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar sucursales.' });
  }
});

// Retorna el catÃƒÂ¡logo unificado con estado actual de publicaciÃƒÂ³n por sucursal.
// Lista menus disponibles para programar vigencias por sucursal.
router.get('/menus', checkPermission(MENU_PUBLICACION_VIEW_PERMISSIONS), async (_req, res) => {
  try {
    const rows = await getMenusForProgramming();
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('admin_menu_publicacion /menus:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar los menus disponibles.' });
  }
});

// AM: lee configuracion global del carrusel hero usada por menu publico.
router.get('/carrusel-config', checkPermission(MENU_PUBLICACION_VIEW_PERMISSIONS), async (_req, res) => {
  try {
    const config = await getPublicMenuHeroCarouselConfig();
    return res.status(200).json({ ok: true, data: config });
  } catch (error) {
    console.error('admin_menu_publicacion GET /carrusel-config:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo cargar la configuracion del carrusel.' });
  }
});

// AM: guarda configuracion global del carrusel hero para todas las sucursales.
router.put('/carrusel-config', checkPermission(MENU_PUBLICACION_SAVE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ ok: false, message: 'Payload invalido para guardar el carrusel.' });
    }

    await client.query('BEGIN');
    const config = await savePublicMenuHeroCarouselConfig({
      client,
      config: payload
    });
    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Carrusel global guardado correctamente.',
      data: config
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('admin_menu_publicacion PUT /carrusel-config:', error.message);
    const safeStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
      ? error.status
      : 500;
    return res.status(safeStatus).json({
      ok: false,
      message: safeStatus < 500
        ? String(error?.message || 'No se pudo guardar la configuracion del carrusel.')
        : 'No se pudo guardar la configuracion del carrusel.'
    });
  } finally {
    client.release();
  }
});

// Crea un menu nuevo para temporadas desde el panel admin sin SQL manual.
router.post('/menus', checkPermission(MENU_TEMPORADA_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const nombreMenu = String(req.body?.nombre_menu ?? '').replace(/\s+/g, ' ').trim();
    const descripcionRaw = String(req.body?.descripcion ?? '').trim();
    const descripcion = descripcionRaw || null;
    const idUsuario = getAuthenticatedUserId(req) || null;
    if (!idUsuario) {
      return res.status(401).json({ ok: false, message: 'No se pudo identificar el usuario autenticado para crear el menu.' });
    }

    if (!nombreMenu || nombreMenu.length < 3) {
      return res.status(400).json({ ok: false, message: 'nombre_menu es obligatorio y debe tener al menos 3 caracteres.' });
    }

    if (nombreMenu.length > 120) {
      return res.status(400).json({ ok: false, message: 'nombre_menu supera el maximo permitido (120).' });
    }

    if (descripcion && descripcion.length > 250) {
      return res.status(400).json({ ok: false, message: 'descripcion supera el maximo permitido (250).' });
    }

    const duplicate = await pool.query(
      `
        SELECT id_menu
        FROM menu
        WHERE LOWER(TRIM(nombre_menu)) = LOWER(TRIM($1))
          AND COALESCE(estado, true) = true
        LIMIT 1;
      `,
      [nombreMenu]
    );

    if (duplicate.rowCount > 0) {
      return res.status(409).json({ ok: false, message: 'Ya existe un menu activo con ese nombre.' });
    }

    const created = await pool.query(
      `
        INSERT INTO menu (
          nombre_menu,
          descripcion,
          estado,
          id_usuario
        ) VALUES ($1, $2, true, $3)
        RETURNING id_menu, nombre_menu, COALESCE(descripcion, '') AS descripcion, COALESCE(estado, true) AS estado, fecha_creacion;
      `,
      [nombreMenu, descripcion, idUsuario]
    );

    const row = created.rows?.[0] || null;
    if (!row) {
      throw new Error('No se recibio el menu creado.');
    }

    return res.status(201).json({
      ok: true,
      message: `Menu #${row.id_menu} creado correctamente.`,
      data: {
        menu: {
          id_menu: Number(row.id_menu),
          nombre_menu: row.nombre_menu || `Menu #${row.id_menu}`,
          descripcion: row.descripcion || '',
          estado: parseBoolean(row.estado),
          fecha_creacion: row.fecha_creacion || null
        }
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion POST /menus:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo crear el menu.' });
  }
});

router.put('/menus/:id_menu', checkPermission(MENU_PUBLICACION_SAVE_PERMISSIONS), async (req, res) => {
  try {
    const idMenu = toPositiveInt(req.params?.id_menu);
    const nombreMenu = String(req.body?.nombre_menu ?? '').replace(/\s+/g, ' ').trim();
    const descripcionRaw = String(req.body?.descripcion ?? '').trim();
    const descripcion = descripcionRaw || null;

    if (!idMenu) {
      return res.status(400).json({ ok: false, message: 'id_menu es obligatorio.' });
    }

    if (!nombreMenu || nombreMenu.length < 3) {
      return res.status(400).json({ ok: false, message: 'nombre_menu es obligatorio y debe tener al menos 3 caracteres.' });
    }

    if (nombreMenu.length > 120) {
      return res.status(400).json({ ok: false, message: 'nombre_menu supera el maximo permitido (120).' });
    }

    if (descripcion && descripcion.length > 250) {
      return res.status(400).json({ ok: false, message: 'descripcion supera el maximo permitido (250).' });
    }

    const currentMenu = await getMenuById(idMenu);
    if (!currentMenu || !currentMenu.estado) {
      return res.status(404).json({ ok: false, message: 'El menu no existe o esta inactivo.' });
    }

    const duplicate = await pool.query(
      `
        SELECT id_menu
        FROM menu
        WHERE id_menu <> $1
          AND LOWER(TRIM(nombre_menu)) = LOWER(TRIM($2))
          AND COALESCE(estado, true) = true
        LIMIT 1;
      `,
      [idMenu, nombreMenu]
    );

    if (duplicate.rowCount > 0) {
      return res.status(409).json({ ok: false, message: 'Ya existe otro menu activo con ese nombre.' });
    }

    const updated = await pool.query(
      `
        UPDATE menu
        SET nombre_menu = $2,
            descripcion = $3
        WHERE id_menu = $1
          AND COALESCE(estado, true) = true
        RETURNING id_menu, nombre_menu, COALESCE(descripcion, '') AS descripcion, COALESCE(estado, true) AS estado;
      `,
      [idMenu, nombreMenu, descripcion]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      return res.status(404).json({ ok: false, message: 'No se pudo actualizar el menu solicitado.' });
    }

    return res.status(200).json({
      ok: true,
      message: `Menu #${row.id_menu} actualizado correctamente.`,
      data: {
        menu: {
          id_menu: Number(row.id_menu),
          nombre_menu: row.nombre_menu || `Menu #${row.id_menu}`,
          descripcion: row.descripcion || '',
          estado: parseBoolean(row.estado)
        }
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion PUT /menus/:id_menu:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar el menu.' });
  }
});

router.delete('/menus/:id_menu', checkPermission(MENU_PUBLICACION_SAVE_PERMISSIONS), async (req, res) => {
  try {
    const idMenu = toPositiveInt(req.params?.id_menu);
    if (!idMenu) {
      return res.status(400).json({ ok: false, message: 'id_menu es obligatorio.' });
    }

    const currentMenu = await getMenuById(idMenu);
    if (!currentMenu || !currentMenu.estado) {
      return res.status(404).json({ ok: false, message: 'El menu no existe o ya esta inactivo.' });
    }

    const usage = await getMenuUsageSummary(idMenu);
    if (!canDeactivateMenu(usage)) {
      return res.status(409).json({
        ok: false,
        message: `No se puede eliminar el menu porque ${buildMenuUsageBlockers(usage).join(', ')}.`,
        data: { usage }
      });
    }

    const updated = await pool.query(
      `
        UPDATE menu
        SET estado = false
        WHERE id_menu = $1
          AND COALESCE(estado, true) = true
        RETURNING id_menu, nombre_menu;
      `,
      [idMenu]
    );

    const row = updated.rows?.[0] || null;
    if (!row) {
      return res.status(404).json({ ok: false, message: 'No se pudo eliminar el menu solicitado.' });
    }

    return res.status(200).json({
      ok: true,
      message: `Menu #${row.id_menu} eliminado correctamente.`,
      data: {
        menu: {
          id_menu: Number(row.id_menu),
          nombre_menu: row.nombre_menu || `Menu #${row.id_menu}`
        }
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion DELETE /menus/:id_menu:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo eliminar el menu.' });
  }
});

// Programa un menu por sucursal para una fecha/hora especifica.
router.post('/programacion', checkPermission(MENU_PUBLICACION_SAVE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idSucursal = toPositiveInt(req.body?.id_sucursal);
    const idMenu = toPositiveInt(req.body?.id_menu);
    const idUsuario = getAuthenticatedUserId(req);
    const fechaRaw = req.body?.fecha_inicio;
    const fechaProgramada = toDateTimeOrNull(fechaRaw) || new Date();

    if (!idSucursal || !idMenu) {
      return res.status(400).json({ ok: false, message: 'id_sucursal e id_menu son obligatorios.' });
    }

    if (!idUsuario) {
      return res.status(400).json({ ok: false, message: 'No se pudo identificar el usuario autenticado para activar menu.' });
    }

    if (fechaRaw && !toDateTimeOrNull(fechaRaw)) {
      return res.status(400).json({ ok: false, message: 'fecha_inicio tiene formato invalido.' });
    }

    const [branchOk, menuOk] = await Promise.all([
      existsActiveBranch(idSucursal),
      existsActiveMenu(idMenu)
    ]);

    if (!branchOk) {
      return res.status(404).json({ ok: false, message: 'La sucursal no existe o esta inactiva.' });
    }

    if (!menuOk) {
      return res.status(404).json({ ok: false, message: 'El menu no existe o esta inactivo.' });
    }

    // Si no viene fecha, el flujo es "activar ahora". Evitamos duplicar filas si ya estaba activo.
    const activeNow = await getActiveMenuByBranch(idSucursal);
    if (!fechaRaw && activeNow && Number(activeNow.id_menu) === idMenu) {
      return res.status(200).json({
        ok: true,
        message: 'Ese menu ya esta activo en la sucursal.',
        data: {
          programacion: null,
          menu_activo_actual: mapMenuSummary(activeNow)
        }
      });
    }

    const now = new Date();
    const activateNow = fechaProgramada <= now;
    const estadoInicial = activateNow;

    await client.query('BEGIN');

    const duplicate = await client.query(
      `
        SELECT id_menu_vigente
        FROM menu_vigente
        WHERE id_sucursal = $1
          AND id_menu = $2
          AND fecha_inicio = $3
        LIMIT 1;
      `,
      [idSucursal, idMenu, fechaProgramada]
    );

    if (duplicate.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: 'Ya existe una vigencia con esa sucursal, menu y fecha.' });
    }

    // Para "activar ahora", apaga primero la vigencia actual y evita colisiones por llaves unicas.
    if (activateNow) {
      await client.query(
        `
          UPDATE menu_vigente
          SET estado = false
          WHERE id_sucursal = $1
            AND COALESCE(estado, true) = true;
        `,
        [idSucursal]
      );
    }

    const insertResult = await client.query(
      `
        INSERT INTO menu_vigente (
          id_sucursal,
          id_menu,
          fecha_inicio,
          id_usuario,
          estado
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id_menu_vigente, id_sucursal, id_menu, fecha_inicio, estado;
      `,
      [idSucursal, idMenu, fechaProgramada, idUsuario, estadoInicial]
    );

    const inserted = insertResult.rows?.[0] || null;
    if (!inserted) {
      throw new Error('No se pudo crear la vigencia en menu_vigente.');
    }

    if (activateNow) {
      // Si entra en vigor ya, se desactivan vigencias previas de la sucursal para evitar colisiones.
      await client.query(
        `
          UPDATE menu_vigente
          SET estado = false
          WHERE id_sucursal = $1
            AND id_menu_vigente <> $2
            AND COALESCE(estado, true) = true
            AND COALESCE(fecha_inicio, NOW()) <= $3;
        `,
        [idSucursal, Number(inserted.id_menu_vigente), fechaProgramada]
      );
    }

    const seededProductsCount = await syncExistingBranchProductsIntoMenu({
      client,
      idSucursal,
      idMenu: Number(inserted.id_menu)
    });

    await client.query('COMMIT');

    const activeMenu = await getActiveMenuByBranch(idSucursal);
    const sharedMenuImpact = await resolveSharedMenuImpact({
      idMenu: Number(inserted.id_menu),
      idSucursal
    });
    const warnings = [];
    if (seededProductsCount > 0) {
      warnings.push(
        `Se agregaron ${seededProductsCount} productos existentes de la sucursal al menu para mantener el aislamiento publico.`
      );
    }
    if (sharedMenuImpact.is_shared) {
      warnings.push(sharedMenuImpact.warning_message);
    }

    return res.status(200).json({
      ok: true,
      message: fechaRaw ? 'Programacion de menu guardada correctamente.' : 'Menu activo actualizado correctamente.',
      data: {
        programacion: {
          id_menu_vigente: Number(inserted.id_menu_vigente),
          id_sucursal: Number(inserted.id_sucursal),
          id_menu: Number(inserted.id_menu),
          fecha_inicio: inserted.fecha_inicio,
          estado: parseBoolean(inserted.estado)
        },
        menu_activo_actual: activeMenu ? mapMenuSummary(activeMenu) : null,
        shared_menu_impact: sharedMenuImpact,
        seeded_products_count: seededProductsCount,
        warnings
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('admin_menu_publicacion POST /programacion:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo activar/programar el menu por sucursal.' });
  } finally {
    client.release();
  }
});

router.get('/catalogo', checkPermission(MENU_PUBLICACION_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = toPositiveInt(req.query.id_sucursal);
    const idMenuQuery = toPositiveInt(req.query.id_menu);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'id_sucursal es obligatorio y debe ser entero positivo.' });
    }

    const [capabilities, imageCapabilities, departmentIds, activeMenu, branch] = await Promise.all([
      getDetalleMenuCapabilities(),
      getCatalogImageCapabilities(),
      // Evita IDs hardcodeados y usa la configuracion real de tipo_departamento.
      resolveMenuDepartmentIds(),
      getActiveMenuByBranch(idSucursal),
      getBranchById(idSucursal)
    ]);

    if (!branch) {
      return res.status(404).json({ ok: false, message: 'La sucursal no existe.' });
    }

    if (!branch.estado) {
      return res.status(409).json({ ok: false, message: 'La sucursal esta inactiva y no admite publicacion administrativa.' });
    }

    const warnings = [];
    let resolvedMenu = activeMenu;

    if (idMenuQuery) {
      const requestedMenu = await getMenuById(idMenuQuery);
      if (!requestedMenu || !requestedMenu.estado) {
        return res.status(404).json({ ok: false, message: 'El menu seleccionado no existe o esta inactivo.' });
      }

      const matchesActive = Number(activeMenu?.id_menu || 0) === requestedMenu.id_menu;
      resolvedMenu = {
        id_menu_vigente: matchesActive ? activeMenu?.id_menu_vigente ?? null : null,
        id_menu: requestedMenu.id_menu,
        id_sucursal: idSucursal,
        fecha_inicio: matchesActive ? activeMenu?.fecha_inicio ?? null : null,
        nombre_menu: requestedMenu.nombre_menu,
        menu_descripcion: requestedMenu.descripcion || '',
        nombre_sucursal: branch.nombre_sucursal
      };

      if (!matchesActive) {
        warnings.push('Visualizando un menu que aun no esta activo en esta sucursal.');
      }
    }

    if (!resolvedMenu) {
      warnings.push('La sucursal no tiene menu vigente activo.');
      return res.status(200).json({
        ok: true,
        data: {
          menu: null,
          capabilities,
          warnings,
          shared_menu_impact: null,
          items: []
        }
      });
    }

    const targetMenuId = Number(resolvedMenu.id_menu);
    const [baseRows, detailRows, sharedMenuImpact, crossBranchRows] = await Promise.all([
      fetchBaseCatalogByMenu(targetMenuId, idSucursal, departmentIds, imageCapabilities),
      fetchDetalleRowsByMenu({ idMenu: targetMenuId, idSucursal, capabilities }),
      resolveSharedMenuImpact({ idMenu: targetMenuId, idSucursal }),
      fetchCrossBranchDetalleRowsByMenu({ idMenu: targetMenuId, idSucursal })
    ]);

    const detailRowsByKey = buildDetailRowsByKey(detailRows);
    const mapped = mapCatalogForAdmin({ baseRows, detailRowsByKey });

    if (mapped.duplicateKeys.length > 0) {
      warnings.push(`Existen duplicados en detalle_menu: ${mapped.duplicateKeys.join(', ')}`);
    }
    if (crossBranchRows.length > 0) {
      warnings.push(
        `Se detectaron ${crossBranchRows.length} publicaciones cruzadas de productos fuera de la sucursal seleccionada. Limpia detalle_menu para evitar contaminacion historica.`
      );
    }
    if (sharedMenuImpact.is_shared) {
      warnings.push(sharedMenuImpact.warning_message);
    }

    return res.status(200).json({
      ok: true,
      data: {
        menu: mapMenuSummary(resolvedMenu),
        capabilities,
        warnings,
        shared_menu_impact: sharedMenuImpact,
        items: mapped.items
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion /catalogo:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo construir el catalogo de publicacion.' });
  }
});

// Preview administrativo del menu por sucursal/menu seleccionado.
router.get('/preview', checkPermission(MENU_PUBLICACION_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = toPositiveInt(req.query.id_sucursal);
    const idMenuQuery = toPositiveInt(req.query.id_menu);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'id_sucursal es obligatorio y debe ser entero positivo.' });
    }

    const [capabilities, imageCapabilities, departmentIds, activeMenu, branch] = await Promise.all([
      getDetalleMenuCapabilities(),
      getCatalogImageCapabilities(),
      resolveMenuDepartmentIds(),
      getActiveMenuByBranch(idSucursal),
      getBranchById(idSucursal)
    ]);

    if (!branch) {
      return res.status(404).json({ ok: false, message: 'La sucursal no existe.' });
    }

    if (!branch.estado) {
      return res.status(409).json({ ok: false, message: 'La sucursal esta inactiva y no admite preview administrativo.' });
    }

    let resolvedMenu = activeMenu;
    if (idMenuQuery) {
      const requestedMenu = await getMenuById(idMenuQuery);
      if (!requestedMenu || !requestedMenu.estado) {
        return res.status(404).json({ ok: false, message: 'El menu seleccionado no existe o esta inactivo.' });
      }

      const matchesActive = Number(activeMenu?.id_menu || 0) === requestedMenu.id_menu;
      resolvedMenu = {
        id_menu_vigente: matchesActive ? activeMenu?.id_menu_vigente ?? null : null,
        id_menu: requestedMenu.id_menu,
        id_sucursal: idSucursal,
        fecha_inicio: matchesActive ? activeMenu?.fecha_inicio ?? null : null,
        nombre_menu: requestedMenu.nombre_menu,
        menu_descripcion: requestedMenu.descripcion || '',
        nombre_sucursal: branch.nombre_sucursal
      };
    }

    if (!resolvedMenu) {
      return res.status(200).json({
        ok: true,
        data: {
          menu: null,
          warnings: [],
          shared_menu_impact: null,
          stats: { total: 0, disponibles: 0, agotados: 0 },
          items: []
        }
      });
    }

    const targetMenuId = Number(resolvedMenu.id_menu);
    const [baseRows, detailRows, sharedMenuImpact, crossBranchRows] = await Promise.all([
      fetchBaseCatalogByMenu(targetMenuId, idSucursal, departmentIds, imageCapabilities),
      fetchDetalleRowsByMenu({ idMenu: targetMenuId, idSucursal, capabilities }),
      resolveSharedMenuImpact({ idMenu: targetMenuId, idSucursal }),
      fetchCrossBranchDetalleRowsByMenu({ idMenu: targetMenuId, idSucursal })
    ]);

    const detailRowsByKey = buildDetailRowsByKey(detailRows);
    const mapped = mapCatalogForAdmin({ baseRows, detailRowsByKey });

    const previewItems = mapped.items
      .filter((item) => Boolean(item?.visible))
      .map(mapPreviewItemFromAdminCatalog)
      .sort((a, b) => {
        const orderA = Number(a?.orden || 2147483647);
        const orderB = Number(b?.orden || 2147483647);
        if (orderA !== orderB) return orderA - orderB;
        return String(a?.nombre || '').localeCompare(String(b?.nombre || ''));
      });

    const disponibles = previewItems.filter((item) => Boolean(item?.disponibilidad?.available)).length;
    const warnings = [];
    if (crossBranchRows.length > 0) {
      warnings.push(
        `Preview con aislamiento defensivo activo: existen ${crossBranchRows.length} publicaciones cruzadas fuera de la sucursal.`
      );
    }
    if (sharedMenuImpact.is_shared) {
      warnings.push(sharedMenuImpact.warning_message);
    }

    return res.status(200).json({
      ok: true,
      data: {
        menu: mapMenuSummary(resolvedMenu),
        warnings,
        shared_menu_impact: sharedMenuImpact,
        stats: {
          total: previewItems.length,
          disponibles,
          agotados: previewItems.length - disponibles
        },
        items: previewItems
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion /preview:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo construir el preview administrativo.' });
  }
});

// Guarda cambios de publicacion para una sucursal en el menu vigente.
router.put('/catalogo', checkPermission(MENU_PUBLICACION_SAVE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  try {
    const idSucursal = toPositiveInt(req.query.id_sucursal);
    const idMenuQuery = toPositiveInt(req.query.id_menu);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'id_sucursal es obligatorio y debe ser entero positivo.' });
    }

    const normalized = normalizeDraftItems(req.body?.items);
    if (!normalized.ok) {
      return res.status(400).json({ ok: false, message: normalized.message });
    }

    const branch = await getBranchById(idSucursal);
    if (!branch) {
      return res.status(404).json({ ok: false, message: 'La sucursal no existe.' });
    }
    if (!branch.estado) {
      return res.status(409).json({ ok: false, message: 'La sucursal esta inactiva y no admite guardar publicacion.' });
    }

    const activeMenu = await getActiveMenuByBranch(idSucursal);
    const targetMenuId = idMenuQuery || Number(activeMenu?.id_menu || 0);
    if (!targetMenuId) {
      return res.status(409).json({ ok: false, message: 'La sucursal no tiene menu vigente activo.' });
    }

    if (idMenuQuery) {
      const requestedMenu = await getMenuById(idMenuQuery);
      if (!requestedMenu || !requestedMenu.estado) {
        return res.status(404).json({ ok: false, message: 'El menu seleccionado no existe o esta inactivo.' });
      }
    }

    const capabilities = await getDetalleMenuCapabilities();
    const [detailRows, stateByKey, sharedMenuImpact] = await Promise.all([
      fetchDetalleRowsByMenu({ idMenu: targetMenuId, idSucursal, capabilities }),
      fetchDraftStateByType({
        idMenu: targetMenuId,
        idSucursal,
        normalizedItems: normalized.data
      }),
      resolveSharedMenuImpact({ idMenu: targetMenuId, idSucursal })
    ]);

    const detailRowsByKey = buildDetailRowsByKey(detailRows);
    const validationErrors = [];

    for (const item of normalized.data) {
      const detailRowsForKey = detailRowsByKey.get(item.key) || [];
      if (detailRowsForKey.length > 1) {
        validationErrors.push(`Existe duplicidad en detalle_menu para ${item.key}. Corrige antes de guardar.`);
      }

      const source = stateByKey.get(item.key);
      if (!source) {
        validationErrors.push(`No existe origen valido para ${item.key} en el menu seleccionado.`);
        continue;
      }

      const finalPrice = item.precio_publico ?? source.precio_base;

      if (item.visible && source.estado_item !== true) {
        validationErrors.push(`No puedes dejar visible ${item.key} porque esta inactivo.`);
      }

      if (item.visible && (!Number.isFinite(finalPrice) || finalPrice < 0)) {
        validationErrors.push(`Precio invalido para ${item.key}.`);
      }

      if (item.visible && (!Number.isInteger(item.orden) || item.orden <= 0)) {
        validationErrors.push(`Orden invalido para ${item.key}. Debe ser entero positivo.`);
      }

      if (
        (item.tipo_item === ITEM_TYPES.RECETA && !capabilities.hasIdReceta) ||
        (item.tipo_item === ITEM_TYPES.COMBO && !capabilities.hasIdCombo)
      ) {
        validationErrors.push(`Tu esquema no soporta publicar ${item.tipo_item} en detalle_menu (columna faltante).`);
      }
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        ok: false,
        message: 'Se encontraron errores de validacion.',
        errors: validationErrors
      });
    }

    await client.query('BEGIN');

    const existingUpdates = [];
    const newItems = [];

    for (const item of normalized.data) {
      const existingRows = detailRowsByKey.get(item.key) || [];
      const existing = existingRows[0] || null;

      // Si no existe fila y el item queda oculto, no insertamos ruido en detalle_menu.
      if (!existing && !item.visible) continue;

      if (existing) {
        existingUpdates.push({
          rowId: Number(existing.id_detalle_menu),
          item
        });
      } else {
        newItems.push(item);
      }
    }

    await updateDetalleRowsBatch({
      client,
      entries: existingUpdates,
      capabilities
    });
    await insertDetalleRowsBatch({
      client,
      idMenu: targetMenuId,
      items: newItems,
      capabilities
    });

    const visibleCount = await getVisibleCountByMenu({
      idMenu: targetMenuId,
      idSucursal,
      capabilities,
      client
    });

    await client.query('COMMIT');

    const warnings = [];
    if (visibleCount === 0) {
      warnings.push('La sucursal quedo sin items visibles para el cliente.');
    }
    if (sharedMenuImpact.is_shared) {
      warnings.push(sharedMenuImpact.warning_message);
    }

    return res.status(200).json({
      ok: true,
      message: 'Publicacion guardada correctamente.',
      data: {
        visible_count: visibleCount,
        applied_count: existingUpdates.length + newItems.length,
        warnings,
        shared_menu_impact: sharedMenuImpact,
        applied_scope: sharedMenuImpact.is_shared
          ? 'MENU_COMPARTIDO_ENTRE_SUCURSALES'
          : 'MENU_EXCLUSIVO_DE_SUCURSAL'
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('admin_menu_publicacion PUT /catalogo:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar la publicacion del menu.' });
  } finally {
    client.release();
  }
});

export default router;





