import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// ==============================
// KARDEX APPEND-ONLY
// TABLA: movimientos_inventario
// VISTA: public.v_kardex_detalle
// ==============================
const VALID_TIPOS = new Set(['ENTRADA', 'SALIDA', 'AJUSTE']);
const ITEM_TIPO_MAP = new Map([
  ['producto', 'Producto'],
  ['insumo', 'Insumo'],
  ['Producto', 'Producto'],
  ['Insumo', 'Insumo']
]);
const APPEND_ONLY_MESSAGE = 'KARDEX NO PERMITE EDITAR/ELIMINAR. CREE UN NUEVO MOVIMIENTO.';

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

const sendInternalError = (res, context, error) => {
  console.error(`[movimientos_inventario] ${context}:`, error);
  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operacion solicitada.');
};

const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

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

// NEW: CENTRALIZA LA VALIDACION DEL PAYLOAD DE ALTA PARA RESPETAR EL KARDEX APPEND-ONLY.
// WHY: EL CLIENTE NO DEBE PODER ENVIAR SALDOS NI MOVIMIENTOS AMBIGUOS ENTRE PRODUCTO/INSUMO.
// IMPACT: POST DEVUELVE 400 CON MENSAJES CLAROS ANTES DE TOCAR LA BD.
const normalizeMovimientoPayload = (payload) => {
  const errors = [];

  const tipoResult = parseOptionalTipo(payload?.tipo);
  if (tipoResult.error) errors.push(tipoResult.error);
  const tipo = tipoResult.value;

  const cantidadRaw = Number(payload?.cantidad);
  if (!hasValue(payload?.cantidad)) {
    errors.push('cantidad es obligatoria.');
  } else if (!Number.isSafeInteger(cantidadRaw)) {
    errors.push('cantidad debe ser un entero.');
  } else if (tipo === 'AJUSTE' ? !isNonNegativeInteger(cantidadRaw) : !isPositiveIntegerId(cantidadRaw)) {
    errors.push(tipo === 'AJUSTE' ? 'cantidad debe ser un entero mayor o igual a 0.' : 'cantidad debe ser un entero mayor a 0.');
  }

  const almacenResult = parseRequiredPositiveInt(payload?.id_almacen, 'id_almacen');
  if (!almacenResult.ok) errors.push(almacenResult.error);

  const productoResult = parseOptionalPositiveInt(payload?.id_producto, 'id_producto');
  if (productoResult.error) errors.push(productoResult.error);

  const insumoResult = parseOptionalPositiveInt(payload?.id_insumo, 'id_insumo');
  if (insumoResult.error) errors.push(insumoResult.error);

  const hasProducto = productoResult.provided;
  const hasInsumo = insumoResult.provided;
  if (hasProducto === hasInsumo) {
    errors.push('Debe enviar exactamente uno entre id_producto o id_insumo.');
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
      cantidad: Number.isSafeInteger(cantidadRaw) ? cantidadRaw : null,
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

// GET: OBTENER MOVIMIENTOS LEGADO
router.get('/movimientos_inventario', async (req, res) => {
  try {
    const idAlmacenFilter = parseOptionalPositiveInt(req.query?.id_almacen, 'id_almacen');
    if (idAlmacenFilter.error) {
      return sendValidationError(res, idAlmacenFilter.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
    }

    const query = `
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
      WHERE ($1::int IS NULL OR m.id_almacen = $1)
        AND ($2::int IS NULL OR a.id_sucursal = $2)
      ORDER BY m.fecha_mov DESC
    `;

    const result = await pool.query(query, [idAlmacenFilter.value, idSucursalFilter.value]);
    res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener movimientos_inventario', error);
  }
});

// GET: OBTENER KARDEX DESDE LA VISTA DE DETALLE
router.get('/kardex', async (req, res) => {
  try {
    const idAlmacenFilter = parseOptionalPositiveInt(req.query?.id_almacen, 'id_almacen');
    if (idAlmacenFilter.error) {
      return sendValidationError(res, idAlmacenFilter.error);
    }

    const idSucursalFilter = parseOptionalPositiveInt(req.query?.id_sucursal, 'id_sucursal');
    if (idSucursalFilter.error) {
      return sendValidationError(res, idSucursalFilter.error);
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

    // NEW: CONSULTA FIJA SOBRE LA VISTA PARA SOPORTAR FILTROS SIN SQL DINAMICO.
    // WHY: EL KARDEX YA TRAE NOMBRES, SUCURSALES, SALDOS E IMPACTO LISTOS PARA LA UI.
    // IMPACT: GET /KARDEX RESPONDE FILAS DE LA VISTA TAL CUAL, ORDENADAS POR FECHA E ID.
    const query = `
      SELECT *
      FROM public.v_kardex_detalle
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
      ORDER BY fecha_mov DESC, id_movimiento DESC
    `;

    const result = await pool.query(query, [
      idAlmacenFilter.value,
      idSucursalFilter.value,
      tipoFilter.value,
      itemTipoFilter.value,
      itemIdFilter.value,
      desdeFilter.value,
      hastaFilter.value,
      textFilter.value
    ]);

    res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener kardex', error);
  }
});

// POST: CREAR MOVIMIENTO
router.post('/movimientos_inventario', async (req, res) => {
  try {
    const normalized = normalizeMovimientoPayload(req.body || {});
    if (!normalized.ok) {
      return sendValidationError(res, normalized.errors[0], normalized.errors);
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

    const kardexRow = createdId ? await getKardexRowByMovimientoId(pool, createdId) : null;

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
router.put('/movimientos_inventario', async (_req, res) => {
  res.status(405).json({ ok: false, error: true, code: 'METHOD_NOT_ALLOWED', message: APPEND_ONLY_MESSAGE });
});

// DELETE: BLOQUEADO POR KARDEX APPEND-ONLY
router.delete('/movimientos_inventario', async (_req, res) => {
  res.status(405).json({ ok: false, error: true, code: 'METHOD_NOT_ALLOWED', message: APPEND_ONLY_MESSAGE });
});

export default router;
