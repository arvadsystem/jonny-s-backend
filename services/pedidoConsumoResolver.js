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

const fetchComboRecipeComponents = async (client, comboIds) => {
  if (!comboIds.length) return [];
  const rs = await client.query(
    `
      SELECT
        dc.id_combo,
        dc.id_receta,
        GREATEST(COALESCE(dc.cantidad, 1), 1)::numeric AS receta_factor
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
  const rs = await client.query(
    `
      SELECT
        dr.id_receta,
        dr.id_insumo,
        COALESCE(dr.cant, 0)::numeric AS insumo_factor
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

  for (const item of items) {
    if (item.tipo_item === ITEM_TYPES.PRODUCTO) addToMapTotal(productoQtyMap, item.id_item, item.cantidad);
    if (item.tipo_item === ITEM_TYPES.RECETA) addToMapTotal(recetaQtyMap, item.id_item, item.cantidad);
    if (item.tipo_item === ITEM_TYPES.COMBO) addToMapTotal(comboQtyMap, item.id_item, item.cantidad);
  }

  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const recetaIds = [...recetaQtyMap.keys()].sort((a, b) => a - b);
  const comboIds = [...comboQtyMap.keys()].sort((a, b) => a - b);

  const [recetasRows, combosRows, comboComponentRows] = await Promise.all([
    fetchRecetasByIds(client, recetaIds),
    fetchCombosByIds(client, comboIds),
    fetchComboRecipeComponents(client, comboIds)
  ]);

  const recetasById = mapById(recetasRows, 'id_receta');
  const combosById = mapById(combosRows, 'id_combo');

  for (const idReceta of recetaIds) {
    const row = recetasById.get(idReceta);
    if (!row) {
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        motivo: 'RECETA_NO_ENCONTRADA'
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        nombre: row.nombre_receta,
        motivo: 'RECETA_INACTIVA'
      });
    }
  }

  for (const idCombo of comboIds) {
    const row = combosById.get(idCombo);
    if (!row) {
      faltantes.push({
        tipo_recurso: 'combo',
        id_recurso: idCombo,
        motivo: 'COMBO_NO_ENCONTRADO'
      });
      continue;
    }
    if (!Boolean(row.estado)) {
      faltantes.push({
        tipo_recurso: 'combo',
        id_recurso: idCombo,
        nombre: row.nombre_combo,
        motivo: 'COMBO_INACTIVO'
      });
    }
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
        nombre: combosById.get(idCombo)?.nombre_combo || null,
        motivo: 'COMBO_SIN_COMPONENTES'
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

  const insumoQtyMap = new Map();
  for (const idReceta of allRecipeIds) {
    const components = recipeComponentsById.get(idReceta) || [];
    if (components.length === 0) {
      faltantes.push({
        tipo_recurso: 'receta',
        id_recurso: idReceta,
        nombre: recetasById.get(idReceta)?.nombre_receta || null,
        motivo: 'RECETA_SIN_COMPONENTES'
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
      insumoQtyMap
    },
    contexto: {
      combosById,
      recetasById
    }
  };
};

