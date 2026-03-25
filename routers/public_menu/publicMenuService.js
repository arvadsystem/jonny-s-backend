import pool from '../../config/db-connection.js';
import {
  PUBLIC_ITEM_TYPES,
  fetchActiveMenuByBranchQuery,
  fetchCatalogItemByIdQuery,
  fetchCatalogRowsByMenuQuery,
  fetchComboAvailabilityQuery,
  fetchEstadoPedidoRowsQuery,
  fetchFallbackOrderUserIdQuery,
  fetchPublicBranchesQuery,
  fetchRecipeAvailabilityQuery,
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

const ORDER_STATE_ALIASES = Object.freeze(['pendiente']);

// Crea errores HTTP controlados para que el controlador responda con status consistente.
const buildHttpError = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

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

// Normaliza booleans provenientes de PG.
const toBoolean = (value) => value === true || value === 'true' || value === 1 || value === '1';

// Convierte filas de sucursales al contrato publico.
const mapBranch = (row) => ({
  id: Number(row.id_sucursal),
  name: row.nombre_sucursal,
  address: row.direccion || 'Direccion no disponible',
  isOpen: toBoolean(row.estado)
});

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
const mapCatalogItem = ({ row, recipeAvailabilityMap, comboAvailabilityMap }) => {
  const price = resolvePricePayload(row);
  const availability = row.tipo_item === PUBLIC_ITEM_TYPES.PRODUCTO
    ? resolveProductAvailability(row)
    : resolveComposedAvailability({ row, recipeAvailabilityMap, comboAvailabilityMap });

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
  const match = rows.find((row) => ORDER_STATE_ALIASES.includes(normalizeTextKey(row?.descripcion)));
  const id = Number(match?.id_estado_pedido || 0);
  return id > 0 ? id : null;
};

const normalizeRequestedOrderItems = (items = []) => {
  const merged = new Map();

  (Array.isArray(items) ? items : []).forEach((row) => {
    const idDetalleMenu = toPositiveInt(row?.id_detalle_menu);
    const cantidad = toPositiveInt(row?.cantidad);
    if (!idDetalleMenu || !cantidad) return;

    const current = merged.get(idDetalleMenu) || 0;
    merged.set(idDetalleMenu, current + cantidad);
  });

  return Array.from(merged.entries()).map(([idDetalleMenu, cantidad]) => ({
    id_detalle_menu: idDetalleMenu,
    cantidad
  }));
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
    mapCatalogItem({ row, recipeAvailabilityMap, comboAvailabilityMap })
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
    item: mapCatalogItem({ row, recipeAvailabilityMap, comboAvailabilityMap })
  };
};

// Servicio: registrar pedido enviado desde el menu publico (sin login dashboard).
export const createPublicOrderService = async ({ idSucursal, tipoPedido, origen = 'public-menu', items = [] }) => {
  const activeMenu = await fetchActiveMenuByBranchQuery(idSucursal);
  if (!activeMenu) {
    throw buildHttpError(409, 'La sucursal no tiene menu vigente activo para registrar pedidos.');
  }

  const requestedItems = normalizeRequestedOrderItems(items);
  if (requestedItems.length === 0) {
    throw buildHttpError(400, 'No hay items validos para registrar el pedido.');
  }

  const rows = await fetchCatalogRowsByMenuQuery(Number(activeMenu.id_menu));

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
    mapCatalogItem({ row, recipeAvailabilityMap, comboAvailabilityMap })
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

    const precioUnitario = toNumberOrNull(catalog?.precio?.final);
    if (precioUnitario === null || precioUnitario <= 0) {
      throw buildHttpError(400, `El item ${catalog.nombre} no tiene precio valido para registrar pedido.`);
    }

    const cantidad = toPositiveInt(line.cantidad);
    const subtotal = roundMoney(precioUnitario * cantidad);

    return {
      id_detalle_menu: Number(catalog.id_detalle_menu),
      tipo_item: String(catalog.tipo_item || 'PRODUCTO'),
      id_producto: catalog.id_producto ? Number(catalog.id_producto) : null,
      id_combo: catalog.id_combo ? Number(catalog.id_combo) : null,
      id_receta: catalog.id_receta ? Number(catalog.id_receta) : null,
      nombre: catalog.nombre,
      cantidad,
      precio_unitario: roundMoney(precioUnitario),
      subtotal
    };
  });

  const total = roundMoney(normalizedLines.reduce((sum, line) => sum + line.subtotal, 0));
  const idEstadoPedido = await resolvePendingStateId();
  if (!idEstadoPedido) {
    throw buildHttpError(500, 'No existe estado PENDIENTE en estados_pedido.');
  }

  const idUsuario = await fetchFallbackOrderUserIdQuery();
  if (!idUsuario) {
    throw buildHttpError(500, 'No hay usuario disponible para registrar pedidos publicos.');
  }

  const descripcionEnvio = SERVICE_TYPE_BY_ORDER_TYPE[tipoPedido] || 'LOCAL';
  const descripcionPedido = `[${origen}] pedido web`;

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
      id_usuario: Number(idUsuario)
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
        observacion: null
      });
    }

    await client.query('COMMIT');

    return {
      id_pedido: idPedido,
      numero_ticket: buildTicketNumber(idPedido),
      id_sucursal: Number(idSucursal),
      id_menu: Number(activeMenu.id_menu),
      tipo_pedido: tipoPedido,
      estado: 'PENDIENTE',
      total,
      total_items: normalizedLines.reduce((sum, line) => sum + Number(line.cantidad || 0), 0),
      fecha_hora_pedido: pedido?.fecha_hora_pedido || null,
      items: normalizedLines.map((line) => ({
        id_detalle_menu: line.id_detalle_menu,
        tipo_item: line.tipo_item,
        nombre: line.nombre,
        cantidad: line.cantidad,
        precio_unitario: line.precio_unitario,
        subtotal: line.subtotal
      }))
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
