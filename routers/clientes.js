import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_cliente', 'fecha_ingreso', 'puntos', 'id_tipo_cliente', 'id_persona', 'id_empresa', 'estado'];
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
        WHERE table_schema = 'public' AND table_name = 'clientes'
      `;

      const tipoClienteColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'tipo_cliente'
      `;

      const relatedTablesQuery = `
        SELECT
          to_regclass('public.personas') AS personas_table,
          to_regclass('public.empresas') AS empresas_table,
          to_regclass('public.tipo_cliente') AS tipo_cliente_table,
          to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [columnsResult, relatedTablesResult] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(relatedTablesQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const relatedTables = relatedTablesResult.rows[0] || {};
      const hasTipoClienteTable = Boolean(relatedTables.tipo_cliente_table);
      let tipoClienteLabelField = null;

      if (hasTipoClienteTable) {
        const tipoClienteColumnsResult = await pool.query(tipoClienteColumnsQuery);
        const tipoClienteColumns = new Set(tipoClienteColumnsResult.rows.map((row) => row.column_name));
        tipoClienteLabelField =
          ['tipo_cliente', 'descripcion', 'nombre', 'nombre_tipo_cliente'].find((field) =>
            tipoClienteColumns.has(field)
          ) || null;
      }

      const softDeleteField = OPTIONAL_SOFT_DELETE_FIELDS.find((field) => columns.has(field)) || null;

      return {
        columns,
        softDeleteField,
        hasCreatedBy: columns.has('created_by'),
        hasUpdatedBy: columns.has('updated_by'),
        hasTenantField: columns.has('id_empresa'),
        hasPersonasTable: Boolean(relatedTables.personas_table),
        hasEmpresasTable: Boolean(relatedTables.empresas_table),
        hasTipoClienteTable,
        tipoClienteLabelField,
        hasBitacorasTable: Boolean(relatedTables.bitacoras_table)
      };
    })().catch((err) => {
      schemaCapabilitiesPromise = null;
      throw err;
    });
  }

  return schemaCapabilitiesPromise;
};

const clienteRepository = {
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
      const searchFragments = ['c.id_cliente::TEXT ILIKE $IDX', 'c.puntos::TEXT ILIKE $IDX'];

      if (capabilities.hasPersonasTable) {
        searchFragments.push('p.nombre ILIKE $IDX');
        searchFragments.push('p.apellido ILIKE $IDX');
        searchFragments.push('p.dni::TEXT ILIKE $IDX');
      }

      if (capabilities.hasEmpresasTable) {
        searchFragments.push('e.nombre_empresa ILIKE $IDX');
      }

      if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
        searchFragments.push(`tc.${capabilities.tipoClienteLabelField} ILIKE $IDX`);
      }

      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`c.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (tenantId && capabilities.hasTenantField) {
      pushFilter('c.id_empresa = $IDX', tenantId);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countWhere = countFilters.length ? `WHERE ${countFilters.join(' AND ')}` : '';

    const fields = BASE_FIELDS.map((field) => `c.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`c.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('c.created_by');
    if (capabilities.hasUpdatedBy) fields.push('c.updated_by');

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
    }

    if (capabilities.hasEmpresasTable) {
      fields.push('e.nombre_empresa');
    }

    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      fields.push(`tc.${capabilities.tipoClienteLabelField} AS tipo_cliente_nombre`);
    }

    const joins = [];
    if (capabilities.hasPersonasTable) joins.push('LEFT JOIN personas p ON p.id_persona = c.id_persona');
    if (capabilities.hasEmpresasTable) joins.push('LEFT JOIN empresas e ON e.id_empresa = c.id_empresa');
    if (capabilities.hasTipoClienteTable) joins.push('LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente');

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM clientes c${joinsSql}
      ${where}
      ORDER BY c.id_cliente
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      FROM clientes c${joinsSql}
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

  async findById(idCliente, capabilities) {
    const fields = BASE_FIELDS.map((field) => `c.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`c.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('c.created_by');
    if (capabilities.hasUpdatedBy) fields.push('c.updated_by');

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
    }

    if (capabilities.hasEmpresasTable) {
      fields.push('e.nombre_empresa');
    }

    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      fields.push(`tc.${capabilities.tipoClienteLabelField} AS tipo_cliente_nombre`);
    }

    const joins = [];
    if (capabilities.hasPersonasTable) joins.push('LEFT JOIN personas p ON p.id_persona = c.id_persona');
    if (capabilities.hasEmpresasTable) joins.push('LEFT JOIN empresas e ON e.id_empresa = c.id_empresa');
    if (capabilities.hasTipoClienteTable) joins.push('LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente');

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const query = `
      SELECT ${fields.join(', ')}
      FROM clientes c${joinsSql}
      WHERE c.id_cliente = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [idCliente]);
    return result.rows[0] || null;
  },

  async create(data) {
    await pool.query('CALL pa_insert($1, $2)', ['clientes', data]);
  },

  async updateField(idCliente, campo, valor) {
    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['clientes', campo, String(valor), 'id_cliente', String(idCliente)]
    );
  },

  async hardDelete(idCliente) {
    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['clientes', 'id_cliente', String(idCliente)]
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

const clienteService = {
  async list(req) {
    const capabilities = await getSchemaCapabilities();
    const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : parsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return { status: 400, body: { error: true, message: 'page y limit deben ser enteros positivos' } };
    }

    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const estado = parseBooleanFilter(req.query.estado);

    if (req.query.estado !== undefined && estado === null) {
      return { status: 400, body: { error: true, message: 'El filtro estado debe ser booleano' } };
    }

    if (req.query.estado !== undefined && !capabilities.softDeleteField) {
      return {
        status: 400,
        body: { error: true, message: 'La tabla clientes no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);

    const { data, total } = await clienteRepository.list({
      page,
      limit,
      searchName,
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
    const idCliente = parsePositiveInt(req.params.id);

    if (!idCliente) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const cliente = await clienteRepository.findById(idCliente, capabilities);
    if (!cliente) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    if (capabilities.softDeleteField && cliente[capabilities.softDeleteField] === false) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== cliente.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este cliente' } };
    }

    return { status: 200, body: cliente };
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
        return { status: 403, body: { error: true, message: 'No puede crear clientes para otra empresa' } };
      }
      if (!requestedTenantId) {
        insertData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    await clienteRepository.create(insertData);
    await clienteRepository.addAuditLog({
      accion: 'CLIENTE_CREAR',
      descripcion: `Cliente creado: persona ${payload.id_persona ?? 'sin_persona'}`,
      idUsuario,
      capabilities
    });

    return { status: 201, body: { message: 'Cliente creado exitosamente.' } };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idCliente = parsePositiveInt(req.params.id);
    const { campo, valor } = req.body;

    if (!idCliente) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!campo || valor === undefined) {
      return { status: 400, body: { error: true, message: 'Debe enviar campo y valor' } };
    }

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_cliente')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    if (!allowedFields.has(campo)) {
      return { status: 400, body: { error: true, message: 'El campo no es valido para actualizacion' } };
    }

    const current = await clienteRepository.findById(idCliente, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este cliente' } };
    }

    if (campo === 'id_empresa' && capabilities.hasTenantField && tenantId && parsePositiveInt(valor) !== tenantId) {
      return { status: 403, body: { error: true, message: 'No puede mover clientes a otra empresa' } };
    }

    await clienteRepository.updateField(idCliente, campo, valor);

    const idUsuario = resolveUserId(req);
    if (capabilities.hasUpdatedBy && idUsuario && campo !== 'updated_by') {
      await clienteRepository.updateField(idCliente, 'updated_by', idUsuario);
    }

    await clienteRepository.addAuditLog({
      accion: 'CLIENTE_ACTUALIZAR',
      descripcion: `Cliente ${idCliente} actualizado: campo ${campo}`,
      idUsuario,
      capabilities
    });

    return {
      status: 200,
      body: { error: false, message: 'Cliente actualizado correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idCliente = parsePositiveInt(req.params.id);

    if (!idCliente) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const current = await clienteRepository.findById(idCliente, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este cliente' } };
    }

    const idUsuario = resolveUserId(req);
    let message = 'Cliente eliminado correctamente';

    if (capabilities.softDeleteField) {
      await clienteRepository.updateField(idCliente, capabilities.softDeleteField, false);
      if (capabilities.hasUpdatedBy && idUsuario) {
        await clienteRepository.updateField(idCliente, 'updated_by', idUsuario);
      }
      message = 'Cliente inactivado correctamente';
    } else {
      await clienteRepository.hardDelete(idCliente);
    }

    await clienteRepository.addAuditLog({
      accion: 'CLIENTE_ELIMINAR',
      descripcion: `Cliente ${idCliente} eliminado. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
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
    console.error('Clientes API error:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
};

/* =======================
   GET - LISTAR CLIENTES
======================= */
router.get('/clientes-detalle', asyncHandler(clienteService.list));
router.get('/clientes', asyncHandler(clienteService.list));

/* =======================
   GET - CLIENTE POR ID
======================= */
router.get('/clientes/:id', asyncHandler(clienteService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/clientes', asyncHandler(clienteService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/clientes/:id', asyncHandler(clienteService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/clientes/:id', asyncHandler(clienteService.remove));

export default router;
