import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { getClientIp } from '../utils/security/clientInfo.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload,
  isSafeDni,
  isSafeEmail,
  isSafePhoneHN,
  isSafeHumanName,
  isValidDateOnly,
  isFutureDateOnly
} from '../utils/security/personasHardening.js';

const router = express.Router();
const PERSONAS_LIST_PERMISSIONS = ['PERSONAS_LISTADO_VER'];
const PERSONAS_DETAIL_PERMISSIONS = ['PERSONAS_DETALLE_VER'];
const PERSONAS_CREATE_PERMISSIONS = ['PERSONAS_CREAR', 'PERSONAS_CREAR_DESDE_CLIENTES'];
const PERSONAS_EDIT_PERMISSIONS = ['PERSONAS_EDITAR'];
const PERSONAS_DELETE_PERMISSIONS = ['PERSONAS_ELIMINAR'];

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
const PERSONA_CONTEXT_FIELDS = new Set(['rbac_context', 'contexto_origen', 'contexto', '_context']);
const PERSONA_ALIAS_FIELDS = new Set(['direccion', 'telefono', 'correo', 'email']);
const PERSONA_CORE_FIELDS = new Set([
  'nombre',
  'apellido',
  'fecha_nacimiento',
  'genero',
  'dni',
  'rtn',
  'id_telefono',
  'id_direccion',
  'id_correo',
  'texto_direccion',
  'texto_telefono',
  'texto_correo',
  'id_empresa',
  'estado',
  'created_by',
  'updated_by',
  'campo',
  'valor'
]);

let schemaCapabilitiesPromise;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const trimOrKeep = (value) => (typeof value === 'string' ? value.trim() : value);

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
const parseBooleanValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo'].includes(normalized)) return false;
  return null;
};

const isClientesContextRequest = (req) => {
  const headerContext = String(
    req.get('x-rbac-context')
    || req.get('x-client-context')
    || ''
  ).trim().toLowerCase();
  const bodyContext = String(
    req.body?.rbac_context
    ?? req.body?.contexto_origen
    ?? req.body?.contexto
    ?? req.body?._context
    ?? ''
  ).trim().toLowerCase();
  const queryContext = String(req.query?.contexto ?? '').trim().toLowerCase();
  return headerContext === 'clientes' || bodyContext === 'clientes' || queryContext === 'clientes';
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
const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop
  }
};

const getCurrentValueForField = (row, field) => {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];

  if (field === 'texto_direccion') return row.direccion ?? null;
  if (field === 'texto_telefono') return row.telefono ?? null;
  if (field === 'texto_correo') return row.correo ?? row.direccion_correo ?? null;

  return undefined;
};

const validatePersonaData = (payload = {}, { requireNombre = false, requireApellido = false } = {}) => {
  const errors = [];
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(payload, key);

  if (requireNombre && !String(payload.nombre ?? '').trim()) {
    errors.push({ field: 'nombre', message: 'nombre es obligatorio.' });
  }
  if (requireApellido && !String(payload.apellido ?? '').trim()) {
    errors.push({ field: 'apellido', message: 'apellido es obligatorio.' });
  }

  if (hasOwn('nombre')) {
    const value = String(payload.nombre ?? '').trim();
    if (value && !isSafeHumanName(value)) {
      errors.push({ field: 'nombre', message: 'nombre solo puede contener letras y espacios.' });
    }
  }

  if (hasOwn('apellido')) {
    const value = String(payload.apellido ?? '').trim();
    if (value && !isSafeHumanName(value)) {
      errors.push({ field: 'apellido', message: 'apellido solo puede contener letras y espacios.' });
    }
  }

  if (hasOwn('dni')) {
    const value = String(payload.dni ?? '').trim();
    if (value && !isSafeDni(value)) {
      errors.push({ field: 'dni', message: 'dni no tiene un formato valido.' });
    }
  }

  if (hasOwn('texto_telefono')) {
    const value = String(payload.texto_telefono ?? '').trim();
    if (value && !isSafePhoneHN(value)) {
      errors.push({ field: 'texto_telefono', message: 'texto_telefono debe tener formato ####-####.' });
    }
  }

  if (hasOwn('texto_correo')) {
    const value = String(payload.texto_correo ?? '').trim();
    if (value && !isSafeEmail(value)) {
      errors.push({ field: 'texto_correo', message: 'texto_correo debe ser un correo valido.' });
    }
  }

  if (hasOwn('fecha_nacimiento')) {
    const value = String(payload.fecha_nacimiento ?? '').trim();
    if (value && (!isValidDateOnly(value) || isFutureDateOnly(value))) {
      errors.push({ field: 'fecha_nacimiento', message: 'fecha_nacimiento no es valida.' });
    }
  }

  if (hasOwn('estado')) {
    const parsed = parseBooleanValue(payload.estado);
    if (parsed === null) {
      errors.push({ field: 'estado', message: 'estado debe ser booleano.' });
    }
  }

  return errors;
};

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

    const searchTerm = typeof search === 'string'
      ? search.trim().replace(/\s+/g, ' ')
      : '';
    if (searchTerm) {
      whereParams.push(`%${searchTerm}%`);
      const searchParamIndex = whereParams.length;
      whereParts.push(`(
        p.nombre ILIKE $${searchParamIndex}
        OR p.apellido ILIKE $${searchParamIndex}
        OR CONCAT_WS(' ', COALESCE(p.nombre, ''), COALESCE(p.apellido, '')) ILIKE $${searchParamIndex}
        OR p.dni::TEXT ILIKE $${searchParamIndex}
        OR p.rtn::TEXT ILIKE $${searchParamIndex}
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
        WHEN CONCAT_WS(' ', COALESCE(p.nombre, ''), COALESCE(p.apellido, '')) ILIKE $${prefixParamIndex} THEN 2
        WHEN p.dni::TEXT ILIKE $${prefixParamIndex} THEN 3
        WHEN p.rtn::TEXT ILIKE $${prefixParamIndex} THEN 4
        WHEN COALESCE(telf.telefono, '') ILIKE $${prefixParamIndex} THEN 5
        WHEN COALESCE(cor.direccion_correo, '') ILIKE $${prefixParamIndex} THEN 6
        WHEN COALESCE(dir.direccion, '') ILIKE $${prefixParamIndex} THEN 7
        ELSE 8
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

    const countFromClause = searchTerm
      ? fromClause
      : 'FROM personas p';

    const totalQuery = `
      SELECT COUNT(*)::INT AS total
      ${countFromClause}
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

  async create(data, db = pool) {
    const payloadJson = JSON.stringify(data ?? {});
    const result = await db.query('SELECT fn_guardar_persona($1::json) AS resultado', [payloadJson]);
    return safeParseJson(extractFunctionResult(result.rows[0], 'resultado'));
  },

  async update(idPersona, data, db = pool) {
    const payloadJson = JSON.stringify(data ?? {});
    const result = await db.query(
      'SELECT fn_actualizar_persona($1, $2::json) AS resultado',
      [idPersona, payloadJson]
    );
    return safeParseJson(extractFunctionResult(result.rows[0], 'resultado'));
  },

  async updateField(idPersona, campo, valor, db = pool) {
    await db.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['personas', campo, String(valor), 'id_persona', String(idPersona)]
    );
  },

  async hardDelete(idPersona, db = pool) {
    await db.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['personas', 'id_persona', String(idPersona)]
    );
  },

  async addAuditLog({
    accion,
    descripcion,
    idUsuario,
    capabilities,
    req,
    modulo = 'PERSONAS',
    tablaAfectada = 'personas',
    idRegistro = null,
    datosAntes = null,
    datosDespues = null,
    db = pool
  }) {
    if (!capabilities.hasBitacorasTable || !idUsuario) return;
    const descripcionSafe = truncateText(descripcion, MAX_AUDIT_DESCRIPCION_LENGTH);
    const moduloSafe = truncateText(modulo, 60) || null;
    const tablaAfectadaSafe = truncateText(tablaAfectada, 60) || null;
    const idRegistroSafe = parsePositiveInt(idRegistro);
    const ipOrigen = req ? getClientIp(req) : null;

    await db.query(
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
    const searchQuery = typeof req.query.q === 'string'
      ? req.query.q.trim()
      : '';
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const searchTerm = search || searchQuery || searchName;
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
    const rawBody = isPlainObject(req.body) ? req.body : {};
    const payload = normalizePersonaPayload(rawBody);
    const hasGeneralCreatePermission = await requestHasAnyPermission(req, ['PERSONAS_CREAR']);

    if (!hasGeneralCreatePermission) {
      const hasContextualCreatePermission = await requestHasAnyPermission(req, ['PERSONAS_CREAR_DESDE_CLIENTES']);
      if (!hasContextualCreatePermission) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado: permisos insuficientes.' })
        };
      }
      if (!isClientesContextRequest(req)) {
        return {
          status: 403,
          body: buildErrorBody({
            code: 'FORBIDDEN',
            message: 'Acceso denegado: PERSONAS_CREAR_DESDE_CLIENTES solo aplica en flujo de clientes.'
          })
        };
      }
    }

    const allowedFields = new Set([
      ...PERSONA_CORE_FIELDS,
      ...PERSONA_ALIAS_FIELDS,
      ...PERSONA_CONTEXT_FIELDS
    ]);
    const unknownFields = unknownFieldsFromPayload(rawBody, allowedFields);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar un objeto con datos validos.' })
      };
    }

    const validationErrors = validatePersonaData(payload, { requireNombre: true, requireApellido: true });
    if (validationErrors.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: validationErrors[0].message,
          details: { field: validationErrors[0].field }
        })
      };
    }

    const insertData = { ...payload };
    const idUsuario = resolveUserId(req);
    const tenantId = parsePositiveInt(req.user?.id_empresa);

    if (capabilities.hasTenantField && tenantId) {
      const requestedTenantId = parsePositiveInt(insertData.id_empresa);
      if (requestedTenantId && requestedTenantId !== tenantId) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede crear personas para otra empresa.' })
        };
      }
      if (!requestedTenantId) {
        insertData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await personaRepository.create(insertData, client);
      await personaRepository.addAuditLog({
        accion: 'PERSONA_CREAR',
        descripcion: `Persona creada: ${payload.nombre ?? 'sin_nombre'}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'PERSONAS',
        tablaAfectada: 'personas',
        datosDespues: payload,
        db: client
      });
      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: isPlainObject(resultado) && resultado.message
            ? resultado.message
            : 'Persona creada exitosamente.',
          data: resultado ?? null
        }
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idPersona = parsePositiveInt(req.params.id);
    const rawBody = isPlainObject(req.body) ? req.body : {};
    const payload = normalizePersonaPayload(rawBody);

    if (!idPersona) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar datos validos para actualizar.' })
      };
    }

    const allowedRequestFields = new Set([
      ...PERSONA_CORE_FIELDS,
      ...PERSONA_ALIAS_FIELDS,
      ...PERSONA_CONTEXT_FIELDS
    ]);
    const unknownFields = unknownFieldsFromPayload(rawBody, allowedRequestFields);
    if (unknownFields.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'UNKNOWN_FIELDS',
          message: 'El payload contiene campos no permitidos.',
          details: { fields: unknownFields }
        })
      };
    }

    const current = await personaRepository.findById(idPersona, capabilities);
    if (!current) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'Persona no encontrada.' })
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para esta persona.' })
      };
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
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'El campo no es valido para actualizacion.'
          })
        };
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
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'No se recibieron campos validos para actualizar.'
          })
        };
      }
    }

    const validationErrors = validatePersonaData(updateData, {
      requireNombre: false,
      requireApellido: false
    });
    if (validationErrors.length) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: validationErrors[0].message,
          details: { field: validationErrors[0].field }
        })
      };
    }

    const idUsuario = resolveUserId(req);
    if (capabilities.hasTenantField && tenantId) {
      const requestedTenantId = parsePositiveInt(updateData.id_empresa);
      if (requestedTenantId && requestedTenantId !== tenantId) {
        return {
          status: 403,
          body: buildErrorBody({
            code: 'FORBIDDEN',
            message: 'No puede actualizar personas de otra empresa.'
          })
        };
      }
      if (!requestedTenantId) {
        updateData.id_empresa = tenantId;
      }
    }

    if (capabilities.hasUpdatedBy && idUsuario) updateData.updated_by = idUsuario;

    const changedEntries = Object.entries(updateData).filter(([field, newValue]) =>
      valuesDiffer(getCurrentValueForField(current, field), newValue)
    );

    const updateDataFiltered = Object.fromEntries(changedEntries);
    if (!Object.keys(updateDataFiltered).length) {
      return {
        status: 200,
        body: {
          ok: true,
          error: false,
          message: 'No se detectaron cambios para actualizar.',
          data: current
        }
      };
    }

    if (capabilities.hasUpdatedBy && idUsuario && !Object.prototype.hasOwnProperty.call(updateDataFiltered, 'updated_by')) {
      updateDataFiltered.updated_by = idUsuario;
    }

    const changedEntriesForAudit = changedEntries.filter(([field]) => field !== 'updated_by');
    const camposActualizados = changedEntriesForAudit.map(([field]) => field).join(', ');
    const datosAntes = changedEntriesForAudit.reduce((acc, [field]) => {
      acc[field] = getCurrentValueForField(current, field) ?? null;
      return acc;
    }, {});
    const datosDespues = changedEntriesForAudit.reduce((acc, [field, value]) => {
      acc[field] = value ?? null;
      return acc;
    }, {});
    const auditDatosAntes = Object.keys(datosAntes).length ? datosAntes : null;
    const auditDatosDespues = Object.keys(datosDespues).length ? datosDespues : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultado = await personaRepository.update(idPersona, updateDataFiltered, client);
      await personaRepository.addAuditLog({
        accion: 'PERSONA_ACTUALIZAR',
        descripcion: `Persona ${idPersona} actualizada: ${camposActualizados || 'sin cambios detectados'}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'PERSONAS',
        tablaAfectada: 'personas',
        idRegistro: idPersona,
        datosAntes: auditDatosAntes,
        datosDespues: auditDatosDespues,
        db: client
      });
      await client.query('COMMIT');

      return {
        status: 200,
        body: {
          ok: true,
          error: false,
          message: isPlainObject(resultado) && resultado.message
            ? resultado.message
            : 'Persona actualizada correctamente.',
          data: resultado ?? null
        }
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idPersona = parsePositiveInt(req.params.id);

    if (!idPersona) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    const current = await personaRepository.findById(idPersona, capabilities);
    if (!current) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'Persona no encontrada.' })
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para esta persona.' })
      };
    }

    const idUsuario = resolveUserId(req);
    const client = await pool.connect();
    let message = 'Persona eliminada correctamente';

    try {
      await client.query('BEGIN');

      if (capabilities.softDeleteField) {
        await personaRepository.updateField(idPersona, capabilities.softDeleteField, false, client);
        if (capabilities.hasUpdatedBy && idUsuario) {
          await personaRepository.updateField(idPersona, 'updated_by', idUsuario, client);
        }
        message = 'Persona inactivada correctamente';
      } else {
        await personaRepository.hardDelete(idPersona, client);
      }

      await personaRepository.addAuditLog({
        accion: 'PERSONA_ELIMINAR',
        descripcion: `Persona ${idPersona} eliminada. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'PERSONAS',
        tablaAfectada: 'personas',
        idRegistro: idPersona,
        datosAntes: current,
        db: client
      });

      await client.query('COMMIT');
      return { status: 200, body: { ok: true, error: false, message } };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Personas API error:', err.message);
    const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return res.status(httpStatus).json(
        buildErrorBody({
          code: err.code || 'REQUEST_ERROR',
          message: sanitizeApiErrorMessage(err.message, httpStatus)
        })
      );
    }

    const mapped = mapDbErrorToSafe(err, {
      defaultMessage: 'No se pudo procesar la solicitud de personas.'
    });
    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({ code: mapped.code, message: mapped.message })
      );
    }

    return res.status(500).json(
      buildErrorBody({ code: 'INTERNAL_ERROR', message: 'No se pudo procesar la solicitud de personas.' })
    );
  }
};

/* =======================
   GET - LISTAR PERSONAS
======================= */
router.get('/personas', checkPermission(PERSONAS_LIST_PERMISSIONS), asyncHandler(personaService.list));
router.get('/personas-detalle', checkPermission(PERSONAS_LIST_PERMISSIONS), asyncHandler(personaService.list));

/* =======================
   GET - PERSONA POR ID
======================= */
router.get('/personas/:id', checkPermission(PERSONAS_DETAIL_PERMISSIONS), asyncHandler(personaService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/personas', checkPermission(PERSONAS_CREATE_PERMISSIONS), asyncHandler(personaService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/personas/:id', checkPermission(PERSONAS_EDIT_PERMISSIONS), asyncHandler(personaService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/personas/:id', checkPermission(PERSONAS_DELETE_PERMISSIONS), asyncHandler(personaService.remove));

export default router;
