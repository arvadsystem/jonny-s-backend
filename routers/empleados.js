import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const EMPLEADOS_LIST_PERMISSIONS = ['EMPLEADOS_LISTADO_VER'];
const EMPLEADOS_DETAIL_PERMISSIONS = ['EMPLEADOS_DETALLE_VER'];
const EMPLEADOS_CREATE_PERMISSIONS = ['EMPLEADOS_CREAR'];
const EMPLEADOS_EDIT_PERMISSIONS = ['EMPLEADOS_EDITAR'];
const EMPLEADOS_DELETE_PERMISSIONS = ['EMPLEADOS_ELIMINAR'];

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_empleado', 'fecha_ingreso', 'salario_base', 'estado', 'id_sucursal', 'id_persona'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FUNCTION_UPDATE_FIELDS = new Set([
  'fecha_ingreso',
  'salario_base',
  'estado',
  'id_sucursal',
  'id_persona',
  'cargo',
  'nombre_referencia',
  'telefono_referencia'
]);

let schemaCapabilitiesPromise;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanFilter = (value) => {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo'].includes(normalized)) return false;
  return null;
};

const resolveUserId = (req) => req.user?.id_usuario ?? null;
const normalizeSearchText = (value) => String(value ?? '').trim().toLowerCase();
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const hasTextValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';

const normalizeLegacyUpdatePayload = (body) => {
  if (!isPlainObject(body)) return null;
  if (!hasOwn(body, 'campo')) return null;

  const campo = typeof body.campo === 'string' ? body.campo.trim() : '';
  if (!campo || body.valor === undefined) return null;
  return { [campo]: body.valor };
};

const mapEmpleadoListRow = (row) => {
  const personaNombre = row.persona_nombre ?? row.nombre ?? null;
  const personaApellido = row.persona_apellido ?? row.apellido ?? null;
  const personaDni = row.persona_dni ?? row.dni ?? null;
  const fullNameFromParts = [personaNombre, personaApellido].filter(Boolean).join(' ').trim();
  const personaNombreCompleto =
    row.persona_nombre_completo ??
    row.nombre_completo ??
    (fullNameFromParts || null);
  const sucursalNombre = row.sucursal_nombre ?? row.nombre_sucursal ?? row.sucursal ?? null;
  const telefono =
    row.telefono ??
    row.texto_telefono ??
    row.telefono_texto ??
    row.persona_telefono ??
    row.telefono_persona ??
    null;
  const correo =
    row.correo ??
    row.texto_correo ??
    row.correo_texto ??
    row.direccion_correo ??
    row.email ??
    null;
  const direccion =
    row.direccion ??
    row.texto_direccion ??
    row.direccion_texto ??
    row.persona_direccion ??
    row.direccion_persona ??
    null;

  return {
    ...row,
    persona_nombre: personaNombre,
    persona_apellido: personaApellido,
    persona_dni: personaDni,
    persona_nombre_completo: personaNombreCompleto,
    sucursal_nombre: sucursalNombre,
    nombre_sucursal: row.nombre_sucursal ?? sucursalNombre,
    telefono,
    correo,
    direccion
  };
};

const empleadoMatchesSearch = (empleado, normalizedSearch) => {
  if (!normalizedSearch) return true;

  const haystack = [
    empleado.id_empleado,
    empleado.salario_base,
    empleado.cargo,
    empleado.persona_nombre,
    empleado.persona_apellido,
    empleado.persona_nombre_completo,
    empleado.nombre,
    empleado.apellido,
    empleado.nombre_completo,
    empleado.persona_dni,
    empleado.dni,
    empleado.telefono,
    empleado.correo,
    empleado.direccion,
    empleado.sucursal_nombre,
    empleado.nombre_sucursal,
    empleado.sucursal
  ]
    .map((value) => String(value ?? ''))
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalizedSearch);
};

const mapDbError = (err) => {
  if (!err?.code) return null;

  if (err.code === 'P0001' && /no existe/i.test(err.message || '')) {
    return { status: 404, message: err.message };
  }

  const badRequestCodes = new Set(['22P02', '22003', '22007', '22008', '23502', '23503', '23505', 'P0001']);
  if (badRequestCodes.has(err.code)) {
    return {
      status: 400,
      message: err.detail || err.message || 'Solicitud invalida para empleados'
    };
  }

  return null;
};

const getSchemaCapabilities = async () => {
  if (!schemaCapabilitiesPromise) {
    schemaCapabilitiesPromise = (async () => {
      const tableColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'empleados'
      `;

      const personasColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'personas'
      `;

      const sucursalesColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sucursales'
      `;

      const relatedTablesQuery = `
        SELECT
          to_regclass('public.personas') AS personas_table,
          to_regclass('public.sucursales') AS sucursales_table,
          to_regclass('public.direcciones') AS direcciones_table,
          to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [columnsResult, personasColumnsResult, relatedTablesResult] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(personasColumnsQuery),
        pool.query(relatedTablesQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const personasColumns = new Set(personasColumnsResult.rows.map((row) => row.column_name));
      const relatedTables = relatedTablesResult.rows[0] || {};
      const hasSucursalesTable = Boolean(relatedTables.sucursales_table);

      let sucursalNameField = null;
      if (hasSucursalesTable) {
        const sucursalesColumnsResult = await pool.query(sucursalesColumnsQuery);
        const sucursalesColumns = new Set(sucursalesColumnsResult.rows.map((row) => row.column_name));
        sucursalNameField =
          ['nombre_sucursal', 'nombre', 'sucursal'].find((field) => sucursalesColumns.has(field)) || null;
      }

      const softDeleteField = OPTIONAL_SOFT_DELETE_FIELDS.find((field) => columns.has(field)) || null;

      return {
        columns,
        softDeleteField,
        hasCreatedBy: columns.has('created_by'),
        hasUpdatedBy: columns.has('updated_by'),
        hasTenantField: columns.has('id_empresa'),
        hasPersonasTable: Boolean(relatedTables.personas_table),
        hasDireccionesTable: Boolean(relatedTables.direcciones_table),
        hasPersonaTenantField: personasColumns.has('id_empresa'),
        hasSucursalesTable,
        sucursalNameField,
        hasBitacorasTable: Boolean(relatedTables.bitacoras_table)
      };
    })().catch((err) => {
      schemaCapabilitiesPromise = null;
      throw err;
    });
  }

  return schemaCapabilitiesPromise;
};

const empleadoRepository = {
  async list() {
    const result = await pool.query('SELECT * FROM empleados_listar()');
    return result.rows;
  },

  async findDetailById(idEmpleado) {
    const result = await pool.query(
      'SELECT * FROM empleados_listar() WHERE id_empleado = $1 LIMIT 1',
      [idEmpleado]
    );
    return result.rows[0] || null;
  },

  async backfillDirecciones(rows, capabilities) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    if (!capabilities?.hasPersonasTable || !capabilities?.hasDireccionesTable) return rows;

    const personaIds = [
      ...new Set(
        rows
          .map((row) => parsePositiveInt(row?.id_persona))
          .filter(Boolean)
      )
    ];

    if (!personaIds.length) return rows;

    const direccionesResult = await pool.query(
      `
        SELECT p.id_persona, d.direccion
        FROM personas p
        LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
        WHERE p.id_persona = ANY($1::int[])
      `,
      [personaIds]
    );

    const direccionByPersona = new Map(
      direccionesResult.rows.map((row) => [parsePositiveInt(row.id_persona), row.direccion ?? null])
    );

    return rows.map((row) => {
      const currentDireccion = row?.direccion ?? row?.texto_direccion ?? row?.direccion_texto;
      if (hasTextValue(currentDireccion)) return row;

      const personaId = parsePositiveInt(row?.id_persona);
      if (!personaId) return row;

      const fallbackDireccion = direccionByPersona.get(personaId);
      if (!hasTextValue(fallbackDireccion)) return row;

      return {
        ...row,
        direccion: fallbackDireccion,
        texto_direccion: row?.texto_direccion ?? fallbackDireccion
      };
    });
  },

  async findById(idEmpleado, capabilities) {
    const fields = BASE_FIELDS.map((field) => `e.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`e.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('e.created_by');
    if (capabilities.hasUpdatedBy) fields.push('e.updated_by');
    if (capabilities.hasTenantField && !BASE_FIELDS.includes('id_empresa')) fields.push('e.id_empresa');

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
      if (capabilities.hasPersonaTenantField) fields.push('p.id_empresa AS persona_id_empresa');
    }

    if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
      fields.push(`s.${capabilities.sucursalNameField} AS sucursal_nombre`);
    }

    const joins = [];
    if (capabilities.hasPersonasTable) joins.push('LEFT JOIN personas p ON p.id_persona = e.id_persona');
    if (capabilities.hasSucursalesTable) joins.push('LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal');

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const query = `
      SELECT ${fields.join(', ')}
      FROM empleados e${joinsSql}
      WHERE e.id_empleado = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [idEmpleado]);
    return result.rows[0] || null;
  },

  async create(data) {
    const result = await pool.query(
      'SELECT empleados_crear($1::json) AS id_empleado',
      [JSON.stringify(data ?? {})]
    );
    return parsePositiveInt(result.rows[0]?.id_empleado);
  },

  async update(idEmpleado, data) {
    await pool.query(
      'SELECT empleados_actualizar($1, $2::json)',
      [idEmpleado, JSON.stringify(data ?? {})]
    );
  },

  async listTenantEmpleadoIds(tenantId, capabilities) {
    if (!tenantId) return null;

    if (capabilities.hasTenantField) {
      const tenantRows = await pool.query(
        'SELECT id_empleado FROM empleados WHERE id_empresa = $1',
        [tenantId]
      );
      return new Set(
        tenantRows.rows
          .map((row) => parsePositiveInt(row.id_empleado))
          .filter(Boolean)
      );
    }

    if (capabilities.hasPersonasTable && capabilities.hasPersonaTenantField) {
      const tenantRows = await pool.query(
        `
          SELECT e.id_empleado
          FROM empleados e
          INNER JOIN personas p ON p.id_persona = e.id_persona
          WHERE p.id_empresa = $1
        `,
        [tenantId]
      );
      return new Set(
        tenantRows.rows
          .map((row) => parsePositiveInt(row.id_empleado))
          .filter(Boolean)
      );
    }

    return null;
  },

  async updateField(idEmpleado, campo, valor) {
    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['empleados', campo, String(valor), 'id_empleado', String(idEmpleado)]
    );
  },

  async hardDelete(idEmpleado) {
    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['empleados', 'id_empleado', String(idEmpleado)]
    );
  },

  async addAuditLog({ accion, descripcion, idUsuario, capabilities }) {
    if (!capabilities.hasBitacorasTable || !idUsuario) return;
    await pool.query(
      'INSERT INTO bitacoras (accion, descripcion, id_usuario) VALUES ($1, $2, $3)',
      [accion, descripcion, idUsuario]
    );
  }
};

const empleadoService = {
  async list(req) {
    const capabilities = await getSchemaCapabilities();
    const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : parsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const effectiveSearch = search || searchQuery || searchName;
    const estado = parseBooleanFilter(req.query.estado);

    if (req.query.estado !== undefined && estado === null) {
      return { status: 400, body: { error: true, message: 'El filtro estado debe ser booleano' } };
    }

    if (req.query.estado !== undefined && !capabilities.softDeleteField) {
      return {
        status: 400,
        body: { error: true, message: 'La tabla empleados no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const normalizedSearch = normalizeSearchText(effectiveSearch);
    const allRows = await empleadoRepository.backfillDirecciones(
      await empleadoRepository.list(),
      capabilities
    );
    const tenantEmpleadoIds = await empleadoRepository.listTenantEmpleadoIds(tenantId, capabilities);

    let filteredRows = allRows
      .map(mapEmpleadoListRow)
      .filter((row) => {
        if (!tenantEmpleadoIds) return true;
        return tenantEmpleadoIds.has(parsePositiveInt(row.id_empleado));
      })
      .filter((row) => {
        if (estado === null) return true;
        const rowSoftDeleteValue =
          capabilities.softDeleteField && row[capabilities.softDeleteField] !== undefined
            ? row[capabilities.softDeleteField]
            : row.estado;
        return Boolean(rowSoftDeleteValue) === estado;
      })
      .filter((row) => empleadoMatchesSearch(row, normalizedSearch))
      .sort((a, b) => Number(a.id_empleado) - Number(b.id_empleado));

    const total = filteredRows.length;
    const offset = (page - 1) * limit;
    const data = filteredRows.slice(offset, offset + limit);

    return {
      status: 200,
      body: {
        data,
        total,
        page,
        limit
      }
    };
  },

  async getById(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const empleado = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!empleado) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    if (capabilities.softDeleteField && empleado[capabilities.softDeleteField] === false) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== empleado.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(empleado.persona_id_empresa)
    ) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    const detailedEmpleado = await empleadoRepository.findDetailById(idEmpleado);
    const responsePayload = mapEmpleadoListRow(detailedEmpleado ? { ...empleado, ...detailedEmpleado } : empleado);
    const [enrichedPayload] = await empleadoRepository.backfillDirecciones([responsePayload], capabilities);

    return { status: 200, body: enrichedPayload };
  },

  async create(req) {
    const capabilities = await getSchemaCapabilities();
    const payload = req.body;

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return { status: 400, body: { error: true, message: 'Debe enviar un objeto con datos validos' } };
    }

    const insertData = { ...payload };
    const idUsuario = resolveUserId(req);
    const tenantId = parsePositiveInt(req.user?.id_empresa);

    if (capabilities.hasTenantField && tenantId) {
      const requestedTenantId = parsePositiveInt(insertData.id_empresa);
      if (requestedTenantId && requestedTenantId !== tenantId) {
        return { status: 403, body: { error: true, message: 'No puede crear empleados para otra empresa' } };
      }
      if (!requestedTenantId) {
        insertData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const idEmpleado = await empleadoRepository.create(insertData);
    if (!idEmpleado) {
      throw new Error('No se pudo obtener el id del empleado creado');
    }

    if (capabilities.hasTenantField && insertData.id_empresa !== undefined) {
      await empleadoRepository.updateField(idEmpleado, 'id_empresa', insertData.id_empresa);
    }
    if (capabilities.hasCreatedBy && idUsuario) {
      await empleadoRepository.updateField(idEmpleado, 'created_by', idUsuario);
    }
    if (capabilities.hasUpdatedBy && idUsuario) {
      await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario);
    }
    await empleadoRepository.addAuditLog({
      accion: 'EMPLEADO_CREAR',
      descripcion: `Empleado creado: persona ${payload.id_persona ?? 'sin_persona'}`,
      idUsuario,
      capabilities
    });

    return { status: 201, body: { message: 'Empleado creado exitosamente.' } };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const legacyPayload = normalizeLegacyUpdatePayload(req.body);
    const rawPayload = legacyPayload || req.body;

    if (!isPlainObject(rawPayload) || Object.keys(rawPayload).length === 0) {
      return {
        status: 400,
        body: { error: true, message: 'Debe enviar un objeto JSON con campos para actualizar' }
      };
    }

    const allowedFields = new Set(FUNCTION_UPDATE_FIELDS);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    const payload = Object.fromEntries(
      Object.entries(rawPayload).filter(([campo, valor]) => campo && valor !== undefined)
    );

    if (!Object.keys(payload).length) {
      return {
        status: 400,
        body: { error: true, message: 'Debe enviar al menos un campo valido para actualizar' }
      };
    }

    const invalidFields = Object.keys(payload).filter((campo) => !allowedFields.has(campo));
    if (invalidFields.length) {
      return {
        status: 400,
        body: {
          error: true,
          message: `Campos no validos para actualizacion: ${invalidFields.join(', ')}`
        }
      };
    }

    const current = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(current.persona_id_empresa)
    ) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    if (
      hasOwn(payload, 'id_empresa') &&
      capabilities.hasTenantField &&
      tenantId &&
      parsePositiveInt(payload.id_empresa) !== tenantId
    ) {
      return { status: 403, body: { error: true, message: 'No puede mover empleados a otra empresa' } };
    }

    const functionPayload = {};
    const fallbackFieldUpdates = [];

    for (const [campo, valor] of Object.entries(payload)) {
      if (FUNCTION_UPDATE_FIELDS.has(campo)) {
        functionPayload[campo] = valor;
      } else {
        fallbackFieldUpdates.push([campo, valor]);
      }
    }

    if (Object.keys(functionPayload).length > 0) {
      await empleadoRepository.update(idEmpleado, functionPayload);
    }

    for (const [campo, valor] of fallbackFieldUpdates) {
      await empleadoRepository.updateField(idEmpleado, campo, valor);
    }

    const idUsuario = resolveUserId(req);
    if (capabilities.hasUpdatedBy && idUsuario && !hasOwn(payload, 'updated_by')) {
      await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario);
    }

    const changedFields = Object.keys(payload).join(', ');
    await empleadoRepository.addAuditLog({
      accion: 'EMPLEADO_ACTUALIZAR',
      descripcion: `Empleado ${idEmpleado} actualizado: campos ${changedFields}`,
      idUsuario,
      capabilities
    });

    return {
      status: 200,
      body: { error: false, message: 'Empleado actualizado correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpleado = parsePositiveInt(req.params.id);

    if (!idEmpleado) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const current = await empleadoRepository.findById(idEmpleado, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Empleado no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    if (
      tenantId &&
      !capabilities.hasTenantField &&
      capabilities.hasPersonasTable &&
      capabilities.hasPersonaTenantField &&
      tenantId !== parsePositiveInt(current.persona_id_empresa)
    ) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este empleado' } };
    }

    const idUsuario = resolveUserId(req);
    let message = 'Empleado eliminado correctamente';

    if (capabilities.softDeleteField) {
      await empleadoRepository.updateField(idEmpleado, capabilities.softDeleteField, false);
      if (capabilities.hasUpdatedBy && idUsuario) {
        await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario);
      }
      message = 'Empleado inactivado correctamente';
    } else {
      await empleadoRepository.hardDelete(idEmpleado);
    }

    await empleadoRepository.addAuditLog({
      accion: 'EMPLEADO_ELIMINAR',
      descripcion: `Empleado ${idEmpleado} eliminado. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
      idUsuario,
      capabilities
    });

    return { status: 200, body: { error: false, message } };
  }
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Empleados API error:', err.message);
    const mappedError = mapDbError(err);
    if (mappedError) {
      return res.status(mappedError.status).json({ error: true, message: mappedError.message });
    }
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
};

/* =======================
   GET - LISTAR EMPLEADOS
======================= */
router.get('/empleados-detalle', checkPermission(EMPLEADOS_LIST_PERMISSIONS), asyncHandler(empleadoService.list));
router.get('/empleados', checkPermission(EMPLEADOS_LIST_PERMISSIONS), asyncHandler(empleadoService.list));

/* =======================
   GET - EMPLEADO POR ID
======================= */
router.get('/empleados/:id', checkPermission(EMPLEADOS_DETAIL_PERMISSIONS), asyncHandler(empleadoService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/empleados', checkPermission(EMPLEADOS_CREATE_PERMISSIONS), asyncHandler(empleadoService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/empleados/:id', checkPermission(EMPLEADOS_EDIT_PERMISSIONS), asyncHandler(empleadoService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/empleados/:id', checkPermission(EMPLEADOS_DELETE_PERMISSIONS), asyncHandler(empleadoService.remove));

export default router;
