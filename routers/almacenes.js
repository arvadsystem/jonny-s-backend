import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const TABLA_ALMACENES = 'almacenes';
const EDITABLE_FIELDS = new Set(['nombre', 'id_sucursal']);
const CREATE_ALLOWED_FIELDS = new Set(['nombre', 'id_sucursal']);
const DELETE_CONFLICT_MESSAGE = 'No se puede eliminar, use inactivar.';

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
  console.error(`[almacenes] ${context}:`, error);
  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operacion solicitada.');
};

const parsePositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: `${fieldName} es obligatorio.` };
  }

  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return { ok: false, error: `${fieldName} debe ser un entero mayor a 0.` };
  }

  return { ok: true, value: normalizedValue };
};

const parseNombre = (rawValue, fieldName = 'nombre') => {
  if (!hasValue(rawValue)) {
    return { ok: false, error: `${fieldName} es obligatorio.` };
  }

  const normalizedValue = String(rawValue).trim();
  if (normalizedValue.length < 2) {
    return { ok: false, error: `${fieldName} debe tener al menos 2 caracteres.` };
  }

  if (normalizedValue.length > 80) {
    return { ok: false, error: `${fieldName} no puede superar 80 caracteres.` };
  }

  return { ok: true, value: normalizedValue };
};

const parseIncludeInactivos = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: true, value: false };

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return { ok: true, value: true };
  if (normalized === '0' || normalized === 'false') return { ok: true, value: false };

  return {
    ok: false,
    error: "include_inactivos invalido. Use '1', '0', 'true' o 'false'."
  };
};

const getAlmacenDependenciasById = async (idAlmacen) => {
  const result = await pool.query(
    `
      SELECT
        a.id_almacen,
        COALESCE((SELECT COUNT(*) FROM public.movimientos_inventario m WHERE m.id_almacen = a.id_almacen), 0)::int AS movimientos,
        COALESCE((SELECT COUNT(*) FROM public.productos p WHERE p.id_almacen = a.id_almacen), 0)::int AS productos,
        COALESCE((SELECT COUNT(*) FROM public.insumos i WHERE i.id_almacen = a.id_almacen), 0)::int AS insumos,
        COALESCE(a.estado, true) AS estado
      FROM public.almacenes a
      WHERE a.id_almacen = $1
      LIMIT 1
    `,
    [idAlmacen]
  );

  const row = result.rows?.[0];
  if (!row) return { exists: false };

  const counts = {
    movimientos: Number(row.movimientos ?? 0),
    productos: Number(row.productos ?? 0),
    insumos: Number(row.insumos ?? 0)
  };

  const canDelete = counts.movimientos === 0 && counts.productos === 0 && counts.insumos === 0;

  return {
    exists: true,
    id_almacen: Number(row.id_almacen),
    estado: Boolean(row.estado),
    counts,
    canDelete,
    canInactivate: true
  };
};

const normalizeAlmacenMutationError = (error) => {
  switch (error?.code) {
    case '23505':
      return { status: 409, code: 'CONFLICT', message: 'Ya existe un almacen con los datos proporcionados.' };
    case '23503':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'La sucursal seleccionada no existe o no esta disponible.'
      };
    case '22P02':
    case '22003':
    case '23514':
      return { status: 400, code: 'VALIDATION_ERROR', message: 'Los datos enviados no son validos.' };
    default:
      return null;
  }
};

const sendMutationError = (res, context, error) => {
  const normalized = normalizeAlmacenMutationError(error);
  if (normalized) {
    console.error(`[almacenes] ${context}:`, error);
    return sendError(res, normalized.status, normalized.code, normalized.message);
  }

  return sendInternalError(res, context, error);
};

// GET: Obtener almacenes
router.get('/almacenes', async (_req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(_req.query?.include_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const query = `
      WITH inventario_items AS (
        SELECT
          p.id_almacen,
          p.id_producto AS item_id,
          p.cantidad,
          p.stock_minimo,
          p.estado
        FROM public.productos p
        UNION ALL
        SELECT
          i.id_almacen,
          i.id_insumo AS item_id,
          i.cantidad,
          i.stock_minimo,
          i.estado
        FROM public.insumos i
      ),
      movimientos_hoy AS (
        SELECT
          k.id_almacen,
          COUNT(*)::int AS movimientos_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'ENTRADA')::int AS entradas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'SALIDA')::int AS salidas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'AJUSTE')::int AS ajustes_hoy
        FROM public.v_kardex_detalle k
        WHERE k.fecha_mov::date = ((now() AT TIME ZONE 'America/Tegucigalpa')::date)
        GROUP BY k.id_almacen
      ),
      dep_movimientos AS (
        SELECT m.id_almacen, COUNT(*)::int AS movimientos_count
        FROM public.movimientos_inventario m
        GROUP BY m.id_almacen
      ),
      dep_productos AS (
        SELECT p.id_almacen, COUNT(*)::int AS productos_count
        FROM public.productos p
        GROUP BY p.id_almacen
      ),
      dep_insumos AS (
        SELECT i.id_almacen, COUNT(*)::int AS insumos_count
        FROM public.insumos i
        GROUP BY i.id_almacen
      )
      SELECT
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        COALESCE(a.estado, true) AS estado,
        s.nombre_sucursal,
        s.estado AS sucursal_estado,
        COALESCE(dm.movimientos_count, 0)::int AS movimientos_count,
        COALESCE(dp.productos_count, 0)::int AS productos_count,
        COALESCE(di.insumos_count, 0)::int AS insumos_count,
        (
          COALESCE(dm.movimientos_count, 0) = 0
          AND COALESCE(dp.productos_count, 0) = 0
          AND COALESCE(di.insumos_count, 0) = 0
        ) AS can_delete,
        COUNT(*) FILTER (WHERE ii.item_id IS NOT NULL)::int AS total_items,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
        )::int AS total_items_activos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = false
        )::int AS total_items_inactivos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
            AND ii.cantidad <= COALESCE(ii.stock_minimo, 0)
        )::int AS alertas_stock,
        COALESCE(mh.movimientos_hoy, 0)::int AS movimientos_hoy,
        COALESCE(mh.entradas_hoy, 0)::int AS entradas_hoy,
        COALESCE(mh.salidas_hoy, 0)::int AS salidas_hoy,
        COALESCE(mh.ajustes_hoy, 0)::int AS ajustes_hoy
      FROM public.almacenes a
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      LEFT JOIN inventario_items ii
        ON ii.id_almacen = a.id_almacen
      LEFT JOIN movimientos_hoy mh
        ON mh.id_almacen = a.id_almacen
      LEFT JOIN dep_movimientos dm
        ON dm.id_almacen = a.id_almacen
      LEFT JOIN dep_productos dp
        ON dp.id_almacen = a.id_almacen
      LEFT JOIN dep_insumos di
        ON di.id_almacen = a.id_almacen
      WHERE ($1::boolean = true OR COALESCE(a.estado, true) = true)
      GROUP BY
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        a.estado,
        s.nombre_sucursal,
        s.estado,
        dm.movimientos_count,
        dp.productos_count,
        di.insumos_count,
        mh.movimientos_hoy,
        mh.entradas_hoy,
        mh.salidas_hoy,
        mh.ajustes_hoy
      ORDER BY a.id_almacen ASC
    `;

    const result = await pool.query(query, [includeInactivosResult.value]);
    res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener almacenes', error);
  }
});

// GET: Dependencias del almacen para decidir eliminar vs inactivar.
router.get('/almacenes/:id/dependencias', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const dependency = await getAlmacenDependenciasById(idResult.value);
    if (!dependency.exists) {
      return sendError(res, 404, 'NOT_FOUND', 'Almacen no encontrado.');
    }

    return res.status(200).json({
      ok: true,
      id_almacen: dependency.id_almacen,
      counts: dependency.counts,
      canDelete: dependency.canDelete,
      canInactivate: dependency.canInactivate
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener dependencias de almacen', error);
  }
});

// PATCH: Inactivar almacen (soft-delete idempotente).
router.patch('/almacenes/:id/inactivar', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const _motivo = hasValue(req.body?.motivo) ? String(req.body.motivo).trim() : null;
    void _motivo;

    const current = await pool.query(
      'SELECT id_almacen, COALESCE(estado, true) AS estado FROM public.almacenes WHERE id_almacen = $1 LIMIT 1',
      [idResult.value]
    );

    if (!current.rows?.length) {
      return sendError(res, 404, 'NOT_FOUND', 'Almacen no encontrado.');
    }

    const wasActive = Boolean(current.rows[0].estado);
    if (wasActive) {
      await pool.query(
        'UPDATE public.almacenes SET estado = false WHERE id_almacen = $1',
        [idResult.value]
      );
    }

    return res.status(200).json({
      ok: true,
      id_almacen: idResult.value,
      estado: false,
      message: wasActive ? 'Almacen inactivado correctamente.' : 'El almacen ya estaba inactivo.'
    });
  } catch (error) {
    return sendInternalError(res, 'Error al inactivar almacen', error);
  }
});

// PATCH: Reactivar almacen (idempotente).
router.patch('/almacenes/:id/reactivar', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const current = await pool.query(
      'SELECT id_almacen, COALESCE(estado, true) AS estado FROM public.almacenes WHERE id_almacen = $1 LIMIT 1',
      [idResult.value]
    );

    if (!current.rows?.length) {
      return sendError(res, 404, 'NOT_FOUND', 'Almacen no encontrado.');
    }

    const wasActive = Boolean(current.rows[0].estado);
    if (!wasActive) {
      await pool.query(
        'UPDATE public.almacenes SET estado = true WHERE id_almacen = $1',
        [idResult.value]
      );
    }

    return res.status(200).json({
      ok: true,
      id_almacen: idResult.value,
      estado: true,
      message: wasActive ? 'El almacen ya estaba activo.' : 'Almacen reactivado correctamente.'
    });
  } catch (error) {
    return sendInternalError(res, 'Error al reactivar almacen', error);
  }
});

// POST: Crear almacén
router.post('/almacenes', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const extraKeys = Object.keys(payload).filter((key) => !CREATE_ALLOWED_FIELDS.has(key));
    if (extraKeys.length) {
      return sendValidationError(res, `Campos no permitidos: ${extraKeys.join(', ')}`);
    }

    const nombreResult = parseNombre(payload.nombre);
    const sucursalResult = parsePositiveInt(payload.id_sucursal, 'id_sucursal');
    const errors = [nombreResult.error, sucursalResult.error].filter(Boolean);

    if (errors.length) {
      return sendValidationError(res, errors[0], errors);
    }

    await pool.query('CALL pa_insert($1, $2)', [
      TABLA_ALMACENES,
      {
        nombre: nombreResult.value,
        id_sucursal: sucursalResult.value
      }
    ]);

    return res.status(201).json({ ok: true, message: 'Almacen creado exitosamente.' });
  } catch (error) {
    return sendMutationError(res, 'Error al crear almacen', error);
  }
});

// PUT legacy: Actualizar almacén (1 campo) manteniendo compatibilidad de clientes existentes.
router.put('/almacenes', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const { campo, valor, id_campo, id_valor } = payload;

    if (!hasValue(campo) || valor === undefined || !hasValue(id_campo) || id_valor === undefined) {
      return sendValidationError(res, 'Faltan campos obligatorios.');
    }

    if (String(id_campo).trim() !== 'id_almacen') {
      return sendValidationError(res, "id_campo invalido. Debe ser 'id_almacen'.");
    }

    const normalizedField = String(campo).trim();
    if (!EDITABLE_FIELDS.has(normalizedField)) {
      return sendValidationError(res, `campo invalido. Permitidos: ${Array.from(EDITABLE_FIELDS).join(', ')}`);
    }

    const idResult = parsePositiveInt(id_valor, 'id_valor');
    if (!idResult.ok) {
      return sendValidationError(res, idResult.error);
    }

    let normalizedValue;
    if (normalizedField === 'nombre') {
      const nombreResult = parseNombre(valor, 'valor');
      if (!nombreResult.ok) return sendValidationError(res, nombreResult.error);
      normalizedValue = nombreResult.value;
    } else {
      const sucursalResult = parsePositiveInt(valor, 'valor');
      if (!sucursalResult.ok) return sendValidationError(res, sucursalResult.error);
      normalizedValue = sucursalResult.value;
    }

    await pool.query('CALL pa_update($1, $2, $3, $4, $5)', [
      TABLA_ALMACENES,
      normalizedField,
      String(normalizedValue),
      'id_almacen',
      String(idResult.value)
    ]);

    return res.status(200).json({ ok: true, message: 'Almacen actualizado correctamente.' });
  } catch (error) {
    return sendMutationError(res, 'Error al actualizar almacen (legacy)', error);
  }
});

// PUT atómico: actualización multi-campo en una sola transacción.
router.put('/almacenes/:id', async (req, res) => {
  const idResult = parsePositiveInt(req.params?.id, 'id');
  if (!idResult.ok) {
    return sendValidationError(res, idResult.error);
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const allowedFields = ['nombre', 'id_sucursal'];
  const extraKeys = Object.keys(payload).filter((key) => !allowedFields.includes(key));
  if (extraKeys.length) {
    return sendValidationError(res, `Campos no permitidos: ${extraKeys.join(', ')}`);
  }

  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'nombre')) {
    const nombreResult = parseNombre(payload.nombre);
    if (!nombreResult.ok) return sendValidationError(res, nombreResult.error);
    updates.nombre = nombreResult.value;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'id_sucursal')) {
    const sucursalResult = parsePositiveInt(payload.id_sucursal, 'id_sucursal');
    if (!sucursalResult.ok) return sendValidationError(res, sucursalResult.error);
    updates.id_sucursal = sucursalResult.value;
  }

  if (!Object.keys(updates).length) {
    return sendValidationError(res, 'Debe enviar al menos un campo editable (nombre o id_sucursal).');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FIX IMPORTANTE: mantiene retrocompatibilidad usando pa_update y asegura atomicidad con transaccion.
    if (Object.prototype.hasOwnProperty.call(updates, 'nombre')) {
      await client.query('CALL pa_update($1, $2, $3, $4, $5)', [
        TABLA_ALMACENES,
        'nombre',
        String(updates.nombre),
        'id_almacen',
        String(idResult.value)
      ]);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'id_sucursal')) {
      await client.query('CALL pa_update($1, $2, $3, $4, $5)', [
        TABLA_ALMACENES,
        'id_sucursal',
        String(updates.id_sucursal),
        'id_almacen',
        String(idResult.value)
      ]);
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok: true, message: 'Almacen actualizado correctamente.' });
  } catch (error) {
    await client.query('ROLLBACK');
    return sendMutationError(res, 'Error al actualizar almacen (atomico)', error);
  } finally {
    client.release();
  }
});

// DELETE: Eliminar almacén
router.delete('/almacenes', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const idResult = parsePositiveInt(payload.valor_id ?? payload.id_almacen, 'id_almacen');
    if (!idResult.ok) {
      return sendValidationError(res, idResult.error);
    }

    const dependency = await getAlmacenDependenciasById(idResult.value);
    if (!dependency.exists) {
      return sendError(res, 404, 'NOT_FOUND', 'Almacen no encontrado.');
    }

    if (!dependency.canDelete) {
      return sendConflictError(res, DELETE_CONFLICT_MESSAGE);
    }

    await pool.query('CALL pa_delete($1, $2, $3)', [
      TABLA_ALMACENES,
      'id_almacen',
      String(idResult.value)
    ]);

    return res.status(200).json({ ok: true, message: 'Almacen eliminado correctamente.' });
  } catch (error) {
    return sendMutationError(res, 'Error al eliminar almacen', error);
  }
});

export default router;
