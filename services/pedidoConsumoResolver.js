import { ITEM_TYPES, toPositiveInt } from './pedidoPayloadValidator.js';

// Resolver de consumo del pedido.
// ------------------------------------------------
// QUE HACE:
// - Convierte items (producto/receta) en cantidades agregadas por entidad.
// - Expande recetas -> insumos.
// - Acumula faltantes de configuracion de recetas sin componentes.
//
// POR QUE SE SEPARA:
// - Permite mantener el calculo de consumo aislado del manejo transaccional.

const addToMapTotal = (map, id, amount) => {
  const current = Number(map.get(id) || 0);
  map.set(id, current + Number(amount || 0));
};

const addMovementRow = (rows, row) => {
  const quantity = Number(row?.cantidad || 0);
  const idDetallePedido = toPositiveInt(row?.id_detalle_pedido);
  if (!Number.isFinite(quantity) || quantity <= 0) return;
  rows.push({
    tipo_recurso: row.tipo_recurso,
    id_producto: toPositiveInt(row.id_producto) || null,
    id_insumo: toPositiveInt(row.id_insumo) || null,
    id_detalle_pedido: idDetallePedido || null,
    cantidad: quantity,
    origen_consumo: String(row.origen_consumo || '').trim().toUpperCase() || null
  });
};

const mapById = (rows, fieldName) => {
  const map = new Map();
  for (const row of rows || []) {
    const id = Number(row?.[fieldName] || 0);
    if (id > 0) map.set(id, row);
  }
  return map;
};

const addContext = (map, id, item) => {
  if (!id) return;
  if (!map.has(id)) map.set(id, []);
  map.get(id).push({
    id_detalle_pedido: toPositiveInt(item?.id_detalle_pedido) || null,
    id_producto: toPositiveInt(item?.id_producto) || null,
    id_receta: toPositiveInt(item?.id_receta) || null,
    id_extra: toPositiveInt(item?.id_extra) || null,
    id_insumo: toPositiveInt(item?.id_insumo) || null,
    cantidad: Number(item?.cantidad || 0) > 0 ? Number(item.cantidad) : null,
    cant: Number(item?.cant || 0) > 0 ? Number(item.cant) : null,
    id_unidad_medida: toPositiveInt(item?.id_unidad_medida) || null,
    codigo: typeof item?.codigo === 'string' ? item.codigo.trim() || null : null,
    nombre: typeof item?.nombre === 'string' ? item.nombre.trim() || null : null
  });
};

const firstContext = (map, id) => (Array.isArray(map.get(id)) ? map.get(id)[0] : {}) || {};

const hasExtraInventorySnapshot = (context) => (
  context?.id_insumo !== null ||
  context?.id_unidad_medida !== null ||
  context?.cant !== null
);

const schemaColumnCache = new Map();
const hasColumn = async (client, tableName, columnName) => {
  const key = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);

  const rs = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  const exists = rs.rowCount > 0;
  schemaColumnCache.set(key, exists);
  return exists;
};

const fetchRecetasByIds = async (client, ids) => {
  if (!ids.length) return [];
  const rs = await client.query(
    `
      SELECT id_receta, nombre_receta, COALESCE(estado, true) AS estado
      FROM public.recetas
      WHERE id_receta = ANY($1::int[])
    `,
    [ids]
  );
  return rs.rows;
};

const fetchExtrasByIds = async (client, ids) => {
  if (!ids.length) return [];
  const hasMenuExtras = await hasColumn(client, 'menu_extras', 'id_extra');
  if (!hasMenuExtras) return [];
  const rs = await client.query(
    `
      SELECT
        id_extra,
        codigo,
        nombre,
        COALESCE(estado, true) AS estado,
        id_insumo,
        COALESCE(cant, 0)::numeric AS insumo_factor,
        id_unidad_medida
      FROM public.menu_extras
      WHERE id_extra = ANY($1::int[])
    `,
    [ids]
  );
  return rs.rows;
};

const fetchRecipeInsumoComponents = async (client, recipeIds) => {
  if (!recipeIds.length) return [];
  const hasDetalleRecetasCant = await hasColumn(client, 'detalle_recetas', 'cant');
  const insumoFactorExpr = hasDetalleRecetasCant
    ? 'COALESCE(dr.cant, 0)::numeric'
    : '0::numeric';
  const rs = await client.query(
    `
      SELECT
        dr.id_receta,
        dr.id_insumo,
        ${insumoFactorExpr} AS insumo_factor
      FROM public.detalle_recetas dr
      WHERE dr.id_receta = ANY($1::int[])
        AND COALESCE(dr.estado, true) = true
    `,
    [recipeIds]
  );
  return rs.rows;
};

export const resolvePedidoConsumo = async ({ client, items }) => {
  const faltantes = [];

  const productoQtyMap = new Map();
  const recetaQtyMap = new Map();
  const extraQtyMap = new Map();
  const insumoQtyMap = new Map();
  const insumoWarehouseById = new Map();
  const insumoTraceById = new Map();
  const productoContextById = new Map();
  const recetaContextById = new Map();
  const extraContextById = new Map();
  const movimientoRows = [];

  for (const item of items) {
    if (item.tipo_item === ITEM_TYPES.PRODUCTO) {
      addToMapTotal(productoQtyMap, item.id_item, item.cantidad);
      addContext(productoContextById, item.id_item, item);
      addMovementRow(movimientoRows, {
        tipo_recurso: 'producto',
        id_producto: item.id_item,
        id_detalle_pedido: item.id_detalle_pedido,
        cantidad: item.cantidad,
        origen_consumo: 'PRODUCTO'
      });
    }
    if (item.tipo_item === ITEM_TYPES.RECETA) {
      addToMapTotal(recetaQtyMap, item.id_item, item.cantidad);
      addContext(recetaContextById, item.id_item, item);
    }
    if (item.tipo_item === ITEM_TYPES.EXTRA) {
      addToMapTotal(extraQtyMap, item.id_item, item.cantidad);
      addContext(extraContextById, item.id_item, item);
    }
    if (item.tipo_item === ITEM_TYPES.SALSA) {
      const idInsumo = toPositiveInt(item.id_insumo);
      const idAlmacen = toPositiveInt(item.id_almacen);
      if (!idInsumo || !idAlmacen) continue;
      const previousWarehouse = insumoWarehouseById.get(idInsumo);
      if (previousWarehouse && previousWarehouse !== idAlmacen) {
        faltantes.push({
          tipo_recurso: 'insumo',
          id_recurso: idInsumo,
          id_insumo: idInsumo,
          motivo: 'SALSA_SNAPSHOT_ALMACEN_AMBIGUO',
          mensaje: `Los snapshots de salsa para el insumo ${idInsumo} apuntan a almacenes distintos.`
        });
        continue;
      }
      insumoWarehouseById.set(idInsumo, idAlmacen);
      addToMapTotal(insumoQtyMap, idInsumo, item.cantidad);
      addMovementRow(movimientoRows, {
        tipo_recurso: 'insumo',
        id_insumo: idInsumo,
        id_detalle_pedido: item.id_detalle_pedido,
        cantidad: item.cantidad,
        origen_consumo: 'SALSA'
      });
      const trace = insumoTraceById.get(idInsumo) || {
        salsaIds: new Set(),
        detallePedidoIds: new Set(),
        nombres: new Set()
      };
      if (toPositiveInt(item.id_salsa)) trace.salsaIds.add(toPositiveInt(item.id_salsa));
      if (toPositiveInt(item.id_detalle_pedido)) trace.detallePedidoIds.add(toPositiveInt(item.id_detalle_pedido));
      if (item.nombre) trace.nombres.add(String(item.nombre).trim());
      insumoTraceById.set(idInsumo, trace);
    }
  }

  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const recetaIds = [...recetaQtyMap.keys()].sort((a, b) => a - b);
  const extraIds = [...extraQtyMap.keys()].sort((a, b) => a - b);

  const [recetasRows, extrasRows] = await Promise.all([
    fetchRecetasByIds(client, recetaIds),
    fetchExtrasByIds(client, extraIds)
  ]);

  const recetasById = mapById(recetasRows, 'id_receta');
  const extrasById = mapById(extrasRows, 'id_extra');
  const excludedRecipeIds = new Set();

  for (const idReceta of recetaIds) {
    const row = recetasById.get(idReceta);
    if (!row) {
      excludedRecipeIds.add(idReceta);
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        id_receta: idReceta,
        ...firstContext(recetaContextById, idReceta),
        motivo: 'RECETA_NO_ENCONTRADA',
        mensaje: `La receta ${idReceta} no existe o no esta disponible.`
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      excludedRecipeIds.add(idReceta);
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        id_receta: idReceta,
        ...firstContext(recetaContextById, idReceta),
        nombre: row.nombre_receta,
        motivo: 'RECETA_INACTIVA',
        mensaje: `La receta ${row.nombre_receta || idReceta} esta inactiva.`
      });
    }
  }

  for (const idExtra of extraIds) {
    const contexts = extraContextById.get(idExtra) || [];
    const firstExtraContext = firstContext(extraContextById, idExtra);
    const row = extrasById.get(idExtra);
    for (const context of contexts) {
      const hasSnapshotInventory = hasExtraInventorySnapshot(context);
      const snapshotInsumoId = toPositiveInt(context.id_insumo);
      const snapshotFactor = Number(context.cant || 0);
      const snapshotUnidadId = toPositiveInt(context.id_unidad_medida);
      if (hasSnapshotInventory) {
        if (!snapshotInsumoId || snapshotFactor <= 0) {
          faltantes.push({
            tipo_recurso: 'extra',
            id_recurso: idExtra,
            id_extra: idExtra,
            ...context,
            motivo: 'EXTRA_SNAPSHOT_INVENTARIO_INVALIDO',
            mensaje: `El snapshot de inventario del extra ${context.nombre || context.codigo || idExtra} esta incompleto.`
          });
          continue;
        }
        const lineQty = Number(context.cantidad || 0);
        addToMapTotal(insumoQtyMap, snapshotInsumoId, lineQty * snapshotFactor);
        addMovementRow(movimientoRows, {
          tipo_recurso: 'insumo',
          id_insumo: snapshotInsumoId,
          id_detalle_pedido: context.id_detalle_pedido,
          cantidad: lineQty * snapshotFactor,
          origen_consumo: 'EXTRA'
        });
        continue;
      }
      if (!row) {
        faltantes.push({
          tipo_recurso: 'extra',
          id_recurso: idExtra,
          id_extra: idExtra,
          ...context,
          motivo: 'EXTRA_SIN_CONFIGURACION_INVENTARIO',
          mensaje: `El extra ${context.nombre || context.codigo || idExtra} no tiene configuracion de inventario disponible.`
        });
        continue;
      }
      if (!Boolean(row.estado)) {
        faltantes.push({
          tipo_recurso: 'extra',
          id_recurso: idExtra,
          id_extra: idExtra,
          ...context,
          nombre: row.nombre,
          codigo: row.codigo || null,
          motivo: 'EXTRA_INACTIVO',
          mensaje: `El extra ${row.nombre || row.codigo || idExtra} esta inactivo.`
        });
        continue;
      }
      const insumoId = toPositiveInt(row?.id_insumo);
      const insumoFactor = Number(row?.insumo_factor || 0);
      const unidadId = snapshotUnidadId || toPositiveInt(row?.id_unidad_medida);
      const nombre = context.nombre || row?.nombre || null;
      const codigo = context.codigo || row?.codigo || null;
      if (!insumoId || insumoFactor <= 0) {
        faltantes.push({
          tipo_recurso: 'extra',
          id_recurso: idExtra,
          id_extra: idExtra,
          ...context,
          nombre,
          codigo,
          motivo: 'EXTRA_SIN_CONFIGURACION_INVENTARIO',
          mensaje: `El extra ${nombre || codigo || idExtra} no tiene id_insumo o cantidad de consumo configurada.`
        });
        continue;
      }
      if (!unidadId) {
        faltantes.push({
          tipo_recurso: 'extra',
          id_recurso: idExtra,
          id_extra: idExtra,
          ...context,
          nombre,
          codigo,
          id_insumo: insumoId,
          cant: insumoFactor,
          motivo: 'EXTRA_SIN_UNIDAD_MEDIDA',
          mensaje: `El extra ${nombre || codigo || idExtra} no tiene unidad de medida configurada.`
        });
        continue;
      }
      const lineQty = Number(context.cantidad || 0);
      addToMapTotal(insumoQtyMap, insumoId, lineQty * insumoFactor);
      addMovementRow(movimientoRows, {
        tipo_recurso: 'insumo',
        id_insumo: insumoId,
        id_detalle_pedido: context.id_detalle_pedido,
        cantidad: lineQty * insumoFactor,
        origen_consumo: 'EXTRA'
      });
    }
    if (contexts.length === 0) {
      faltantes.push({
        tipo_recurso: 'extra',
        id_recurso: idExtra,
        id_extra: idExtra,
        ...firstExtraContext,
        motivo: 'EXTRA_SIN_CONTEXTO_LINEA',
        mensaje: `El extra ${idExtra} no tiene contexto de linea para inventario.`
      });
    }
  }

  const allRecipeIds = [...recetaQtyMap.keys()].filter((idReceta) => !excludedRecipeIds.has(idReceta)).sort((a, b) => a - b);
  const recipeComponentsRows = await fetchRecipeInsumoComponents(client, allRecipeIds);
  const recipeComponentsById = new Map();
  const invalidRecipeComponentIds = new Set();

  for (const row of recipeComponentsRows) {
    const recipeId = Number(row?.id_receta || 0);
    const insumoId = Number(row?.id_insumo || 0);
    const factor = Number(row?.insumo_factor || 0);
    if (!recipeId) continue;
    if (!insumoId || factor <= 0) {
      invalidRecipeComponentIds.add(recipeId);
      continue;
    }
    if (!recipeComponentsById.has(recipeId)) recipeComponentsById.set(recipeId, []);
    recipeComponentsById.get(recipeId).push({
      id_insumo: insumoId,
      insumo_factor: factor
    });
  }

  for (const idReceta of allRecipeIds) {
    if (invalidRecipeComponentIds.has(idReceta)) {
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        id_receta: idReceta,
        ...firstContext(recetaContextById, idReceta),
        nombre: recetasById.get(idReceta)?.nombre_receta || null,
        motivo: 'RECETA_CON_COMPONENTES_INVALIDOS',
        mensaje: `La receta ${recetasById.get(idReceta)?.nombre_receta || idReceta} tiene componentes de inventario invalidos.`
      });
      continue;
    }
    const components = recipeComponentsById.get(idReceta) || [];
    if (components.length === 0) {
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        id_receta: idReceta,
        ...firstContext(recetaContextById, idReceta),
        nombre: recetasById.get(idReceta)?.nombre_receta || null,
        motivo: 'RECETA_SIN_COMPONENTES',
        mensaje: `La receta ${recetasById.get(idReceta)?.nombre_receta || idReceta} no tiene insumos configurados.`
      });
      continue;
    }
    const recipeQty = Number(recetaQtyMap.get(idReceta) || 0);
    for (const component of components) {
      addToMapTotal(insumoQtyMap, component.id_insumo, recipeQty * Number(component.insumo_factor));
      for (const context of recetaContextById.get(idReceta) || []) {
        addMovementRow(movimientoRows, {
          tipo_recurso: 'insumo',
          id_insumo: component.id_insumo,
          id_detalle_pedido: context.id_detalle_pedido,
          cantidad: Number(context.cantidad || 0) * Number(component.insumo_factor),
          origen_consumo: 'RECETA'
        });
      }
    }
  }

  // Sanidad minima para evitar IDs invalidos propagandose al validador de stock.
  for (const id of [...productoQtyMap.keys(), ...insumoQtyMap.keys()]) {
    if (!toPositiveInt(id)) {
      faltantes.push({
        tipo_recurso: 'configuracion',
        id_recurso: id,
        motivo: 'ID_INVALIDO_EN_CONSUMO'
      });
    }
  }

  return {
    faltantes,
    consumo: {
      productoQtyMap,
      recetaQtyMap,
      extraQtyMap,
      insumoQtyMap,
      movimientoRows
    },
    contexto: {
      recetasById,
      extrasById
    },
    insumoWarehouseById,
    insumoTraceById
  };
};

