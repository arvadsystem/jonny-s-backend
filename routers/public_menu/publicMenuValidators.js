import { sendPublicMenuClientError } from './publicMenuResponse.js';

// Validador central para el modulo publico de menu.
// Mantiene parsing de parametros en un solo lugar para evitar duplicaciones en controladores.

const PUBLIC_ORDER_TYPES = new Set(['dine-in', 'pickup', 'delivery']);
const ORDER_TYPES_REQUIRING_TRANSFER_PROOF = new Set(['pickup', 'delivery']);
const TRANSFER_METHOD_ALIASES = new Set(['transferencia', 'transferencia_bancaria', 'transfer']);
const MAX_ORDER_TEXT = Object.freeze({
  ORIGEN: 60,
  IDEMPOTENCY_KEY: 120,
  CONTACT_NAME: 120,
  CONTACT_PHONE: 30,
  DELIVERY_ADDRESS: 240,
  DELIVERY_REFERENCE: 160,
  TRANSFER_RECEIPT: 180,
  ITEM_NOTE: 100
});

// Convierte cualquier valor a entero positivo. Devuelve null si no cumple.
const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

// Helper para devolver errores uniformes de validacion.
const sendValidationError = (req, res, message) =>
  sendPublicMenuClientError(req, res, {
    status: 400,
    code: 'PUBLIC_MENU_VALIDATION_ERROR',
    message
  });

const normalizeCompactText = (value, maxLength) => {
  const clean = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

  if (!clean) return '';
  if (!Number.isInteger(maxLength) || maxLength <= 0) return clean;
  return clean.slice(0, maxLength);
};

const normalizeIdempotencyKey = (value) =>
  normalizeCompactText(value, MAX_ORDER_TEXT.IDEMPOTENCY_KEY)
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/g, '');

const normalizeTransferMethod = (value) => {
  const clean = normalizeCompactText(value, 40).toLowerCase();
  if (!clean) return '';
  return clean
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
};

const normalizeOrderBusinessContext = ({ body, tipoPedido }) => {
  const contactoRaw = body?.contacto && typeof body.contacto === 'object' ? body.contacto : {};
  const entregaRaw = body?.entrega && typeof body.entrega === 'object' ? body.entrega : {};
  const pagoRaw = body?.pago && typeof body.pago === 'object' ? body.pago : {};

  const contacto = {
    nombre: normalizeCompactText(
      contactoRaw.nombre ?? body?.nombre_contacto,
      MAX_ORDER_TEXT.CONTACT_NAME
    ),
    telefono: normalizeCompactText(
      contactoRaw.telefono ?? body?.telefono_contacto,
      MAX_ORDER_TEXT.CONTACT_PHONE
    )
  };

  const entrega = {
    direccion: normalizeCompactText(
      entregaRaw.direccion ?? body?.direccion_entrega,
      MAX_ORDER_TEXT.DELIVERY_ADDRESS
    ),
    referencia: normalizeCompactText(
      entregaRaw.referencia ?? body?.referencia_entrega,
      MAX_ORDER_TEXT.DELIVERY_REFERENCE
    )
  };

  const pago = {
    metodo: normalizeTransferMethod(pagoRaw.metodo ?? body?.metodo_pago),
    comprobante_transferencia: normalizeCompactText(
      pagoRaw.comprobante_transferencia ??
        body?.comprobante_transferencia ??
        pagoRaw.referencia ??
        body?.referencia_transferencia,
      MAX_ORDER_TEXT.TRANSFER_RECEIPT
    )
  };

  // Regla de negocio: pickup/delivery requieren comprobante de transferencia.
  const requiresTransferProof = ORDER_TYPES_REQUIRING_TRANSFER_PROOF.has(tipoPedido);
  if (requiresTransferProof && !pago.comprobante_transferencia) {
    return {
      error: 'Debes adjuntar referencia o comprobante de transferencia para pickup y delivery.'
    };
  }

  // Regla de negocio: pickup/delivery exigen al menos un telefono de contacto.
  if (requiresTransferProof && !contacto.telefono) {
    return {
      error: 'Debes enviar telefono de contacto para pickup y delivery.'
    };
  }

  // Regla de negocio: delivery exige direccion.
  if (tipoPedido === 'delivery' && !entrega.direccion) {
    return {
      error: 'Debes enviar direccion de entrega para pedidos delivery.'
    };
  }

  if (requiresTransferProof && pago.metodo && !TRANSFER_METHOD_ALIASES.has(pago.metodo)) {
    return {
      error: 'metodo_pago invalido para pickup/delivery. Usa transferencia.'
    };
  }

  if (requiresTransferProof && !pago.metodo) {
    pago.metodo = 'transferencia';
  }

  return {
    data: {
      contacto,
      entrega,
      pago
    }
  };
};

const normalizeExtraSelection = (entry) => {
  const idExtra = String(entry?.id_extra || entry || '').trim();
  if (!idExtra) return null;
  return { id_extra: idExtra };
};

const normalizeSauceSelection = (entry) => {
  const idSalsa = toPositiveInt(entry?.id_salsa);
  const cantidad = toPositiveInt(entry?.cantidad);
  if (!idSalsa || !cantidad) return null;
  return {
    id_salsa: idSalsa,
    cantidad
  };
};

// Valida `:id_sucursal` en rutas de sucursal.
export const validateBranchParam = (req, res, next) => {
  const idSucursal = toPositiveInt(req.params.id_sucursal);

  if (!idSucursal) {
    return sendValidationError(req, res, 'id_sucursal debe ser un entero mayor a 0.');
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
    return sendValidationError(req, res, 'id_sucursal es obligatorio y debe ser un entero mayor a 0.');
  }

  if (tipoPedido && !PUBLIC_ORDER_TYPES.has(tipoPedido)) {
    return sendValidationError(req, res, 'tipo_pedido invalido. Valores permitidos: dine-in, pickup, delivery.');
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
    return sendValidationError(req, res, 'id_detalle_menu debe ser un entero mayor a 0.');
  }

  if (!idSucursal) {
    return sendValidationError(req, res, 'id_sucursal es obligatorio para resolver el item en el menu vigente.');
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
  const origen = normalizeCompactText(body.origen || 'public-menu', MAX_ORDER_TEXT.ORIGEN) || 'public-menu';
  const idempotencyKey = normalizeIdempotencyKey(body.idempotency_key);
  const rawItems = Array.isArray(body.items) ? body.items : [];

  if (!idSucursal) {
    return sendValidationError(req, res, 'id_sucursal es obligatorio y debe ser un entero mayor a 0.');
  }

  if (!tipoPedido || !PUBLIC_ORDER_TYPES.has(tipoPedido)) {
    return sendValidationError(req, res, 'tipo_pedido invalido. Valores permitidos: dine-in, pickup, delivery.');
  }

  if (!idempotencyKey || idempotencyKey.length < 12) {
    return sendValidationError(
      req,
      res,
      'idempotency_key es obligatorio y debe tener al menos 12 caracteres validos.'
    );
  }

  if (rawItems.length === 0) {
    return sendValidationError(req, res, 'Debes enviar al menos un item en el pedido.');
  }

  const businessContextResult = normalizeOrderBusinessContext({ body, tipoPedido });
  if (businessContextResult?.error) {
    return sendValidationError(req, res, businessContextResult.error);
  }

  const items = [];
  for (const rawItem of rawItems) {
    const row = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const idDetalleMenu = toPositiveInt(row.id_detalle_menu);
    const cantidad = toPositiveInt(row.cantidad);

    if (!idDetalleMenu) {
      return sendValidationError(req, res, 'Cada item debe incluir id_detalle_menu valido (> 0).');
    }

    if (!cantidad) {
      return sendValidationError(req, res, 'Cada item debe incluir cantidad valida (> 0).');
    }

    if (row.extras !== undefined && !Array.isArray(row.extras)) {
      return sendValidationError(req, res, 'extras debe ser un arreglo cuando se envia en el item.');
    }

    if (row.salsas_por_unidad !== undefined && !Array.isArray(row.salsas_por_unidad)) {
      return sendValidationError(req, res, 'salsas_por_unidad debe ser un arreglo cuando se envia en el item.');
    }

    const extras = (Array.isArray(row.extras) ? row.extras : [])
      .map(normalizeExtraSelection)
      .filter(Boolean);

    const salsasPorUnidad = (Array.isArray(row.salsas_por_unidad) ? row.salsas_por_unidad : [])
      .map(normalizeSauceSelection)
      .filter(Boolean);

    // Nota del cliente por item (ej. "sin cebolla"), limitada para evitar abuso.
    const nota = normalizeCompactText(row.nota ?? row.observacion_cliente ?? '', MAX_ORDER_TEXT.ITEM_NOTE);

    items.push({
      id_detalle_menu: idDetalleMenu,
      cantidad,
      extras,
      salsas_por_unidad: salsasPorUnidad,
      nota
    });
  }

  req.publicMenu = {
    ...(req.publicMenu || {}),
    idSucursal,
    tipoPedido,
    origen,
    idempotencyKey,
    business: businessContextResult?.data || {
      contacto: { nombre: '', telefono: '' },
      entrega: { direccion: '', referencia: '' },
      pago: { metodo: '', comprobante_transferencia: '' }
    },
    items
  };

  return next();
};

