import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const TABLA_PROVEEDORES = 'public.proveedores';
const PROVEEDOR_EDITABLE_FIELDS = new Set([
  'nombre_proveedor',
  'id_persona',
  'id_empresa',
  'correo_electronico',
  'telefono_principal',
  'telefono_secundario',
  'contacto_principal',
  'direccion',
  'ciudad',
  'rtn',
  'plazo_pago_dias',
  'observaciones',
  'estado'
]);

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

const sendConflictError = (res, message, extra = {}) =>
  sendError(res, 409, 'CONFLICT', message, extra);

const sendNotFoundError = (res, message) =>
  sendError(res, 404, 'NOT_FOUND', message);

const sendInternalError = (res, context, error) => {
  console.error(`[proveedores] ${context}:`, error);
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

const parseOptionalPositiveInt = (rawValue, fieldName) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return { ok: false, error: `${fieldName} debe ser un entero mayor a 0.` };
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

const parseBooleanState = (rawValue, fieldName = 'estado') => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  if (rawValue === true || rawValue === 1 || rawValue === '1') return { ok: true, value: true };
  if (rawValue === false || rawValue === 0 || rawValue === '0') return { ok: true, value: false };

  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false, error: `${fieldName} invalido.` };
};

const parseOptionalText = (rawValue, fieldName, { max = 255 } = {}) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const value = String(rawValue).trim();
  if (!value) return { ok: true, value: null };
  if (value.length > max) {
    return { ok: false, error: `${fieldName} no puede superar ${max} caracteres.` };
  }
  return { ok: true, value };
};

const parseNombreProveedor = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: false, error: 'nombre_proveedor es obligatorio.' };
  const value = String(rawValue).trim();
  if (value.length < 2) return { ok: false, error: 'nombre_proveedor debe tener al menos 2 caracteres.' };
  if (value.length > 120) return { ok: false, error: 'nombre_proveedor no puede superar 120 caracteres.' };
  return { ok: true, value };
};

const parseOptionalEmail = (rawValue) => {
  const parsed = parseOptionalText(rawValue, 'correo_electronico', { max: 160 });
  if (!parsed.ok || !parsed.value) return parsed;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(parsed.value)) {
    return { ok: false, error: 'correo_electronico no tiene un formato valido.' };
  }
  return parsed;
};

const parsePlazoPago = (rawValue) => {
  if (!hasValue(rawValue)) return { ok: true, value: null };
  const normalizedValue = Number(rawValue);
  if (!Number.isInteger(normalizedValue) || normalizedValue < 0) {
    return { ok: false, error: 'plazo_pago_dias debe ser un entero mayor o igual a 0.' };
  }
  if (normalizedValue > 3650) {
    return { ok: false, error: 'plazo_pago_dias no puede superar 3650 dias.' };
  }
  return { ok: true, value: normalizedValue };
};

const CUENTA_TIPOS_VALIDOS = new Set(['AHORRO', 'CHEQUES', 'OTRA']);
const CUENTA_MONEDAS_VALIDAS = new Set(['HNL', 'USD']);

// AM: valida y normaliza una cuenta bancaria de proveedor.
const normalizeCuentaBancariaPayload = (rawCuenta, index) => {
  const cuenta = rawCuenta && typeof rawCuenta === 'object' ? rawCuenta : {};
  const errors = {};

  const banco = String(cuenta?.banco ?? '').trim();
  const tipoCuenta = String(cuenta?.tipo_cuenta ?? '').trim().toUpperCase();
  const numeroCuenta = String(cuenta?.numero_cuenta ?? '').trim();
  const nombreTitular = parseOptionalText(cuenta?.nombre_titular, 'nombre_titular', { max: 120 });
  const identificacionTitular = parseOptionalText(cuenta?.identificacion_titular, 'identificacion_titular', {
    max: 60
  });
  const monedaRaw = String(cuenta?.moneda ?? 'HNL').trim().toUpperCase();
  const esPrincipalParsed = parseBooleanState(cuenta?.es_principal, 'es_principal');
  const observacion = parseOptionalText(cuenta?.observacion, 'observacion', { max: 255 });

  if (!banco) errors.banco = `cuentas_bancarias[${index}].banco es obligatorio.`;
  else if (banco.length > 120) errors.banco = `cuentas_bancarias[${index}].banco no puede superar 120 caracteres.`;

  if (!tipoCuenta) errors.tipo_cuenta = `cuentas_bancarias[${index}].tipo_cuenta es obligatorio.`;
  else if (!CUENTA_TIPOS_VALIDOS.has(tipoCuenta)) {
    errors.tipo_cuenta = `cuentas_bancarias[${index}].tipo_cuenta debe ser AHORRO, CHEQUES u OTRA.`;
  }

  if (!numeroCuenta) errors.numero_cuenta = `cuentas_bancarias[${index}].numero_cuenta es obligatorio.`;
  else if (numeroCuenta.length > 80) {
    errors.numero_cuenta = `cuentas_bancarias[${index}].numero_cuenta no puede superar 80 caracteres.`;
  }

  if (!CUENTA_MONEDAS_VALIDAS.has(monedaRaw)) {
    errors.moneda = `cuentas_bancarias[${index}].moneda debe ser HNL o USD.`;
  }

  if (!nombreTitular.ok) errors.nombre_titular = `cuentas_bancarias[${index}].${nombreTitular.error}`;
  if (!identificacionTitular.ok) {
    errors.identificacion_titular = `cuentas_bancarias[${index}].${identificacionTitular.error}`;
  }
  if (!esPrincipalParsed.ok) errors.es_principal = `cuentas_bancarias[${index}].${esPrincipalParsed.error}`;
  if (!observacion.ok) errors.observacion = `cuentas_bancarias[${index}].${observacion.error}`;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    cuenta: {
      banco,
      tipo_cuenta: tipoCuenta,
      numero_cuenta: numeroCuenta,
      nombre_titular: nombreTitular.value ?? null,
      identificacion_titular: identificacionTitular.value ?? null,
      moneda: monedaRaw,
      es_principal: esPrincipalParsed.value === true,
      estado: parseBooleanState(cuenta?.estado, 'estado').value !== false,
      observacion: observacion.value ?? null
    }
  };
};

// AM: valida arreglo de cuentas bancarias para alta/edicion de proveedor.
const normalizeCuentasBancariasPayload = (rawCuentas) => {
  if (rawCuentas === undefined) return { ok: true, cuentas: [], provided: false };
  if (rawCuentas === null) return { ok: true, cuentas: [], provided: true };
  if (!Array.isArray(rawCuentas)) {
    return {
      ok: false,
      errors: {
        cuentas_bancarias: 'cuentas_bancarias debe ser un arreglo.'
      }
    };
  }

  const normalized = [];
  const errors = {};
  const accountKeys = new Set();
  let principalCount = 0;

  rawCuentas.forEach((cuenta, index) => {
    const parsed = normalizeCuentaBancariaPayload(cuenta, index);
    if (!parsed.ok) {
      Object.assign(errors, parsed.errors);
      return;
    }

    const accountKey = `${parsed.cuenta.numero_cuenta}`.toUpperCase();
    if (accountKeys.has(accountKey)) {
      errors[`cuentas_bancarias_${index}_duplicado`] = `cuentas_bancarias[${index}] repite numero_cuenta.`;
      return;
    }

    accountKeys.add(accountKey);
    if (parsed.cuenta.es_principal) principalCount += 1;
    normalized.push(parsed.cuenta);
  });

  if (principalCount > 1) {
    errors.cuentas_bancarias = 'Solo se permite una cuenta principal por proveedor.';
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    cuentas: normalized,
    provided: true
  };
};

const findProveedorById = async (queryable, idProveedor) => {
  const result = await queryable.query(
    `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        p.nombre_proveedor,
        p.id_persona,
        p.id_empresa,
        p.correo_electronico,
        p.telefono_principal,
        p.telefono_secundario,
        p.contacto_principal,
        p.direccion,
        p.ciudad,
        p.rtn,
        p.plazo_pago_dias,
        p.observaciones,
        COALESCE(p.estado, true) AS estado,
        p.fecha_registro,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count,
        (
          COALESCE(cd.compras_count, 0) = 0
          AND COALESCE(kd.cuentas_bancarias_count, 0) = 0
        ) AS can_delete
      FROM public.proveedores p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE p.id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );

  return result.rows?.[0] || null;
};

const listCuentasBancariasByProveedor = async (queryable, idProveedor) => {
  const result = await queryable.query(
    `
      SELECT
        id_cuenta_bancaria,
        id_proveedor,
        banco,
        UPPER(tipo_cuenta) AS tipo_cuenta,
        numero_cuenta,
        nombre_titular,
        identificacion_titular,
        UPPER(moneda) AS moneda,
        COALESCE(es_principal, false) AS es_principal,
        COALESCE(estado, true) AS estado,
        observacion,
        fecha_registro
      FROM public.proveedores_cuentas_bancarias
      WHERE id_proveedor = $1
      ORDER BY COALESCE(es_principal, false) DESC, id_cuenta_bancaria ASC
    `,
    [idProveedor]
  );

  return result.rows || [];
};

const replaceCuentasBancariasProveedor = async (queryable, idProveedor, cuentas) => {
  await queryable.query('DELETE FROM public.proveedores_cuentas_bancarias WHERE id_proveedor = $1', [idProveedor]);

  for (const cuenta of Array.isArray(cuentas) ? cuentas : []) {
    await queryable.query(
      `
        INSERT INTO public.proveedores_cuentas_bancarias (
          id_proveedor,
          banco,
          tipo_cuenta,
          numero_cuenta,
          nombre_titular,
          identificacion_titular,
          moneda,
          es_principal,
          estado,
          observacion
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,
      [
        idProveedor,
        cuenta.banco,
        cuenta.tipo_cuenta,
        cuenta.numero_cuenta,
        cuenta.nombre_titular ?? null,
        cuenta.identificacion_titular ?? null,
        cuenta.moneda,
        cuenta.es_principal === true,
        cuenta.estado !== false,
        cuenta.observacion ?? null
      ]
    );
  }
};

// AM: normaliza payload de proveedores para create/update con validacion de tipos y longitudes.
const normalizeProveedorPayload = (rawPayload, { partial = false } = {}) => {
  const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const cleaned = {};
  const errors = {};

  const assignIfPresent = (key, parser) => {
    if (!partial || Object.prototype.hasOwnProperty.call(payload, key)) {
      const parsed = parser(payload[key]);
      if (!parsed.ok) {
        errors[key] = parsed.error;
      } else if (parsed.value !== null) {
        cleaned[key] = parsed.value;
      } else if (partial) {
        cleaned[key] = null;
      }
    }
  };

  assignIfPresent('nombre_proveedor', parseNombreProveedor);
  assignIfPresent('id_persona', (value) => parseOptionalPositiveInt(value, 'id_persona'));
  assignIfPresent('id_empresa', (value) => parseOptionalPositiveInt(value, 'id_empresa'));
  assignIfPresent('correo_electronico', parseOptionalEmail);
  assignIfPresent('telefono_principal', (value) =>
    parseOptionalText(value, 'telefono_principal', { max: 30 })
  );
  assignIfPresent('telefono_secundario', (value) =>
    parseOptionalText(value, 'telefono_secundario', { max: 30 })
  );
  assignIfPresent('contacto_principal', (value) =>
    parseOptionalText(value, 'contacto_principal', { max: 120 })
  );
  assignIfPresent('direccion', (value) => parseOptionalText(value, 'direccion', { max: 240 }));
  assignIfPresent('ciudad', (value) => parseOptionalText(value, 'ciudad', { max: 120 }));
  assignIfPresent('rtn', (value) => parseOptionalText(value, 'rtn', { max: 30 }));
  assignIfPresent('plazo_pago_dias', parsePlazoPago);
  assignIfPresent('observaciones', (value) => parseOptionalText(value, 'observaciones', { max: 500 }));
  assignIfPresent('estado', (value) => parseBooleanState(value, 'estado'));

  if (!partial && !Object.prototype.hasOwnProperty.call(cleaned, 'estado')) {
    cleaned.estado = true;
  }

  if (!partial && !Object.prototype.hasOwnProperty.call(cleaned, 'plazo_pago_dias')) {
    cleaned.plazo_pago_dias = 0;
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    cleaned
  };
};

const getProveedorDependenciasById = async (idProveedor) => {
  const dependencyResult = await pool.query(
    `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        COALESCE(p.estado, true) AS estado,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count
      FROM public.proveedores p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE p.id_proveedor = $1
      LIMIT 1
    `,
    [idProveedor]
  );

  const row = dependencyResult.rows?.[0];
  if (!row) return { exists: false };

  const counts = {
    compras: Number(row.compras_count ?? 0),
    cuentas_bancarias: Number(row.cuentas_bancarias_count ?? 0)
  };

  return {
    exists: true,
    id_proveedor: Number(row.id_proveedor),
    estado: Boolean(row.estado),
    counts,
    canDelete: counts.compras === 0 && counts.cuentas_bancarias === 0
  };
};

const normalizeProveedorMutationError = (error) => {
  switch (error?.code) {
    case '23503':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Existe un valor relacionado que no esta registrado en catalogos.'
      };
    case '23505':
      if (String(error?.constraint || '').trim() === 'uq_prov_numero_cuenta') {
        return {
          status: 409,
          code: 'CONFLICT',
          message: 'No se puede repetir numero_cuenta para el mismo proveedor.'
        };
      }
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'Ya existe un proveedor con los datos enviados.'
      };
    case '22P02':
    case '22003':
    case '23514':
    case '428C9':
      return {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Los datos enviados no son validos.'
      };
    default:
      return null;
  }
};

const sendProveedorMutationError = (res, context, error) => {
  const normalized = normalizeProveedorMutationError(error);
  if (normalized) {
    console.error(`[proveedores] ${context}:`, error);
    return sendError(res, normalized.status, normalized.code, normalized.message);
  }
  return sendInternalError(res, context, error);
};

const executeProveedorUpdate = async (idProveedor, cleanedFields, queryable = pool) => {
  const entries = Object.entries(cleanedFields).filter(([field]) => PROVEEDOR_EDITABLE_FIELDS.has(field));
  if (!entries.length) return { updated: false, reason: 'NO_FIELDS' };

  const setParts = [];
  const values = [idProveedor];
  let paramIndex = 2;

  for (const [field, value] of entries) {
    setParts.push(`${field} = $${paramIndex}`);
    values.push(value);
    paramIndex += 1;
  }

  const query = `
    UPDATE ${TABLA_PROVEEDORES}
    SET ${setParts.join(', ')}
    WHERE id_proveedor = $1
    RETURNING
      id_proveedor,
      nombre_proveedor,
      id_persona,
      id_empresa,
      correo_electronico,
      telefono_principal,
      telefono_secundario,
      contacto_principal,
      direccion,
      ciudad,
      rtn,
      plazo_pago_dias,
      observaciones,
      COALESCE(estado, true) AS estado,
      fecha_registro
  `;

  const result = await queryable.query(query, values);
  if (!result.rows?.length) return { updated: false, reason: 'NOT_FOUND' };

  return { updated: true, row: result.rows[0] };
};

const executeProveedorDelete = async (idProveedor) => {
  const dependency = await getProveedorDependenciasById(idProveedor);
  if (!dependency.exists) return { deleted: false, reason: 'NOT_FOUND' };
  if (!dependency.canDelete) {
    return {
      deleted: false,
      reason: 'DEPENDENCIES',
      dependency
    };
  }

  const deleteResult = await pool.query(
    `
      DELETE FROM ${TABLA_PROVEEDORES}
      WHERE id_proveedor = $1
      RETURNING id_proveedor, nombre_proveedor
    `,
    [idProveedor]
  );

  if (!deleteResult.rows?.length) return { deleted: false, reason: 'NOT_FOUND' };
  return { deleted: true, row: deleteResult.rows[0] };
};

// GET: listado operativo de proveedores (con dependencias y opcion de incluir inactivos).
router.get('/proveedores', async (req, res) => {
  try {
    const includeInactivosResult = parseIncludeInactivos(req.query?.include_inactivos);
    if (!includeInactivosResult.ok) {
      return sendValidationError(res, includeInactivosResult.error);
    }

    const query = `
      WITH compras_dep AS (
        SELECT c.id_proveedor, COUNT(*)::int AS compras_count
        FROM public.compras c
        GROUP BY c.id_proveedor
      ),
      cuentas_dep AS (
        SELECT pcb.id_proveedor, COUNT(*)::int AS cuentas_bancarias_count
        FROM public.proveedores_cuentas_bancarias pcb
        GROUP BY pcb.id_proveedor
      )
      SELECT
        p.id_proveedor,
        p.nombre_proveedor,
        p.id_persona,
        p.id_empresa,
        p.correo_electronico,
        p.telefono_principal,
        p.telefono_secundario,
        p.contacto_principal,
        p.direccion,
        p.ciudad,
        p.rtn,
        p.plazo_pago_dias,
        p.observaciones,
        COALESCE(p.estado, true) AS estado,
        p.fecha_registro,
        COALESCE(cd.compras_count, 0)::int AS compras_count,
        COALESCE(kd.cuentas_bancarias_count, 0)::int AS cuentas_bancarias_count,
        (
          COALESCE(cd.compras_count, 0) = 0
          AND COALESCE(kd.cuentas_bancarias_count, 0) = 0
        ) AS can_delete
      FROM ${TABLA_PROVEEDORES} p
      LEFT JOIN compras_dep cd
        ON cd.id_proveedor = p.id_proveedor
      LEFT JOIN cuentas_dep kd
        ON kd.id_proveedor = p.id_proveedor
      WHERE ($1::boolean = true OR COALESCE(p.estado, true) = true)
      ORDER BY p.id_proveedor ASC
    `;

    const result = await pool.query(query, [includeInactivosResult.value]);
    return res.status(200).json(result.rows || []);
  } catch (error) {
    return sendInternalError(res, 'Error al obtener proveedores', error);
  }
});

// GET: dependencias por proveedor (para decidir eliminar vs inactivar).
router.get('/proveedores/:id/dependencias', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const dependency = await getProveedorDependenciasById(idResult.value);
    if (!dependency.exists) return sendNotFoundError(res, 'Proveedor no encontrado.');

    return res.status(200).json({
      ok: true,
      id_proveedor: dependency.id_proveedor,
      counts: dependency.counts,
      canDelete: dependency.canDelete
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener dependencias de proveedor', error);
  }
});

// AM: detalle operativo por proveedor con todas sus cuentas bancarias.
router.get('/proveedores/:id', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const proveedor = await findProveedorById(pool, idResult.value);
    if (!proveedor) return sendNotFoundError(res, 'Proveedor no encontrado.');

    const cuentas = await listCuentasBancariasByProveedor(pool, idResult.value);

    return res.status(200).json({
      ok: true,
      data: {
        ...proveedor,
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    return sendInternalError(res, 'Error al obtener detalle de proveedor', error);
  }
});

// POST: crear proveedor.
router.post('/proveedores', async (req, res) => {
  const client = await pool.connect();
  try {
    const cuentasValidation = normalizeCuentasBancariasPayload(req.body?.cuentas_bancarias);
    if (!cuentasValidation.ok) {
      return sendValidationError(
        res,
        'Datos invalidos en cuentas bancarias del proveedor.',
        cuentasValidation.errors
      );
    }

    const validation = normalizeProveedorPayload(req.body, { partial: false });
    if (!validation.ok) {
      return sendValidationError(res, 'Datos invalidos para crear proveedor.', validation.errors);
    }

    await client.query('BEGIN');
    const proveedor = validation.cleaned;
    const insertResult = await client.query(
      `
        INSERT INTO ${TABLA_PROVEEDORES} (
          nombre_proveedor,
          id_persona,
          id_empresa,
          correo_electronico,
          telefono_principal,
          telefono_secundario,
          contacto_principal,
          direccion,
          ciudad,
          rtn,
          plazo_pago_dias,
          observaciones,
          estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING
          id_proveedor,
          nombre_proveedor,
          id_persona,
          id_empresa,
          correo_electronico,
          telefono_principal,
          telefono_secundario,
          contacto_principal,
          direccion,
          ciudad,
          rtn,
          plazo_pago_dias,
          observaciones,
          COALESCE(estado, true) AS estado,
          fecha_registro
      `,
      [
        proveedor.nombre_proveedor,
        proveedor.id_persona ?? null,
        proveedor.id_empresa ?? null,
        proveedor.correo_electronico ?? null,
        proveedor.telefono_principal ?? null,
        proveedor.telefono_secundario ?? null,
        proveedor.contacto_principal ?? null,
        proveedor.direccion ?? null,
        proveedor.ciudad ?? null,
        proveedor.rtn ?? null,
        proveedor.plazo_pago_dias ?? 0,
        proveedor.observaciones ?? null,
        proveedor.estado ?? true
      ]
    );

    const idProveedor = Number(insertResult.rows?.[0]?.id_proveedor ?? 0);

    // AM: guarda cuentas bancarias en la misma transaccion para mantener integridad.
    if (cuentasValidation.provided) {
      await replaceCuentasBancariasProveedor(client, idProveedor, cuentasValidation.cuentas);
    }

    const cuentas = await listCuentasBancariasByProveedor(client, idProveedor);

    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      message: 'Proveedor creado correctamente.',
      data: {
        ...(insertResult.rows?.[0] || {}),
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    return sendProveedorMutationError(res, 'Error al crear proveedor', error);
  } finally {
    client.release();
  }
});

// PUT moderno: actualizar proveedor por id.
router.put('/proveedores/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const cuentasValidation = normalizeCuentasBancariasPayload(req.body?.cuentas_bancarias);
    if (!cuentasValidation.ok) {
      return sendValidationError(
        res,
        'Datos invalidos en cuentas bancarias del proveedor.',
        cuentasValidation.errors
      );
    }

    const validation = normalizeProveedorPayload(req.body, { partial: true });
    if (!validation.ok) {
      return sendValidationError(res, 'Datos invalidos para actualizar proveedor.', validation.errors);
    }

    const hasProveedorFields = Object.keys(validation.cleaned).length > 0;
    const hasCuentasPayload = cuentasValidation.provided;

    if (!hasProveedorFields && !hasCuentasPayload) {
      return sendValidationError(res, 'Debes enviar al menos un campo editable o cuentas_bancarias.');
    }

    await client.query('BEGIN');

    let updateResult = { updated: true, row: null };

    if (hasProveedorFields) {
      updateResult = await executeProveedorUpdate(idResult.value, validation.cleaned, client);
      if (!updateResult.updated && updateResult.reason === 'NO_FIELDS') {
        await client.query('ROLLBACK');
        return sendValidationError(res, 'No se detectaron campos editables para actualizar.');
      }
      if (!updateResult.updated && updateResult.reason === 'NOT_FOUND') {
        await client.query('ROLLBACK');
        return sendNotFoundError(res, 'Proveedor no encontrado.');
      }
    } else {
      const exists = await findProveedorById(client, idResult.value);
      if (!exists) {
        await client.query('ROLLBACK');
        return sendNotFoundError(res, 'Proveedor no encontrado.');
      }
    }

    if (hasCuentasPayload) {
      await replaceCuentasBancariasProveedor(client, idResult.value, cuentasValidation.cuentas);
    }

    const proveedor = await findProveedorById(client, idResult.value);
    const cuentas = await listCuentasBancariasByProveedor(client, idResult.value);

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Proveedor actualizado correctamente.',
      data: {
        ...(proveedor || updateResult.row || {}),
        cuentas_bancarias: cuentas
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // noop
    }
    return sendProveedorMutationError(res, 'Error al actualizar proveedor', error);
  } finally {
    client.release();
  }
});

// PUT legacy: actualizacion de un solo campo con contrato previo.
router.put('/proveedores', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};
    if (!hasValue(campo) || !hasValue(id_campo) || !hasValue(id_valor)) {
      return sendValidationError(res, 'Faltan campos obligatorios para el formato legacy.');
    }

    if (String(id_campo).trim() !== 'id_proveedor') {
      return sendValidationError(res, "id_campo debe ser 'id_proveedor'.");
    }

    if (!PROVEEDOR_EDITABLE_FIELDS.has(String(campo).trim())) {
      return sendValidationError(res, `Campo no permitido para actualizar: ${campo}.`);
    }

    const idResult = parsePositiveInt(id_valor, 'id_valor');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const payload = { [String(campo).trim()]: valor };
    const validation = normalizeProveedorPayload(payload, { partial: true });
    if (!validation.ok) {
      return sendValidationError(res, 'Valor invalido para el campo solicitado.', validation.errors);
    }

    const updateResult = await executeProveedorUpdate(idResult.value, validation.cleaned);
    if (!updateResult.updated && updateResult.reason === 'NOT_FOUND') {
      return sendNotFoundError(res, 'Proveedor no encontrado.');
    }
    if (!updateResult.updated && updateResult.reason === 'NO_FIELDS') {
      return sendValidationError(res, 'No se detectaron campos validos para actualizar.');
    }

    return res.status(200).json({
      ok: true,
      message: 'Proveedor actualizado correctamente.',
      data: updateResult.row
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al actualizar proveedor (legacy)', error);
  }
});

// PATCH: inactivar proveedor.
router.patch('/proveedores/:id/inactivar', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const current = await pool.query(
      `SELECT id_proveedor, COALESCE(estado, true) AS estado
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );

    if (!current.rows?.length) return sendNotFoundError(res, 'Proveedor no encontrado.');
    const wasActive = Boolean(current.rows[0].estado);

    if (wasActive) {
      await pool.query(
        `UPDATE ${TABLA_PROVEEDORES}
         SET estado = false
         WHERE id_proveedor = $1`,
        [idResult.value]
      );
    }

    return res.status(200).json({
      ok: true,
      id_proveedor: idResult.value,
      estado: false,
      message: wasActive ? 'Proveedor inactivado correctamente.' : 'El proveedor ya estaba inactivo.'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al inactivar proveedor', error);
  }
});

// PATCH: reactivar proveedor.
router.patch('/proveedores/:id/reactivar', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const current = await pool.query(
      `SELECT id_proveedor, COALESCE(estado, true) AS estado
       FROM ${TABLA_PROVEEDORES}
       WHERE id_proveedor = $1
       LIMIT 1`,
      [idResult.value]
    );

    if (!current.rows?.length) return sendNotFoundError(res, 'Proveedor no encontrado.');
    const wasActive = Boolean(current.rows[0].estado);

    if (!wasActive) {
      await pool.query(
        `UPDATE ${TABLA_PROVEEDORES}
         SET estado = true
         WHERE id_proveedor = $1`,
        [idResult.value]
      );
    }

    return res.status(200).json({
      ok: true,
      id_proveedor: idResult.value,
      estado: true,
      message: wasActive ? 'El proveedor ya estaba activo.' : 'Proveedor reactivado correctamente.'
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al reactivar proveedor', error);
  }
});

// DELETE moderno: elimina proveedor por id si no tiene dependencias.
router.delete('/proveedores/:id', async (req, res) => {
  try {
    const idResult = parsePositiveInt(req.params?.id, 'id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const deleteResult = await executeProveedorDelete(idResult.value);
    if (!deleteResult.deleted && deleteResult.reason === 'NOT_FOUND') {
      return sendNotFoundError(res, 'Proveedor no encontrado.');
    }
    if (!deleteResult.deleted && deleteResult.reason === 'DEPENDENCIES') {
      return sendConflictError(
        res,
        'No se puede eliminar el proveedor porque tiene compras o cuentas bancarias asociadas.',
        {
          counts: deleteResult.dependency?.counts || { compras: 0, cuentas_bancarias: 0 }
        }
      );
    }

    return res.status(200).json({
      ok: true,
      message: 'Proveedor eliminado correctamente.',
      data: deleteResult.row
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al eliminar proveedor', error);
  }
});

// DELETE legacy: elimina por payload previo { columna_id, valor_id }.
router.delete('/proveedores', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};
    if (!hasValue(columna_id) || !hasValue(valor_id)) {
      return sendValidationError(res, 'Faltan datos para eliminar (formato legacy).');
    }
    if (String(columna_id).trim() !== 'id_proveedor') {
      return sendValidationError(res, "columna_id debe ser 'id_proveedor'.");
    }

    const idResult = parsePositiveInt(valor_id, 'valor_id');
    if (!idResult.ok) return sendValidationError(res, idResult.error);

    const deleteResult = await executeProveedorDelete(idResult.value);
    if (!deleteResult.deleted && deleteResult.reason === 'NOT_FOUND') {
      return sendNotFoundError(res, 'Proveedor no encontrado.');
    }
    if (!deleteResult.deleted && deleteResult.reason === 'DEPENDENCIES') {
      return sendConflictError(
        res,
        'No se puede eliminar el proveedor porque tiene compras o cuentas bancarias asociadas.',
        {
          counts: deleteResult.dependency?.counts || { compras: 0, cuentas_bancarias: 0 }
        }
      );
    }

    return res.status(200).json({
      ok: true,
      message: 'Proveedor eliminado correctamente.',
      data: deleteResult.row
    });
  } catch (error) {
    return sendProveedorMutationError(res, 'Error al eliminar proveedor (legacy)', error);
  }
});

export default router;
