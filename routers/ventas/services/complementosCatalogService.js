import {
  VENTA_COMPLEMENTO_TIPO_SALSAS,
  WINGS_SAUCE_KEYWORDS
} from '../constants.js';
import { normalizeSearchText } from '../utils/parseUtils.js';
import { measureVentasPerf } from '../utils/perfUtils.js';
import {
  fetchPublicActiveSaucesQuery
} from '../../public_menu/publicMenuQueries.js';
import { resolveSalsasInventory } from './salsasInventoryService.js';
import { clearVentasCajaBootstrapCache } from './cajaBootstrapCacheService.js';

const getVentasCatalogCacheTtlMs = () => {
  const rawValue = process.env.VENTAS_CATALOG_CACHE_TTL_MS;
  const defaultValue = process.env.NODE_ENV === 'production' ? '0' : '30000';
  const parsed = Number.parseInt(rawValue === undefined || rawValue === null || String(rawValue).trim() === '' ? defaultValue : rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isVentasCatalogCacheEnabled = () =>
  getVentasCatalogCacheTtlMs() > 0;

const ventasStaticComplementCache = new Map();

export const clearVentasComplementCatalogCache = () => {
  ventasStaticComplementCache.clear();
  clearVentasCajaBootstrapCache();
};

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

const calculateFallbackWingSauceRequirement = ({ nombre = '', descripcion = '' }) => {
  const baseUnits = inferSauceUnitsBaseFromText(nombre, descripcion);
  if (baseUnits <= 1) return 0;
  return Math.max(0, Math.ceil(baseUnits / 6));
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

const validateSalsaRules = (rules = []) => {
  const orderedRules = [...(Array.isArray(rules) ? rules : [])]
    .map((rule) => ({
      min: Number(rule?.min_unidades || 0),
      max: rule?.max_unidades === null || rule?.max_unidades === undefined ? null : Number(rule.max_unidades),
      required: Number(rule?.salsas_requeridas || 0)
    }))
    .sort((left, right) => left.min - right.min || Number(left.max || 0) - Number(right.max || 0));

  for (let index = 0; index < orderedRules.length; index += 1) {
    const current = orderedRules[index];
    if (!Number.isFinite(current.min) || current.min <= 0) {
      return {
        ok: false,
        code: 'VENTAS_REGLA_SALSA_CONFIGURACION_INVALIDA',
        message: 'Existe una regla de salsas con minimo invalido.'
      };
    }
    if (current.max !== null && (!Number.isFinite(current.max) || current.max < current.min)) {
      return {
        ok: false,
        code: 'VENTAS_REGLA_SALSA_CONFIGURACION_INVALIDA',
        message: 'Existe una regla de salsas con rango invalido.'
      };
    }
    if (!Number.isFinite(current.required) || current.required < 0) {
      return {
        ok: false,
        code: 'VENTAS_REGLA_SALSA_CONFIGURACION_INVALIDA',
        message: 'Existe una regla de salsas con cantidad requerida invalida.'
      };
    }
    const next = orderedRules[index + 1];
    if (!next) continue;
    const currentMax = current.max === null ? Number.POSITIVE_INFINITY : current.max;
    if (current.min === next.min && currentMax === (next.max === null ? Number.POSITIVE_INFINITY : next.max)) {
      return {
        ok: false,
        code: 'VENTAS_REGLA_SALSA_AMBIGUA',
        message: 'Existen reglas de salsas duplicadas para la receta.'
      };
    }
    if (currentMax >= next.min) {
      return {
        ok: false,
        code: 'VENTAS_REGLA_SALSA_AMBIGUA',
        message: 'Existen reglas de salsas traslapadas para la receta.'
      };
    }
  }

  return { ok: true };
};

const buildRecipeSauceRequirement = ({ recipeName = '', recipeDescription = '', rules = [] }) => {
  const unitsBase = Math.max(1, inferSauceUnitsBaseFromText(recipeName, recipeDescription));
  const rulesValidation = validateSalsaRules(rules);
  if (!rulesValidation.ok) {
    return {
      ok: false,
      code: rulesValidation.code,
      message: rulesValidation.message,
      required: 0
    };
  }
  const rule = findMatchingSalsaRule(rules, unitsBase);
  if (rule) {
    return { ok: true, required: Number(rule?.salsas_requeridas || 0) };
  }
  if (Array.isArray(rules) && rules.length > 0) {
    return {
      ok: false,
      code: 'VENTAS_REGLA_SALSA_NO_CONFIGURADA',
      message: `La receta ${recipeName || 'seleccionada'} no tiene una regla de salsas configurada para ${unitsBase} unidades.`,
      required: 0
    };
  }
  // AM: fallback acotado solo para familias alitas/tenders cuando no hay reglas formales.
  return {
    ok: true,
    required: calculateFallbackWingSauceRequirement({
      nombre: recipeName,
      descripcion: recipeDescription
    })
  };
};

export const validateComplementSelectionBounds = ({
  selectedCount = 0,
  minimo = 0,
  maximo = 0,
  allowIncomplete = false,
  nombreItem = 'este item'
} = {}) => {
  const count = Math.max(0, Number(selectedCount || 0));
  const min = Math.max(0, Number(minimo || 0));
  const max = Math.max(min, Number(maximo || 0));

  if (max > 0 && count > max) {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_COMPLEMENTOS_EXCEDIDOS',
      message: `No puedes seleccionar mas de ${max} complemento(s) para ${nombreItem || 'este item'}.`
    };
  }

  if (min > 0 && count < min && allowIncomplete !== true) {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_COMPLEMENTOS_INCOMPLETOS',
      message: `Debes seleccionar al menos ${min} complemento(s) para ${nombreItem || 'este item'}.`
    };
  }

  return { ok: true };
};

export const resolveRecetaComplementMetadata = ({ receta = {}, quantity = 1, allowedSauces = [], rules = [], fallbackSauces = [] }) => {
  const requirement = buildRecipeSauceRequirement({
    recipeName: receta?.nombre_receta,
    recipeDescription: receta?.descripcion,
    rules,
    quantity
  });
  if (!requirement.ok) {
    return {
      ok: false,
      code: requirement.code,
      message: requirement.message,
      requiere_complementos: false,
      tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
      minimo_complementos: 0,
      maximo_complementos: 0,
      complementos_disponibles: []
    };
  }
  const required = Math.max(0, Number(requirement.required || 0));
  let available = sortSauceOptions(allowedSauces);
  if (required > 0 && available.length === 0) {
    available = sortSauceOptions(fallbackSauces);
  }
  return {
    ok: true,
    requiere_complementos: required > 0,
    tipo_complemento: VENTA_COMPLEMENTO_TIPO_SALSAS,
    minimo_complementos: required,
    maximo_complementos: required,
    complementos_disponibles: available
  };
};

export const buildVentaComplementCatalogCacheKey = ({ recipeIds = [], idSucursal }) =>
  `complement_context:s=${Number(idSucursal)}:r=${buildVentasStaticCacheKey('recipes', recipeIds)}`;

const fetchVentaComplementCatalogSnapshot = async (client, { recipeIds = [], idSucursal }) => {
  const result = await client.query(
    `
      WITH all_recipe_ids AS (
        SELECT DISTINCT UNNEST($1::int[]) AS id_receta
      ),
      allowed_sauces AS (
        SELECT
          rs.id_receta,
          s.id_salsa,
          s.nombre,
          s.nivel_picante,
          s.orden,
          s.id_insumo,
          s.cantidad_porcion,
          s.id_unidad_consumo,
          COALESCE(s.estado, true) AS disponible
        FROM receta_salsa rs
        INNER JOIN salsas s ON s.id_salsa = rs.id_salsa
        INNER JOIN all_recipe_ids ari ON ari.id_receta = rs.id_receta
        INNER JOIN public.salsa_sucursales ss
          ON ss.id_salsa = s.id_salsa
         AND ss.id_sucursal = $2
         AND ss.estado IS TRUE
         AND ss.publicada IS TRUE
        WHERE COALESCE(rs.estado, true) = true
          AND COALESCE(s.estado, true) = true
      ),
      sauce_rules AS (
        SELECT
          rsr.id_regla,
          rsr.id_receta,
          rsr.min_unidades,
          rsr.max_unidades,
          rsr.salsas_requeridas
        FROM reglas_salsas_receta rsr
        INNER JOIN all_recipe_ids ari ON ari.id_receta = rsr.id_receta
        WHERE COALESCE(rsr.estado, true) = true
      )
      SELECT
        COALESCE((
          SELECT jsonb_agg(to_jsonb(sa) ORDER BY sa.id_receta, sa.orden, sa.nombre)
          FROM allowed_sauces sa
        ), '[]'::jsonb) AS allowed_sauces,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(sr) ORDER BY sr.id_receta, sr.min_unidades, sr.max_unidades NULLS LAST, sr.id_regla)
          FROM sauce_rules sr
        ), '[]'::jsonb) AS sauce_rules
    `,
    [recipeIds, idSucursal]
  );
  const row = result.rows?.[0] || {};
  return {
    allowedSauces: Array.isArray(row.allowed_sauces) ? row.allowed_sauces : [],
    sauceRules: Array.isArray(row.sauce_rules) ? row.sauce_rules : []
  };
};

export const buildVentaComplementContext = async ({ client, normalizedItems, idSucursal, perf = null, recetaMap = new Map() }) => {
  const complementosStart = perf?.now?.() || 0;
  const recipeIds = [...new Set(
    (Array.isArray(normalizedItems) ? normalizedItems : [])
      .filter((item) => item.kind === 'RECETA')
      .map((item) => Number(item.id_receta || 0))
      .filter((id) => id > 0)
  )];
  const branchId = Number(idSucursal);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new TypeError('idSucursal es requerido para construir el catalogo de salsas.');
  }

  try {
    if (recipeIds.length === 0) {
      return {
        saucesByRecipe: new Map(),
        rulesByRecipe: new Map(),
        fallbackSauces: []
      };
    }

    const catalogPrefetchStart = perf?.now?.() || 0;
    const complementSnapshot = await measureVentasPerf(
      perf,
      'catalog_prefetch_ms',
      () => fetchCachedVentasStaticValue(
        buildVentaComplementCatalogCacheKey({ recipeIds, idSucursal: branchId }),
        () => fetchVentaComplementCatalogSnapshot(client, { recipeIds, idSucursal: branchId }),
        perf
      )
    );
    if ((complementSnapshot.allowedSauces || []).length > 0 || recipeIds.length > 0) {
      perf?.add?.('totals_allowed_sauces_ms', catalogPrefetchStart);
      perf?.add?.('totals_sauce_rules_ms', catalogPrefetchStart);
    }
    const rawAllowedSauceRows = Array.isArray(complementSnapshot.allowedSauces)
      ? complementSnapshot.allowedSauces
      : [];
    const uniqueAllowed = [...new Map(rawAllowedSauceRows.map((row) => [Number(row.id_salsa), row])).values()];
    const availableAllowed = await resolveSalsasInventory({
      queryRunner: client,
      salsas: uniqueAllowed,
      idSucursal: branchId,
      mode: 'catalog'
    });
    const availableIds = new Set(availableAllowed.filter((row) => row.disponible).map((row) => Number(row.id_salsa)));
    const allowedSauceRows = rawAllowedSauceRows.filter((row) => availableIds.has(Number(row.id_salsa)));
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

    let needsFallbackSauces = false;
    for (const item of Array.isArray(normalizedItems) ? normalizedItems : []) {
      if (item.kind === 'RECETA') {
        const recipeId = Number(item.id_receta || 0);
        const receta = recetaMap.get(recipeId) || {};
        const allowed = saucesByRecipe.get(recipeId) || [];
        const rules = rulesByRecipe.get(recipeId) || [];
        const requirement = buildRecipeSauceRequirement({
          recipeName: receta?.nombre_receta,
          recipeDescription: receta?.descripcion,
          rules,
          quantity: item.cantidad
        });
        const required = requirement.ok ? Math.max(0, Number(requirement.required || 0)) : 0;
        if (required > 0 && allowed.length === 0) {
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
          `active_sauces:s=${branchId}`,
          () => fetchPublicActiveSaucesQuery(branchId, client),
          perf
        )
      )
      : [];
    const resolvedFallbackSauces = await resolveSalsasInventory({
      queryRunner: client,
      salsas: Array.isArray(fallbackSauces) ? fallbackSauces : [],
      idSucursal: branchId,
      mode: 'catalog'
    });
    const normalizedFallbackSauces = sortSauceOptions(resolvedFallbackSauces.filter((row) => row.disponible).map((row) => ({
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
      fallbackSauces: normalizedFallbackSauces
    };
  } finally {
    perf?.add?.('totals_complementos_ms', complementosStart);
  }
};
