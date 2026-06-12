import pool from '../config/db-connection.js';

const DETAIL_ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA',
  COMBO: 'COMBO'
});

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

let detalleMenuCapabilitiesPromise = null;

const hasColumn = async (tableName, columnName, db = pool) => {
  const result = await db.query(
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

const getDetalleMenuCapabilities = async (db = pool) => {
  if (!detalleMenuCapabilitiesPromise) {
    detalleMenuCapabilitiesPromise = Promise.all([
      hasColumn('detalle_menu', 'id_receta', db),
      hasColumn('detalle_menu', 'id_combo', db),
      hasColumn('detalle_menu', 'visible', db),
      hasColumn('detalle_menu', 'precio_publico', db),
      hasColumn('detalle_menu', 'orden', db)
    ])
      .then(([hasIdReceta, hasIdCombo, hasVisible, hasPrecioPublico, hasOrden]) => ({
        hasIdReceta,
        hasIdCombo,
        hasVisible,
        hasPrecioPublico,
        hasOrden
      }))
      .catch((error) => {
        detalleMenuCapabilitiesPromise = null;
        throw error;
      });
  }

  return detalleMenuCapabilitiesPromise;
};

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveProductCategoryAlias = async ({ client, idCategoriaProducto }) => {
  const id = toPositiveInt(idCategoriaProducto);
  if (!id) return '';

  const result = await client.query(
    `
      SELECT LOWER(REGEXP_REPLACE(TRIM(COALESCE(nombre_categoria, '')), '\\s*/\\s*', '/', 'g')) AS alias
      FROM categorias_productos
      WHERE id_categoria_producto = $1
        AND COALESCE(estado, true) = true
      LIMIT 1;
    `,
    [id]
  );

  return String(result.rows?.[0]?.alias || '').trim();
};

const isProductEligibleForPublicMenu = async ({ client, idCategoriaProducto }) => {
  const alias = await resolveProductCategoryAlias({ client, idCategoriaProducto });
  return MENU_PRODUCT_CATEGORY_ALIASES.includes(alias);
};

const getActivePublicMenuIdsByBranch = async ({ client, idSucursal }) => {
  const branchId = toPositiveInt(idSucursal);
  if (!branchId) return [];

  const result = await client.query(
    `
      SELECT DISTINCT mv.id_menu::int AS id_menu
      FROM menu_vigente mv
      INNER JOIN menu m
        ON m.id_menu = mv.id_menu
      INNER JOIN sucursales s
        ON s.id_sucursal = mv.id_sucursal
      WHERE COALESCE(mv.estado, true) = true
        AND COALESCE(m.estado, true) = true
        AND COALESCE(s.estado, true) = true
        AND mv.id_sucursal = $1
        AND mv.fecha_inicio <= NOW()
      ORDER BY mv.id_menu ASC;
    `,
    [branchId]
  );

  return [...new Set((result.rows || [])
    .map((row) => toPositiveInt(row.id_menu))
    .filter(Boolean))];
};

const resolveItemColumn = ({ tipoItem, capabilities }) => {
  if (tipoItem === DETAIL_ITEM_TYPES.PRODUCTO) return 'id_producto';
  if (tipoItem === DETAIL_ITEM_TYPES.RECETA && capabilities.hasIdReceta) return 'id_receta';
  if (tipoItem === DETAIL_ITEM_TYPES.COMBO && capabilities.hasIdCombo) return 'id_combo';
  return '';
};

const getExistingMenuIdsForItem = async ({
  client,
  menuIds,
  tipoItem,
  idItemOrigen,
  capabilities
}) => {
  const itemColumn = resolveItemColumn({ tipoItem, capabilities });
  const idItem = toPositiveInt(idItemOrigen);
  const normalizedMenuIds = [...new Set((Array.isArray(menuIds) ? menuIds : [])
    .map((menuId) => toPositiveInt(menuId))
    .filter(Boolean))];

  if (!itemColumn || !idItem || normalizedMenuIds.length === 0) {
    return new Set();
  }

  const result = await client.query(
    `
      SELECT DISTINCT id_menu::int AS id_menu
      FROM detalle_menu
      WHERE id_menu = ANY($1::int[])
        AND ${itemColumn} = $2
        AND COALESCE(estado, true) = true;
    `,
    [normalizedMenuIds, idItem]
  );

  return new Set((result.rows || [])
    .map((row) => toPositiveInt(row.id_menu))
    .filter(Boolean));
};

const getNextOrderByMenu = async ({ client, menuIds, capabilities }) => {
  const normalizedMenuIds = [...new Set((Array.isArray(menuIds) ? menuIds : [])
    .map((menuId) => toPositiveInt(menuId))
    .filter(Boolean))];
  const orderByMenu = new Map();

  if (!capabilities.hasOrden || normalizedMenuIds.length === 0) {
    return orderByMenu;
  }

  const result = await client.query(
    `
      SELECT id_menu::int AS id_menu, COALESCE(MAX(orden), 0)::int AS max_orden
      FROM detalle_menu
      WHERE id_menu = ANY($1::int[])
        AND COALESCE(estado, true) = true
      GROUP BY id_menu;
    `,
    [normalizedMenuIds]
  );

  for (const menuId of normalizedMenuIds) {
    orderByMenu.set(menuId, 1);
  }

  for (const row of result.rows || []) {
    const menuId = toPositiveInt(row.id_menu);
    if (!menuId) continue;
    orderByMenu.set(menuId, Number.parseInt(String(row.max_orden || 0), 10) + 1);
  }

  return orderByMenu;
};

const insertDetalleMenuRows = async ({ client, rows, capabilities }) => {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const columns = ['id_menu', 'estado', 'id_producto'];
  const selectValues = ['input.id_menu', 'input.estado', 'input.id_producto'];

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

  await client.query(
    `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS value(
          id_menu integer,
          estado boolean,
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
    [JSON.stringify(rows)]
  );
};

const getDetalleMenuRowsForItem = async ({
  client,
  idMenu,
  tipoItem,
  idItemOrigen,
  capabilities
}) => {
  const itemColumn = resolveItemColumn({ tipoItem, capabilities });
  const menuId = toPositiveInt(idMenu);
  const idItem = toPositiveInt(idItemOrigen);

  if (!itemColumn || !menuId || !idItem) return [];

  const selectVisible = capabilities.hasVisible
    ? 'COALESCE(visible, true) AS visible'
    : 'true AS visible';
  const selectOrden = capabilities.hasOrden
    ? 'orden'
    : 'NULL::integer AS orden';

  const result = await client.query(
    `
      SELECT
        id_detalle_menu,
        COALESCE(estado, true) AS estado,
        ${selectVisible},
        ${selectOrden}
      FROM detalle_menu
      WHERE id_menu = $1
        AND ${itemColumn} = $2
      ORDER BY id_detalle_menu DESC;
    `,
    [menuId, idItem]
  );

  return result.rows || [];
};

const deactivateDetalleMenuRowsByIds = async ({ client, rowIds, capabilities }) => {
  const normalizedIds = [...new Set((Array.isArray(rowIds) ? rowIds : [])
    .map((rowId) => toPositiveInt(rowId))
    .filter(Boolean))];
  if (normalizedIds.length === 0) return;

  const updates = ['estado = false'];
  if (capabilities.hasVisible) {
    updates.push('visible = false');
  }

  await client.query(
    `
      UPDATE detalle_menu
      SET ${updates.join(', ')}
      WHERE id_detalle_menu = ANY($1::int[]);
    `,
    [normalizedIds]
  );
};

const deactivateDetalleMenuRowsByMenu = async ({
  client,
  idMenu,
  tipoItem,
  idItemOrigen,
  capabilities
}) => {
  const itemColumn = resolveItemColumn({ tipoItem, capabilities });
  const menuId = toPositiveInt(idMenu);
  const idItem = toPositiveInt(idItemOrigen);

  if (!itemColumn || !menuId || !idItem) return;

  const updates = ['estado = false'];
  if (capabilities.hasVisible) {
    updates.push('visible = false');
  }

  await client.query(
    `
      UPDATE detalle_menu
      SET ${updates.join(', ')}
      WHERE id_menu = $1
        AND ${itemColumn} = $2;
    `,
    [menuId, idItem]
  );
};

const activateDetalleMenuRow = async ({
  client,
  idDetalleMenu,
  orderFallback,
  capabilities
}) => {
  const rowId = toPositiveInt(idDetalleMenu);
  if (!rowId) return;

  const updates = ['estado = true'];
  const params = [rowId];

  if (capabilities.hasVisible) {
    updates.push('visible = true');
  }
  if (capabilities.hasPrecioPublico) {
    updates.push('precio_publico = NULL');
  }
  if (capabilities.hasOrden) {
    params.push(toPositiveInt(orderFallback) || 1);
    updates.push(`orden = COALESCE(orden, $${params.length})`);
  }

  await client.query(
    `
      UPDATE detalle_menu
      SET ${updates.join(', ')}
      WHERE id_detalle_menu = $1;
    `,
    params
  );
};

const ensureDetailMenuRows = async ({
  client,
  menuIds,
  tipoItem,
  idItemOrigen,
  visibleDefault = true
}) => {
  const capabilities = await getDetalleMenuCapabilities(client);
  const normalizedMenuIds = [...new Set((Array.isArray(menuIds) ? menuIds : [])
    .map((menuId) => toPositiveInt(menuId))
    .filter(Boolean))];
  const idItem = toPositiveInt(idItemOrigen);

  if (!idItem || normalizedMenuIds.length === 0) return 0;
  if (tipoItem === DETAIL_ITEM_TYPES.RECETA && !capabilities.hasIdReceta) return 0;
  if (tipoItem === DETAIL_ITEM_TYPES.COMBO && !capabilities.hasIdCombo) return 0;

  const existingMenuIds = await getExistingMenuIdsForItem({
    client,
    menuIds: normalizedMenuIds,
    tipoItem,
    idItemOrigen: idItem,
    capabilities
  });

  const missingMenuIds = normalizedMenuIds.filter((menuId) => !existingMenuIds.has(menuId));
  if (missingMenuIds.length === 0) return 0;

  const nextOrderByMenu = await getNextOrderByMenu({
    client,
    menuIds: missingMenuIds,
    capabilities
  });

  const payload = missingMenuIds.map((menuId) => ({
    id_menu: menuId,
    estado: capabilities.hasVisible ? true : Boolean(visibleDefault),
    id_producto: tipoItem === DETAIL_ITEM_TYPES.PRODUCTO ? idItem : null,
    id_receta: tipoItem === DETAIL_ITEM_TYPES.RECETA ? idItem : null,
    id_combo: tipoItem === DETAIL_ITEM_TYPES.COMBO ? idItem : null,
    visible: Boolean(visibleDefault),
    precio_publico: null,
    orden: capabilities.hasOrden ? nextOrderByMenu.get(menuId) || 1 : null
  }));

  await insertDetalleMenuRows({ client, rows: payload, capabilities });
  return payload.length;
};

export const autoPublishNewRecipe = async ({
  client,
  idMenu,
  idReceta,
  estadoItem = true
}) => ensureDetailMenuRows({
  client,
  menuIds: [idMenu],
  tipoItem: DETAIL_ITEM_TYPES.RECETA,
  idItemOrigen: idReceta,
  visibleDefault: Boolean(estadoItem)
});

export const autoPublishNewCombo = async ({
  client,
  idMenu,
  idCombo,
  estadoItem = true
}) => ensureDetailMenuRows({
  client,
  menuIds: [idMenu],
  tipoItem: DETAIL_ITEM_TYPES.COMBO,
  idItemOrigen: idCombo,
  visibleDefault: Boolean(estadoItem)
});

export const autoPublishNewProduct = async ({
  client,
  idProducto,
  idCategoriaProducto,
  idAlmacen,
  estadoItem = true
}) => {
  const eligible = await isProductEligibleForPublicMenu({ client, idCategoriaProducto });
  if (!eligible) return 0;

  const warehouseResult = await client.query(
    `
      SELECT id_sucursal
      FROM almacenes
      WHERE id_almacen = $1
      LIMIT 1;
    `,
    [toPositiveInt(idAlmacen)]
  );
  const idSucursal = toPositiveInt(warehouseResult.rows?.[0]?.id_sucursal);
  if (!idSucursal) return 0;

  const activeMenuIds = await getActivePublicMenuIdsByBranch({ client, idSucursal });
  if (activeMenuIds.length === 0) return 0;

  return ensureDetailMenuRows({
    client,
    menuIds: activeMenuIds,
    tipoItem: DETAIL_ITEM_TYPES.PRODUCTO,
    idItemOrigen: idProducto,
    visibleDefault: Boolean(estadoItem)
  });
};

export const syncExistingBranchProductsIntoMenu = async ({
  client,
  idSucursal,
  idMenu
}) => {
  const branchId = toPositiveInt(idSucursal);
  const menuId = toPositiveInt(idMenu);
  if (!branchId || !menuId) return 0;

  const result = await client.query(
    `
      SELECT DISTINCT p.id_producto::int AS id_producto
      FROM public.productos_almacenes pa
      INNER JOIN public.almacenes ap
        ON ap.id_almacen = pa.id_almacen
       AND ap.id_sucursal = $1
       AND COALESCE(ap.estado, true) = true
      INNER JOIN public.productos p
        ON p.id_producto = pa.id_producto
      LEFT JOIN categorias_productos cp
        ON cp.id_categoria_producto = p.id_categoria_producto
      WHERE COALESCE(pa.estado, true) = true
        AND COALESCE(p.estado, true) = true
        AND COALESCE(cp.estado, true) = true
        AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(cp.nombre_categoria, '')), '\\s*/\\s*', '/', 'g')) = ANY($2::text[])
      ORDER BY p.id_producto ASC;
    `,
    [branchId, [...MENU_PRODUCT_CATEGORY_ALIASES]]
  );

  const productIds = [...new Set((result.rows || [])
    .map((row) => toPositiveInt(row.id_producto))
    .filter(Boolean))];

  if (productIds.length === 0) return 0;

  let createdCount = 0;
  for (const idProducto of productIds) {
    createdCount += await ensureDetailMenuRows({
      client,
      menuIds: [menuId],
      tipoItem: DETAIL_ITEM_TYPES.PRODUCTO,
      idItemOrigen: idProducto,
      visibleDefault: true
    });
  }

  return createdCount;
};

const movePublishedItemToMenu = async ({
  client,
  tipoItem,
  idItemOrigen,
  fromMenuId,
  toMenuId
}) => {
  const capabilities = await getDetalleMenuCapabilities(client);
  const sourceMenuId = toPositiveInt(fromMenuId);
  const targetMenuId = toPositiveInt(toMenuId);
  const idItem = toPositiveInt(idItemOrigen);

  if (!idItem || !sourceMenuId || !targetMenuId || sourceMenuId === targetMenuId) {
    return 0;
  }
  if (tipoItem === DETAIL_ITEM_TYPES.RECETA && !capabilities.hasIdReceta) return 0;
  if (tipoItem === DETAIL_ITEM_TYPES.COMBO && !capabilities.hasIdCombo) return 0;

  await deactivateDetalleMenuRowsByMenu({
    client,
    idMenu: sourceMenuId,
    tipoItem,
    idItemOrigen: idItem,
    capabilities
  });

  const existingTargetRows = await getDetalleMenuRowsForItem({
    client,
    idMenu: targetMenuId,
    tipoItem,
    idItemOrigen: idItem,
    capabilities
  });

  const keeperRow = existingTargetRows[0] || null;
  const duplicateRowIds = existingTargetRows
    .slice(1)
    .map((row) => toPositiveInt(row.id_detalle_menu))
    .filter(Boolean);

  if (duplicateRowIds.length > 0) {
    await deactivateDetalleMenuRowsByIds({
      client,
      rowIds: duplicateRowIds,
      capabilities
    });
  }

  if (!keeperRow) {
    return ensureDetailMenuRows({
      client,
      menuIds: [targetMenuId],
      tipoItem,
      idItemOrigen: idItem,
      visibleDefault: true
    });
  }

  const currentOrder = toPositiveInt(keeperRow.orden);
  let orderFallback = currentOrder;

  if (!currentOrder && capabilities.hasOrden) {
    const nextOrderByMenu = await getNextOrderByMenu({
      client,
      menuIds: [targetMenuId],
      capabilities
    });
    orderFallback = nextOrderByMenu.get(targetMenuId) || 1;
  }

  await activateDetalleMenuRow({
    client,
    idDetalleMenu: keeperRow.id_detalle_menu,
    orderFallback,
    capabilities
  });

  return 1;
};

export const moveRecipePublicationToMenu = async ({
  client,
  idReceta,
  fromMenuId,
  toMenuId
}) => movePublishedItemToMenu({
  client,
  tipoItem: DETAIL_ITEM_TYPES.RECETA,
  idItemOrigen: idReceta,
  fromMenuId,
  toMenuId
});

export const moveComboPublicationToMenu = async ({
  client,
  idCombo,
  fromMenuId,
  toMenuId
}) => movePublishedItemToMenu({
  client,
  tipoItem: DETAIL_ITEM_TYPES.COMBO,
  idItemOrigen: idCombo,
  fromMenuId,
  toMenuId
});
