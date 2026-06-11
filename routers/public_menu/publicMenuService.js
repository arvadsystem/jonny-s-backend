import pool from '../../config/db-connection.js';
import { createHash } from 'crypto';
import { buildAbsolutePublicUrl } from '../../utils/uploads.js';
import {
  PUBLIC_ITEM_TYPES,
  acquirePublicOrderIdempotencyLockQuery,
  fetchActiveMenuByBranchQuery,
  fetchAllowedSauceRowsByRecipeIdsQuery,
  fetchCatalogItemByIdQuery,
  fetchCatalogRowsByMenuQuery,
  fetchComboRecipeComponentsQuery,
  fetchComboAvailabilityQuery,
  fetchEstadoPedidoRowsQuery,
  fetchPublicActiveSaucesQuery,
  fetchPedidoByIdempotencyKeyQuery,
  fetchPublicBranchAvailabilityByIdQuery,
  fetchPublicBranchesQuery,
  fetchPublicMenuExtrasByRecipeIdsQuery,
  fetchRecipeAvailabilityQuery,
  fetchSauceRuleRowsByRecipeIdsQuery,
  insertPublicPedidoDetalleQuery,
  insertPublicPedidoQuery
} from './publicMenuQueries.js';
import { getPublicMenuHeroCarouselConfig } from '../../services/publicMenuHeroCarouselConfigService.js';

// Tabla de mensajes legibles para no exponer codigos internos al frontend.
const AVAILABILITY_REASON_LABEL = Object.freeze({
  ITEM_INACTIVO: 'No disponible en este momento.',
  STOCK_INSUFICIENTE: 'Agotado por stock minimo.',
  RECETA_INACTIVA: 'Receta inactiva.',
  RECETA_SIN_DETALLE: 'Receta sin configuracion de insumos.',
  INSUMOS_INSUFICIENTES: 'Agotado por falta de insumos.',
  COMBO_INACTIVO: 'Combo inactivo.',
  COMBO_SIN_COMPONENTES: 'Combo sin recetas asociadas.',
  COMPONENTES_NO_DISPONIBLES: 'Combo agotado por componentes no disponibles.',
  SIN_PRECIO: 'Item sin precio configurado.'
});

const SERVICE_TYPE_BY_ORDER_TYPE = Object.freeze({
  'dine-in': 'LOCAL',
  pickup: 'PARA_LLEVAR',
  delivery: 'DELIVERY'
});
const DELIVERY_TYPE_BY_ORDER_TYPE = Object.freeze({
  'dine-in': 'LOCAL',
  pickup: 'RECOGER',
  delivery: 'DELIVERY'
});
const INITIAL_ORDER_PAYMENT_STATE = 'PENDIENTE_VALIDACION';
const ORDER_PAYMENT_VALIDATION_WINDOW_MINUTES = 10;

const ORDER_STATE_ALIASES = Object.freeze([
  'pendiente',
  'pendientes',
  'pendiente_/_por_pagar',
  'pendientes_/_por_pagar',
  'por_pagar',
  'pendiente_por_pagar'
]);
const HAMBURGUESA_KEYWORDS = Object.freeze(['hamburguesa', 'burger', 'smash']);
const PUBLIC_EXTRA_OPTIONS = Object.freeze([
  {
    id_extra: 'hamb-extra-bacon',
    codigo: 'extra_bacon',
    nombre: 'Extra bacon',
    precio_adicional: 30,
    keywords: HAMBURGUESA_KEYWORDS
  }
]);
const ORDER_TYPES_REQUIRING_TRANSFER_PROOF = new Set(['delivery']);
const TRANSFER_METHOD_ALIASES = new Set(['transferencia', 'transferencia_bancaria', 'transfer']);
const CASH_METHOD_ALIASES = new Set(['caja', 'efectivo', 'cash']);
const MAX_PUBLIC_ORDER_DESCRIPTION_LENGTH = 240;
const MAX_PUBLIC_ITEM_NOTE_LENGTH = 100;
const MAX_PUBLIC_ORDER_IDEMPOTENCY_LENGTH = 120;
const WINGS_SAUCE_KEYWORDS = Object.freeze(['alita', 'alitas', 'tender', 'tenders']);
const LEGACY_GOOGLE_IMAGE_RE = /(?:drive\.google\.com|drive\.usercontent\.google\.com|googleusercontent\.com)/i;

// Crea errores HTTP controlados para que el controlador responda con status consistente.
const buildHttpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const normalizeCompactText = (value, maxLength = 120) => {
  const clean = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!clean) return '';
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 120;
  return clean.slice(0, limit);
};

const normalizeIdempotencyKey = (value) =>
  normalizeCompactText(value, MAX_PUBLIC_ORDER_IDEMPOTENCY_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '');

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const resolvePublicCatalogImageUrl = (rawUrl) => {
  const value = String(rawUrl || '').trim();
  if (!value || LEGACY_GOOGLE_IMAGE_RE.test(value)) return '';
  return buildAbsolutePublicUrl(null, value) || value;
};

const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const inferSauceUnitsBaseFromText = (...sources) => {
  const text = normalizeSearchText(sources.filter(Boolean).join(' '));
  if (!text) return 1;

  // Regla de negocio: solo aplicamos inferencia por texto para familias de alitas/tenders.
  const containsKeyword = WINGS_SAUCE_KEYWORDS.some((keyword) => text.includes(keyword));
  if (!containsKeyword) return 1;

  // Prioriza patrones comunes del negocio: "24 uds", "24 piezas", "24 pzas".
  const match =
    text.match(/\b(\d{1,3})\s*(?:alitas?|tenders?)\b/i) ||
    text.match(/\b(\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\b/i) ||
    text.match(/\((\d{1,3})\s*(?:uds?|unidades?|pzas?|piezas?)\)/i);

  const units = Number(match?.[1] || 0);
  if (!Number.isFinite(units) || units <= 0) return 1;
  return Math.max(1, Math.floor(units));
};

const calculateFallbackWingSauceRequirement = ({
  nombre = '',
  descripcion = '',
  quantity = 1
}) => {
  const baseUnits = inferSauceUnitsBaseFromText(nombre, descripcion);
  if (baseUnits <= 1) return 0;
  const totalUnits = Math.max(1, Number(quantity || 1)) * baseUnits;
  return Math.max(0, Math.ceil(totalUnits / 6));
};

const resolveRequiredSaucesByCatalog = ({ catalog = {}, quantity = 1 }) => {
  const fromComponents = calculateRequiredSaucesForQuantity(catalog?.salsas_componentes, quantity);
  if (fromComponents > 0) return fromComponents;
  return calculateFallbackWingSauceRequirement({
    nombre: catalog?.nombre,
    descripcion: catalog?.descripcion,
    quantity
  });
};

const hasAnyKeyword = (rawText, keywords = []) => {
  const source = normalizeSearchText(rawText);
  if (!source) return false;
  return keywords.some((keyword) => source.includes(normalizeSearchText(keyword)));
};

const toUniquePositiveIntArray = (values = []) => (
  [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
);

// Convierte numeros de BD a Number JS cuidando null.
const toNumberOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
};

const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const buildTicketNumber = (idPedido) => `VTA-${String(idPedido).padStart(5, '0')}`;

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

const hasSauceRequirementRules = (rules = []) =>
  (Array.isArray(rules) ? rules : []).some((rule) => Number(rule?.salsas_requeridas || 0) > 0);

const calculateRequiredSaucesForQuantity = (components, quantity = 1) => (
  (Array.isArray(components) ? components : []).reduce((total, component) => {
    const multiplier = Math.max(1, Number(component?.multiplicador || 1));
    const baseUnits = Math.max(1, Number(component?.unidades_base || 1));
    const units = Math.max(1, Number(quantity || 1)) * multiplier * baseUnits;
    const rule = findMatchingSalsaRule(component?.reglas, units);
    return total + Number(rule?.salsas_requeridas || 0);
  }, 0)
);

// Normaliza booleans provenientes de PG.
const toBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

const normalizeTimeValue = (value) => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
};

const formatTimeLabel = (value) => {
  const normalized = normalizeTimeValue(value);
  if (!normalized) return '';
  const [hourText, minuteText] = normalized.split(':');
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) return normalized;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minuteText} ${suffix}`;
};

const buildBranchScheduleLabel = ({ opensAt, closesAt }) => {
  const openLabel = formatTimeLabel(opensAt);
  const closeLabel = formatTimeLabel(closesAt);
  if (!openLabel || !closeLabel) return '';
  return `${openLabel} - ${closeLabel}`;
};

const buildBranchClosedReason = ({
  isActive,
  opensAt,
  closesAt,
  hasConfiguredSchedule = false,
  isClosedByOperationalConfig = false
}) => {
  if (!isActive) return 'Sucursal no disponible';
  const schedule = buildBranchScheduleLabel({ opensAt, closesAt });
  if (!schedule && hasConfiguredSchedule && isClosedByOperationalConfig) {
    return 'Sucursal cerrada por horario configurado';
  }
  if (!schedule) return '';
  return `Disponible de ${schedule}`;
};

// Convierte filas de sucursales al contrato publico.
const mapBranch = (row) => {
  const isActive = toBoolean(row?.estado);
  const opensAt = normalizeTimeValue(row?.hora_inicio);
  const closesAt = normalizeTimeValue(row?.hora_final);
  const hasSchedule = Boolean(opensAt && closesAt);
  const hasConfiguredSchedule = toBoolean(row?.horario_operativo_configurado);
  const isClosedByOperationalConfig = toBoolean(row?.cerrado_operativo);
  const isOpen = isActive && (hasConfiguredSchedule ? toBoolean(row?.abierto_por_horario) : true);
  const schedule = buildBranchScheduleLabel({ opensAt, closesAt }) || (
    hasConfiguredSchedule && isClosedByOperationalConfig ? 'Cerrado hoy' : 'Horario por confirmar'
  );

  return {
    id: Number(row.id_sucursal),
    name: row.nombre_sucursal,
    address: row.direccion || 'Direccion no disponible',
    isActive,
    isOpen,
    acceptsOrders: isOpen,
    opensAt,
    closesAt,
    schedule,
    statusLabel: isOpen ? (hasSchedule ? 'Abierto ahora' : 'Disponible') : 'Cerrado',
    closedReason: isOpen
      ? ''
      : buildBranchClosedReason({
        isActive,
        opensAt,
        closesAt,
        hasConfiguredSchedule,
        isClosedByOperationalConfig
      })
  };
};

const assertBranchAcceptsPublicOrders = async (idSucursal) => {
  const branchRow = await fetchPublicBranchAvailabilityByIdQuery(idSucursal);
  if (!branchRow) {
    throw buildHttpError(404, 'La sucursal seleccionada no existe.');
  }

  const branch = mapBranch(branchRow);
  if (!branch.isActive) {
    throw buildHttpError(409, 'La sucursal seleccionada no esta disponible para pedidos.');
  }

  if (!branch.isOpen) {
    const detail = branch.closedReason ? ` ${branch.closedReason}.` : '';
    throw buildHttpError(409, `La sucursal esta cerrada en este momento.${detail}`);
  }

  return branch;
};

const normalizeExtraOption = (option) => ({
  id_extra: String(option?.id_extra || '').trim(),
  codigo: String(option?.codigo || '').trim(),
  nombre: String(option?.nombre || 'Extra').trim(),
  precio_adicional: roundMoney(option?.precio_adicional || 0)
});

const getFallbackCatalogItemExtraOptions = ({ nombre, descripcion, categoriaNombre, tipoItem }) => {
  if (String(tipoItem || '') !== PUBLIC_ITEM_TYPES.RECETA) {
    return [];
  }

  const safeName = String(nombre || '').trim();
  const safeDescription = String(descripcion || '').trim();
  const safeCategory = String(categoriaNombre || '').trim();

  return PUBLIC_EXTRA_OPTIONS
    .filter((option) => (
      hasAnyKeyword(safeName, option.keywords) ||
      hasAnyKeyword(safeDescription, option.keywords) ||
      hasAnyKeyword(safeCategory, option.keywords)
    ))
    .map(normalizeExtraOption);
};

const buildCatalogExtrasByRecipe = async (catalogRows = [], db = pool) => {
  const recipeIds = toUniquePositiveIntArray(
    catalogRows
      .filter((row) => String(row?.tipo_item || '') === PUBLIC_ITEM_TYPES.RECETA)
      .map((row) => row?.id_receta)
  );

  const rows = await fetchPublicMenuExtrasByRecipeIdsQuery(recipeIds, db);
  const grouped = new Map();

  rows.forEach((row) => {
    const idReceta = Number(row?.id_receta || 0);
    if (!idReceta) return;
    const extra = normalizeExtraOption(row);
    if (!extra.id_extra) return;
    if (!grouped.has(idReceta)) grouped.set(idReceta, []);
    grouped.get(idReceta).push(extra);
  });

  return grouped;
};

const buildCatalogSauceConfigByDetail = async (catalogRows = [], db = pool) => {
  const directRecipeIds = toUniquePositiveIntArray(
    catalogRows.map((row) => row?.id_receta)
  );
  const comboIds = toUniquePositiveIntArray(
    catalogRows.map((row) => row?.id_combo)
  );

  const comboComponentRows = comboIds.length > 0
    ? await fetchComboRecipeComponentsQuery(comboIds, db)
    : [];

  const allRecipeIds = toUniquePositiveIntArray([
    ...directRecipeIds,
    ...comboComponentRows.map((row) => row?.id_receta)
  ]);

  const [allowedSauceRows, sauceRuleRows] = allRecipeIds.length > 0
    ? await Promise.all([
      fetchAllowedSauceRowsByRecipeIdsQuery(allRecipeIds, db),
      fetchSauceRuleRowsByRecipeIdsQuery(allRecipeIds, db)
    ])
    : [[], []];
  const fallbackSauceCatalog = allRecipeIds.length > 0
    ? await fetchPublicActiveSaucesQuery(db)
    : [];

  const allowedSaucesByRecipe = new Map();
  for (const row of allowedSauceRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!allowedSaucesByRecipe.has(recipeId)) {
      allowedSaucesByRecipe.set(recipeId, []);
    }
    allowedSaucesByRecipe.get(recipeId).push({
      id_salsa: Number(row.id_salsa),
      nombre: row.nombre,
      nivel_picante: Number(row.nivel_picante || 0),
      orden: Number(row.orden || 0),
      disponible: Boolean(row?.disponible ?? true)
    });
  }

  const rulesByRecipe = new Map();
  for (const row of sauceRuleRows) {
    const recipeId = Number(row?.id_receta || 0);
    if (!rulesByRecipe.has(recipeId)) {
      rulesByRecipe.set(recipeId, []);
    }
    rulesByRecipe.get(recipeId).push({
      id_regla: Number(row.id_regla),
      min_unidades: Number(row.min_unidades || 0),
      max_unidades: row.max_unidades === null || row.max_unidades === undefined
        ? null
        : Number(row.max_unidades),
      salsas_requeridas: Number(row.salsas_requeridas || 0)
    });
  }

  const comboComponentsById = new Map();
  for (const row of comboComponentRows) {
    const comboId = Number(row?.id_combo || 0);
    const recipeId = Number(row?.id_receta || 0);
    if (!comboComponentsById.has(comboId)) {
      comboComponentsById.set(comboId, []);
    }

    comboComponentsById.get(comboId).push({
      id_receta: recipeId,
      nombre_receta: row.nombre_receta,
      multiplicador: Math.max(1, Number(row?.multiplicador || 1)),
      // Base de unidades por componente (ej. alitas 6/12/24) para reglas de salsas.
      unidades_base: inferSauceUnitsBaseFromText(row?.nombre_receta),
      salsas_permitidas: (() => {
        const rules = rulesByRecipe.get(recipeId) || [];
        const recipeAllowedSauces = allowedSaucesByRecipe.get(recipeId) || [];
        if (recipeAllowedSauces.length === 0 && hasSauceRequirementRules(rules)) {
          return sortSauceOptions(fallbackSauceCatalog);
        }
        return sortSauceOptions(recipeAllowedSauces);
      })(),
      reglas: rulesByRecipe.get(recipeId) || []
    });
  }

  const configByDetail = new Map();

  for (const row of catalogRows) {
    const idDetalleMenu = Number(row?.id_detalle_menu || 0);
    if (!idDetalleMenu) continue;

    let salsasComponentes = [];
    if (Number(row?.id_receta || 0) > 0) {
      const recipeId = Number(row.id_receta);
      salsasComponentes = [{
        id_receta: recipeId,
        nombre_receta: row.nombre_item || row.descripcion_item || 'Receta',
        multiplicador: 1,
        // Base de unidades para items directos (alitas/tenders) segun nombre/descripcion.
        unidades_base: inferSauceUnitsBaseFromText(row?.nombre_item, row?.descripcion_item),
        salsas_permitidas: (() => {
          const rules = rulesByRecipe.get(recipeId) || [];
          const recipeAllowedSauces = allowedSaucesByRecipe.get(recipeId) || [];
          if (recipeAllowedSauces.length === 0 && hasSauceRequirementRules(rules)) {
            return sortSauceOptions(fallbackSauceCatalog);
          }
          return sortSauceOptions(recipeAllowedSauces);
        })(),
        reglas: rulesByRecipe.get(recipeId) || []
      }];
    } else if (Number(row?.id_combo || 0) > 0) {
      salsasComponentes = comboComponentsById.get(Number(row.id_combo)) || [];
    }

    const unionSauces = new Map();
    for (const component of salsasComponentes) {
      for (const sauce of component.salsas_permitidas || []) {
        unionSauces.set(Number(sauce.id_salsa), sauce);
      }
    }

    const requiredFromRules = calculateRequiredSaucesForQuantity(salsasComponentes, 1);
    const fallbackRequired = calculateFallbackWingSauceRequirement({
      nombre: row?.nombre_item,
      descripcion: row?.descripcion_item,
      quantity: 1
    });
    const requiredSaucesBase = Math.max(
      Number(requiredFromRules || 0),
      Number(fallbackRequired || 0)
    );

    let salsasPermitidas = sortSauceOptions(Array.from(unionSauces.values()));
    if (salsasPermitidas.length === 0 && requiredSaucesBase > 0) {
      // Si inferimos requerimiento por texto (ej. "18 alitas") y no hay mapeo receta_salsa,
      // exponemos el catalogo publico de salsas activas para permitir la seleccion.
      salsasPermitidas = sortSauceOptions(fallbackSauceCatalog);
    }

    const salsasRequiereSeleccion = requiredSaucesBase > 0;

    configByDetail.set(idDetalleMenu, {
      salsas_componentes: salsasComponentes,
      salsas_permitidas: salsasPermitidas,
      salsas_requiere_seleccion: salsasRequiereSeleccion,
      salsas_requeridas_base: requiredSaucesBase
    });
  }

  return configByDetail;
};

// Crea metadata de disponibilidad unificada para frontend.
const buildAvailabilityPayload = ({ available, reasonCode = null }) => ({
  available,
  reasonCode,
  message: reasonCode ? AVAILABILITY_REASON_LABEL[reasonCode] || 'No disponible.' : 'Disponible'
});

// Calcula disponibilidad para productos de stock directo.
const resolveProductAvailability = (row) => {
  const isActive = toBoolean(row.estado_item_base);
  if (!isActive) {
    return buildAvailabilityPayload({ available: false, reasonCode: 'ITEM_INACTIVO' });
  }

  const currentStock = toNumberOrNull(row.cantidad_actual) ?? 0;
  const minimumStock = toNumberOrNull(row.stock_minimo) ?? 0;
  const availableUnits = currentStock - minimumStock;

  if (availableUnits <= 0) {
    return buildAvailabilityPayload({ available: false, reasonCode: 'STOCK_INSUFICIENTE' });
  }

  return buildAvailabilityPayload({ available: true });
};

// Calcula disponibilidad para recetas/combo con mapas precomputados.
const resolveComposedAvailability = ({ row, recipeAvailabilityMap, comboAvailabilityMap }) => {
  const isActive = toBoolean(row.estado_item_base);
  if (!isActive) {
    return buildAvailabilityPayload({ available: false, reasonCode: 'ITEM_INACTIVO' });
  }

  if (row.tipo_item === PUBLIC_ITEM_TYPES.RECETA) {
    const info = recipeAvailabilityMap.get(Number(row.id_receta));
    if (!info) return buildAvailabilityPayload({ available: false, reasonCode: 'RECETA_SIN_DETALLE' });
    return buildAvailabilityPayload({ available: toBoolean(info.disponible), reasonCode: info.motivo || null });
  }

  if (row.tipo_item === PUBLIC_ITEM_TYPES.COMBO) {
    const info = comboAvailabilityMap.get(Number(row.id_combo));
    if (!info) return buildAvailabilityPayload({ available: false, reasonCode: 'COMBO_SIN_COMPONENTES' });
    return buildAvailabilityPayload({ available: toBoolean(info.disponible), reasonCode: info.motivo || null });
  }

  return buildAvailabilityPayload({ available: false, reasonCode: 'ITEM_INACTIVO' });
};

// AM: Regla oficial de precio final: override valido o precio base.
const resolvePricePayload = (row) => {
  const rawPublicPrice = toNumberOrNull(row.precio_publico);
  const rawBasePrice = toNumberOrNull(row.precio_base);
  const publicPrice = rawPublicPrice !== null && rawPublicPrice >= 0 ? rawPublicPrice : null;
  const basePrice = rawBasePrice !== null && rawBasePrice >= 0 ? rawBasePrice : null;
  const finalPrice = publicPrice ?? basePrice;

  return {
    base: basePrice,
    public: publicPrice,
    final: finalPrice,
    hasValidPrice: finalPrice !== null && finalPrice >= 0
  };
};

// Convierte una fila SQL de catalogo a payload publico final.
const mapCatalogItem = ({
  row,
  recipeAvailabilityMap,
  comboAvailabilityMap,
  sauceConfigByDetail = new Map(),
  extrasByRecipe = new Map()
}) => {
  const price = resolvePricePayload(row);
  const availability = row.tipo_item === PUBLIC_ITEM_TYPES.PRODUCTO
    ? resolveProductAvailability(row)
    : resolveComposedAvailability({ row, recipeAvailabilityMap, comboAvailabilityMap });
  const itemSauceConfig = sauceConfigByDetail.get(Number(row?.id_detalle_menu || 0)) || {
    salsas_componentes: [],
    salsas_permitidas: [],
    salsas_requiere_seleccion: false,
    salsas_requeridas_base: 0
  };
  const fallbackRequiredSauces = calculateFallbackWingSauceRequirement({
    nombre: row?.nombre_item,
    descripcion: row?.descripcion_item,
    quantity: 1
  });
  const requiredSaucesBase = Math.max(
    Number(itemSauceConfig.salsas_requeridas_base || 0),
    Number(fallbackRequiredSauces || 0)
  );
  const dbExtras = extrasByRecipe.get(Number(row?.id_receta || 0)) || [];
  const extrasOpciones = dbExtras.length > 0 ? dbExtras : getFallbackCatalogItemExtraOptions({
    nombre: row?.nombre_item,
    descripcion: row?.descripcion_item,
    categoriaNombre: row?.categoria_nombre,
    tipoItem: row?.tipo_item
  });

  const finalAvailability = !price.hasValidPrice
    ? buildAvailabilityPayload({ available: false, reasonCode: 'SIN_PRECIO' })
    : availability;

  return {
    id_detalle_menu: Number(row.id_detalle_menu),
    tipo_item: row.tipo_item,
    id_item_base: Number(row.id_item_base),
    id_producto: row.id_producto ? Number(row.id_producto) : null,
    id_receta: row.id_receta ? Number(row.id_receta) : null,
    id_combo: row.id_combo ? Number(row.id_combo) : null,
    nombre: row.nombre_item || 'Item sin nombre',
    descripcion: row.descripcion_item || '',
    categoria: {
      id_tipo_departamento: row.id_tipo_departamento ? Number(row.id_tipo_departamento) : null,
      nombre: row.categoria_nombre || 'Sin categoria',
      nombre_producto: row.producto_categoria_nombre || ''
    },
    imagen_url: resolvePublicCatalogImageUrl(row.url_imagen),
    precio: price,
    disponibilidad: finalAvailability,
    extras_opciones: extrasOpciones,
    salsas_componentes: itemSauceConfig.salsas_componentes,
    salsas_permitidas: itemSauceConfig.salsas_permitidas,
    salsas_requiere_seleccion: itemSauceConfig.salsas_requiere_seleccion || requiredSaucesBase > 0,
    salsas_requeridas_base: Number(requiredSaucesBase || 0),
    visible: toBoolean(row.visible),
    orden: Number(row.orden || 0)
  };
};

// Construye mapa de disponibilidad por ID para consultas O(1) en mapeo final.
const toAvailabilityMap = (rows = [], keyName) =>
  new Map(rows.map((row) => [Number(row[keyName]), row]));

const isRowVisibleInPublicMenu = (row) =>
  toBoolean(row?.visible) && toBoolean(row?.estado_item_base);

// Resumen de menu vigente para reutilizar en varios endpoints.
const mapMenuSummary = (row) => ({
  id_menu_vigente: Number(row.id_menu_vigente),
  id_menu: Number(row.id_menu),
  id_sucursal: Number(row.id_sucursal),
  nombre_menu: row.nombre_menu,
  descripcion_menu: row.menu_descripcion || '',
  nombre_sucursal: row.nombre_sucursal,
  fecha_inicio: row.fecha_inicio
});

const resolvePendingStateId = async (db = pool) => {
  const rows = await fetchEstadoPedidoRowsQuery(db);
  // Regla robusta: resolver por descripcion canonica para no depender del ID numerico.
  // En algunos entornos el id=1 NO es "PENDIENTE" (por ejemplo EN_PREPARACION).
  const matchByAlias = rows.find((row) =>
    ORDER_STATE_ALIASES.includes(normalizeTextKey(row?.descripcion))
  );
  const id = Number(matchByAlias?.id_estado_pedido || 0);
  return id > 0 ? id : null;
};

const normalizeRequestedExtras = (rawExtras = []) => {
  const uniqueIds = [...new Set(
    (Array.isArray(rawExtras) ? rawExtras : [])
      .map((entry) => String(entry?.id_extra || entry || '').trim())
      .filter(Boolean)
  )];

  return uniqueIds.map((id_extra) => ({ id_extra }));
};

const resolveExtraOptionByRequestedId = (extraOptions = [], requestedId = '') => {
  const safeRequestedId = String(requestedId || '').trim();
  if (!safeRequestedId) return null;

  const directMatch = extraOptions.find((option) => String(option?.id_extra || '').trim() === safeRequestedId);
  if (directMatch) return directMatch;

  const fallbackOption = PUBLIC_EXTRA_OPTIONS.find((option) => String(option?.id_extra || '').trim() === safeRequestedId);
  if (!fallbackOption?.codigo) return null;

  return extraOptions.find(
    (option) => normalizeTextKey(option?.codigo || '') === normalizeTextKey(fallbackOption.codigo)
  ) || null;
};

const buildExtraOptionIndex = (extraOptions = []) => {
  const index = new Map();

  (Array.isArray(extraOptions) ? extraOptions : []).forEach((option) => {
    const id = String(option?.id_extra || '').trim();
    const codigo = normalizeTextKey(option?.codigo || '');
    if (id) index.set(id, option);
    if (codigo) index.set(codigo, option);
  });

  return index;
};

const normalizeRequestedSauces = (rawSauces = []) => {
  const merged = new Map();

  (Array.isArray(rawSauces) ? rawSauces : []).forEach((entry) => {
    const id_salsa = toPositiveInt(entry?.id_salsa);
    const cantidad = toPositiveInt(entry?.cantidad);
    if (!id_salsa || !cantidad) return;

    const current = merged.get(id_salsa) || 0;
    merged.set(id_salsa, current + cantidad);
  });

  return Array.from(merged.entries())
    .map(([id_salsa, cantidad]) => ({ id_salsa: Number(id_salsa), cantidad: Number(cantidad) }))
    .sort((left, right) => left.id_salsa - right.id_salsa);
};

const buildRequestedConfigSignature = ({ extras = [], salsas_por_unidad = [], nota = '' }) => {
  const extrasToken = normalizeRequestedExtras(extras)
    .map((entry) => entry.id_extra)
    .sort()
    .join('|');

  const saucesToken = normalizeRequestedSauces(salsas_por_unidad)
    .map((entry) => `${entry.id_salsa}:${entry.cantidad}`)
    .join('|');

  // Incluimos la nota para evitar fusionar lineas con configuraciones iguales pero instrucciones distintas.
  const noteToken = normalizeCompactText(nota, MAX_PUBLIC_ITEM_NOTE_LENGTH);
  return `${extrasToken}::${saucesToken}::${noteToken}`;
};

const normalizeRequestedOrderItems = (items = []) => {
  const merged = new Map();

  (Array.isArray(items) ? items : []).forEach((row) => {
    const idDetalleMenu = toPositiveInt(row?.id_detalle_menu);
    const cantidad = toPositiveInt(row?.cantidad);
    if (!idDetalleMenu || !cantidad) return;

    const signature = buildRequestedConfigSignature({
      extras: row?.extras,
      salsas_por_unidad: row?.salsas_por_unidad,
      nota: row?.nota
    });
    const lineKey = `${idDetalleMenu}::${signature}`;
    const current = merged.get(lineKey);

    if (!current) {
      merged.set(lineKey, {
        id_detalle_menu: idDetalleMenu,
        cantidad,
        extras: normalizeRequestedExtras(row?.extras),
        salsas_por_unidad: normalizeRequestedSauces(row?.salsas_por_unidad),
        nota: normalizeCompactText(row?.nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)
      });
      return;
    }

    current.cantidad += cantidad;
  });

  return Array.from(merged.values()).map((line) => ({
    ...line,
    cantidad: Number(line.cantidad || 0)
  }));
};

const buildLineObservation = ({ extras = [], salsasPorUnidad = [], nota = '' }) => {
  const extrasToken = (Array.isArray(extras) ? extras : [])
    .map((entry) => {
      const code = normalizeTextKey(entry?.codigo || entry?.id_extra || '');
      if (!code) return null;
      return `${code}*1@${roundMoney(entry?.precio_adicional || 0).toFixed(2)}`;
    })
    .filter(Boolean)
    .sort()
    .join(',');

  const saucesToken = (Array.isArray(salsasPorUnidad) ? salsasPorUnidad : [])
    .map((entry) => {
      const id = Number(entry?.id_salsa || 0);
      const qty = Number(entry?.cantidad || 0);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) return null;
      return `${id}*${qty}`;
    })
    .filter(Boolean)
    .sort()
    .join(',');

  const chunks = [];
  if (extrasToken) chunks.push(`extras=${extrasToken}`);
  if (saucesToken) chunks.push(`salsas=${saucesToken}`);
  if (normalizeCompactText(nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)) {
    chunks.push(`nota=${normalizeCompactText(nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)}`);
  }
  if (chunks.length === 0) return null;

  return `PUBCFG:v1|${chunks.join('|')}`.slice(0, 200);
};

const buildLineStructuredConfig = ({
  line = {},
  catalog = {},
  configuration = {},
  precioUnitario = 0,
  subtotal = 0
}) => {
  const extras = [...(Array.isArray(configuration?.extras) ? configuration.extras : [])]
    .map((entry) => ({
      id_extra: String(entry?.id_extra || ''),
      codigo: String(entry?.codigo || entry?.id_extra || ''),
      nombre: String(entry?.nombre || 'Extra'),
      precio_adicional: roundMoney(entry?.precio_adicional || 0)
    }))
    .filter((entry) => entry.id_extra)
    .sort((left, right) => left.id_extra.localeCompare(right.id_extra));

  const salsasPorUnidad = [...(Array.isArray(configuration?.salsas_por_unidad) ? configuration.salsas_por_unidad : [])]
    .map((entry) => ({
      id_salsa: Number(entry?.id_salsa || 0),
      cantidad: Number(entry?.cantidad || 0)
    }))
    .filter((entry) => Number.isInteger(entry.id_salsa) && entry.id_salsa > 0 && Number.isInteger(entry.cantidad) && entry.cantidad > 0)
    .sort((left, right) => left.id_salsa - right.id_salsa);

  // Snapshot inmutable de la linea para trazabilidad operativa (cocina/ventas/auditoria).
  return {
    schema_version: 'menu_publico_linea_v1',
    id_detalle_menu: Number(catalog?.id_detalle_menu || line?.id_detalle_menu || 0),
    tipo_item: String(catalog?.tipo_item || line?.tipo_item || 'PRODUCTO'),
    nombre_item: String(catalog?.nombre || line?.nombre || 'Item'),
    cantidad: Number(line?.cantidad || 0),
    precio_unitario: roundMoney(precioUnitario || 0),
    subtotal_linea: roundMoney(subtotal || 0),
    extras,
    salsas_por_unidad: salsasPorUnidad,
    salsas_requeridas: Number(configuration?.salsas_requeridas || 0),
    nota_cliente: normalizeCompactText(line?.nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)
  };
};

const normalizePublicOrderBusinessContext = ({ tipoPedido, business = {} }) => {
  const contactoRaw = business?.contacto && typeof business.contacto === 'object'
    ? business.contacto
    : {};
  const entregaRaw = business?.entrega && typeof business.entrega === 'object'
    ? business.entrega
    : {};
  const pagoRaw = business?.pago && typeof business.pago === 'object'
    ? business.pago
    : {};
  const servicioRaw = business?.servicio && typeof business.servicio === 'object'
    ? business.servicio
    : {};

  return {
    contacto: {
      nombre: normalizeCompactText(contactoRaw.nombre, 120),
      telefono: normalizeCompactText(contactoRaw.telefono, 30)
    },
    entrega: {
      direccion: normalizeCompactText(entregaRaw.direccion, 240),
      referencia: normalizeCompactText(entregaRaw.referencia, 160)
    },
    pago: {
      metodo: normalizeCompactText(pagoRaw.metodo, 40),
      comprobante_transferencia: normalizeCompactText(pagoRaw.comprobante_transferencia, 180)
    },
    servicio: {
      mesa: normalizeCompactText(servicioRaw.mesa, 40)
    },
    requiresTransferProof: ORDER_TYPES_REQUIRING_TRANSFER_PROOF.has(String(tipoPedido || ''))
  };
};

const buildIdempotencyPayloadSignature = ({
  idSucursal,
  tipoPedido,
  businessContext,
  requestedItems
}) => {
  const items = (Array.isArray(requestedItems) ? requestedItems : [])
    .map((line) => ({
      id_detalle_menu: Number(line?.id_detalle_menu || 0),
      cantidad: Number(line?.cantidad || 0),
      extras: normalizeRequestedExtras(line?.extras)
        .map((entry) => String(entry.id_extra || ''))
        .sort(),
      salsas_por_unidad: normalizeRequestedSauces(line?.salsas_por_unidad),
      nota: normalizeCompactText(line?.nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)
    }))
    .sort((left, right) => left.id_detalle_menu - right.id_detalle_menu);

  const canonical = JSON.stringify({
    id_sucursal: Number(idSucursal || 0),
    tipo_pedido: String(tipoPedido || ''),
    business: {
      contacto: {
        nombre: normalizeCompactText(businessContext?.contacto?.nombre, 120),
        telefono: normalizeCompactText(businessContext?.contacto?.telefono, 30)
      },
      entrega: {
        direccion: normalizeCompactText(businessContext?.entrega?.direccion, 240),
        referencia: normalizeCompactText(businessContext?.entrega?.referencia, 160)
      },
      pago: {
        metodo: normalizeCompactText(businessContext?.pago?.metodo, 40),
        comprobante_transferencia: normalizeCompactText(businessContext?.pago?.comprobante_transferencia, 180)
      },
      servicio: {
        mesa: normalizeCompactText(businessContext?.servicio?.mesa, 40)
      }
    },
    items
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
};

const readMarkerValueFromDescription = ({ description = '', marker = '' }) => {
  const safeDescription = String(description || '');
  const safeMarker = String(marker || '').trim().toLowerCase();
  if (!safeMarker) return '';

  const normalized = safeDescription.toLowerCase();
  const index = normalized.indexOf(`${safeMarker}:`);
  if (index < 0) return '';

  const rest = safeDescription.slice(index + safeMarker.length + 1);
  const value = String(rest.split('|')[0] || '').trim();
  return normalizeCompactText(value, 64).toLowerCase();
};

const assertIdempotencyPayloadCompatibility = ({ existingOrder, requestSignature }) => {
  if (!existingOrder?.id_pedido) return;
  const storedSignature = readMarkerValueFromDescription({
    description: existingOrder?.descripcion_pedido,
    marker: 'sig'
  });

  // Compatibilidad retroactiva: pedidos antiguos pueden no tener firma persistida.
  if (!storedSignature) return;

  if (storedSignature !== String(requestSignature || '').toLowerCase()) {
    throw buildHttpError(
      409,
      'La idempotency_key ya fue usada con un payload distinto. Genera una nueva llave para reintentar.'
    );
  }
};

const materializePublicOrderSnapshot = async ({ idSucursal, requestedItems = [], db = pool }) => {
  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal, db);
  if (!activeMenu) {
    throw buildHttpError(409, 'La sucursal no tiene menu vigente activo para registrar pedidos.');
  }

  const rows = await fetchCatalogRowsByMenuQuery(Number(activeMenu.id_menu), Number(idSucursal), db);
  const [sauceConfigByDetail, extrasByRecipe] = await Promise.all([
    buildCatalogSauceConfigByDetail(rows, db),
    buildCatalogExtrasByRecipe(rows, db)
  ]);

  const recipeIds = rows
    .filter((row) => row.tipo_item === PUBLIC_ITEM_TYPES.RECETA && row.id_receta)
    .map((row) => Number(row.id_receta));

  const comboIds = rows
    .filter((row) => row.tipo_item === PUBLIC_ITEM_TYPES.COMBO && row.id_combo)
    .map((row) => Number(row.id_combo));

  const [recipeAvailabilityRows, comboAvailabilityRows] = await Promise.all([
    fetchRecipeAvailabilityQuery([...new Set(recipeIds)], db),
    fetchComboAvailabilityQuery([...new Set(comboIds)], db)
  ]);

  const recipeAvailabilityMap = toAvailabilityMap(recipeAvailabilityRows, 'id_receta');
  const comboAvailabilityMap = toAvailabilityMap(comboAvailabilityRows, 'id_combo');

  const catalogItems = rows.map((row) =>
    mapCatalogItem({
      row,
      recipeAvailabilityMap,
      comboAvailabilityMap,
      sauceConfigByDetail,
      extrasByRecipe
    })
  );

  const catalogByDetail = new Map(catalogItems.map((item) => [Number(item.id_detalle_menu), item]));

  const normalizedLines = requestedItems.map((line) => {
    const catalog = catalogByDetail.get(Number(line.id_detalle_menu));
    if (!catalog) {
      throw buildHttpError(400, `El item ${line.id_detalle_menu} no pertenece al menu vigente de la sucursal.`);
    }

    if (!catalog?.disponibilidad?.available) {
      throw buildHttpError(409, `El item ${catalog.nombre} no esta disponible actualmente.`);
    }

    const configuration = validateAndResolveLineConfiguration({ catalog, line });
    const precioBase = toNumberOrNull(catalog?.precio?.final);
    if (precioBase === null || precioBase <= 0) {
      throw buildHttpError(400, `El item ${catalog.nombre} no tiene precio valido para registrar pedido.`);
    }

    const cantidad = toPositiveInt(line.cantidad);
    const precioUnitario = roundMoney(Number(precioBase || 0) + Number(configuration.extra_unit_amount || 0));
    const subtotal = roundMoney(precioUnitario * cantidad);
    const observacion = buildLineObservation({
      extras: configuration.extras,
      salsasPorUnidad: configuration.salsas_por_unidad,
      nota: line?.nota
    });
    const configuracionMenu = buildLineStructuredConfig({
      line,
      catalog,
      configuration,
      precioUnitario,
      subtotal
    });

    return {
      id_detalle_menu: Number(catalog.id_detalle_menu),
      tipo_item: String(catalog.tipo_item || 'PRODUCTO'),
      id_producto: catalog.id_producto ? Number(catalog.id_producto) : null,
      id_combo: catalog.id_combo ? Number(catalog.id_combo) : null,
      id_receta: catalog.id_receta ? Number(catalog.id_receta) : null,
      nombre: catalog.nombre,
      cantidad,
      precio_unitario: roundMoney(precioUnitario),
      subtotal,
      observacion,
      configuracion_menu: configuracionMenu,
      extras: configuration.extras,
      salsas_por_unidad: configuration.salsas_por_unidad,
      salsas_requeridas: configuration.salsas_requeridas,
      nota: normalizeCompactText(line?.nota, MAX_PUBLIC_ITEM_NOTE_LENGTH)
    };
  });

  return {
    activeMenu,
    normalizedLines,
    total: roundMoney(normalizedLines.reduce((sum, line) => sum + line.subtotal, 0))
  };
};

const buildPublicOrderDescription = ({
  origen,
  tipoPedido,
  businessContext,
  idempotencyKey
}) => {
  const safeOrigin = normalizeCompactText(origen || 'public-menu', 60) || 'public-menu';
  const base = `[${safeOrigin}] pedido web`;
  const chunks = [];
  if (idempotencyKey) {
    // Marcador persistido para poder recuperar el mismo pedido ante reintentos/reconexiones.
    chunks.push(`idem:${idempotencyKey}`);
  }

  if (businessContext?.contacto?.telefono) {
    chunks.push(`tel:${businessContext.contacto.telefono}`);
  }

  if (businessContext?.pago?.comprobante_transferencia) {
    chunks.push(`comp:${businessContext.pago.comprobante_transferencia}`);
  }

  if (String(tipoPedido || '') === 'delivery') {
    if (businessContext?.entrega?.direccion) {
      chunks.push(`dir:${businessContext.entrega.direccion}`);
    }

    if (businessContext?.entrega?.referencia) {
      chunks.push(`ref:${businessContext.entrega.referencia}`);
    }
  }

  if (chunks.length === 0) {
    return base.slice(0, MAX_PUBLIC_ORDER_DESCRIPTION_LENGTH);
  }

  return `${base} | ${chunks.join(' | ')}`.slice(0, MAX_PUBLIC_ORDER_DESCRIPTION_LENGTH);
};

const buildPublicOrderResult = ({
  idPedido,
  idSucursal,
  idCliente,
  idMenu,
  tipoPedido,
  tipoEntrega,
  businessContext,
  validacionPagoVenceAt,
  total,
  normalizedLines = [],
  fechaHoraPedido = null,
  idempotencyKey = '',
  replayed = false
}) => ({
  id_pedido: Number(idPedido),
  numero_ticket: buildTicketNumber(idPedido),
  id_sucursal: Number(idSucursal),
  id_cliente: Number(idCliente),
  id_menu: Number(idMenu || 0) || null,
  tipo_pedido: tipoPedido,
  tipo_entrega: tipoEntrega,
  business: businessContext,
  estado: 'PENDIENTE',
  estado_pago: INITIAL_ORDER_PAYMENT_STATE,
  validacion_pago_vence_at: validacionPagoVenceAt
    ? new Date(validacionPagoVenceAt).toISOString()
    : null,
  total: roundMoney(total || 0),
  total_items: normalizedLines.reduce((sum, line) => sum + Number(line.cantidad || 0), 0),
  fecha_hora_pedido: fechaHoraPedido || null,
  idempotency: {
    key: idempotencyKey || null,
    replayed: Boolean(replayed)
  },
  items: normalizedLines.map((line) => ({
    id_detalle_menu: line.id_detalle_menu,
    tipo_item: line.tipo_item,
    nombre: line.nombre,
    cantidad: line.cantidad,
    precio_unitario: line.precio_unitario,
    subtotal: line.subtotal,
    configuracion_menu: line.configuracion_menu,
    extras: line.extras,
    salsas_por_unidad: line.salsas_por_unidad,
    salsas_requeridas: line.salsas_requeridas
  }))
});

const validateAndResolveLineConfiguration = ({ catalog, line }) => {
  const extraOptions = Array.isArray(catalog?.extras_opciones) ? catalog.extras_opciones : [];
  const extraOptionById = buildExtraOptionIndex(extraOptions);
  const selectedExtraIds = normalizeRequestedExtras(line?.extras).map((entry) => entry.id_extra);

  const resolvedExtras = selectedExtraIds.map((idExtra) => {
    const option =
      extraOptionById.get(String(idExtra).trim()) ||
      extraOptionById.get(normalizeTextKey(idExtra)) ||
      resolveExtraOptionByRequestedId(extraOptions, idExtra);
    if (!option) {
      throw buildHttpError(400, `El item ${catalog.nombre} no permite el extra solicitado (${idExtra}).`);
    }
    return {
      id_extra: String(option.id_extra),
      codigo: String(option.codigo || option.id_extra),
      nombre: String(option.nombre || 'Extra'),
      precio_adicional: roundMoney(option.precio_adicional || 0)
    };
  });

  const extraUnitAmount = roundMoney(
    resolvedExtras.reduce((sum, entry) => sum + Number(entry.precio_adicional || 0), 0)
  );

  const allowedSauces = Array.isArray(catalog?.salsas_permitidas) ? catalog.salsas_permitidas : [];
  const allowedSauceMap = new Map(
    allowedSauces.map((entry) => [Number(entry.id_salsa), Boolean(entry?.disponible ?? true)])
  );
  const selectedSauces = normalizeRequestedSauces(line?.salsas_por_unidad);

  for (const selected of selectedSauces) {
    const sauceId = Number(selected.id_salsa);
    if (!allowedSauceMap.has(sauceId)) {
      throw buildHttpError(
        400,
        `El item ${catalog.nombre} no permite la salsa ${selected.id_salsa} para esta configuracion.`
      );
    }

    if (!allowedSauceMap.get(sauceId)) {
      throw buildHttpError(
        409,
        `La salsa ${selected.id_salsa} no esta disponible actualmente para ${catalog.nombre}.`
      );
    }
  }

  const selectedSauceCount = selectedSauces.reduce(
    (sum, entry) => sum + Number(entry.cantidad || 0),
    0
  );
  const requiredSauces = resolveRequiredSaucesByCatalog({
    catalog,
    quantity: Number(line?.cantidad || 1)
  });
  const requiresSelection = catalog?.salsas_requiere_seleccion === true || requiredSauces > 0;

  if (requiresSelection && requiredSauces > 0 && allowedSauces.length === 0) {
    throw buildHttpError(
      409,
      `El item ${catalog.nombre} requiere salsas, pero no tiene salsas disponibles.`
    );
  }

  if (requiresSelection && requiredSauces > 0 && selectedSauceCount !== requiredSauces) {
    throw buildHttpError(
      400,
      `El item ${catalog.nombre} requiere ${requiredSauces} salsa(s) para la cantidad seleccionada.`
    );
  }

  return {
    extras: resolvedExtras,
    salsas_por_unidad: selectedSauces,
    extra_unit_amount: extraUnitAmount,
    salsas_requeridas: Number(requiredSauces || 0)
  };
};

// Servicio: listar sucursales publicas.
export const getPublicBranchesService = async () => {
  const rows = await fetchPublicBranchesQuery();
  return rows.map(mapBranch);
};

// AM: servicio para obtener configuracion global del carrusel hero.
export const getPublicHeroCarouselConfigService = async () => getPublicMenuHeroCarouselConfig();

// Servicio: obtener menu vigente por sucursal.
export const getMenuVigenteByBranchService = async (idSucursal) => {
  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal);
  if (!activeMenu) return null;
  return mapMenuSummary(activeMenu);
};

// Servicio: construir catalogo publico real usando menu_vigente + detalle_menu.
export const getPublicCatalogService = async ({ idSucursal, tipoPedido = null }) => {
  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal);

  if (!activeMenu) {
    return {
      menu: null,
      tipo_pedido: tipoPedido,
      stats: {
        total: 0,
        disponibles: 0,
        agotados: 0
      },
      items: []
    };
  }

  const rows = await fetchCatalogRowsByMenuQuery(Number(activeMenu.id_menu), Number(idSucursal));
  const [sauceConfigByDetail, extrasByRecipe] = await Promise.all([
    buildCatalogSauceConfigByDetail(rows),
    buildCatalogExtrasByRecipe(rows)
  ]);

  const recipeIds = rows
    .filter((row) => row.tipo_item === PUBLIC_ITEM_TYPES.RECETA && row.id_receta)
    .map((row) => Number(row.id_receta));

  const comboIds = rows
    .filter((row) => row.tipo_item === PUBLIC_ITEM_TYPES.COMBO && row.id_combo)
    .map((row) => Number(row.id_combo));

  const [recipeAvailabilityRows, comboAvailabilityRows] = await Promise.all([
    fetchRecipeAvailabilityQuery([...new Set(recipeIds)]),
    fetchComboAvailabilityQuery([...new Set(comboIds)])
  ]);

  const recipeAvailabilityMap = toAvailabilityMap(recipeAvailabilityRows, 'id_receta');
  const comboAvailabilityMap = toAvailabilityMap(comboAvailabilityRows, 'id_combo');

  const items = rows
    .filter(isRowVisibleInPublicMenu)
    .map((row) =>
    mapCatalogItem({
      row,
      recipeAvailabilityMap,
      comboAvailabilityMap,
      sauceConfigByDetail,
      extrasByRecipe
    })
    );

  const disponibles = items.filter((item) => item.disponibilidad.available).length;

  return {
    menu: mapMenuSummary(activeMenu),
    tipo_pedido: tipoPedido,
    stats: {
      total: items.length,
      disponibles,
      agotados: items.length - disponibles
    },
    items
  };
};

// Servicio: detalle de un item puntual del menu vigente por sucursal.
export const getPublicCatalogItemDetailService = async ({ idSucursal, idDetalleMenu }) => {
  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal);
  if (!activeMenu) {
    throw buildHttpError(404, 'No existe menu vigente para la sucursal seleccionada.');
  }

  const row = await fetchCatalogItemByIdQuery({
    idMenu: Number(activeMenu.id_menu),
    idDetalleMenu,
    idSucursal: Number(idSucursal)
  });

  if (!row) {
    throw buildHttpError(404, 'El item no existe en el menu vigente de esta sucursal.');
  }
  if (!isRowVisibleInPublicMenu(row)) {
    throw buildHttpError(404, 'El item no esta disponible en el menu publico de esta sucursal.');
  }
  const [sauceConfigByDetail, extrasByRecipe] = await Promise.all([
    buildCatalogSauceConfigByDetail([row]),
    buildCatalogExtrasByRecipe([row])
  ]);

  const recipeIds = row.id_receta ? [Number(row.id_receta)] : [];
  const comboIds = row.id_combo ? [Number(row.id_combo)] : [];

  const [recipeAvailabilityRows, comboAvailabilityRows] = await Promise.all([
    fetchRecipeAvailabilityQuery(recipeIds),
    fetchComboAvailabilityQuery(comboIds)
  ]);

  const recipeAvailabilityMap = toAvailabilityMap(recipeAvailabilityRows, 'id_receta');
  const comboAvailabilityMap = toAvailabilityMap(comboAvailabilityRows, 'id_combo');

  return {
    menu: mapMenuSummary(activeMenu),
    item: mapCatalogItem({
      row,
      recipeAvailabilityMap,
      comboAvailabilityMap,
      sauceConfigByDetail,
      extrasByRecipe
    })
  };
};

// Servicio: registrar pedido enviado desde el menu publico.
// Regla: pedido asociado al cliente autenticado (sin usuario fallback).
export const createPublicOrderService = async ({
  idSucursal,
  tipoPedido,
  origen = 'public-menu',
  idempotencyKey = '',
  business = {},
  items = [],
  auth = {}
}) => {
  const idUsuario = toPositiveInt(auth?.idUsuario);
  const idCliente = toPositiveInt(auth?.idCliente);
  if (!idUsuario || !idCliente) {
    throw buildHttpError(401, 'Sesion de cliente invalida para registrar el pedido.');
  }
  const safeIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
  if (!safeIdempotencyKey || safeIdempotencyKey.length < 12) {
    throw buildHttpError(400, 'idempotency_key invalido para registrar el pedido.');
  }

  const businessContext = normalizePublicOrderBusinessContext({
    tipoPedido,
    business
  });

  if (businessContext.requiresTransferProof && !businessContext.pago.comprobante_transferencia) {
    throw buildHttpError(400, 'Debes adjuntar referencia o comprobante de transferencia para delivery.');
  }

  if ((String(tipoPedido || '') === 'pickup' || String(tipoPedido || '') === 'delivery') && !businessContext.contacto.telefono) {
    throw buildHttpError(400, 'Debes enviar telefono de contacto para pickup/delivery.');
  }

  if (String(tipoPedido || '') === 'pickup' && !businessContext.pago?.metodo) {
    throw buildHttpError(400, 'Debes seleccionar metodo de pago para pickup: caja o transferencia.');
  }

  if (
    String(tipoPedido || '') === 'pickup' &&
    businessContext.pago?.metodo &&
    !TRANSFER_METHOD_ALIASES.has(String(businessContext.pago.metodo || '').toLowerCase()) &&
    !CASH_METHOD_ALIASES.has(String(businessContext.pago.metodo || '').toLowerCase())
  ) {
    throw buildHttpError(400, 'metodo_pago invalido para pickup. Usa caja o transferencia.');
  }

  if (
    String(tipoPedido || '') === 'delivery' &&
    businessContext.pago?.metodo &&
    !TRANSFER_METHOD_ALIASES.has(String(businessContext.pago.metodo || '').toLowerCase())
  ) {
    throw buildHttpError(400, 'metodo_pago invalido para delivery. Usa transferencia.');
  }

  if (String(tipoPedido || '') === 'delivery' && !businessContext.entrega.direccion) {
    throw buildHttpError(400, 'Debes enviar direccion de entrega para pedidos delivery.');
  }

  if (String(tipoPedido || '') === 'delivery' && !businessContext.entrega.referencia) {
    throw buildHttpError(400, 'Debes enviar referencia de entrega para pedidos delivery.');
  }

  const requestedItems = normalizeRequestedOrderItems(items);
  if (requestedItems.length === 0) {
    throw buildHttpError(400, 'No hay items validos para registrar el pedido.');
  }

  await assertBranchAcceptsPublicOrders(idSucursal);

  const requestSignature = buildIdempotencyPayloadSignature({
    idSucursal,
    tipoPedido,
    businessContext,
    requestedItems
  });

  // Primera verificacion de idempotencia: responde rapido a reintentos legitimos
  // y bloquea reuse de llave con payload alterado.
  {
    const replayClient = await pool.connect();
    try {
      await replayClient.query('BEGIN');
      await acquirePublicOrderIdempotencyLockQuery(replayClient, {
        idCliente,
        idempotencyKey: safeIdempotencyKey
      });

      const existing = await fetchPedidoByIdempotencyKeyQuery(replayClient, {
        idCliente,
        idSucursal,
        idempotencyKey: safeIdempotencyKey
      });
      assertIdempotencyPayloadCompatibility({
        existingOrder: existing,
        requestSignature
      });

      await replayClient.query('COMMIT');

      if (existing?.id_pedido) {
        return buildPublicOrderResult({
          idPedido: Number(existing.id_pedido),
          idSucursal,
          idCliente,
          idMenu: null,
          tipoPedido,
          tipoEntrega: DELIVERY_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL',
          businessContext,
          validacionPagoVenceAt: existing?.validacion_pago_vence_at || null,
          total: Number(existing?.total || 0),
          normalizedLines: [],
          fechaHoraPedido: existing?.fecha_hora_pedido || null,
          idempotencyKey: safeIdempotencyKey,
          replayed: true
        });
      }
    } catch (error) {
      await replayClient.query('ROLLBACK');
      throw error;
    } finally {
      replayClient.release();
    }
  }

  const descripcionEnvio = SERVICE_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL';
  const tipoEntrega = DELIVERY_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquirePublicOrderIdempotencyLockQuery(client, {
      idCliente,
      idempotencyKey: safeIdempotencyKey
    });

    // Segunda verificacion en la misma transaccion de escritura para cerrar carrera entre nodos/procesos.
    const existingInWriteTx = await fetchPedidoByIdempotencyKeyQuery(client, {
      idCliente,
      idSucursal,
      idempotencyKey: safeIdempotencyKey
    });
    assertIdempotencyPayloadCompatibility({
      existingOrder: existingInWriteTx,
      requestSignature
    });
    if (existingInWriteTx?.id_pedido) {
      await client.query('COMMIT');
      return buildPublicOrderResult({
        idPedido: Number(existingInWriteTx.id_pedido),
        idSucursal,
        idCliente,
        idMenu: null,
        tipoPedido,
        tipoEntrega,
        businessContext,
        validacionPagoVenceAt: existingInWriteTx?.validacion_pago_vence_at || null,
        total: Number(existingInWriteTx?.total || 0),
        normalizedLines: [],
        fechaHoraPedido: existingInWriteTx?.fecha_hora_pedido || null,
        idempotencyKey: safeIdempotencyKey,
        replayed: true
      });
    }

    // Validacion final transaccional: el pedido se calcula con el estado actual de BD
    // en la misma transaccion que inserta cabecera y detalle.
    const {
      activeMenu,
      normalizedLines,
      total
    } = await materializePublicOrderSnapshot({
      idSucursal,
      requestedItems,
      db: client
    });

    const idEstadoPedido = await resolvePendingStateId(client);
    if (!idEstadoPedido) {
      throw buildHttpError(
        409,
        'Configuracion incompleta: no existe estado inicial PENDIENTE/POR PAGAR para pedidos.'
      );
    }

    const validacionPagoVenceAt = new Date(Date.now() + ORDER_PAYMENT_VALIDATION_WINDOW_MINUTES * 60 * 1000);
    const descripcionPedido = buildPublicOrderDescription({
      origen,
      tipoPedido,
      businessContext,
      idempotencyKey: safeIdempotencyKey
    });

    const pedido = await insertPublicPedidoQuery(client, {
      descripcion_pedido: descripcionPedido,
      descripcion_envio: descripcionEnvio,
      sub_total: total,
      isv: 0,
      total,
      id_estado_pedido: idEstadoPedido,
      id_sucursal: Number(idSucursal),
      id_cliente: Number(idCliente),
      id_usuario: Number(idUsuario),
      estado_pago: INITIAL_ORDER_PAYMENT_STATE,
      tipo_entrega: tipoEntrega,
      validacion_pago_vence_at: validacionPagoVenceAt
    });

    const idPedido = Number(pedido?.id_pedido || 0);
    if (!idPedido) {
      throw buildHttpError(500, 'No se pudo generar el ID del pedido.');
    }

    for (const line of normalizedLines) {
      await insertPublicPedidoDetalleQuery(client, {
        sub_total_pedido: line.subtotal,
        total_pedido: line.subtotal,
        id_producto: line.id_producto,
        id_pedido: idPedido,
        id_combo: line.id_combo,
        id_receta: line.id_receta,
        cantidad: line.cantidad,
        observacion: line.observacion,
        configuracion_menu: line.configuracion_menu
      });
    }

    await client.query('COMMIT');

    return buildPublicOrderResult({
      idPedido,
      idSucursal,
      idCliente,
      idMenu: Number(activeMenu.id_menu || 0) || null,
      tipoPedido,
      tipoEntrega,
      businessContext,
      validacionPagoVenceAt,
      total,
      normalizedLines,
      fechaHoraPedido: pedido?.fecha_hora_pedido || null,
      idempotencyKey: safeIdempotencyKey,
      replayed: false
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
