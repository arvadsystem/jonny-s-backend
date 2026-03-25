// Validador central para el modulo publico de menu.
// Mantiene parsing de parametros en un solo lugar para evitar duplicaciones en controladores.

const PUBLIC_ORDER_TYPES = new Set(['dine-in', 'pickup', 'delivery']);

// Convierte cualquier valor a entero positivo. Devuelve null si no cumple.
const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

// Helper para devolver errores uniformes de validacion.
const sendValidationError = (res, message) =>
  res.status(400).json({
    ok: false,
    message
  });

// Valida `:id_sucursal` en rutas de sucursal.
export const validateBranchParam = (req, res, next) => {
  const idSucursal = toPositiveInt(req.params.id_sucursal);

  if (!idSucursal) {
    return sendValidationError(res, 'id_sucursal debe ser un entero mayor a 0.');
  }

  req.publicMenu = {
    ...(req.publicMenu || {}),
    idSucursal
  };

  return next();
};

// Valida query de catalogo publico. `id_sucursal` es obligatorio.
export const validateCatalogQuery = (req, res, next) => {
  const idSucursal = toPositiveInt(req.query.id_sucursal);
  const tipoPedidoRaw = String(req.query.tipo_pedido || '').trim().toLowerCase();
  const tipoPedido = tipoPedidoRaw || null;

  if (!idSucursal) {
    return sendValidationError(res, 'id_sucursal es obligatorio y debe ser un entero mayor a 0.');
  }

  if (tipoPedido && !PUBLIC_ORDER_TYPES.has(tipoPedido)) {
    return sendValidationError(res, 'tipo_pedido invalido. Valores permitidos: dine-in, pickup, delivery.');
  }

  req.publicMenu = {
    ...(req.publicMenu || {}),
    idSucursal,
    tipoPedido
  };

  return next();
};

// Valida request de detalle de item. Se exige sucursal para validar menu vigente real.
export const validateItemDetailRequest = (req, res, next) => {
  const idDetalleMenu = toPositiveInt(req.params.id_detalle_menu);
  const idSucursal = toPositiveInt(req.query.id_sucursal);

  if (!idDetalleMenu) {
    return sendValidationError(res, 'id_detalle_menu debe ser un entero mayor a 0.');
  }

  if (!idSucursal) {
    return sendValidationError(res, 'id_sucursal es obligatorio para resolver el item en el menu vigente.');
  }

  req.publicMenu = {
    ...(req.publicMenu || {}),
    idDetalleMenu,
    idSucursal
  };

  return next();
};

// Valida payload para crear pedido desde el menu publico.
export const validateCreateOrderBody = (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const idSucursal = toPositiveInt(body.id_sucursal);
  const tipoPedido = String(body.tipo_pedido || '').trim().toLowerCase();
  const origen = String(body.origen || 'public-menu').trim() || 'public-menu';
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!idSucursal) {
    return sendValidationError(res, 'id_sucursal es obligatorio y debe ser un entero mayor a 0.');
  }

  if (!tipoPedido || !PUBLIC_ORDER_TYPES.has(tipoPedido)) {
    return sendValidationError(res, 'tipo_pedido invalido. Valores permitidos: dine-in, pickup, delivery.');
  }

  if (rawItems.length === 0) {
    return sendValidationError(res, 'Debes enviar al menos un item en el pedido.');
  }

  const items = [];
  for (const rawItem of rawItems) {
    const row = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const idDetalleMenu = toPositiveInt(row.id_detalle_menu);
    const cantidad = toPositiveInt(row.cantidad);

    if (!idDetalleMenu) {
      return sendValidationError(res, 'Cada item debe incluir id_detalle_menu valido (> 0).');
    }

    if (!cantidad) {
      return sendValidationError(res, 'Cada item debe incluir cantidad valida (> 0).');
    }

    items.push({
      id_detalle_menu: idDetalleMenu,
      cantidad
    });
  }

  req.publicMenu = {
    ...(req.publicMenu || {}),
    idSucursal,
    tipoPedido,
    origen,
    items
  };

  return next();
};
