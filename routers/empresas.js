import express from 'express';
import pool from '../config/db-connection.js';
import { getClientIp } from '../utils/security/clientInfo.js';

const router = express.Router();  

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_empresa', 'rtn', 'nombre_empresa', 'id_telefono', 'id_direccion', 'id_correo'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];

let schemaCapabilitiesPromise;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeComparableValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const valuesDiffer = (beforeValue, afterValue) =>
  normalizeComparableValue(beforeValue) !== normalizeComparableValue(afterValue);

const truncateText = (value, maxLength) => {
  const text = String(value ?? '');
  if (!Number.isInteger(maxLength) || maxLength <= 0) return text;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
};

const toJsonParam = (value) => {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
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
      pushFilter('e.nombre_empresa ILIKE $IDX', value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`e.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (tenantId) {
      pushFilter('e.id_empresa = $IDX', tenantId);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countWhere = countFilters.length ? `WHERE ${countFilters.join(' AND ')}` : '';

    const fields = BASE_FIELDS.map((field) => `e.${field}`);
    if (capabilities.softDeleteField && !fields.includes(capabilities.softDeleteField)) {
      fields.push(`e.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('e.created_by');
    if (capabilities.hasUpdatedBy) fields.push('e.updated_by');
    fields.push('t.telefono');
    fields.push('d.direccion');
    fields.push('c.direccion_correo AS correo');

    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM empresas e
      LEFT JOIN telefonos t ON t.id_telefono = e.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = e.id_direccion
      LEFT JOIN correos c ON c.id_correo = e.id_correo
      ${where}
      ORDER BY e.id_empresa
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      FROM empresas e
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
    await pool.query('CALL pa_insert($1, $2)', ['empresas', data]);
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

  async addAuditLog({
    accion,
    descripcion,
    idUsuario,
    capabilities,
    req,
    modulo = 'EMPRESAS',
    tablaAfectada = 'empresas',
    idRegistro = null,
    datosAntes = null,
    datosDespues = null
  }) {
    if (!capabilities.hasBitacorasTable || !idUsuario) return;
    const descripcionSafe = truncateText(descripcion, 100);
    const moduloSafe = truncateText(modulo, 60) || null;
    const tablaAfectadaSafe = truncateText(tablaAfectada, 60) || null;
    const idRegistroSafe = parsePositiveInt(idRegistro);
    const ipOrigen = req ? getClientIp(req) : null;

    await pool.query(
      `
        INSERT INTO bitacoras (
          accion,
          descripcion,
          fecha_hora,
          id_usuario,
          modulo,
          tabla_afectada,
          id_registro,
          ip_origen,
          datos_antes,
          datos_despues
        ) VALUES (
          $1,
          $2,
          timezone('America/Tegucigalpa', now()),
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb,
          $9::jsonb
        )
      `,
      [
        accion,
        descripcionSafe,
        idUsuario,
        moduloSafe,
        tablaAfectadaSafe,
        idRegistroSafe,
        ipOrigen,
        toJsonParam(datosAntes),
        toJsonParam(datosDespues)
      ]
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

    const { data, total } = await empresaRepository.list({
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
    const payload = req.body;

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

    await empresaRepository.create(insertData);
    await empresaRepository.addAuditLog({
      accion: 'EMPRESA_CREAR',
      descripcion: `Empresa creada: ${payload.nombre_empresa}`,
      idUsuario,
      capabilities,
      req,
      modulo: 'EMPRESAS',
      tablaAfectada: 'empresas',
      datosDespues: insertData
    });

    return { status: 201, body: { message: 'Empresa creada exitosamente.' } };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpresa = parsePositiveInt(req.params.id);
    const { campo, valor } = req.body;

    if (!idEmpresa) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!campo || valor === undefined) {
      return { status: 400, body: { error: true, message: 'Debe enviar campo y valor' } };
    }

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_empresa')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');

    if (!allowedFields.has(campo)) {
      return { status: 400, body: { error: true, message: 'El campo no es valido para actualizacion' } };
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
    const beforeValue = current?.[campo] ?? null;
    if (!valuesDiffer(beforeValue, valor)) {
      return {
        status: 200,
        body: { error: false, message: 'No se detectaron cambios para actualizar' }
      };
    }

    await empresaRepository.updateField(idEmpresa, campo, valor);

    if (capabilities.hasUpdatedBy && idUsuario && campo !== 'updated_by') {
      await empresaRepository.updateField(idEmpresa, 'updated_by', idUsuario);
    }

    await empresaRepository.addAuditLog({
      accion: 'EMPRESA_ACTUALIZAR',
      descripcion: `Empresa ${idEmpresa} actualizada: campo ${campo}`,
      idUsuario,
      capabilities,
      req,
      modulo: 'EMPRESAS',
      tablaAfectada: 'empresas',
      idRegistro: idEmpresa,
      datosAntes: { [campo]: beforeValue },
      datosDespues: { [campo]: valor }
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
      capabilities,
      req,
      modulo: 'EMPRESAS',
      tablaAfectada: 'empresas',
      idRegistro: idEmpresa,
      datosAntes: current
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
