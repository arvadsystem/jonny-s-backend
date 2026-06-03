import { ITEM_TYPES, toPositiveInt } from './pedidoPayloadValidator.js';

// Resolver de consumo del pedido.
// ------------------------------------------------
// QUE HACE:
// - Convierte items (producto/receta/combo) en cantidades agregadas por entidad.
// - Expande combos -> recetas y recetas -> insumos.
// - Acumula faltantes de configuracion (combo/receta sin componentes).
//
// POR QUE SE SEPARA:
// - Permite mantener el calculo de consumo aislado del manejo transaccional.

const addToMapTotal = (map, id, amount) => {
  const current = Number(map.get(id) || 0);
  map.set(id, current + Number(amount || 0));
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
    id_combo: toPositiveInt(item?.id_combo) || null,
    id_extra: toPositiveInt(item?.id_extra) || null
  });
};

const firstContext = (map, id) => (Array.isArray(map.get(id)) ? map.get(id)[0] : {}) || {};

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

const fetchCombosByIds = async (client, ids) => {
  if (!ids.length) return [];
  const rs = await client.query(
    `
      SELECT
        id_combo,
        COALESCE(NULLIF(nombre_combo, ''), NULLIF(descripcion, ''), CONCAT('Combo #', id_combo::text)) AS nombre_combo,
        COALESCE(estado, true) AS estado
      FROM public.combos
      WHERE id_combo = ANY($1::int[])
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
        COALESCE(cant, 0)::numeric AS insumo_factor
      FROM public.menu_extras
      WHERE id_extra = ANY($1::int[])
    `,
    [ids]
  );
  return rs.rows;
};

const fetchComboRecipeComponents = async (client, comboIds) => {
  if (!comboIds.length) return [];
  const hasDetalleComboCantidad = await hasColumn(client, 'detalle_combo', 'cantidad');
  const comboQtyExpr = hasDetalleComboCantidad
    ? 'GREATEST(COALESCE(dc.cantidad, 1), 1)::numeric'
    : '1::numeric';
  const rs = await client.query(
    `
      SELECT
        dc.id_combo,
        dc.id_receta,
        ${comboQtyExpr} AS receta_factor
      FROM public.detalle_combo dc
      WHERE dc.id_combo = ANY($1::int[])
        AND dc.id_receta IS NOT NULL
        AND COALESCE(dc.estado, true) = true
    `,
    [comboIds]
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
        AND dr.id_insumo IS NOT NULL
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
  const comboQtyMap = new Map();
  const extraQtyMap = new Map();
  const productoContextById = new Map();
  const recetaContextById = new Map();
  const comboContextById = new Map();
  const extraContextById = new Map();

  for (const item of items) {
    if (item.tipo_item === ITEM_TYPES.PRODUCTO) {
      addToMapTotal(productoQtyMap, item.id_item, item.cantidad);
      addContext(productoContextById, item.id_item, item);
    }
    if (item.tipo_item === ITEM_TYPES.RECETA) {
      addToMapTotal(recetaQtyMap, item.id_item, item.cantidad);
      addContext(recetaContextById, item.id_item, item);
    }
    if (item.tipo_item === ITEM_TYPES.COMBO) {
      addToMapTotal(comboQtyMap, item.id_item, item.cantidad);
      addContext(comboContextById, item.id_item, item);
    }
    if (item.tipo_item === ITEM_TYPES.EXTRA) {
      addToMapTotal(extraQtyMap, item.id_item, item.cantidad);
      addContext(extraContextById, item.id_item, item);
    }
  }

  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const recetaIds = [...recetaQtyMap.keys()].sort((a, b) => a - b);
  const comboIds = [...comboQtyMap.keys()].sort((a, b) => a - b);
  const extraIds = [...extraQtyMap.keys()].sort((a, b) => a - b);

  const [recetasRows, combosRows, extrasRows, comboComponentRows] = await Promise.all([
    fetchRecetasByIds(client, recetaIds),
    fetchCombosByIds(client, comboIds),
    fetchExtrasByIds(client, extraIds),
    fetchComboRecipeComponents(client, comboIds)
  ]);

  const recetasById = mapById(recetasRows, 'id_receta');
  const combosById = mapById(combosRows, 'id_combo');
  const extrasById = mapById(extrasRows, 'id_extra');

  for (const idReceta of recetaIds) {
    const row = recetasById.get(idReceta);
    if (!row) {
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

  for (const idCombo of comboIds) {
    const row = combosById.get(idCombo);
    if (!row) {
      faltantes.push({
        tipo_recurso: 'combo',
        id_recurso: idCombo,
        id_combo: idCombo,
        ...firstContext(comboContextById, idCombo),
        motivo: 'COMBO_NO_ENCONTRADO',
        mensaje: `El combo ${idCombo} no existe o no esta disponible.`
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      faltantes.push({
        tipo_recurso: 'combo',
        id_recurso: idCombo,
        id_combo: idCombo,
        ...firstContext(comboContextById, idCombo),
        nombre: row.nombre_combo,
        motivo: 'COMBO_INACTIVO',
        mensaje: `El combo ${row.nombre_combo || idCombo} esta inactivo.`
      });
    }
  }

  const insumoQtyMap = new Map();
  for (const idExtra of extraIds) {
    const row = extrasById.get(idExtra);
    if (!row) {
      faltantes.push({
        tipo_recurso: 'extra',
        id_recurso: idExtra,
        id_extra: idExtra,
        ...firstContext(extraContextById, idExtra),
        motivo: 'EXTRA_NO_ENCONTRADO',
        mensaje: `El extra ${idExtra} no existe o no esta disponible.`
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      faltantes.push({
        tipo_recurso: 'extra',
        id_recurso: idExtra,
        id_extra: idExtra,
        ...firstContext(extraContextById, idExtra),
        nombre: row.nombre,
        codigo: row.codigo || null,
        motivo: 'EXTRA_INACTIVO',
        mensaje: `El extra ${row.nombre || row.codigo || idExtra} esta inactivo.`
      });
      continue;
    }
    const insumoId = toPositiveInt(row.id_insumo);
    const insumoFactor = Number(row.insumo_factor || 0);
    if (!insumoId || insumoFactor <= 0) {
      faltantes.push({
        tipo_recurso: 'extra',
        id_recurso: idExtra,
        id_extra: idExtra,
        ...firstContext(extraContextById, idExtra),
        nombre: row.nombre,
        codigo: row.codigo || null,
        motivo: 'EXTRA_SIN_CONFIGURACION_INVENTARIO',
        mensaje: `El extra ${row.nombre || row.codigo || idExtra} no tiene id_insumo o cantidad de consumo configurada.`
      });
      continue;
    }
    addToMapTotal(insumoQtyMap, insumoId, Number(extraQtyMap.get(idExtra) || 0) * insumoFactor);
  }

  const comboComponentsById = new Map();
  for (const row of comboComponentRows) {
    const comboId = Number(row?.id_combo || 0);
    const recipeId = Number(row?.id_receta || 0);
    const factor = Number(row?.receta_factor || 0);
    if (!comboId || !recipeId || factor <= 0) continue;
    if (!comboComponentsById.has(comboId)) comboComponentsById.set(comboId, []);
    comboComponentsById.get(comboId).push({ id_receta: recipeId, receta_factor: factor });
  }

  for (const idCombo of comboIds) {
    const components = comboComponentsById.get(idCombo) || [];
    if (components.length === 0) {
      faltantes.push({
        tipo_recurso: 'combo',
        id_recurso: idCombo,
        id_combo: idCombo,
        ...firstContext(comboContextById, idCombo),
        nombre: combosById.get(idCombo)?.nombre_combo || null,
        motivo: 'COMBO_SIN_COMPONENTES',
        mensaje: `El combo ${combosById.get(idCombo)?.nombre_combo || idCombo} no tiene recetas/componentes configurados.`
      });
      continue;
    }
    const comboQty = Number(comboQtyMap.get(idCombo) || 0);
    for (const component of components) {
      addToMapTotal(recetaQtyMap, component.id_receta, comboQty * Number(component.receta_factor));
    }
  }

  const allRecipeIds = [...recetaQtyMap.keys()].sort((a, b) => a - b);
  const recipeComponentsRows = await fetchRecipeInsumoComponents(client, allRecipeIds);
  const recipeComponentsById = new Map();

  for (const row of recipeComponentsRows) {
    const recipeId = Number(row?.id_receta || 0);
    const insumoId = Number(row?.id_insumo || 0);
    const factor = Number(row?.insumo_factor || 0);
    if (!recipeId || !insumoId || factor <= 0) continue;
    if (!recipeComponentsById.has(recipeId)) recipeComponentsById.set(recipeId, []);
    recipeComponentsById.get(recipeId).push({
      id_insumo: insumoId,
      insumo_factor: factor
    });
  }

  for (const idReceta of allRecipeIds) {
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
      comboQtyMap,
      extraQtyMap,
      insumoQtyMap
    },
    contexto: {
      combosById,
      recetasById,
      extrasById
    }
  };
};

