import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();

const MOBILIARIO_LIST_PERMISSIONS = ['INVENTARIO_MOBILIARIO_VER', 'INVENTARIO_MOBILIARIO_DETALLE_VER'];
const MOBILIARIO_CREATE_PERMISSIONS = ['INVENTARIO_MOBILIARIO_CREAR'];
const MOBILIARIO_EDIT_PERMISSIONS = ['INVENTARIO_MOBILIARIO_EDITAR'];
const MOBILIARIO_STATE_PERMISSIONS = ['INVENTARIO_MOBILIARIO_ESTADO_CAMBIAR'];

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

const sendNotFound = (res, message) =>
  sendError(res, 404, 'NOT_FOUND', message);

const sendInternalError = (res, context, error) => {
  console.error(`[mobiliario] ${context}:`, error);
  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operacion solicitada.');
};

const parsePositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) return { ok: false, error: `${fieldName} es obligatorio.` };

  const numeric = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { ok: false, error: `${fieldName} debe ser un entero mayor a 0.` };
  }

  return { ok: true, value: numeric };
};

const parseBooleanValue = (rawValue, fieldName) => {
  if (typeof rawValue === 'boolean') return { ok: true, value: rawValue };
  return { ok: false, error: `${fieldName} debe ser booleano.` };
};

const parseIncludeInactivos = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: true, value: false };

  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 't', 'si'].includes(normalized)) return { ok: true, value: true };
  if (['0', 'false', 'f', 'no'].includes(normalized)) return { ok: true, value: false };

  return {
    ok: false,
    error: "incluir_inactivos invalido. Use '1', '0', 'true' o 'false'."
  };
};

const parseNombreBien = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: false, error: 'nombre_bien es obligatorio.' };

  const normalized = String(rawValue).trim();
  if (normalized.length < 2) {
    return { ok: false, error: 'nombre_bien debe tener al menos 2 caracteres.' };
  }

  if (normalized.length > 160) {
    return { ok: false, error: 'nombre_bien no puede superar 160 caracteres.' };
  }

  return { ok: true, value: normalized };
};

const parseFechaAsignacion = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: false, error: 'fecha_asignacion es obligatoria.' };

  const normalized = String(rawValue).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return { ok: false, error: 'fecha_asignacion debe tener formato YYYY-MM-DD.' };
  }

  const parsedDate = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsedDate.getTime())) {
    return { ok: false, error: 'fecha_asignacion no es una fecha valida.' };
  }

  return { ok: true, value: normalized };
};

const EMPLEADO_JOIN_FRAGMENT = `
  LEFT JOIN public.empleados e
    ON e.id_empleado = m.id_empleado
  LEFT JOIN public.personas p
    ON p.id_persona = e.id_persona
`;

const EMPLEADO_NOMBRE_EXPR = `
  NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '')
`;

const MOBILIARIO_SELECT_FIELDS = `
  m.id_mobiliario,
  m.nombre_bien,
  m.id_empleado,
  COALESCE(${EMPLEADO_NOMBRE_EXPR}, CONCAT('Empleado #', m.id_empleado::text)) AS empleado_nombre,
  m.fecha_asignacion,
  m.activo
`;

const getEmpleadoById = async (idEmpleado) => {
  const result = await pool.query(
    `
      SELECT
        e.id_empleado,
        COALESCE(e.estado, true) AS estado,
        COALESCE(
          ${EMPLEADO_NOMBRE_EXPR},
          CONCAT('Empleado #', e.id_empleado::text)
        ) AS empleado_nombre
      FROM public.empleados e
      LEFT JOIN public.personas p ON p.id_persona = e.id_persona
      WHERE e.id_empleado = $1
      LIMIT 1
    `,
    [idEmpleado]
  );

  return result.rows?.[0] || null;
};

router.get('/mobiliario', checkPermission(MOBILIARIO_LIST_PERMISSIONS), async (req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(req.query?.incluir_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const q = hasValue(req.query?.q) ? String(req.query.q).trim() : '';
    const searchTerm = q ? `%${q}%` : null;

    const result = await pool.query(
      `
        SELECT
          ${MOBILIARIO_SELECT_FIELDS}
        FROM public.mobiliario m
        ${EMPLEADO_JOIN_FRAGMENT}
        WHERE ($1::boolean = true OR m.activo = true)
          AND (
            $2::text IS NULL
            OR m.nombre_bien ILIKE $2
            OR COALESCE(${EMPLEADO_NOMBRE_EXPR}, '') ILIKE $2
            OR m.id_empleado::text ILIKE $2
          )
        ORDER BY m.id_mobiliario DESC
      `,
      [includeInactivosResult.value, searchTerm]
    );

    return res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al listar mobiliario', error);
  }
});

router.post('/mobiliario', checkPermission(MOBILIARIO_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const nombreResult = parseNombreBien(payload.nombre_bien);
    const empleadoResult = parsePositiveInt(payload.id_empleado, 'id_empleado');
    const fechaResult = parseFechaAsignacion(payload.fecha_asignacion);
    const errors = [nombreResult.error, empleadoResult.error, fechaResult.error].filter(Boolean);
    if (errors.length) return sendValidationError(res, errors[0], errors);

    const empleado = await getEmpleadoById(empleadoResult.value);
    if (!empleado) return sendNotFound(res, 'El empleado seleccionado no existe.');
    if (empleado.estado === false) {
      return sendError(res, 409, 'CONFLICT', 'No se puede asignar mobiliario a un empleado inactivo.');
    }

    const insertResult = await pool.query(
      `
        INSERT INTO public.mobiliario (nombre_bien, id_empleado, fecha_asignacion)
        VALUES ($1, $2, $3::date)
        RETURNING id_mobiliario
      `,
      [nombreResult.value, empleadoResult.value, fechaResult.value]
    );

    const idMobiliario = insertResult.rows?.[0]?.id_mobiliario;
    const readResult = await pool.query(
      `
        SELECT
          ${MOBILIARIO_SELECT_FIELDS}
        FROM public.mobiliario m
        ${EMPLEADO_JOIN_FRAGMENT}
        WHERE m.id_mobiliario = $1
        LIMIT 1
      `,
      [idMobiliario]
    );

    return res.status(201).json({
      ok: true,
      message: 'Bien registrado correctamente.',
      data: readResult.rows?.[0] || null
    });
  } catch (error) {
    if (error?.code === '23503') {
      return sendValidationError(res, 'El empleado seleccionado no existe.');
    }
    return sendInternalError(res, 'Error al crear mobiliario', error);
  }
});

router.put('/mobiliario/:id', checkPermission(MOBILIARIO_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const updates = {};
    const errors = [];

    if (Object.prototype.hasOwnProperty.call(payload, 'nombre_bien')) {
      const nombreResult = parseNombreBien(payload.nombre_bien);
      if (!nombreResult.ok) errors.push(nombreResult.error);
      else updates.nombre_bien = nombreResult.value;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'id_empleado')) {
      const empleadoResult = parsePositiveInt(payload.id_empleado, 'id_empleado');
      if (!empleadoResult.ok) {
        errors.push(empleadoResult.error);
      } else {
        const empleado = await getEmpleadoById(empleadoResult.value);
        if (!empleado) errors.push('El empleado seleccionado no existe.');
        else if (empleado.estado === false) errors.push('No se puede asignar a un empleado inactivo.');
        else updates.id_empleado = empleadoResult.value;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'fecha_asignacion')) {
      const fechaResult = parseFechaAsignacion(payload.fecha_asignacion);
      if (!fechaResult.ok) errors.push(fechaResult.error);
      else updates.fecha_asignacion = fechaResult.value;
    }

    if (!Object.keys(updates).length) {
      return sendValidationError(
        res,
        'Debe enviar al menos un campo editable: nombre_bien, id_empleado o fecha_asignacion.'
      );
    }

    if (errors.length) return sendValidationError(res, errors[0], errors);

    const setClauses = [];
    const params = [idResult.value];
    let idx = 2;

    if (Object.prototype.hasOwnProperty.call(updates, 'nombre_bien')) {
      setClauses.push(`nombre_bien = $${idx}`);
      params.push(updates.nombre_bien);
      idx += 1;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'id_empleado')) {
      setClauses.push(`id_empleado = $${idx}`);
      params.push(updates.id_empleado);
      idx += 1;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'fecha_asignacion')) {
      setClauses.push(`fecha_asignacion = $${idx}::date`);
      params.push(updates.fecha_asignacion);
      idx += 1;
    }

    const updateQuery = `
      UPDATE public.mobiliario
      SET ${setClauses.join(', ')}
      WHERE id_mobiliario = $1
      RETURNING id_mobiliario
    `;

    const updateResult = await pool.query(updateQuery, params);
    if (!updateResult.rows?.length) return sendNotFound(res, 'Registro de mobiliario no encontrado.');

    const readResult = await pool.query(
      `
        SELECT
          ${MOBILIARIO_SELECT_FIELDS}
        FROM public.mobiliario m
        ${EMPLEADO_JOIN_FRAGMENT}
        WHERE m.id_mobiliario = $1
        LIMIT 1
      `,
      [idResult.value]
    );

    return res.status(200).json({
      ok: true,
      message: 'Bien actualizado correctamente.',
      data: readResult.rows?.[0] || null
    });
  } catch (error) {
    if (error?.code === '23503') {
      return sendValidationError(res, 'El empleado seleccionado no existe.');
    }
    return sendInternalError(res, 'Error al actualizar mobiliario', error);
  }
});

router.patch('/mobiliario/:id/estado', checkPermission(MOBILIARIO_STATE_PERMISSIONS), async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const estadoResult = parseBooleanValue(req.body?.activo, 'activo');
    if (!estadoResult.ok) return sendValidationError(res, estadoResult.error);

    const result = await pool.query(
      `
        UPDATE public.mobiliario
        SET activo = $2
        WHERE id_mobiliario = $1
        RETURNING id_mobiliario, activo
      `,
      [idResult.value, estadoResult.value]
    );

    if (!result.rows?.length) return sendNotFound(res, 'Registro de mobiliario no encontrado.');

    return res.status(200).json({
      ok: true,
      message: estadoResult.value ? 'Bien reactivado correctamente.' : 'Bien desactivado correctamente.',
      data: result.rows[0]
    });
  } catch (error) {
    return sendInternalError(res, 'Error al cambiar estado de mobiliario', error);
  }
});

export default router;
