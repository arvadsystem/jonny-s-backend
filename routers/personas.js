import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const MAX_LIMIT = 100;
const MAX_SUGGESTIONS_LIMIT = 12;
const MAX_AUDIT_DESCRIPCION_LENGTH = 100;
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
const LISTAR_BASE_FIELDS = [
  'id_persona',
  'nombre',
  'apellido',
  'fecha_nacimiento',
  'genero',
  'dni',
  'rtn',
  'telefono',
  'direccion',
  'direccion_correo'
];

let schemaCapabilitiesPromise;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const trimOrKeep = (value) => (typeof value === 'string' ? value.trim() : value);

const truncateText = (value, maxLength) => {
  const text = String(value ?? '');
  if (!Number.isInteger(maxLength) || maxLength <= 0) return text;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
};

const normalizePersonaPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = Object.entries(payload).reduce((acc, [key, value]) => {
    acc[key] = trimOrKeep(value);
    return acc;
  }, {});

  if (!Object.prototype.hasOwnProperty.call(normalized, 'texto_direccion')
    && Object.prototype.hasOwnProperty.call(normalized, 'direccion')) {
    normalized.texto_direccion = normalized.direccion;
  }

  if (!Object.prototype.hasOwnProperty.call(normalized, 'texto_telefono')
    && Object.prototype.hasOwnProperty.call(normalized, 'telefono')) {
    normalized.texto_telefono = normalized.telefono;
  }

  if (!Object.prototype.hasOwnProperty.call(normalized, 'texto_correo')) {
    if (Object.prototype.hasOwnProperty.call(normalized, 'correo')) {
      normalized.texto_correo = normalized.correo;
    } else if (Object.prototype.hasOwnProperty.call(normalized, 'email')) {
      normalized.texto_correo = normalized.email;
    }
  }

  delete normalized.id_persona;
  return normalized;
};

const normalizeUpdateFieldName = (field) => {
  const aliases = {
    direccion: 'texto_direccion',
    telefono: 'texto_telefono',
    correo: 'texto_correo',
    email: 'texto_correo'
  };
  return aliases[field] || field;
};

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const safeParseJson = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;

  const text = value.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
};

const extractFunctionResult = (row, key) => {
  if (!isPlainObject(row)) return null;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];

  const [firstKey] = Object.keys(row);
  return firstKey ? row[firstKey] : null;
};

const normalizeArrayResult = (value) => {
  const normalized = safeParseJson(value);
  if (!normalized) return [];
  if (Array.isArray(normalized)) return normalized;
  if (isPlainObject(normalized)) {
    if (Array.isArray(normalized.data)) return normalized.data;
    if (Array.isArray(normalized.rows)) return normalized.rows;
    if (Array.isArray(normalized.items)) return normalized.items;
  }
  return [];
};

const rowsHaveField = (rows, field) =>
  Array.isArray(rows) && rows.some((row) => Object.prototype.hasOwnProperty.call(row || {}, field));

const toIntSet = (rows, key) =>
  new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => parsePositiveInt(row?.[key]))
      .filter((value) => value !== null)
  );

const isRetryableListError = (error) =>
  Boolean(error?.code && ['42702', '42703'].includes(error.code));

const buildListaValores = (capabilities, { includeOptional = true } = {}) => {
  const fields = [...LISTAR_BASE_FIELDS];
  if (includeOptional) {
    if (capabilities.softDeleteField) fields.push(capabilities.softDeleteField);
    if (capabilities.hasTenantField) fields.push('id_empresa');
  }
  return fields.join(', ');
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

const parseSuggestMode = (value) => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 't', 'si', 'yes'].includes(normalized);
};

const normalizeGeneroFilter = (value) => {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'todos') return '';
  if (['f', 'femenino', 'female', 'mujer'].includes(normalized)) return 'femenino';
  if (['m', 'masculino', 'male', 'hombre'].includes(normalized)) return 'masculino';
  return normalized;
};

const buildPersonaSuggestions = (rows = []) => {
  const seen = new Set();
  const suggestions = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const nombre = `${row?.nombre || ''} ${row?.apellido || ''}`.trim();
    const dni = String(row?.dni ?? '').trim();
    const correo = String(row?.direccion_correo ?? row?.correo ?? '').trim();
    const telefono = String(row?.telefono ?? '').trim();
    const fallback = dni || correo || telefono;
    const value = nombre || fallback;
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    suggestions.push({
      id_persona: row?.id_persona ?? null,
      value,
      nombre,
      dni,
      correo,
      telefono
    });

    if (suggestions.length >= MAX_SUGGESTIONS_LIMIT) break;
  }

  return suggestions;
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
    capabilities
  }) {
    const runList = async (listaValores) => {
      const result = await pool.query('SELECT fn_listar_personas($1) AS resultado', [listaValores]);
      const raw = extractFunctionResult(result.rows[0], 'resultado');
      return normalizeArrayResult(raw);
    };

    const listaPrincipal = buildListaValores(capabilities, { includeOptional: true });

    try {
      return await runList(listaPrincipal);
    } catch (error) {
      if (!isRetryableListError(error)) throw error;

      const listaFallback = buildListaValores(capabilities, { includeOptional: false });
      return await runList(listaFallback);
    }
  },

  async searchWithPagination({
    capabilities,
    search,
    page,
    limit,
    tenantId = null,
    estado = null,
    sort = 'recientes',
    genero = '',
    suggestMode = false
  }) {
    const fields = BASE_FIELDS.map((field) => `p.${field}`);
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`p.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasTenantField && !BASE_FIELDS.includes('id_empresa')) {
      fields.push('p.id_empresa');
    }
    fields.push('telf.telefono');
    fields.push('dir.direccion');
    fields.push('cor.direccion_correo');
    fields.push('cor.direccion_correo AS correo');

    const fromClause = `
      FROM personas p
      LEFT JOIN telefonos telf ON telf.id_telefono = p.id_telefono
      LEFT JOIN direcciones dir ON dir.id_direccion = p.id_direccion
      LEFT JOIN correos cor ON cor.id_correo = p.id_correo
    `;

    const whereParams = [];
    const whereParts = [];

    const searchTerm = typeof search === 'string' ? search.trim() : '';
    if (searchTerm) {
      whereParams.push(`%${searchTerm}%`);
      const searchParamIndex = whereParams.length;
      whereParts.push(`(
        p.nombre ILIKE $${searchParamIndex}
        OR p.apellido ILIKE $${searchParamIndex}
        OR p.dni::TEXT ILIKE $${searchParamIndex}
        OR COALESCE(telf.telefono, '') ILIKE $${searchParamIndex}
        OR COALESCE(cor.direccion_correo, '') ILIKE $${searchParamIndex}
        OR COALESCE(dir.direccion, '') ILIKE $${searchParamIndex}
      )`);
    }

    const normalizedGenero = normalizeGeneroFilter(genero);
    if (normalizedGenero === 'femenino') {
      whereParts.push(`LOWER(COALESCE(p.genero, '')) IN ('f', 'femenino', 'female', 'mujer')`);
    } else if (normalizedGenero === 'masculino') {
      whereParts.push(`LOWER(COALESCE(p.genero, '')) IN ('m', 'masculino', 'male', 'hombre')`);
    } else if (normalizedGenero) {
      whereParams.push(`%${normalizedGenero}%`);
      whereParts.push(`LOWER(COALESCE(p.genero, '')) LIKE LOWER($${whereParams.length})`);
    }

    if (
      estado !== null
      && capabilities.softDeleteField
      && OPTIONAL_SOFT_DELETE_FIELDS.includes(capabilities.softDeleteField)
    ) {
      whereParams.push(estado);
      whereParts.push(`p.${capabilities.softDeleteField} = $${whereParams.length}`);
    }

    if (tenantId && capabilities.hasTenantField) {
      whereParams.push(tenantId);
      whereParts.push(`p.id_empresa = $${whereParams.length}`);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const dataParams = [...whereParams];
    const normalizedSort = typeof sort === 'string' ? sort.trim().toLowerCase() : 'recientes';
    let orderByClause = 'p.id_persona DESC';

    if (normalizedSort === 'nombre_asc') {
      orderByClause = "p.nombre ASC, p.apellido ASC, p.id_persona DESC";
    } else if (normalizedSort === 'nombre_desc') {
      orderByClause = "p.nombre DESC, p.apellido DESC, p.id_persona DESC";
    } else if (searchTerm && (suggestMode || normalizedSort === 'relevancia')) {
      dataParams.push(`${searchTerm}%`);
      const prefixParamIndex = dataParams.length;
      orderByClause = `CASE
        WHEN p.nombre ILIKE $${prefixParamIndex} THEN 0
        WHEN p.apellido ILIKE $${prefixParamIndex} THEN 1
        WHEN p.dni::TEXT ILIKE $${prefixParamIndex} THEN 2
        WHEN COALESCE(telf.telefono, '') ILIKE $${prefixParamIndex} THEN 3
        WHEN COALESCE(cor.direccion_correo, '') ILIKE $${prefixParamIndex} THEN 4
        WHEN COALESCE(dir.direccion, '') ILIKE $${prefixParamIndex} THEN 5
        ELSE 6
      END, p.id_persona DESC`;
    }

    const limitParamIndex = dataParams.length + 1;
    const offsetParamIndex = dataParams.length + 2;
    const dataParamsWithPage = [...dataParams, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      ${fromClause}
      ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex}
    `;

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      ${fromClause}
      ${whereClause}
    `;

    const [dataResult, totalResult] = await Promise.all([
      pool.query(dataQuery, dataParamsWithPage),
      pool.query(totalQuery, whereParams)
    ]);

    return {
      data: dataResult.rows,
      total: totalResult.rows[0]?.total || 0
    };
  },

  async getGlobalStats({ capabilities, tenantId = null, estado = null }) {
    const whereParts = [];
    const params = [];

    if (
      estado !== null
      && capabilities.softDeleteField
      && OPTIONAL_SOFT_DELETE_FIELDS.includes(capabilities.softDeleteField)
    ) {
      params.push(estado);
      whereParts.push(`${capabilities.softDeleteField} = $${params.length}`);
    }

    if (tenantId && capabilities.hasTenantField) {
      params.push(tenantId);
      whereParts.push(`id_empresa = $${params.length}`);
    }

    const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
    const activeExpr = capabilities.softDeleteField
      ? `SUM(CASE WHEN ${capabilities.softDeleteField} = true THEN 1 ELSE 0 END)::INT AS activas`
      : 'COUNT(*)::INT AS activas';
    const inactiveExpr = capabilities.softDeleteField
      ? `SUM(CASE WHEN ${capabilities.softDeleteField} = false THEN 1 ELSE 0 END)::INT AS inactivas`
      : '0::INT AS inactivas';

    const query = `
      SELECT
        COUNT(*)::INT AS total,
        ${activeExpr},
        ${inactiveExpr},
        SUM(CASE WHEN LOWER(COALESCE(genero, '')) IN ('f', 'femenino', 'female', 'mujer') THEN 1 ELSE 0 END)::INT AS femenino,
        SUM(CASE WHEN LOWER(COALESCE(genero, '')) IN ('m', 'masculino', 'male', 'hombre') THEN 1 ELSE 0 END)::INT AS masculino
      FROM personas
      ${whereClause}
    `;

    const result = await pool.query(query, params);
    return result.rows[0] || {
      total: 0,
      activas: 0,
      inactivas: 0,
      femenino: 0,
      masculino: 0
    };
  },

  async listPersonaIdsByTenant(tenantId) {
    const result = await pool.query(
      'SELECT id_persona FROM personas WHERE id_empresa = $1',
      [tenantId]
    );
    return toIntSet(result.rows, 'id_persona');
  },

  async listPersonaIdsByEstado({ softDeleteField, estado, tenantId = null, capabilities }) {
    if (!softDeleteField || !OPTIONAL_SOFT_DELETE_FIELDS.includes(softDeleteField)) {
      return new Set();
    }

    const params = [estado];
    let query = `SELECT id_persona FROM personas WHERE ${softDeleteField} = $1`;

    if (tenantId && capabilities?.hasTenantField) {
      params.push(tenantId);
      query += ` AND id_empresa = $${params.length}`;
    }

    const result = await pool.query(query, params);
    return toIntSet(result.rows, 'id_persona');
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
    const payloadJson = JSON.stringify(data ?? {});
    const result = await pool.query('SELECT fn_guardar_persona($1::json) AS resultado', [payloadJson]);
    return safeParseJson(extractFunctionResult(result.rows[0], 'resultado'));
  },

  async update(idPersona, data) {
    const payloadJson = JSON.stringify(data ?? {});
    const result = await pool.query(
      'SELECT fn_actualizar_persona($1, $2::json) AS resultado',
      [idPersona, payloadJson]
    );
    return safeParseJson(extractFunctionResult(result.rows[0], 'resultado'));
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
    const descripcionSafe = truncateText(descripcion, MAX_AUDIT_DESCRIPCION_LENGTH);
    await pool.query(
      'INSERT INTO bitacoras (accion, descripcion, id_usuario) VALUES ($1, $2, $3)',
      [accion, descripcionSafe, idUsuario]
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
    const search = typeof req.query.search === 'string'
      ? req.query.search.trim()
      : '';
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const searchTerm = search || searchName;
    const estado = parseBooleanFilter(req.query.estado);
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'recientes';
    const genero = typeof req.query.genero === 'string' ? req.query.genero.trim() : '';
    const suggestMode = parseSuggestMode(req.query.suggest);

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

    const effectiveLimit = suggestMode ? Math.min(limit, MAX_SUGGESTIONS_LIMIT) : limit;

    const { data, total } = await personaRepository.searchWithPagination({
      capabilities,
      search: searchTerm,
      page,
      limit: effectiveLimit,
      tenantId,
      estado,
      sort,
      genero,
      suggestMode
    });

    let stats = null;
    if (!searchTerm && !suggestMode) {
      stats = await personaRepository.getGlobalStats({
        capabilities,
        tenantId,
        estado
      });
    }

    const suggestions = suggestMode ? buildPersonaSuggestions(data) : null;

    return {
      status: 200,
      body: {
        data,
        total,
        page,
        limit: effectiveLimit,
        ...(stats ? { stats } : {}),
        ...(suggestions ? { suggestions } : {})
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
    const payload = normalizePersonaPayload(req.body);

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

    const resultado = await personaRepository.create(insertData);
    await personaRepository.addAuditLog({
      accion: 'PERSONA_CREAR',
      descripcion: `Persona creada: ${payload.nombre ?? 'sin_nombre'}`,
      idUsuario,
      capabilities
    });

    return {
      status: 201,
      body: {
        error: false,
        message: isPlainObject(resultado) && resultado.message
          ? resultado.message
          : 'Persona creada exitosamente.',
        data: resultado ?? null
      }
    };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idPersona = parsePositiveInt(req.params.id);
    const payload = normalizePersonaPayload(req.body);

    if (!idPersona) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return { status: 400, body: { error: true, message: 'Debe enviar datos validos para actualizar' } };
    }

    const current = await personaRepository.findById(idPersona, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Persona no encontrada' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta persona' } };
    }

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_persona')]);
    allowedFields.add('texto_direccion');
    allowedFields.add('texto_telefono');
    allowedFields.add('texto_correo');
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    let updateData = {};

    if (
      Object.prototype.hasOwnProperty.call(payload, 'campo')
      && Object.prototype.hasOwnProperty.call(payload, 'valor')
    ) {
      const campo = normalizeUpdateFieldName(payload.campo);
      const valor = payload.valor;
      if (!allowedFields.has(campo)) {
        return { status: 400, body: { error: true, message: 'El campo no es valido para actualizacion' } };
      }
      updateData = { [campo]: valor };
    } else {
      updateData = Object.entries(payload).reduce((acc, [campo, valor]) => {
        const normalizedField = normalizeUpdateFieldName(campo);
        if (!allowedFields.has(normalizedField)) return acc;
        if (valor === undefined) return acc;
        acc[normalizedField] = valor;
        return acc;
      }, {});

      if (!Object.keys(updateData).length) {
        return {
          status: 400,
          body: { error: true, message: 'No se recibieron campos validos para actualizar' }
        };
      }
    }

    const idUsuario = resolveUserId(req);
    if (capabilities.hasTenantField && tenantId) {
      const requestedTenantId = parsePositiveInt(updateData.id_empresa);
      if (requestedTenantId && requestedTenantId !== tenantId) {
        return { status: 403, body: { error: true, message: 'No puede actualizar personas de otra empresa' } };
      }
      if (!requestedTenantId) {
        updateData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasUpdatedBy && idUsuario) {
      updateData.updated_by = idUsuario;
    }

    const resultado = await personaRepository.update(idPersona, updateData);
    const camposActualizados = Object.keys(updateData).join(', ');

    await personaRepository.addAuditLog({
      accion: 'PERSONA_ACTUALIZAR',
      descripcion: `Persona ${idPersona} actualizada: ${camposActualizados}`,
      idUsuario,
      capabilities
    });

    return {
      status: 200,
      body: {
        error: false,
        message: isPlainObject(resultado) && resultado.message
          ? resultado.message
          : 'Persona actualizada correctamente',
        data: resultado ?? null
      }
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
router.get('/personas', asyncHandler(personaService.list));
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
