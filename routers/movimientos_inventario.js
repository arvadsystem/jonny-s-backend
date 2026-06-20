import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();

// ==============================
// KARDEX APPEND-ONLY
// TABLA: movimientos_inventario
// VISTA: public.v_kardex_detalle
// ==============================
const VALID_TIPOS = new Set(['ENTRADA', 'SALIDA', 'AJUSTE']);
const MOVIMIENTOS_VIEW_PERMISSIONS = ['INVENTARIO_MOVIMIENTOS_VER'];
const MOVIMIENTOS_CREATE_PERMISSIONS = ['INVENTARIO_MOVIMIENTOS_CREAR'];
const MOVIMIENTOS_EDIT_PERMISSIONS = ['INVENTARIO_MOVIMIENTOS_EDITAR'];
const MOVIMIENTOS_DELETE_PERMISSIONS = ['INVENTARIO_MOVIMIENTOS_ELIMINAR'];
const MOVIMIENTOS_DEFAULT_PAGE = 1;
const MOVIMIENTOS_DEFAULT_PAGE_SIZE = 10;
const MOVIMIENTOS_MAX_PAGE_SIZE = 100;
const MOVIMIENTOS_REFERENCIAS_DEFAULT_LIMIT = 200;
const MOVIMIENTOS_REFERENCIAS_MAX_LIMIT = 500;
const ITEM_TIPO_MAP = new Map([
  ['producto', 'Producto'],
  ['insumo', 'Insumo'],
  ['Producto', 'Producto'],
  ['Insumo', 'Insumo']
]);
const APPEND_ONLY_MESSAGE = 'KARDEX NO PERMITE EDITAR/ELIMINAR. CREE UN NUEVO MOVIMIENTO.';
const MOVIMIENTOS_SCOPE_FORBIDDEN_MESSAGE =
  'No tiene permisos para operar sobre recursos fuera de su sucursal.';
const MOVIMIENTOS_SCOPE_MISSING_BRANCHES_MESSAGE = 'El empleado no tiene sucursales asignadas.';
const MOVIMIENTOS_ALMACEN_NOT_FOUND_MESSAGE = 'Almacen no encontrado.';

const hasValue = (value) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === 'string' && value.trim() === '');

const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({
    ok: false,
    error: true,
    code,
    message,
    ...extra
  });

const sendValidationError = (res, message, details) =>
  sendError(res, 400, 'VALIDATION_ERROR', message, details ? { details } : {});

const sendConflictError = (res, message) =>
  sendError(res, 409, 'CONFLICT', message);

const SHOULD_INCLUDE_ERROR_STACK = ['development', 'dev', 'local'].includes(
  String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase()
);

const truncateLogValue = (value, maxLength = 280) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
};

const looksSensitiveErrorMessage = (message) =>
  /\b(select|insert|update|delete|from|where|join)\b/i.test(String(message || '')) ||
  /public\./i.test(String(message || ''));

const sanitizeErrorForLog = (error) => {
  const rawMessage = truncateLogValue(error?.message || 'Unexpected error');
  const safeMessage = looksSensitiveErrorMessage(rawMessage)
    ? 'Database error details hidden.'
    : rawMessage;

  const safeError = {
    name: truncateLogValue(error?.name || 'Error', 120) || 'Error',
    code: truncateLogValue(error?.code || '', 80) || null,
    message: safeMessage
  };

  if (SHOULD_INCLUDE_ERROR_STACK && typeof error?.stack === 'string') {
    safeError.stack = truncateLogValue(
      error.stack
        .split('\n')
        .slice(0, 6)
        .join('\n'),
      1200
    );
  }

  return safeError;
};

const logRouterError = (context, error, { category = 'INTERNAL_ERROR' } = {}) => {
  const safeContext = truncateLogValue(context || 'Unhandled context', 160) || 'Unhandled context';
  const safeError = sanitizeErrorForLog(error);
  console.error('[movimientos_inventario] error', {
    category,
    context: safeContext,
    ...safeError
  });
};

const sendInternalError = (
  res,
  context,
  error,
  publicMessage = 'Error interno al consultar movimientos de inventario.'
) => {
  logRouterError(context, error, { category: 'INTERNAL_ERROR' });
  return sendError(res, 500, 'INTERNAL_ERROR', publicMessage);
};

const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

const isPositiveDecimal = (value) => Number.isFinite(value) && value > 0;
const isNonNegativeDecimal = (value) => Number.isFinite(value) && value >= 0;

// NEW: NORMALIZA IDS NUMERICOS OPCIONALES PARA QUERIES Y PAYLOADS.
// WHY: EVITA CASTEOS IMPLICITOS, MENSAJES OPACOS DE POSTGRES Y DUPLICACION DE VALIDACIONES.
// IMPACT: SI EL DATO NO EXISTE, EL FILTRO NO SE APLICA; SI ES INVALIDO, RESPONDE 400.
const parseOptionalPositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null, error: null };
  }

  const normalizedValue = Number(rawValue);
  if (!isPositiveIntegerId(normalizedValue)) {
    return {
      provided: true,
      value: null,
      error: `${fieldName} debe ser un entero mayor a 0.`
    };
  }

  return { provided: true, value: normalizedValue, error: null };
};

const parseRequiredPositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { ok: false, value: null, error: `${fieldName} es obligatorio.` };
  }

  const normalizedValue = Number(rawValue);
  if (!isPositiveIntegerId(normalizedValue)) {
    return { ok: false, value: null, error: `${fieldName} debe ser un entero mayor a 0.` };
  }

  return { ok: true, value: normalizedValue, error: null };
};

const normalizeScopeSucursalIds = (rawIds) =>
  Array.from(
    new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .map((value) => Number.parseInt(String(value ?? '').trim(), 10))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );

const getRequestMovimientosScope = async (req, db = pool) => {
  if (req?.__movimientosScope) return req.__movimientosScope;

  const resolvedScope = await resolveRequestUserSucursalScope(req, db);
  const scope = {
    isSuperAdmin: Boolean(resolvedScope?.isSuperAdmin),
    allowedSucursalIds: normalizeScopeSucursalIds(resolvedScope?.allowedSucursalIds)
  };

  if (req) req.__movimientosScope = scope;
  return scope;
};

const ensureMovimientosScopeAvailable = (res, scope) => {
  if (scope?.isSuperAdmin) return true;
  if (Array.isArray(scope?.allowedSucursalIds) && scope.allowedSucursalIds.length > 0) return true;

  sendError(res, 403, 'FORBIDDEN', MOVIMIENTOS_SCOPE_MISSING_BRANCHES_MESSAGE);
  return false;
};

const ensureMovimientosSucursalInScope = (res, scope, idSucursal) => {
  if (scope?.isSuperAdmin) return true;
  if (!Array.isArray(scope?.allowedSucursalIds) || scope.allowedSucursalIds.length === 0) {
    sendError(res, 403, 'FORBIDDEN', MOVIMIENTOS_SCOPE_MISSING_BRANCHES_MESSAGE);
    return false;
  }

  if (!scope.allowedSucursalIds.includes(Number(idSucursal))) {
    sendError(res, 403, 'FORBIDDEN', MOVIMIENTOS_SCOPE_FORBIDDEN_MESSAGE);
    return false;
  }

  return true;
};

const findAlmacenScopeRowById = async (idAlmacen, db = pool) => {
  const result = await db.query(
    `
      SELECT id_almacen, id_sucursal
      FROM public.almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [idAlmacen]
  );

  return result.rows?.[0] || null;
};

const ensureAlmacenIdInMovimientosScope = async (
  req,
  res,
  idAlmacen,
  {
    scope = null,
    db = pool,
    notFoundMessage = MOVIMIENTOS_ALMACEN_NOT_FOUND_MESSAGE,
    shouldMaskOutOfScope = true
  } = {}
) => {
  const resolvedScope = scope || (await getRequestMovimientosScope(req, db));
  if (!ensureMovimientosScopeAvailable(res, resolvedScope)) {
    return { ok: false, scope: resolvedScope, almacen: null };
  }

  if (resolvedScope.isSuperAdmin) {
    return { ok: true, scope: resolvedScope, almacen: await findAlmacenScopeRowById(idAlmacen, db) };
  }

  const almacen = await findAlmacenScopeRowById(idAlmacen, db);
  if (!almacen) {
    return { ok: true, scope: resolvedScope, almacen: null };
  }

  const idSucursal = Number.parseInt(String(almacen?.id_sucursal ?? '').trim(), 10);
  if (!Number.isInteger(idSucursal) || !resolvedScope.allowedSucursalIds.includes(idSucursal)) {
    if (shouldMaskOutOfScope) {
      sendError(res, 404, 'NOT_FOUND', notFoundMessage);
    } else {
      sendError(res, 403, 'FORBIDDEN', MOVIMIENTOS_SCOPE_FORBIDDEN_MESSAGE);
    }
    return { ok: false, scope: resolvedScope, almacen: null };
  }

  return { ok: true, scope: resolvedScope, almacen };
};

const parseOptionalTipo = (rawValue) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null, error: null };
  }

  const normalizedValue = String(rawValue).trim().toUpperCase();
  if (!VALID_TIPOS.has(normalizedValue)) {
    return {
      provided: true,
      value: null,
      error: 'tipo debe ser ENTRADA, SALIDA o AJUSTE.'
    };
  }

  return { provided: true, value: normalizedValue, error: null };
};

const parseOptionalItemTipo = (rawValue) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null, error: null };
  }

  const normalizedValue = ITEM_TIPO_MAP.get(String(rawValue).trim());
  if (!normalizedValue) {
    return {
      provided: true,
      value: null,
      error: 'item_tipo debe ser Producto o Insumo.'
    };
  }

  return { provided: true, value: normalizedValue, error: null };
};

const parseOptionalDate = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null, error: null };
  }

  const normalizedValue = String(rawValue).trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(normalizedValue)) {
    return {
      provided: true,
      value: null,
      error: `${fieldName} debe tener formato YYYY-MM-DD.`
    };
  }

  const [yearRaw, monthRaw, dayRaw] = normalizedValue.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  // FIX IMPORTANTE: valida fecha calendario real para evitar casos como 2024-02-31 que JS autocorrige.
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  const isSameCalendarDate =
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day;

  if (!isSameCalendarDate) {
    return {
      provided: true,
      value: null,
      error: `${fieldName} no es una fecha valida.`
    };
  }

  return { provided: true, value: normalizedValue, error: null };
};

const parseOptionalText = (rawValue) => {
  if (!hasValue(rawValue)) {
    return { provided: false, value: null };
  }

  const normalizedValue = String(rawValue).trim();
  return normalizedValue ? { provided: true, value: normalizedValue } : { provided: false, value: null };
};

const parseReferenciaItemTipo = (rawValue) => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: 'item_tipo es obligatorio. Use producto o insumo.' };
  }

  const normalizedValue = String(rawValue).trim().toLowerCase();
  if (!['producto', 'insumo'].includes(normalizedValue)) {
    return { ok: false, error: 'item_tipo debe ser producto o insumo.' };
  }

  return { ok: true, value: normalizedValue };
};

const parseReferencesLimit = (query = {}) => {
  const parsed = parseOptionalPositiveInt(query?.limit ?? query?.pageSize ?? query?.page_size, 'limit');
  if (parsed.error) {
    return { ok: false, error: parsed.error };
  }

  const limit = parsed.provided ? parsed.value : MOVIMIENTOS_REFERENCIAS_DEFAULT_LIMIT;
  if (limit > MOVIMIENTOS_REFERENCIAS_MAX_LIMIT) {
    return {
      ok: false,
      error: `limit no puede ser mayor a ${MOVIMIENTOS_REFERENCIAS_MAX_LIMIT}.`
    };
  }

  return { ok: true, value: limit };
};

const parsePaginationQuery = (query = {}) => {
  const pageResult = parseOptionalPositiveInt(query?.page, 'page');
  if (pageResult.error) {
    return { ok: false, error: pageResult.error };
  }

  const rawPageSize = query?.pageSize ?? query?.page_size ?? query?.limit;
  const pageSizeResult = parseOptionalPositiveInt(rawPageSize, 'pageSize');
  if (pageSizeResult.error) {
    return { ok: false, error: pageSizeResult.error };
  }

  const page = pageResult.provided ? pageResult.value : MOVIMIENTOS_DEFAULT_PAGE;
  const pageSize = pageSizeResult.provided ? pageSizeResult.value : MOVIMIENTOS_DEFAULT_PAGE_SIZE;

  if (pageSize > MOVIMIENTOS_MAX_PAGE_SIZE) {
    return {
      ok: false,
      error: `pageSize no puede ser mayor a ${MOVIMIENTOS_MAX_PAGE_SIZE}.`
    };
  }

  return {
    ok: true,
    page,
    pageSize,
    offset: (page - 1) * pageSize
  };
};

const buildPaginatedPayload = ({ items, page, pageSize, total }) => {
  const safeItems = Array.isArray(items) ? items : [];
  const safeTotal = Number.isInteger(Number(total)) ? Number(total) : 0;
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));

  return {
    ok: true,
    items: safeItems,
    data: safeItems,
    pagination: {
      page,
      pageSize,
      total: safeTotal,
      totalPages
    }
  };
};

// NEW: CENTRALIZA LA VALIDACION DEL PAYLOAD DE ALTA PARA RESPETAR EL KARDEX APPEND-ONLY.
// WHY: EL CLIENTE NO DEBE PODER ENVIAR SALDOS NI MOVIMIENTOS AMBIGUOS ENTRE PRODUCTO/INSUMO.
// IMPACT: POST DEVUELVE 400 CON MENSAJES CLAROS ANTES DE TOCAR LA BD.
const normalizeMovimientoPayload = (payload) => {
  const errors = [];

  const tipoResult = parseOptionalTipo(payload?.tipo);
  if (!tipoResult.provided) errors.push('tipo es obligatorio.');
  if (tipoResult.error) errors.push(tipoResult.error);
  const tipo = tipoResult.value;

  const cantidadRaw = Number(payload?.cantidad);
  if (!hasValue(payload?.cantidad)) {
    errors.push('cantidad es obligatoria.');
  } else if (tipo === 'AJUSTE' ? !isNonNegativeDecimal(cantidadRaw) : !isPositiveDecimal(cantidadRaw)) {
    errors.push(
      tipo === 'AJUSTE'
        ? 'La existencia final debe ser un numero mayor o igual a 0.'
        : 'La cantidad debe ser un numero mayor que 0.'
    );
  }

  const almacenResult = parseRequiredPositiveInt(payload?.id_almacen, 'id_almacen');
  if (!almacenResult.ok) errors.push(almacenResult.error);

  const productoResult = parseOptionalPositiveInt(payload?.id_producto, 'id_producto');
  if (productoResult.error) errors.push(productoResult.error);

  const insumoResult = parseOptionalPositiveInt(payload?.id_insumo, 'id_insumo');
  if (insumoResult.error) errors.push(insumoResult.error);

  const hasProducto = productoResult.provided;
  const hasInsumo = insumoResult.provided;
  if (hasProducto && hasInsumo) {
    errors.push('No puede enviar id_producto e id_insumo al mismo tiempo.');
  } else if (!hasProducto && !hasInsumo) {
    errors.push('Debe enviar id_producto o id_insumo.');
  }

  const idRefResult = parseOptionalPositiveInt(payload?.id_ref, 'id_ref');
  if (idRefResult.error) errors.push(idRefResult.error);

  const refOrigen = hasValue(payload?.ref_origen) ? String(payload.ref_origen).trim() : null;
  const descripcion = hasValue(payload?.descripcion) ? String(payload.descripcion).trim() : null;

  return {
    ok: errors.length === 0,
    errors,
    values: {
      tipo,
      cantidad: tipo === 'AJUSTE'
        ? (isNonNegativeDecimal(cantidadRaw) ? cantidadRaw : null)
        : (isPositiveDecimal(cantidadRaw) ? cantidadRaw : null),
      id_almacen: almacenResult.value,
      id_producto: hasProducto ? productoResult.value : null,
      id_insumo: hasInsumo ? insumoResult.value : null,
      ref_origen: refOrigen || null,
      id_ref: idRefResult.provided ? idRefResult.value : null,
      descripcion: descripcion || null
    }
  };
};

const buildMovimientoItemPayload = (itemTipo, idItem) =>
  itemTipo === 'producto' ? { id_producto: idItem, id_insumo: null } : { id_producto: null, id_insumo: idItem };

const buildMovimientoInsertValues = ({ tipo, cantidad, id_almacen, item_tipo, id_item, ref_origen, id_ref, descripcion }) => {
  const movementItem = buildMovimientoItemPayload(item_tipo, id_item);

  return [
    tipo,
    cantidad,
    id_almacen,
    movementItem.id_producto,
    movementItem.id_insumo,
    ref_origen ?? null,
    id_ref ?? null,
    descripcion ?? null
  ];
};

const insertMovimiento = async (client, movement) => {
  const result = await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        ref_origen,
        id_ref,
        descripcion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id_movimiento
    `,
    buildMovimientoInsertValues(movement)
  );

  return result.rows[0]?.id_movimiento ?? null;
};

const getKardexRowByMovimientoId = async (client, idMovimiento) => {
  const result = await client.query(
    'SELECT * FROM public.v_kardex_detalle WHERE id_movimiento = $1 LIMIT 1',
    [idMovimiento]
  );

  return result.rows[0] || null;
};

const validateOperationalEntities = async ({ id_almacen, id_producto, id_insumo }, db = pool) => {
  const almacenResult = await db.query(
    `
      SELECT id_almacen, COALESCE(estado, true) AS estado
      FROM public.almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [id_almacen]
  );

  if (almacenResult.rowCount === 0) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'EL ALMACEN SELECCIONADO NO EXISTE.' };
  }

  if (!Boolean(almacenResult.rows?.[0]?.estado)) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'El almacen seleccionado esta inactivo.' };
  }

  if (id_producto) {
    const productoResult = await db.query(
      `
        SELECT id_producto, COALESCE(estado, true) AS estado
        FROM public.productos
        WHERE id_producto = $1
        LIMIT 1
      `,
      [id_producto]
    );

    if (productoResult.rowCount === 0) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'EL PRODUCTO SELECCIONADO NO EXISTE.' };
    }

    if (!Boolean(productoResult.rows?.[0]?.estado)) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'El producto esta inactivo.' };
    }
  }

  if (id_insumo) {
    const insumoResult = await db.query(
      `
        SELECT id_insumo, COALESCE(estado, true) AS estado
        FROM public.insumos
        WHERE id_insumo = $1
        LIMIT 1
      `,
      [id_insumo]
    );

    if (insumoResult.rowCount === 0) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'EL INSUMO SELECCIONADO NO EXISTE.' };
    }

    if (!Boolean(insumoResult.rows?.[0]?.estado)) {
      return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'El insumo esta inactivo.' };
    }
  }

  return { ok: true };
};

// NEW: TRADUCE ERRORES DE POSTGRES/TRIGGERS A MENSAJES DE DOMINIO MAS CLAROS.
// WHY: EL KARDEX USA TRIGGERS/REGLAS DE BD Y EL FRONT NECESITA FEEDBACK ENTENDIBLE.
// IMPACT: FALLAS DE STOCK, FK O VALIDACIONES DEL TRIGGER BAJAN COMO 400 CON MENSAJE LEGIBLE.
const normalizeMovimientoDbError = (error) => {
  const rawMessage = String(error?.message ?? '').trim();
  const lowerMessage = rawMessage.toLowerCase();

  if (error?.code === 'P0001') {
    if (
      lowerMessage.includes('stock insuficiente') ||
      lowerMessage.includes('pertenece a otro almacen') ||
      lowerMessage.includes('pertenece a otro almac') ||
      lowerMessage.includes('no pertenece al almacen')
    ) {
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'No se pudo registrar el movimiento por conflicto de stock o de almacen.'
      };
    }

    return { status: 400, code: 'VALIDATION_ERROR', message: 'No se pudo registrar el movimiento.' };
  }

  if (error?.code === '23503') {
    if (lowerMessage.includes('id_almacen')) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'EL ALMACEN SELECCIONADO NO EXISTE.' };
    }
    if (lowerMessage.includes('id_producto')) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'EL PRODUCTO SELECCIONADO NO EXISTE.' };
    }
    if (lowerMessage.includes('id_insumo')) {
      return { status: 400, code: 'VALIDATION_ERROR', message: 'EL INSUMO SELECCIONADO NO EXISTE.' };
    }
    return { status: 400, code: 'VALIDATION_ERROR', message: 'EL MOVIMIENTO REFERENCIA DATOS QUE NO EXISTEN.' };
  }

  if (error?.code === '23514' || error?.code === '22003' || error?.code === '22P02') {
    return { status: 400, code: 'VALIDATION_ERROR', message: 'LOS DATOS DEL MOVIMIENTO SON INVALIDOS.' };
  }

  if (
    lowerMessage.includes('stock insuficiente') ||
    lowerMessage.includes('pertenece a otro almacen') ||
    lowerMessage.includes('pertenece a otro almac') ||
    lowerMessage.includes('no pertenece al almacen')
  ) {
    return {
      status: 409,
      code: 'CONFLICT',
      message: 'No se pudo registrar el movimiento por conflicto de stock o de almacen.'
    };
  }

  return null;
};

// GET: REFERENCIAS OPERATIVAS PARA FORMULARIO DE MOVIMIENTOS
router.get('/movimientos_inventario/referencias', checkPermission(MOVIMIENTOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const itemTipo = parseReferenciaItemTipo(req.query?.item_tipo);
    if (!itemTipo.ok) {
      return sendValidationError(res, itemTipo.error);
    }

    const idAlmacenFilter = parseOptionalPositiveInt(req.query?.id_almacen, 'id_almacen');
    if (idAlmacenFilter.error) {
      return sendValidationError(res, idAlmacenFilter.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const scope = await getRequestMovimientosScope(req);
    if (!ensureMovimientosScopeAvailable(res, scope)) {
      return;
    }
    if (
      idSucursalFilter.provided &&
      !ensureMovimientosSucursalInScope(res, scope, idSucursalFilter.value)
    ) {
      return;
    }
    if (idAlmacenFilter.provided) {
      const almacenScopeCheck = await ensureAlmacenIdInMovimientosScope(
        req,
        res,
        idAlmacenFilter.value,
        { scope, shouldMaskOutOfScope: true }
      );
      if (!almacenScopeCheck.ok) return;
    }

    if (!idAlmacenFilter.provided && !idSucursalFilter.provided) {
      return sendValidationError(res, 'Debe enviar id_almacen o id_sucursal para cargar referencias.');
    }

    const parsedLimit = parseReferencesLimit(req.query || {});
    if (!parsedLimit.ok) {
      return sendValidationError(res, parsedLimit.error);
    }

    const queryByItemType = itemTipo.value === 'producto'
      ? `
        SELECT
          item.id_producto,
          item.nombre_producto,
          pa.id_almacen,
          COALESCE(pa.cantidad, 0)::numeric AS cantidad_disponible
        FROM public.productos_almacenes pa
        INNER JOIN public.productos item ON item.id_producto = pa.id_producto
        INNER JOIN public.almacenes a ON a.id_almacen = pa.id_almacen
        WHERE COALESCE(pa.estado, true) = true
          AND COALESCE(item.estado, true) = true
          AND COALESCE(a.estado, true) = true
          AND ($1::int IS NULL OR pa.id_almacen = $1)
          AND ($2::int IS NULL OR a.id_sucursal = $2)
          AND ($4::boolean = true OR a.id_sucursal = ANY($5::int[]))
        ORDER BY item.nombre_producto ASC, item.id_producto ASC
        LIMIT $3
      `
      : `
        SELECT
          item.id_insumo,
          item.nombre_insumo,
          ia.id_almacen,
          COALESCE(ia.cantidad, 0)::numeric AS cantidad_disponible
        FROM public.insumos_almacenes ia
        INNER JOIN public.insumos item ON item.id_insumo = ia.id_insumo
        INNER JOIN public.almacenes a ON a.id_almacen = ia.id_almacen
        WHERE COALESCE(ia.estado, true) = true
          AND COALESCE(item.estado, true) = true
          AND COALESCE(a.estado, true) = true
          AND ($1::int IS NULL OR ia.id_almacen = $1)
          AND ($2::int IS NULL OR a.id_sucursal = $2)
          AND ($4::boolean = true OR a.id_sucursal = ANY($5::int[]))
        ORDER BY item.nombre_insumo ASC, item.id_insumo ASC
        LIMIT $3
      `;

    const queryResult = await pool.query(queryByItemType, [
      idAlmacenFilter.value,
      idSucursalFilter.value,
      parsedLimit.value,
      scope.isSuperAdmin,
      scope.allowedSucursalIds
    ]);

    return res.status(200).json({
      ok: true,
      item_tipo: itemTipo.value,
      items: queryResult.rows || []
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener referencias de movimientos', error);
  }
});

// GET: OBTENER MOVIMIENTOS LEGADO
router.get('/movimientos_inventario', checkPermission(MOVIMIENTOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const pagination = parsePaginationQuery(req.query || {});
    if (!pagination.ok) {
      return sendValidationError(res, pagination.error);
    }

    const idAlmacenFilter = parseOptionalPositiveInt(req.query?.id_almacen, 'id_almacen');
    if (idAlmacenFilter.error) {
      return sendValidationError(res, idAlmacenFilter.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const scope = await getRequestMovimientosScope(req);
    if (!ensureMovimientosScopeAvailable(res, scope)) {
      return;
    }
    if (
      idSucursalFilter.provided &&
      !ensureMovimientosSucursalInScope(res, scope, idSucursalFilter.value)
    ) {
      return;
    }

    if (idAlmacenFilter.provided) {
      const almacenScopeCheck = await ensureAlmacenIdInMovimientosScope(
        req,
        res,
        idAlmacenFilter.value,
        { scope, shouldMaskOutOfScope: true }
      );
      if (!almacenScopeCheck.ok) return;
    }

    const whereClause = `
      WHERE ($1::int IS NULL OR m.id_almacen = $1)
        AND ($2::int IS NULL OR a.id_sucursal = $2)
        AND ($3::boolean = true OR a.id_sucursal = ANY($4::int[]))
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM movimientos_inventario m
      LEFT JOIN almacenes a ON a.id_almacen = m.id_almacen
      ${whereClause}
    `;

    const dataQuery = `
      SELECT
        m.id_movimiento,
        m.fecha_mov,
        m.tipo,
        m.cantidad,
        m.id_almacen,
        m.id_producto,
        m.id_insumo,
        m.ref_origen,
        m.id_ref,
        m.descripcion
      FROM movimientos_inventario m
      LEFT JOIN almacenes a ON a.id_almacen = m.id_almacen
      ${whereClause}
      ORDER BY m.fecha_mov DESC, m.id_movimiento DESC
      LIMIT $5 OFFSET $6
    `;

    const baseParams = [
      idAlmacenFilter.value,
      idSucursalFilter.value,
      scope.isSuperAdmin,
      scope.allowedSucursalIds
    ];
    const countResult = await pool.query(countQuery, baseParams);
    const total = Number(countResult.rows?.[0]?.total ?? 0);

    const result = await pool.query(dataQuery, [
      ...baseParams,
      pagination.pageSize,
      pagination.offset
    ]);

    return res.status(200).json(
      buildPaginatedPayload({
        items: result.rows || [],
        page: pagination.page,
        pageSize: pagination.pageSize,
        total
      })
    );
  } catch (error) {
    return sendInternalError(res, 'Error al obtener movimientos_inventario', error);
  }
});

// GET: OBTENER KARDEX DESDE LA VISTA DE DETALLE
router.get('/kardex', checkPermission(MOVIMIENTOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const pagination = parsePaginationQuery(req.query || {});
    if (!pagination.ok) {
      return sendValidationError(res, pagination.error);
    }

    const idAlmacenFilter = parseOptionalPositiveInt(req.query?.id_almacen, 'id_almacen');
    if (idAlmacenFilter.error) {
      return sendValidationError(res, idAlmacenFilter.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const scope = await getRequestMovimientosScope(req);
    if (!ensureMovimientosScopeAvailable(res, scope)) {
      return;
    }
    if (
      idSucursalFilter.provided &&
      !ensureMovimientosSucursalInScope(res, scope, idSucursalFilter.value)
    ) {
      return;
    }
    if (idAlmacenFilter.provided) {
      const almacenScopeCheck = await ensureAlmacenIdInMovimientosScope(
        req,
        res,
        idAlmacenFilter.value,
        { scope, shouldMaskOutOfScope: true }
      );
      if (!almacenScopeCheck.ok) return;
    }

    const tipoFilter = parseOptionalTipo(req.query?.tipo);
    if (tipoFilter.error) {
      return sendValidationError(res, tipoFilter.error);
    }

    const itemTipoFilter = parseOptionalItemTipo(req.query?.item_tipo);
    if (itemTipoFilter.error) {
      return sendValidationError(res, itemTipoFilter.error);
    }

    const itemIdFilter = parseOptionalPositiveInt(req.query?.id_item, 'id_item');
    if (itemIdFilter.error) {
      return sendValidationError(res, itemIdFilter.error);
    }

    const desdeFilter = parseOptionalDate(req.query?.desde, 'desde');
    if (desdeFilter.error) {
      return sendValidationError(res, desdeFilter.error);
    }

    const hastaFilter = parseOptionalDate(req.query?.hasta, 'hasta');
    if (hastaFilter.error) {
      return sendValidationError(res, hastaFilter.error);
    }

    if (desdeFilter.value && hastaFilter.value && desdeFilter.value > hastaFilter.value) {
      return sendValidationError(res, 'desde no puede ser mayor que hasta.');
    }

    const textFilter = parseOptionalText(req.query?.q);

    const whereClause = `
      WHERE ($1::int IS NULL OR id_almacen = $1)
        AND ($2::int IS NULL OR id_sucursal = $2)
        AND ($3::text IS NULL OR tipo = $3)
        AND ($4::text IS NULL OR item_tipo = $4)
        AND ($5::int IS NULL OR item_id = $5)
        AND ($6::date IS NULL OR fecha_mov::date >= $6)
        AND ($7::date IS NULL OR fecha_mov::date <= $7)
        AND (
          $8::text IS NULL OR (
            COALESCE(item_nombre, '') ILIKE '%' || $8 || '%'
            OR COALESCE(descripcion, '') ILIKE '%' || $8 || '%'
            OR COALESCE(ref_origen, '') ILIKE '%' || $8 || '%'
          )
        )
        AND ($9::boolean = true OR id_sucursal = ANY($10::int[]))
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM public.v_kardex_detalle
      ${whereClause}
    `;

    // NEW: CONSULTA FIJA SOBRE LA VISTA PARA SOPORTAR FILTROS SIN SQL DINAMICO.
    // WHY: EL KARDEX YA TRAE NOMBRES, SUCURSALES, SALDOS E IMPACTO LISTOS PARA LA UI.
    // IMPACT: GET /KARDEX RESPONDE FILAS DE LA VISTA TAL CUAL, ORDENADAS POR FECHA E ID.
    const dataQuery = `
      SELECT *
      FROM public.v_kardex_detalle
      ${whereClause}
      ORDER BY fecha_mov DESC, id_movimiento DESC
      LIMIT $11 OFFSET $12
    `;

    const params = [
      idAlmacenFilter.value,
      idSucursalFilter.value,
      tipoFilter.value,
      itemTipoFilter.value,
      itemIdFilter.value,
      desdeFilter.value,
      hastaFilter.value,
      textFilter.value,
      scope.isSuperAdmin,
      scope.allowedSucursalIds
    ];

    const countResult = await pool.query(countQuery, params);
    const total = Number(countResult.rows?.[0]?.total ?? 0);

    const result = await pool.query(dataQuery, [
      ...params,
      pagination.pageSize,
      pagination.offset
    ]);

    return res.status(200).json(
      buildPaginatedPayload({
        items: result.rows || [],
        page: pagination.page,
        pageSize: pagination.pageSize,
        total
      })
    );
  } catch (error) {
    return sendInternalError(res, 'Error al obtener kardex', error);
  }
});

// POST: CREAR MOVIMIENTO
router.post('/movimientos_inventario', checkPermission(MOVIMIENTOS_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const normalized = normalizeMovimientoPayload(req.body || {});
    if (!normalized.ok) {
      return sendValidationError(res, normalized.errors[0], normalized.errors);
    }

    const scopeCheck = await ensureAlmacenIdInMovimientosScope(
      req,
      res,
      normalized.values.id_almacen,
      { shouldMaskOutOfScope: true }
    );
    if (!scopeCheck.ok) {
      return;
    }

    const operationalValidation = await validateOperationalEntities(
      {
        id_almacen: normalized.values.id_almacen,
        id_producto: normalized.values.id_producto,
        id_insumo: normalized.values.id_insumo
      },
      pool
    );
    if (!operationalValidation.ok) {
      return sendError(
        res,
        operationalValidation.status || 400,
        operationalValidation.code || 'VALIDATION_ERROR',
        operationalValidation.message || 'No se pudo registrar el movimiento.'
      );
    }

    const createdId = await insertMovimiento(pool, {
      tipo: normalized.values.tipo,
      cantidad: normalized.values.cantidad,
      id_almacen: normalized.values.id_almacen,
      item_tipo: normalized.values.id_producto ? 'producto' : 'insumo',
      id_item: normalized.values.id_producto ?? normalized.values.id_insumo,
      ref_origen: normalized.values.ref_origen,
      id_ref: normalized.values.id_ref,
      descripcion: normalized.values.descripcion
    });

    if (!createdId) {
      return sendInternalError(
        res,
        'Error al crear movimiento_inventario (insert sin id_movimiento)',
        new Error('insert_movimiento_without_id'),
        'Error interno al crear movimiento de inventario.'
      );
    }

    const kardexRow = await getKardexRowByMovimientoId(pool, createdId);

    res.status(201).json({
      message: 'Movimiento creado exitosamente.',
      data: kardexRow
    });
  } catch (error) {
    const normalizedError = normalizeMovimientoDbError(error);
    if (normalizedError) {
      if (normalizedError.code === 'CONFLICT') {
        return sendConflictError(res, normalizedError.message);
      }
      return sendError(res, normalizedError.status, normalizedError.code, normalizedError.message);
    }

    return sendInternalError(res, 'Error al crear movimiento_inventario', error);
  }
});

// PUT: BLOQUEADO POR KARDEX APPEND-ONLY
router.put('/movimientos_inventario', checkPermission(MOVIMIENTOS_EDIT_PERMISSIONS), async (_req, res) => {
  res.status(405).json({ ok: false, error: true, code: 'METHOD_NOT_ALLOWED', message: APPEND_ONLY_MESSAGE });
});

// DELETE: BLOQUEADO POR KARDEX APPEND-ONLY
router.delete('/movimientos_inventario', checkPermission(MOVIMIENTOS_DELETE_PERMISSIONS), async (_req, res) => {
  res.status(405).json({ ok: false, error: true, code: 'METHOD_NOT_ALLOWED', message: APPEND_ONLY_MESSAGE });
});

export default router;
