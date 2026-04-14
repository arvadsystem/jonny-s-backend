import pool from '../../config/db-connection.js';
import {
  PUBLIC_ITEM_TYPES,
  fetchActiveMenuByBranchQuery,
  fetchAllowedSauceRowsByRecipeIdsQuery,
  fetchCatalogItemByIdQuery,
  fetchCatalogRowsByMenuQuery,
  fetchComboRecipeComponentsQuery,
  fetchComboAvailabilityQuery,
  fetchEstadoPedidoRowsQuery,
  fetchPublicBranchesQuery,
  fetchRecipeAvailabilityQuery,
  fetchSauceRuleRowsByRecipeIdsQuery,
  insertPublicPedidoDetalleQuery,
  insertPublicPedidoQuery
} from './publicMenuQueries.js';

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
const PENDING_STATE_ID_PRIORITY = 1;
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
const ORDER_TYPES_REQUIRING_TRANSFER_PROOF = new Set(['pickup', 'delivery']);
const MAX_PUBLIC_ORDER_DESCRIPTION_LENGTH = 240;
const MAX_PUBLIC_ITEM_NOTE_LENGTH = 100;

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

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const normalizeSearchText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

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

const calculateRequiredSaucesForQuantity = (components, quantity = 1) => (
  (Array.isArray(components) ? components : []).reduce((total, component) => {
    const multiplier = Math.max(1, Number(component?.multiplicador || 1));
    const units = Math.max(1, Number(quantity || 1)) * multiplier;
    const rule = findMatchingSalsaRule(component?.reglas, units);
    return total + Number(rule?.salsas_requeridas || 0);
  }, 0)
);

// Normaliza booleans provenientes de PG.
const toBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

// Convierte filas de sucursales al contrato publico.
const mapBranch = (row) => ({
  id: Number(row.id_sucursal),
  name: row.nombre_sucursal,
  address: row.direccion || 'Direccion no disponible',
  isOpen: toBoolean(row.estado)
});

const normalizeExtraOption = (option) => ({
  id_extra: String(option?.id_extra || '').trim(),
  codigo: String(option?.codigo || '').trim(),
  nombre: String(option?.nombre || 'Extra').trim(),
  precio_adicional: roundMoney(option?.precio_adicional || 0)
});

const getCatalogItemExtraOptions = ({ nombre, descripcion, categoriaNombre, tipoItem }) => {
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

const buildCatalogSauceConfigByDetail = async (catalogRows = []) => {
  const directRecipeIds = toUniquePositiveIntArray(
    catalogRows.map((row) => row?.id_receta)
  );
  const comboIds = toUniquePositiveIntArray(
    catalogRows.map((row) => row?.id_combo)
  );

  const comboComponentRows = comboIds.length > 0
    ? await fetchComboRecipeComponentsQuery(comboIds)
    : [];

  const allRecipeIds = toUniquePositiveIntArray([
    ...directRecipeIds,
    ...comboComponentRows.map((row) => row?.id_receta)
  ]);

  const [allowedSauceRows, sauceRuleRows] = allRecipeIds.length > 0
    ? await Promise.all([
      fetchAllowedSauceRowsByRecipeIdsQuery(allRecipeIds),
      fetchSauceRuleRowsByRecipeIdsQuery(allRecipeIds)
    ])
    : [[], []];

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
      salsas_permitidas: sortSauceOptions(allowedSaucesByRecipe.get(recipeId) || []),
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
        salsas_permitidas: sortSauceOptions(allowedSaucesByRecipe.get(recipeId) || []),
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

    const salsasPermitidas = sortSauceOptions(Array.from(unionSauces.values()));
    const salsasRequiereSeleccion = salsasComponentes.some((component) =>
      (component.reglas || []).some((rule) => Number(rule?.salsas_requeridas || 0) > 0)
    );

    configByDetail.set(idDetalleMenu, {
      salsas_componentes: salsasComponentes,
      salsas_permitidas: salsasPermitidas,
      salsas_requiere_seleccion: salsasRequiereSeleccion,
      salsas_requeridas_base: calculateRequiredSaucesForQuantity(salsasComponentes, 1)
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

// Regla oficial de precio final: precio_publico ?? precio_base.
const resolvePricePayload = (row) => {
  const publicPrice = toNumberOrNull(row.precio_publico);
  const basePrice = toNumberOrNull(row.precio_base);
  const finalPrice = publicPrice ?? basePrice;

  return {
    base: basePrice,
    public: publicPrice,
    final: finalPrice,
    hasValidPrice: finalPrice !== null
  };
};

// Convierte una fila SQL de catalogo a payload publico final.
const mapCatalogItem = ({
  row,
  recipeAvailabilityMap,
  comboAvailabilityMap,
  sauceConfigByDetail = new Map()
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
  const extrasOpciones = getCatalogItemExtraOptions({
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
      nombre: row.categoria_nombre || 'Sin categoria'
    },
    imagen_url: row.url_imagen || '',
    precio: price,
    disponibilidad: finalAvailability,
    extras_opciones: extrasOpciones,
    salsas_componentes: itemSauceConfig.salsas_componentes,
    salsas_permitidas: itemSauceConfig.salsas_permitidas,
    salsas_requiere_seleccion: itemSauceConfig.salsas_requiere_seleccion,
    salsas_requeridas_base: Number(itemSauceConfig.salsas_requeridas_base || 0),
    visible: toBoolean(row.visible),
    orden: Number(row.orden || 0)
  };
};

// Construye mapa de disponibilidad por ID para consultas O(1) en mapeo final.
const toAvailabilityMap = (rows = [], keyName) =>
  new Map(rows.map((row) => [Number(row[keyName]), row]));

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

const resolvePendingStateId = async () => {
  const rows = await fetchEstadoPedidoRowsQuery();
  // Regla de compatibilidad con tablero Ventas:
  // El carril "Pendientes / Por pagar" consume actualmente id_estado_pedido = 1.
  // Priorizamos ese ID para que los pedidos del menú público entren en la primera columna.
  const priorityById = rows.find(
    (row) => Number(row?.id_estado_pedido || 0) === PENDING_STATE_ID_PRIORITY
  );
  if (priorityById) {
    return Number(priorityById.id_estado_pedido);
  }

  // Fallback defensivo por descripción (instalaciones con catálogo distinto).
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
    requiresTransferProof: ORDER_TYPES_REQUIRING_TRANSFER_PROOF.has(String(tipoPedido || ''))
  };
};

const buildPublicOrderDescription = ({ origen, tipoPedido, businessContext }) => {
  const safeOrigin = normalizeCompactText(origen || 'public-menu', 60) || 'public-menu';
  const base = `[${safeOrigin}] pedido web`;
  const chunks = [];

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

const validateAndResolveLineConfiguration = ({ catalog, line }) => {
  const extraOptions = Array.isArray(catalog?.extras_opciones) ? catalog.extras_opciones : [];
  const extraOptionById = new Map(extraOptions.map((option) => [String(option.id_extra), option]));
  const selectedExtraIds = normalizeRequestedExtras(line?.extras).map((entry) => entry.id_extra);

  const resolvedExtras = selectedExtraIds.map((idExtra) => {
    const option = extraOptionById.get(String(idExtra));
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
  const requiredSauces = calculateRequiredSaucesForQuantity(
    catalog?.salsas_componentes,
    Number(line?.cantidad || 1)
  );
  const requiresSelection = catalog?.salsas_requiere_seleccion === true;

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

  const rows = await fetchCatalogRowsByMenuQuery(Number(activeMenu.id_menu));
  const sauceConfigByDetail = await buildCatalogSauceConfigByDetail(rows);

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

  const items = rows.map((row) =>
    mapCatalogItem({
      row,
      recipeAvailabilityMap,
      comboAvailabilityMap,
      sauceConfigByDetail
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
    idDetalleMenu
  });

  if (!row) {
    throw buildHttpError(404, 'El item no existe en el menu vigente de esta sucursal.');
  }
  const sauceConfigByDetail = await buildCatalogSauceConfigByDetail([row]);

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
      sauceConfigByDetail
    })
  };
};

// Servicio: registrar pedido enviado desde el menu publico.
// Regla: pedido asociado al cliente autenticado (sin usuario fallback).
export const createPublicOrderService = async ({
  idSucursal,
  tipoPedido,
  origen = 'public-menu',
  business = {},
  items = [],
  auth = {}
}) => {
  const idUsuario = toPositiveInt(auth?.idUsuario);
  const idCliente = toPositiveInt(auth?.idCliente);
  if (!idUsuario || !idCliente) {
    throw buildHttpError(401, 'Sesion de cliente invalida para registrar el pedido.');
  }

  const businessContext = normalizePublicOrderBusinessContext({
    tipoPedido,
    business
  });

  if (businessContext.requiresTransferProof && !businessContext.pago.comprobante_transferencia) {
    throw buildHttpError(400, 'Debes adjuntar referencia o comprobante de transferencia.');
  }

  if (businessContext.requiresTransferProof && !businessContext.contacto.telefono) {
    throw buildHttpError(400, 'Debes enviar telefono de contacto para pickup/delivery.');
  }

  if (String(tipoPedido || '') === 'delivery' && !businessContext.entrega.direccion) {
    throw buildHttpError(400, 'Debes enviar direccion de entrega para pedidos delivery.');
  }

  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal);
  if (!activeMenu) {
    throw buildHttpError(409, 'La sucursal no tiene menu vigente activo para registrar pedidos.');
  }

  const requestedItems = normalizeRequestedOrderItems(items);
  if (requestedItems.length === 0) {
    throw buildHttpError(400, 'No hay items validos para registrar el pedido.');
  }

  const rows = await fetchCatalogRowsByMenuQuery(Number(activeMenu.id_menu));
  const sauceConfigByDetail = await buildCatalogSauceConfigByDetail(rows);

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

  const catalogItems = rows.map((row) =>
    mapCatalogItem({
      row,
      recipeAvailabilityMap,
      comboAvailabilityMap,
      sauceConfigByDetail
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

  const total = roundMoney(normalizedLines.reduce((sum, line) => sum + line.subtotal, 0));
  const validacionPagoVenceAt = new Date(Date.now() + ORDER_PAYMENT_VALIDATION_WINDOW_MINUTES * 60 * 1000);
  const idEstadoPedido = await resolvePendingStateId();
  if (!idEstadoPedido) {
    throw buildHttpError(
      409,
      'Configuracion incompleta: no existe estado inicial PENDIENTE/POR PAGAR para pedidos.'
    );
  }

  const descripcionEnvio = SERVICE_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL';
  const tipoEntrega = DELIVERY_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL';
  const descripcionPedido = buildPublicOrderDescription({
    origen,
    tipoPedido,
    businessContext
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
        observacion: line.observacion,
        configuracion_menu: line.configuracion_menu
      });
    }

    await client.query('COMMIT');

    return {
      id_pedido: idPedido,
      numero_ticket: buildTicketNumber(idPedido),
      id_sucursal: Number(idSucursal),
      id_cliente: Number(idCliente),
      id_menu: Number(activeMenu.id_menu),
      tipo_pedido: tipoPedido,
      tipo_entrega: tipoEntrega,
      business: businessContext,
      estado: 'PENDIENTE',
      estado_pago: INITIAL_ORDER_PAYMENT_STATE,
      validacion_pago_vence_at: validacionPagoVenceAt.toISOString(),
      total,
      total_items: normalizedLines.reduce((sum, line) => sum + Number(line.cantidad || 0), 0),
      fecha_hora_pedido: pedido?.fecha_hora_pedido || null,
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
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
