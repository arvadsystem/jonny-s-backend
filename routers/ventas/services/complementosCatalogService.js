import {
  VENTA_COMPLEMENTO_TIPO_SALSAS,
  WINGS_SAUCE_KEYWORDS
} from '../constants.js';
import { normalizeSearchText } from '../utils/parseUtils.js';
import { measureVentasPerf } from '../utils/perfUtils.js';
import {
  fetchPublicActiveSaucesQuery
} from '../../public_menu/publicMenuQueries.js';

const getVentasCatalogCacheTtlMs = () => {
  const rawValue = process.env.VENTAS_CATALOG_CACHE_TTL_MS;
  const defaultValue = process.env.NODE_ENV === 'production' ? '0' : '30000';
  const parsed = Number.parseInt(rawValue === undefined || rawValue === null || String(rawValue).trim() === '' ? defaultValue : rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isVentasCatalogCacheEnabled = () =>
  getVentasCatalogCacheTtlMs() > 0;

const ventasStaticComplementCache = new Map();

export const buildVentasStaticCacheKey = (prefix, ids = []) => {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => Number(id || 0))
    .filter((id) => Number.isInteger(id) && id > 0))]
    .sort((a, b) => a - b);
  return `${prefix}:${normalizedIds.join(',')}`;
};

const cloneRows = (rows) => (Array.isArray(rows) ? rows.map((row) => ({ ...row })) : []);

const cloneVentasCacheValue = (value) => {
  if (Array.isArray(value)) return cloneRows(value);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        Array.isArray(entryValue) ? cloneRows(entryValue) : entryValue
      ])
    );
  }
  return value;
};

export const fetchCachedVentasStaticValue = async (cacheKey, loader, perf = null) => {
  const cacheStart = perf?.now?.() || 0;
  if (!isVentasCatalogCacheEnabled()) {
    perf?.inc?.('cache_misses');
    const value = await loader();
    perf?.add?.('catalog_cache_ms', cacheStart);
    return value;
  }

  const now = Date.now();
  const cached = ventasStaticComplementCache.get(cacheKey);
  const ttlMs = getVentasCatalogCacheTtlMs();
  if (cached && now - cached.at < ttlMs) {
    perf?.inc?.('cache_hits');
    perf?.add?.('catalog_cache_ms', cacheStart);
    return cloneVentasCacheValue(cached.value);
  }

  perf?.inc?.('cache_misses');
  const value = await loader();
  ventasStaticComplementCache.set(cacheKey, { at: now, value: cloneVentasCacheValue(value) });
  perf?.add?.('catalog_cache_ms', cacheStart);
  return cloneVentasCacheValue(value);
};

export const fetchCachedVentasStaticRows = async (cacheKey, loader, perf = null) =>
  fetchCachedVentasStaticValue(cacheKey, loader, perf);

const sortSauceOptions = (items) => (
  [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const orderA = Number(left?.orden || 0);
    const orderB = Number(right?.orden || 0);
    if (orderA !== orderB) return orderA - orderB;
    return String(left?.nombre || '').localeCompare(String(right?.nombre || ''), 'es', {
      sensitivity: 'base'
    });
  })
);

const inferSauceUnitsBaseFromText = (...sources) => {
  const text = normalizeSearchText(sources.filter(Boolean).join(' '));
  if (!text) return 1;
  const containsKeyword = WINGS_SAUCE_KEYWORDS.some((keyword) => text.includes(keyword));
  if (!containsKeyword) return 1;
  const match =
    text.match(/\b(\d{1,3})\s*(?:alitas?|tenders?)\b/i) ||
    text.match(/\b(\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\b/i) ||
    text.match(/\((\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\)/i);
  const units = Number(match?.[1] || 0);
  if (!Number.isFinite(units) || units <= 0) return 1;
  return Math.max(1, Math.floor(units));
};

const calculateFallbackWingSauceRequirement = ({ nombre = '', descripcion = '', quantity = 1 }) => {
  const baseUnits = inferSauceUnitsBaseFromText(nombre, descripcion);
  if (baseUnits <= 1) return 0;
  const totalUnits = Math.max(1, Number(quantity || 1)) * baseUnits;
  return Math.max(0, Math.ceil(totalUnits / 6));
};

const findMatchingSalsaRule = (rules, unidades) => {
  const units = Number(unidades);
  if (!Number.isFinite(units) || units <= 0) return null;
  const orderedRules = [...(Array.isArray(rules) ? rules : [])].sort((left, right) => (
    Number(left?.min_unidades || 0) - Number(right?.min_unidades || 0)
  ));
  return orderedRules.find((rule) => {
    const min = Number(rule?.min_unidades || 0);
    const max = rule?.max_unidades === null || rule?.max_unidades === undefined
      ? null
      : Number(rule.max_unidades);
    if (!Number.isFinite(min) || units < min) return false;
    if (max !== null && Number.isFinite(max) && units > max) return false;
    return true;
  }) || null;
};

const buildRecipeSauceRequirement = ({ recipeName = '', recipeDescription = '', rules = [], quantity = 1 }) => {
  const unitsBase = Math.max(1, inferSauceUnitsBaseFromText(recipeName, recipeDescription));
  const units = Math.max(1, Number(quantity || 1)) * unitsBase;
  const rule = findMatchingSalsaRule(rules, units);
  if (rule) {
    return Number(rule?.salsas_requeridas || 0);
  }
  // AM: fallback acotado solo para familias alitas/tenders cuando no hay reglas formales.
  return calculateFallbackWingSauceRequirement({
    nombre: recipeName,
    descripcion: recipeDescription,
    quantity
  });
};

export const resolveRecetaComplementMetadata = ({ receta = {}, quantity = 1, allowedSauces = [], rules = [], fallbackSauces = [] }) => {
  const required = Math.max(0, buildRecipeSauceRequirement({
    recipeName: receta?.nombre_receta,
    recipeDescription: receta?.descripcion,
    rules,
    quantity
  }));
  let available = sortSauceOptions(allowedSauces);
  if (required > 0 && available.length === 0) {
    available = sortSauceOptions(fallbackSauces);
  }
  return {
    requiere_complementos: required > 0,
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    minimo_complementos: required,
    maximo_complementos: required,
    complementos_disponibles: available
  };
};

export const resolveComboComplementMetadata = ({ combo = {}, quantity = 1, components = [], saucesByRecipe = new Map(), rulesByRecipe = new Map(), fallbackSauces = [] }) => {
  const unionSauces = new Map();
  let required = 0;
  for (const component of Array.isArray(components) ? components : []) {
    const idReceta = Number(component?.id_receta || 0);
    if (!idReceta) continue;
    const allowed = saucesByRecipe.get(idReceta) || [];
    for (const sauce of allowed) {
      const key = Number(sauce?.id_salsa || 0);
      if (key > 0) unionSauces.set(key, sauce);
    }
    const rules = rulesByRecipe.get(idReceta) || [];
    const multiplier = Math.max(1, Number(component?.multiplicador || 1));
    required += Math.max(0, buildRecipeSauceRequirement({
      recipeName: component?.nombre_receta,
      recipeDescription: component?.nombre_receta,
      rules,
      quantity: Math.max(1, Number(quantity || 1)) * multiplier
    }));
  }
  let available = sortSauceOptions(Array.from(unionSauces.values()));
  if (required > 0 && available.length === 0) {
    available = sortSauceOptions(fallbackSauces);
  }
  return {
    requiere_complementos: required > 0,
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    minimo_complementos: required,
    maximo_complementos: required,
    complementos_disponibles: available
  };
};

const buildVentaComplementCatalogCacheKey = ({ recipeIds = [], comboIds = [] }) =>
  `complement_context:r=${buildVentasStaticCacheKey('recipes', recipeIds)}:c=${buildVentasStaticCacheKey('combos', comboIds)}`;

const fetchVentaComplementCatalogSnapshot = async (client, { recipeIds = [], comboIds = [] }) => {
  const result = await client.query(
    `
      WITH input AS (
        SELECT $1::int[] AS recipe_ids, $2::int[] AS combo_ids
      ),
      combo_components AS (
        SELECT
          dc.id_combo,
          dc.id_receta,
          GREATEST(COALESCE(dc.cantidad, 1), 1)::int AS multiplicador,
          r.nombre_receta,
          COALESCE(dc.orden, dc.id_detalle_combo) AS orden
        FROM detalle_combo dc
        INNER JOIN recetas r
          ON r.id_receta = dc.id_receta
        CROSS JOIN input i
        WHERE dc.id_combo = ANY(i.combo_ids)
          AND dc.id_receta IS NOT NULL
          AND COALESCE(dc.estado, true) = true
          AND COALESCE(r.estado, true) = true
      ),
      all_recipe_ids AS (
        SELECT DISTINCT id_receta
        FROM (
          SELECT UNNEST((SELECT recipe_ids FROM input)) AS id_receta
          UNION ALL
          SELECT id_receta FROM combo_components
        ) recipes
        WHERE id_receta IS NOT NULL
      ),
      allowed_sauces AS (
        SELECT
          rs.id_receta,
          s.id_salsa,
          s.nombre,
          s.nivel_picante,
          s.orden,
          COALESCE(s.estado, true) AS disponible
        FROM receta_salsa rs
        INNER JOIN salsas s
          ON s.id_salsa = rs.id_salsa
        INNER JOIN all_recipe_ids ari
          ON ari.id_receta = rs.id_receta
        WHERE COALESCE(rs.estado, true) = true
      ),
      sauce_rules AS (
        SELECT
          rsr.id_regla,
          rsr.id_receta,
          rsr.min_unidades,
          rsr.max_unidades,
          rsr.salsas_requeridas
        FROM reglas_salsas_receta rsr
        INNER JOIN all_recipe_ids ari
          ON ari.id_receta = rsr.id_receta
        WHERE COALESCE(rsr.estado, true) = true
      )
      SELECT
        COALESCE((
          SELECT jsonb_agg(to_jsonb(cc) - 'orden' ORDER BY cc.id_combo, cc.orden)
          FROM combo_components cc
        ), '[]'::jsonb) AS combo_components,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(sa) ORDER BY sa.id_receta, sa.orden, sa.nombre)
          FROM allowed_sauces sa
        ), '[]'::jsonb) AS allowed_sauces,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.id_receta, sr.min_unidades, sr.max_unidades NULLS LAST, sr.id_regla)
          FROM sauce_rules sr
        ), '[]'::jsonb) AS sauce_rules
    `,
    [recipeIds, comboIds]
  );
  const row = result.rows?.[0] || {};
  return {
    comboComponents: Array.isArray(row.combo_components) ? row.combo_components : [],
    allowedSauces: Array.isArray(row.allowed_sauces) ? row.allowed_sauces : [],
    sauceRules: Array.isArray(row.sauce_rules) ? row.sauce_rules : []
  };
};

export const buildVentaComplementContext = async ({ client, normalizedItems, perf = null, recetaMap = new Map() }) => {
  const complementosStart = perf?.now?.() || 0;
  const recipeIds = [...new Set(
    (Array.isArray(normalizedItems) ? normalizedItems : [])
      .filter((item) => item.kind === 'RECETA')
      .map((item) => Number(item.id_receta || 0))
      .filter((id) => id > 0)
  )];
  const comboIds = [...new Set(
    (Array.isArray(normalizedItems) ? normalizedItems : [])
      .filter((item) => item.kind === 'COMBO')
      .map((item) => Number(item.id_combo || 0))
      .filter((id) => id > 0)
  )];

  try {
    if (recipeIds.length === 0 && comboIds.length === 0) {
      return {
        saucesByRecipe: new Map(),
        rulesByRecipe: new Map(),
        comboComponentsByCombo: new Map(),
        fallbackSauces: []
      };
    }

    const catalogPrefetchStart = perf?.now?.() || 0;
    const complementSnapshot = await measureVentasPerf(
      perf,
      'catalog_prefetch_ms',
      () => fetchCachedVentasStaticValue(
        buildVentaComplementCatalogCacheKey({ recipeIds, comboIds }),
        () => fetchVentaComplementCatalogSnapshot(client, { recipeIds, comboIds }),
        perf
      )
    );
    if (comboIds.length > 0) {
      perf?.add?.('totals_combo_components_ms', catalogPrefetchStart);
      perf?.add?.('totals_combos_ms', catalogPrefetchStart);
    }
    if ((complementSnapshot.allowedSauces || []).length > 0 || recipeIds.length > 0 || comboIds.length > 0) {
      perf?.add?.('totals_allowed_sauces_ms', catalogPrefetchStart);
      perf?.add?.('totals_sauce_rules_ms', catalogPrefetchStart);
    }
    const comboComponents = Array.isArray(complementSnapshot.comboComponents)
      ? complementSnapshot.comboComponents
      : [];
    const allowedSauceRows = Array.isArray(complementSnapshot.allowedSauces)
      ? complementSnapshot.allowedSauces
      : [];
    const sauceRuleRows = Array.isArray(complementSnapshot.sauceRules)
      ? complementSnapshot.sauceRules
      : [];

    const saucesByRecipe = new Map();
    for (const row of allowedSauceRows) {
      const recipeId = Number(row?.id_receta || 0);
      if (!recipeId) continue;
      if (!saucesByRecipe.has(recipeId)) saucesByRecipe.set(recipeId, []);
      saucesByRecipe.get(recipeId).push({
        id_complemento: Number(row.id_salsa),
        id_salsa: Number(row.id_salsa),
        nombre: String(row.nombre || 'Salsa').trim(),
        nivel_picante: Number(row.nivel_picante || 0),
        orden: Number(row.orden || 0),
        disponible: row.disponible !== false
      });
    }

    const rulesByRecipe = new Map();
    for (const row of sauceRuleRows) {
      const recipeId = Number(row?.id_receta || 0);
      if (!recipeId) continue;
      if (!rulesByRecipe.has(recipeId)) rulesByRecipe.set(recipeId, []);
      rulesByRecipe.get(recipeId).push({
        min_unidades: Number(row?.min_unidades || 0),
        max_unidades:
          row?.max_unidades === null || row?.max_unidades === undefined ? null : Number(row.max_unidades),
        salsas_requeridas: Number(row?.salsas_requeridas || 0)
      });
    }

    const comboComponentsByCombo = new Map();
    for (const row of comboComponents) {
      const comboId = Number(row?.id_combo || 0);
      if (!comboId) continue;
      if (!comboComponentsByCombo.has(comboId)) comboComponentsByCombo.set(comboId, []);
      comboComponentsByCombo.get(comboId).push({
        id_receta: Number(row?.id_receta || 0),
        multiplicador: Math.max(1, Number(row?.multiplicador || 1)),
        nombre_receta: String(row?.nombre_receta || '').trim()
      });
    }

    let needsFallbackSauces = false;
    for (const item of Array.isArray(normalizedItems) ? normalizedItems : []) {
      if (item.kind === 'RECETA') {
        const recipeId = Number(item.id_receta || 0);
        const receta = recetaMap.get(recipeId) || {};
        const allowed = saucesByRecipe.get(recipeId) || [];
        const rules = rulesByRecipe.get(recipeId) || [];
        const required = Math.max(0, buildRecipeSauceRequirement({
          recipeName: receta?.nombre_receta,
          recipeDescription: receta?.descripcion,
          rules,
          quantity: item.cantidad
        }));
        if (required > 0 && allowed.length === 0) {
          needsFallbackSauces = true;
          break;
        }
      }

      if (item.kind === 'COMBO') {
        const components = comboComponentsByCombo.get(Number(item.id_combo || 0)) || [];
        const unionSauces = new Map();
        let required = 0;
        for (const component of components) {
          const idReceta = Number(component?.id_receta || 0);
          if (!idReceta) continue;
          for (const sauce of saucesByRecipe.get(idReceta) || []) {
            const key = Number(sauce?.id_salsa || 0);
            if (key > 0) unionSauces.set(key, sauce);
          }
          const rules = rulesByRecipe.get(idReceta) || [];
          const multiplier = Math.max(1, Number(component?.multiplicador || 1));
          required += Math.max(0, buildRecipeSauceRequirement({
            recipeName: component?.nombre_receta,
            recipeDescription: component?.nombre_receta,
            rules,
            quantity: Math.max(1, Number(item.cantidad || 1)) * multiplier
          }));
        }
        if (required > 0 && unionSauces.size === 0) {
          needsFallbackSauces = true;
          break;
        }
      }
    }

    const fallbackSauces = needsFallbackSauces
      ? await measureVentasPerf(
        perf,
        'totals_allowed_sauces_ms',
        () => fetchCachedVentasStaticRows(
          'active_sauces',
          () => fetchPublicActiveSaucesQuery(client),
          perf
        )
      )
      : [];
    const normalizedFallbackSauces = sortSauceOptions((Array.isArray(fallbackSauces) ? fallbackSauces : []).map((row) => ({
      id_complemento: Number(row.id_salsa),
      id_salsa: Number(row.id_salsa),
      nombre: String(row.nombre || 'Salsa').trim(),
      nivel_picante: Number(row.nivel_picante || 0),
      orden: Number(row.orden || 0),
      disponible: true
    })));

    return {
      saucesByRecipe,
      rulesByRecipe,
      comboComponentsByCombo,
      fallbackSauces: normalizedFallbackSauces
    };
  } finally {
    perf?.add?.('totals_complementos_ms', complementosStart);
  }
};
