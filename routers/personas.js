import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const MAX_LIMIT = 100;
const BASE_FIELDS = [
  'id_persona',
  'nombre',
  'apellido',
  'fecha_nacimiento',
  'genero',
  'dni',
  'rtn',
  'id_telefono',
  'id_direccion',
  'id_correo'
];
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
        WHERE table_schema = 'public' AND table_name = 'personas'
      `;

      const bitacorasQuery = `
        SELECT to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [columnsResult, bitacorasResult] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(bitacorasQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const softDeleteField = OPTIONAL_SOFT_DELETE_FIELDS.find((field) => columns.has(field)) || null;

      return {
        columns,
        softDeleteField,
        hasCreatedBy: columns.has('created_by'),
        hasUpdatedBy: columns.has('updated_by'),
        hasTenantField: columns.has('id_empresa'),
        hasBitacorasTable: Boolean(bitacorasResult.rows[0]?.bitacoras_table)
      };
    })().catch((err) => {
      schemaCapabilitiesPromise = null;
      throw err;
    });
  }

  return schemaCapabilitiesPromise;
};

const personaRepository = {
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
      pushFilter(
        '(p.nombre ILIKE $IDX OR p.apellido ILIKE $IDX OR p.dni::TEXT ILIKE $IDX OR p.rtn::TEXT ILIKE $IDX)',
        value
      );
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`p.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (tenantId && capabilities.hasTenantField) {
      pushFilter('p.id_empresa = $IDX', tenantId);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countWhere = countFilters.length ? `WHERE ${countFilters.join(' AND ')}` : '';

    const fields = BASE_FIELDS.map((field) => `p.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`p.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('p.created_by');
    if (capabilities.hasUpdatedBy) fields.push('p.updated_by');
    if (capabilities.hasTenantField) fields.push('p.id_empresa');
    fields.push('t.telefono');
    fields.push('d.direccion');
    fields.push('c.direccion_correo AS correo');

    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM personas p
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      ${where}
      ORDER BY p.id_persona
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      FROM personas p
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

  async findById(idPersona, capabilities) {
    const fields = BASE_FIELDS.map((field) => `p.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`p.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('p.created_by');
    if (capabilities.hasUpdatedBy) fields.push('p.updated_by');
    if (capabilities.hasTenantField) fields.push('p.id_empresa');
    fields.push('t.telefono');
    fields.push('d.direccion');
    fields.push('c.direccion_correo AS correo');

    const query = `
      SELECT ${fields.join(', ')}
      FROM personas p
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      WHERE p.id_persona = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [idPersona]);
    return result.rows[0] || null;
  },

  async create(data) {
    await pool.query('CALL pa_insert($1, $2)', ['personas', data]);
  },

  async updateField(idPersona, campo, valor) {
    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['personas', campo, String(valor), 'id_persona', String(idPersona)]
    );
  },

  async hardDelete(idPersona) {
    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['personas', 'id_persona', String(idPersona)]
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

const personaService = {
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
        body: { error: true, message: 'La tabla personas no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);

    const { data, total } = await personaRepository.list({
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
    const idPersona = parsePositiveInt(req.params.id);

    if (!idPersona) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const persona = await personaRepository.findById(idPersona, capabilities);
    if (!persona) {
      return { status: 404, body: { error: true, message: 'Persona no encontrada' } };
    }

    if (capabilities.softDeleteField && persona[capabilities.softDeleteField] === false) {
      return { status: 404, body: { error: true, message: 'Persona no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== persona.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta persona' } };
    }

    return { status: 200, body: persona };
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
        return { status: 403, body: { error: true, message: 'No puede crear personas para otra empresa' } };
      }
      if (!requestedTenantId) {
        insertData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    await personaRepository.create(insertData);
    await personaRepository.addAuditLog({
      accion: 'PERSONA_CREAR',
      descripcion: `Persona creada: ${payload.nombre ?? 'sin_nombre'}`,
      idUsuario,
      capabilities
    });

    return { status: 201, body: { message: 'Persona creada exitosamente.' } };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idPersona = parsePositiveInt(req.params.id);
    const { campo, valor } = req.body;

    if (!idPersona) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!campo || valor === undefined) {
      return { status: 400, body: { error: true, message: 'Debe enviar campo y valor' } };
    }

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_persona')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');

    if (!allowedFields.has(campo)) {
      return { status: 400, body: { error: true, message: 'El campo no es valido para actualizacion' } };
    }

    const current = await personaRepository.findById(idPersona, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Persona no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta persona' } };
    }

    await personaRepository.updateField(idPersona, campo, valor);

    const idUsuario = resolveUserId(req);
    if (capabilities.hasUpdatedBy && idUsuario && campo !== 'updated_by') {
      await personaRepository.updateField(idPersona, 'updated_by', idUsuario);
    }

    await personaRepository.addAuditLog({
      accion: 'PERSONA_ACTUALIZAR',
      descripcion: `Persona ${idPersona} actualizada: campo ${campo}`,
      idUsuario,
      capabilities
    });

    return {
      status: 200,
      body: { error: false, message: 'Persona actualizada correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idPersona = parsePositiveInt(req.params.id);

    if (!idPersona) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const current = await personaRepository.findById(idPersona, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Persona no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta persona' } };
    }

    const idUsuario = resolveUserId(req);
    let message = 'Persona eliminada correctamente';

    if (capabilities.softDeleteField) {
      await personaRepository.updateField(idPersona, capabilities.softDeleteField, false);
      if (capabilities.hasUpdatedBy && idUsuario) {
        await personaRepository.updateField(idPersona, 'updated_by', idUsuario);
      }
      message = 'Persona inactivada correctamente';
    } else {
      await personaRepository.hardDelete(idPersona);
    }

    await personaRepository.addAuditLog({
      accion: 'PERSONA_ELIMINAR',
      descripcion: `Persona ${idPersona} eliminada. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
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
    console.error('Personas API error:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
};

/* =======================
   GET - LISTAR PERSONAS
======================= */
router.get('/personas-detalle', asyncHandler(personaService.list));

/* =======================
   GET - PERSONA POR ID
======================= */
router.get('/personas/:id', asyncHandler(personaService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/personas', asyncHandler(personaService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/personas/:id', asyncHandler(personaService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/personas/:id', asyncHandler(personaService.remove));

export default router;
