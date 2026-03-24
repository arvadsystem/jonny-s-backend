import express from 'express';
import pool from '../config/db-connection.js';
import { resolveMenuDepartmentIds } from './menu_departamentos.js';

const router = express.Router();

const ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  COMBO: 'COMBO'
});

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

const parseBoolean = (value) => (
  value === true ||
  value === 1 ||
  value === '1' ||
  String(value ?? '').trim().toLowerCase() === 'true'
);

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
      ORDER BY mv.fecha_inicio DESC, mv.id_menu_vigente DESC
      LIMIT 1;
    `,
    [idSucursal]
  );

  return result.rows?.[0] || null;
};

const mapMenuSummary = (row) => ({
  id_menu_vigente: Number(row.id_menu_vigente),
  id_menu: Number(row.id_menu),
  id_sucursal: Number(row.id_sucursal),
  nombre_menu: row.nombre_menu || 'Menu',
  descripcion_menu: row.menu_descripcion || '',
  nombre_sucursal: row.nombre_sucursal || '',
  fecha_inicio: row.fecha_inicio || null
});

const getBranchesForPublication = async () => {
  const result = await pool.query(
    `
      SELECT
        s.id_sucursal,
        s.nombre_sucursal,
        COALESCE(s.estado, true) AS estado,
        mv.id_menu_vigente,
        mv.id_menu,
        mv.fecha_inicio
      FROM sucursales s
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
        ORDER BY mvv.fecha_inicio DESC, mvv.id_menu_vigente DESC
        LIMIT 1
      ) mv ON true
      WHERE COALESCE(s.estado, true) = true
      ORDER BY s.id_sucursal ASC;
    `
  );

  return (result.rows || []).map((row) => ({
    id_sucursal: Number(row.id_sucursal),
    nombre_sucursal: row.nombre_sucursal,
    estado: parseBoolean(row.estado),
    tiene_menu_vigente: Number(row.id_menu_vigente || 0) > 0,
    id_menu_vigente: row.id_menu_vigente ? Number(row.id_menu_vigente) : null,
    id_menu: row.id_menu ? Number(row.id_menu) : null,
    fecha_inicio_menu: row.fecha_inicio || null
  }));
};

const fetchBaseCatalogByMenu = async (idMenu, departmentIds) => {
  const recipeExcludedDepartmentIds = Array.isArray(departmentIds?.recipeExcludedDepartmentIds)
    ? departmentIds.recipeExcludedDepartmentIds
    : [];
  const comboDepartmentId = Number.isInteger(departmentIds?.comboDepartmentId)
    ? departmentIds.comboDepartmentId
    : null;
  const productDepartmentIds = Array.isArray(departmentIds?.productDepartmentIds)
    ? departmentIds.productDepartmentIds
    : [];

  const result = await pool.query(
    `
      SELECT
        '${ITEM_TYPES.RECETA}'::text AS tipo_item,
        r.id_receta::int AS id_item_origen,
        r.nombre_receta::text AS nombre_item,
        COALESCE(r.estado, true) AS estado_item,
        r.precio::numeric AS precio_base
      FROM recetas r
      WHERE r.id_menu = $1
        AND r.id_tipo_departamento IS NOT NULL
        AND r.id_tipo_departamento <> ALL($2::int[])

      UNION ALL

      SELECT
        '${ITEM_TYPES.COMBO}'::text AS tipo_item,
        c.id_combo::int AS id_item_origen,
        COALESCE(NULLIF(c.nombre_combo, ''), NULLIF(c.descripcion, ''), CONCAT('Combo #', c.id_combo::text))::text AS nombre_item,
        COALESCE(c.estado, true) AS estado_item,
        c.precio::numeric AS precio_base
      FROM combos c
      WHERE c.id_menu = $1
        AND c.id_tipo_departamento = $3

      UNION ALL

      SELECT
        '${ITEM_TYPES.PRODUCTO}'::text AS tipo_item,
        p.id_producto::int AS id_item_origen,
        p.nombre_producto::text AS nombre_item,
        COALESCE(p.estado, true) AS estado_item,
        p.precio::numeric AS precio_base
      FROM productos p
      WHERE p.id_tipo_departamento = ANY($4::int[])

      ORDER BY tipo_item, nombre_item ASC;
    `,
    [
      idMenu,
      recipeExcludedDepartmentIds,
      comboDepartmentId,
      productDepartmentIds
    ]
  );

  return result.rows || [];
};

const fetchDetalleRowsByMenu = async ({ idMenu, capabilities }) => {
  const selectIdReceta = capabilities.hasIdReceta ? 'dm.id_receta' : 'NULL::integer AS id_receta';
  const selectIdCombo = capabilities.hasIdCombo ? 'dm.id_combo' : 'NULL::integer AS id_combo';
  const selectVisible = capabilities.hasVisible ? 'COALESCE(dm.visible, true)' : 'true AS visible';
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
      WHERE dm.id_menu = $1
        AND COALESCE(dm.estado, true) = true
      ORDER BY dm.id_detalle_menu ASC;
    `,
    [idMenu]
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
      estado_item: parseBoolean(row.estado_item),
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

const normalizeDraftItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debes enviar al menos un item para guardar publicación.', data: [] };
  }

  const normalized = [];
  const seenKeys = new Set();

  for (const raw of items) {
    const tipoItem = normalizeItemType(raw?.tipo_item);
    const idItemOrigen = toPositiveInt(raw?.id_item_origen);
    if (!tipoItem || !idItemOrigen) {
      return { ok: false, message: 'Cada item requiere tipo_item válido e id_item_origen positivo.', data: [] };
    }

    const visible = parseBoolean(raw?.visible);
    const precioPublico = toNullableMoney(raw?.precio_publico);
    if (Number.isNaN(precioPublico)) {
      return { ok: false, message: `precio_publico inválido para ${tipoItem} #${idItemOrigen}.`, data: [] };
    }

    const orden = toNullablePositiveInt(raw?.orden);
    if (Number.isNaN(orden)) {
      return { ok: false, message: `orden inválido para ${tipoItem} #${idItemOrigen}.`, data: [] };
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

const fetchDraftStateByType = async ({ idMenu, normalizedItems }) => {
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
        SELECT id_producto AS id_item_origen, COALESCE(estado, true) AS estado_item, precio
        FROM productos
        WHERE id_producto = ANY($1::int[]);
      `,
      [[...new Set(productIds)]]
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

const updateDetalleRow = async ({ client, rowId, item, capabilities }) => {
  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (capabilities.hasVisible) {
    updates.push(`visible = $${paramIndex++}`);
    values.push(item.visible);
    updates.push('estado = true');
  } else {
    updates.push(`estado = ${item.visible ? 'true' : 'false'}`);
  }

  if (capabilities.hasPrecioPublico) {
    updates.push(`precio_publico = $${paramIndex++}`);
    values.push(item.precio_publico);
  }

  if (capabilities.hasOrden && item.orden !== null) {
    updates.push(`orden = $${paramIndex++}`);
    values.push(item.orden);
  }

  values.push(rowId);
  await client.query(
    `UPDATE detalle_menu SET ${updates.join(', ')} WHERE id_detalle_menu = $${paramIndex};`,
    values
  );
};

const insertDetalleRow = async ({ client, idMenu, item, capabilities }) => {
  const columns = ['id_menu', 'estado'];
  const values = [idMenu, true];

  if (item.tipo_item === ITEM_TYPES.PRODUCTO) {
    columns.push('id_producto');
    values.push(item.id_item_origen);
  } else if (item.tipo_item === ITEM_TYPES.RECETA && capabilities.hasIdReceta) {
    columns.push('id_receta');
    values.push(item.id_item_origen);
  } else if (item.tipo_item === ITEM_TYPES.COMBO && capabilities.hasIdCombo) {
    columns.push('id_combo');
    values.push(item.id_item_origen);
  } else {
    throw new Error(`No se puede publicar ${item.tipo_item}: la columna no existe en detalle_menu.`);
  }

  if (capabilities.hasVisible) {
    columns.push('visible');
    values.push(item.visible);
  }
  if (capabilities.hasPrecioPublico) {
    columns.push('precio_publico');
    values.push(item.precio_publico);
  }
  if (capabilities.hasOrden && item.orden !== null) {
    columns.push('orden');
    values.push(item.orden);
  }

  const placeholders = values.map((_, idx) => `$${idx + 1}`);
  await client.query(
    `
      INSERT INTO detalle_menu (${columns.join(', ')})
      VALUES (${placeholders.join(', ')});
    `,
    values
  );
};

const getVisibleCountByMenu = async ({ idMenu, capabilities, client }) => {
  const countVisibleExpr = capabilities.hasVisible ? 'AND COALESCE(visible, true) = true' : '';
  const result = await client.query(
    `
      SELECT COUNT(*)::int AS total
      FROM detalle_menu
      WHERE id_menu = $1
        AND COALESCE(estado, true) = true
        ${countVisibleExpr};
    `,
    [idMenu]
  );
  return Number(result.rows?.[0]?.total || 0);
};

// Lista sucursales operativas para el selector de publicación.
router.get('/sucursales', async (_req, res) => {
  try {
    const rows = await getBranchesForPublication();
    return res.status(200).json({ ok: true, data: rows });
  } catch (error) {
    console.error('admin_menu_publicacion /sucursales:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar sucursales.' });
  }
});

// Retorna el catálogo unificado con estado actual de publicación por sucursal.
router.get('/catalogo', async (req, res) => {
  try {
    const idSucursal = toPositiveInt(req.query.id_sucursal);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'id_sucursal es obligatorio y debe ser entero positivo.' });
    }

    const activeMenu = await getActiveMenuByBranch(idSucursal);
    if (!activeMenu) {
      return res.status(200).json({
        ok: true,
        data: {
          menu: null,
          capabilities: await getDetalleMenuCapabilities(),
          warnings: ['La sucursal no tiene menú vigente activo.'],
          items: []
        }
      });
    }

    const [capabilities, departmentIds] = await Promise.all([
      getDetalleMenuCapabilities(),
      // Evita IDs hardcodeados y usa la configuracion real de tipo_departamento.
      resolveMenuDepartmentIds()
    ]);
    const [baseRows, detailRows] = await Promise.all([
      fetchBaseCatalogByMenu(Number(activeMenu.id_menu), departmentIds),
      fetchDetalleRowsByMenu({ idMenu: Number(activeMenu.id_menu), capabilities })
    ]);

    const detailRowsByKey = buildDetailRowsByKey(detailRows);
    const mapped = mapCatalogForAdmin({ baseRows, detailRowsByKey });

    const warnings = [];
    if (mapped.duplicateKeys.length > 0) {
      warnings.push(`Existen duplicados en detalle_menu: ${mapped.duplicateKeys.join(', ')}`);
    }

    return res.status(200).json({
      ok: true,
      data: {
        menu: mapMenuSummary(activeMenu),
        capabilities,
        warnings,
        items: mapped.items
      }
    });
  } catch (error) {
    console.error('admin_menu_publicacion /catalogo:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo construir el catálogo de publicación.' });
  }
});

// Guarda cambios de publicación para una sucursal en el menú vigente.
router.put('/catalogo', async (req, res) => {
  const client = await pool.connect();
  try {
    const idSucursal = toPositiveInt(req.query.id_sucursal);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'id_sucursal es obligatorio y debe ser entero positivo.' });
    }

    const normalized = normalizeDraftItems(req.body?.items);
    if (!normalized.ok) {
      return res.status(400).json({ ok: false, message: normalized.message });
    }

    const activeMenu = await getActiveMenuByBranch(idSucursal);
    if (!activeMenu) {
      return res.status(409).json({ ok: false, message: 'La sucursal no tiene menú vigente activo.' });
    }

    const capabilities = await getDetalleMenuCapabilities();
    const [detailRows, stateByKey] = await Promise.all([
      fetchDetalleRowsByMenu({ idMenu: Number(activeMenu.id_menu), capabilities }),
      fetchDraftStateByType({
        idMenu: Number(activeMenu.id_menu),
        normalizedItems: normalized.data
      })
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
        validationErrors.push(`No existe origen válido para ${item.key} en el menú/sucursal seleccionados.`);
        continue;
      }

      const finalPrice = item.precio_publico ?? source.precio_base;

      if (item.visible && source.estado_item !== true) {
        validationErrors.push(`No puedes dejar visible ${item.key} porque está inactivo.`);
      }

      if (item.visible && (!Number.isFinite(finalPrice) || finalPrice < 0)) {
        validationErrors.push(`Precio inválido para ${item.key}.`);
      }

      if (item.visible && (!Number.isInteger(item.orden) || item.orden <= 0)) {
        validationErrors.push(`Orden inválido para ${item.key}. Debe ser entero positivo.`);
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
        message: 'Se encontraron errores de validación.',
        errors: validationErrors
      });
    }

    await client.query('BEGIN');

    for (const item of normalized.data) {
      const existingRows = detailRowsByKey.get(item.key) || [];
      const existing = existingRows[0] || null;

      // Si no existe fila y el item queda oculto, no insertamos ruido en detalle_menu.
      if (!existing && !item.visible) continue;

      if (existing) {
        await updateDetalleRow({
          client,
          rowId: Number(existing.id_detalle_menu),
          item,
          capabilities
        });
      } else {
        await insertDetalleRow({
          client,
          idMenu: Number(activeMenu.id_menu),
          item,
          capabilities
        });
      }
    }

    const visibleCount = await getVisibleCountByMenu({
      idMenu: Number(activeMenu.id_menu),
      capabilities,
      client
    });

    await client.query('COMMIT');

    const warnings = [];
    if (visibleCount === 0) {
      warnings.push('La sucursal quedó sin items visibles para el cliente.');
    }

    return res.status(200).json({
      ok: true,
      message: 'Publicación guardada correctamente.',
      data: {
        visible_count: visibleCount,
        warnings
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('admin_menu_publicacion PUT /catalogo:', error.message);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar la publicación del menú.' });
  } finally {
    client.release();
  }
});

export default router;
