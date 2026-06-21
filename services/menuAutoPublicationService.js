import pool from '../config/db-connection.js';

const DETAIL_ITEM_TYPES = Object.freeze({
  PRODUCTO: 'PRODUCTO',
  RECETA: 'RECETA'
});

let detalleMenuCapabilitiesPromise = null;

const getDetalleMenuCapabilities = async (db = pool) => {
  if (!detalleMenuCapabilitiesPromise) {
    detalleMenuCapabilitiesPromise = db.query(
      `
        SELECT
          COALESCE(BOOL_OR(column_name = 'id_receta'), false) AS has_id_receta,
          COALESCE(BOOL_OR(column_name = 'visible'), false) AS has_visible,
          COALESCE(BOOL_OR(column_name = 'precio_publico'), false) AS has_precio_publico,
          COALESCE(BOOL_OR(column_name = 'orden'), false) AS has_orden
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'detalle_menu'
          AND column_name = ANY($1::text[]);
      `,
      [['id_receta', 'visible', 'precio_publico', 'orden']]
    )
      .then((result) => {
        const row = result.rows?.[0] || {};
        return {
          hasIdReceta: Boolean(row.has_id_receta),
          hasVisible: Boolean(row.has_visible),
          hasPrecioPublico: Boolean(row.has_precio_publico),
          hasOrden: Boolean(row.has_orden)
        };
      })
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

const mapPublicationRule = (row) => {
  if (!row) return null;
  return {
    visibleDefault: row.visible_default !== null && row.visible_default !== undefined
      ? Boolean(row.visible_default)
      : true,
    orden: toPositiveInt(row.orden)
  };
};

const getProductAutoPublicationRule = async ({ client, idProducto, idCategoriaProducto }) => {
  const productId = toPositiveInt(idProducto);
  const categoryId = toPositiveInt(idCategoriaProducto);
  if (!productId) return null;

  const result = await client.query(
    `
      SELECT mpr.visible_default, mpr.orden
      FROM public.productos p
      INNER JOIN public.menu_publicacion_reglas mpr
        ON mpr.tipo_item = $2
       AND mpr.id_categoria_producto = p.id_categoria_producto
       AND COALESCE(mpr.estado, true) = true
       AND COALESCE(mpr.autopublicar, false) = true
      WHERE p.id_producto = $1
        AND ($3::int IS NULL OR p.id_categoria_producto = $3)
      LIMIT 1;
    `,
    [productId, DETAIL_ITEM_TYPES.PRODUCTO, categoryId]
  );

  return mapPublicationRule(result.rows?.[0] || null);
};

const getRecipeAutoPublicationRule = async ({ client, idReceta }) => {
  const recipeId = toPositiveInt(idReceta);
  if (!recipeId) return null;

  const result = await client.query(
    `
      SELECT mpr.visible_default, mpr.orden
      FROM public.recetas r
      INNER JOIN public.menu_publicacion_reglas mpr
        ON mpr.tipo_item = $2
       AND mpr.id_tipo_departamento = r.id_tipo_departamento
       AND COALESCE(mpr.estado, true) = true
       AND COALESCE(mpr.autopublicar, false) = true
      WHERE r.id_receta = $1
        AND r.id_tipo_departamento IS NOT NULL
      LIMIT 1;
    `,
    [recipeId, DETAIL_ITEM_TYPES.RECETA]
  );

  return mapPublicationRule(result.rows?.[0] || null);
};

const getActivePublicMenuIdsByBranch = async ({ client, idSucursal }) => {
  const branchId = toPositiveInt(idSucursal);
  if (!branchId) return [];

  const result = await client.query(
    `
      SELECT DISTINCT r.id_menu::int AS id_menu
      FROM public.fn_resolver_menu_publicado($1) r
      ORDER BY r.id_menu ASC;
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
  visibleDefault = true,
  preferredOrder = null
}) => {
  const capabilities = await getDetalleMenuCapabilities(client);
  const normalizedMenuIds = [...new Set((Array.isArray(menuIds) ? menuIds : [])
    .map((menuId) => toPositiveInt(menuId))
    .filter(Boolean))];
  const idItem = toPositiveInt(idItemOrigen);

  if (!idItem || normalizedMenuIds.length === 0) return 0;
  if (tipoItem === DETAIL_ITEM_TYPES.RECETA && !capabilities.hasIdReceta) return 0;

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
  const orderBase = toPositiveInt(preferredOrder);

  const payload = missingMenuIds.map((menuId) => ({
    id_menu: menuId,
    estado: capabilities.hasVisible ? true : Boolean(visibleDefault),
    id_producto: tipoItem === DETAIL_ITEM_TYPES.PRODUCTO ? idItem : null,
    id_receta: tipoItem === DETAIL_ITEM_TYPES.RECETA ? idItem : null,
    visible: Boolean(visibleDefault),
    precio_publico: null,
    orden: capabilities.hasOrden ? orderBase || nextOrderByMenu.get(menuId) || 1 : null
  }));

  await insertDetalleMenuRows({ client, rows: payload, capabilities });
  return payload.length;
};

export const autoPublishNewRecipe = async ({
  client,
  idMenu,
  idReceta
}) => {
  const rule = await getRecipeAutoPublicationRule({ client, idReceta });
  if (!rule) return 0;

  return ensureDetailMenuRows({
    client,
    menuIds: [idMenu],
    tipoItem: DETAIL_ITEM_TYPES.RECETA,
    idItemOrigen: idReceta,
    visibleDefault: rule.visibleDefault,
    preferredOrder: rule.orden ? rule.orden * 1000 : null
  });
};

export const autoPublishNewProduct = async ({
  client,
  idProducto,
  idCategoriaProducto,
  idAlmacen
}) => {
  const rule = await getProductAutoPublicationRule({ client, idProducto, idCategoriaProducto });
  if (!rule) return 0;

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
    visibleDefault: rule.visibleDefault,
    preferredOrder: rule.orden ? rule.orden * 1000 : null
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
      SELECT DISTINCT
        p.id_producto::int AS id_producto,
        COALESCE(mpr.visible_default, true) AS visible_default
      FROM public.productos_almacenes pa
      INNER JOIN public.almacenes ap
        ON ap.id_almacen = pa.id_almacen
       AND ap.id_sucursal = $1
       AND COALESCE(ap.estado, true) = true
      INNER JOIN public.productos p
        ON p.id_producto = pa.id_producto
      INNER JOIN public.menu_publicacion_reglas mpr
        ON mpr.tipo_item = $2
       AND mpr.id_categoria_producto = p.id_categoria_producto
       AND COALESCE(mpr.estado, true) = true
       AND COALESCE(mpr.autopublicar, false) = true
      WHERE COALESCE(pa.estado, true) = true
        AND COALESCE(p.estado, true) = true
      ORDER BY p.id_producto ASC;
    `,
    [branchId, DETAIL_ITEM_TYPES.PRODUCTO]
  );

  const products = [];
  const seenProductIds = new Set();
  for (const row of result.rows || []) {
    const idProducto = toPositiveInt(row.id_producto);
    if (!idProducto || seenProductIds.has(idProducto)) continue;
    seenProductIds.add(idProducto);
    products.push({
      idProducto,
      visibleDefault: row.visible_default !== null && row.visible_default !== undefined
        ? Boolean(row.visible_default)
        : true
    });
  }

  if (products.length === 0) return 0;

  let createdCount = 0;
  for (const product of products) {
    createdCount += await ensureDetailMenuRows({
      client,
      menuIds: [menuId],
      tipoItem: DETAIL_ITEM_TYPES.PRODUCTO,
      idItemOrigen: product.idProducto,
      visibleDefault: product.visibleDefault
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
