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
  async list({
    page,
    limit,
    searchName,
    estado,
    tenantId,
    capabilities
  }) {
    const filters = [];
    const countFilters = [];
    const params = [];
    const countParams = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      countParams.push(value);
      filters.push(fragment.replaceAll('$IDX', `$${params.length}`));
      countFilters.push(fragment.replaceAll('$IDX', `$${countParams.length}`));
    };

    if (searchName) {
      const value = `%${searchName}%`;
      const searchFragments = ['e.id_empleado::TEXT ILIKE $IDX', 'e.salario_base::TEXT ILIKE $IDX'];

      if (capabilities.hasPersonasTable) {
        searchFragments.push('p.nombre ILIKE $IDX');
        searchFragments.push('p.apellido ILIKE $IDX');
        searchFragments.push('p.dni::TEXT ILIKE $IDX');
      }

      if (capabilities.hasSucursalesTable && capabilities.sucursalNameField) {
        searchFragments.push(`s.${capabilities.sucursalNameField} ILIKE $IDX`);
      }

      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`e.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (tenantId && capabilities.hasTenantField) {
      pushFilter('e.id_empresa = $IDX', tenantId);
    } else if (tenantId && capabilities.hasPersonasTable && capabilities.hasPersonaTenantField) {
      pushFilter('p.id_empresa = $IDX', tenantId);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countWhere = countFilters.length ? `WHERE ${countFilters.join(' AND ')}` : '';

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
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM empleados e${joinsSql}
      ${where}
      ORDER BY e.id_empleado
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      FROM empleados e${joinsSql}
      ${countWhere}
    `;

    const [dataResult, totalResult] = await Promise.all([
      pool.query(dataQuery, dataParams),
      pool.query(totalQuery, countParams)
    ]);

    return {
      data: dataResult.rows,
      total: totalResult.rows[0]?.total || 0
    };
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
    await pool.query('CALL pa_insert($1, $2)', ['empleados', data]);
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

    const { data, total } = await empleadoRepository.list({
      page,
      limit,
      searchName: effectiveSearch,
      estado,
      tenantId,
      capabilities
    });

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

    return { status: 200, body: empleado };
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

    await empleadoRepository.create(insertData);
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
    const { campo, valor } = req.body;

    if (!idEmpleado) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!campo || valor === undefined) {
      return { status: 400, body: { error: true, message: 'Debe enviar campo y valor' } };
    }

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_empleado')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    if (!allowedFields.has(campo)) {
      return { status: 400, body: { error: true, message: 'El campo no es valido para actualizacion' } };
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

    if (campo === 'id_empresa' && capabilities.hasTenantField && tenantId && parsePositiveInt(valor) !== tenantId) {
      return { status: 403, body: { error: true, message: 'No puede mover empleados a otra empresa' } };
    }

    await empleadoRepository.updateField(idEmpleado, campo, valor);

    const idUsuario = resolveUserId(req);
    if (capabilities.hasUpdatedBy && idUsuario && campo !== 'updated_by') {
      await empleadoRepository.updateField(idEmpleado, 'updated_by', idUsuario);
    }

    await empleadoRepository.addAuditLog({
      accion: 'EMPLEADO_ACTUALIZAR',
      descripcion: `Empleado ${idEmpleado} actualizado: campo ${campo}`,
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
