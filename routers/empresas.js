import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();  

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_empresa', 'rtn', 'nombre_empresa', 'id_telefono', 'id_direccion', 'id_correo'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FN_EMPRESA_FIELDS = new Set([
  'rtn',
  'nombre_empresa',
  'id_telefono',
  'id_direccion',
  'id_correo',
  'texto_direccion',
  'texto_telefono',
  'texto_correo'
]);
const LEGACY_TEXT_MAPPINGS = {
  direccion: 'texto_direccion',
  telefono: 'texto_telefono',
  correo: 'texto_correo',
  email: 'texto_correo',
  direccion_correo: 'texto_correo'
};

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
const toNullableTrimmedText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const normalizeEmpresaFunctionPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(payload)) {
    if (rawValue === undefined) continue;

    const mappedKey = LEGACY_TEXT_MAPPINGS[rawKey] || rawKey;
    if (!FN_EMPRESA_FIELDS.has(mappedKey)) continue;

    if (['id_telefono', 'id_direccion', 'id_correo'].includes(mappedKey)) {
      const parsed = parsePositiveInt(rawValue);
      if (parsed) normalized[mappedKey] = parsed;
      continue;
    }

    const textValue = toNullableTrimmedText(rawValue);
    if (textValue !== null) normalized[mappedKey] = textValue;
  }

  return normalized;
};

const getSchemaCapabilities = async () => {
  if (!schemaCapabilitiesPromise) {
    schemaCapabilitiesPromise = (async () => {
      const tableColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'empresas'
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
        hasBitacorasTable: Boolean(bitacorasResult.rows[0]?.bitacoras_table)
      };
    })().catch((err) => {
      schemaCapabilitiesPromise = null;
      throw err;
    });
  }

  return schemaCapabilitiesPromise;
};

const empresaRepository = {
  async list(capabilities) {
    const result = await pool.query('SELECT fn_listar_empresas() AS empresas');
    const rows = parseJsonArray(result.rows[0]?.empresas).map((row) => ({
      ...row,
      correo: row?.correo ?? row?.direccion_correo ?? null
    }));

    if (!capabilities.softDeleteField) return rows;

    const stateResult = await pool.query(`
      SELECT id_empresa, ${capabilities.softDeleteField} AS estado_actual
      FROM empresas
    `);
    const stateMap = new Map(
      stateResult.rows.map((item) => [Number(item.id_empresa), Boolean(item.estado_actual)])
    );

    return rows.map((row) => {
      const key = Number(row?.id_empresa);
      if (!stateMap.has(key)) return row;
      return {
        ...row,
        [capabilities.softDeleteField]: stateMap.get(key)
      };
    });
  },

  async findById(idEmpresa, capabilities) {
    const fields = BASE_FIELDS.map((field) => `e.${field}`);
    if (capabilities.softDeleteField && !fields.includes(capabilities.softDeleteField)) {
      fields.push(`e.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('e.created_by');
    if (capabilities.hasUpdatedBy) fields.push('e.updated_by');
    fields.push('t.telefono');
    fields.push('d.direccion');
    fields.push('c.direccion_correo AS correo');

    const query = `
      SELECT ${fields.join(', ')}
      FROM empresas e
      LEFT JOIN telefonos t ON t.id_telefono = e.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = e.id_direccion
      LEFT JOIN correos c ON c.id_correo = e.id_correo
      WHERE e.id_empresa = $1
      LIMIT 1
    `;

    const result = await pool.query(query, [idEmpresa]);
    return result.rows[0] || null;
  },

  async create(data) {
    const result = await pool.query(
      'SELECT fn_guardar_empresa($1::json) AS id_empresa',
      [JSON.stringify(data)]
    );
    return result.rows[0]?.id_empresa ?? null;
  },

  async updateWithFunction(idEmpresa, data) {
    await pool.query(
      'SELECT fn_actualizar_empresa($1::INT, $2::json) AS id_empresa',
      [idEmpresa, JSON.stringify(data)]
    );
  },

  async updateField(idEmpresa, campo, valor) {
    await pool.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['empresas', campo, String(valor), 'id_empresa', String(idEmpresa)]
    );
  },

  async hardDelete(idEmpresa) {
    await pool.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['empresas', 'id_empresa', String(idEmpresa)]
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

const empresaService = {
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
        body: { error: true, message: 'La tabla empresas no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);

    const allRows = await empresaRepository.list(capabilities);
    const normalizedRows = allRows.filter((row) => {
      if (!tenantId) return true;
      return Number(row?.id_empresa) === tenantId;
    });

    const searchedRows = searchName
      ? normalizedRows.filter((row) =>
          String(row?.nombre_empresa ?? '')
            .toLowerCase()
            .includes(searchName.toLowerCase())
        )
      : normalizedRows;

    const statusFilteredRows =
      estado !== null && capabilities.softDeleteField
        ? searchedRows.filter((row) => Boolean(row?.[capabilities.softDeleteField]) === estado)
        : searchedRows;

    const total = statusFilteredRows.length;
    const offset = (page - 1) * limit;
    const data = statusFilteredRows.slice(offset, offset + limit);

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
    const idEmpresa = parsePositiveInt(req.params.id);

    if (!idEmpresa) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const empresa = await empresaRepository.findById(idEmpresa, capabilities);
    if (!empresa) {
      return { status: 404, body: { error: true, message: 'Empresa no encontrada' } };
    }

    if (capabilities.softDeleteField && empresa[capabilities.softDeleteField] === false) {
      return { status: 404, body: { error: true, message: 'Empresa no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== empresa.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta empresa' } };
    }

    return { status: 200, body: empresa };
  },

  async create(req) {
    const capabilities = await getSchemaCapabilities();
    const payload = normalizeEmpresaFunctionPayload(req.body);

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return { status: 400, body: { error: true, message: 'Debe enviar un objeto con datos validos' } };
    }

    if (!payload.nombre_empresa || typeof payload.nombre_empresa !== 'string') {
      return { status: 400, body: { error: true, message: 'nombre_empresa es obligatorio' } };
    }

    const insertData = { ...payload };
    const idUsuario = resolveUserId(req);

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const createdId = await empresaRepository.create(insertData);
    await empresaRepository.addAuditLog({
      accion: 'EMPRESA_CREAR',
      descripcion: `Empresa creada: ${payload.nombre_empresa}`,
      idUsuario,
      capabilities
    });

    return {
      status: 201,
      body: {
        message: 'Empresa creada exitosamente.',
        id_empresa: createdId
      }
    };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpresa = parsePositiveInt(req.params.id);
    const body = req.body;
    const hasCampoValor = isPlainObject(body)
      && Object.prototype.hasOwnProperty.call(body, 'campo')
      && Object.prototype.hasOwnProperty.call(body, 'valor');

    if (!idEmpresa) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!isPlainObject(body)) {
      return { status: 400, body: { error: true, message: 'Debe enviar un objeto con datos validos' } };
    }

    const current = await empresaRepository.findById(idEmpresa, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Empresa no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta empresa' } };
    }

    const rawUpdates = hasCampoValor
      ? { [body.campo]: body.valor }
      : body;

    const normalizedUpdates = normalizeEmpresaFunctionPayload(rawUpdates);
    const idUsuario = resolveUserId(req);
    let touched = false;

    if (capabilities.softDeleteField && Object.prototype.hasOwnProperty.call(rawUpdates, capabilities.softDeleteField)) {
      await empresaRepository.updateField(
        idEmpresa,
        capabilities.softDeleteField,
        rawUpdates[capabilities.softDeleteField]
      );
      touched = true;
    }

    if (Object.keys(normalizedUpdates).length > 0) {
      await empresaRepository.updateWithFunction(idEmpresa, normalizedUpdates);
      touched = true;
    }

    if (!touched) {
      return { status: 400, body: { error: true, message: 'No hay campos validos para actualizar' } };
    }

    if (capabilities.hasUpdatedBy && idUsuario) {
      await empresaRepository.updateField(idEmpresa, 'updated_by', idUsuario);
    }

    const updatedFields = Object.keys(normalizedUpdates);
    if (capabilities.softDeleteField && Object.prototype.hasOwnProperty.call(rawUpdates, capabilities.softDeleteField)) {
      updatedFields.push(capabilities.softDeleteField);
    }

    await empresaRepository.addAuditLog({
      accion: 'EMPRESA_ACTUALIZAR',
      descripcion: `Empresa ${idEmpresa} actualizada: ${updatedFields.join(', ') || 'sin detalle'}`,
      idUsuario,
      capabilities
    });

    return {
      status: 200,
      body: { error: false, message: 'Empresa actualizada correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpresa = parsePositiveInt(req.params.id);

    if (!idEmpresa) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    const current = await empresaRepository.findById(idEmpresa, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Empresa no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta empresa' } };
    }

    const idUsuario = resolveUserId(req);
    let message = 'Empresa eliminada correctamente';

    if (capabilities.softDeleteField) {
      await empresaRepository.updateField(idEmpresa, capabilities.softDeleteField, false);
      if (capabilities.hasUpdatedBy && idUsuario) {
        await empresaRepository.updateField(idEmpresa, 'updated_by', idUsuario);
      }
      message = 'Empresa inactivada correctamente';
    } else {
      await empresaRepository.hardDelete(idEmpresa);
    }

    await empresaRepository.addAuditLog({
      accion: 'EMPRESA_ELIMINAR',
      descripcion: `Empresa ${idEmpresa} eliminada. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
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
    console.error('Empresas API error:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
};

/* =======================
   GET - LISTAR EMPRESAS
======================= */
router.get('/empresas', asyncHandler(empresaService.list));

/* =======================
   GET - LISTAR EMPRESAS POR ID
======================= */
router.get('/empresas/:id', asyncHandler(empresaService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/empresas', asyncHandler(empresaService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/empresas/:id', asyncHandler(empresaService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/empresas/:id', asyncHandler(empresaService.remove));


export default router;
