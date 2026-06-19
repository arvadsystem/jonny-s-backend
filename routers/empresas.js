import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyPermission } from '../middleware/checkPermission.js';
import { getClientIp } from '../utils/security/clientInfo.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload,
  isSafeEmail,
  isSafePhoneHN
} from '../utils/security/personasHardening.js';

const router = express.Router();  
const EMPRESAS_LIST_PERMISSIONS = ['EMPRESAS_LISTADO_VER'];
const EMPRESAS_DETAIL_PERMISSIONS = ['EMPRESAS_DETALLE_VER'];
const EMPRESAS_CREATE_PERMISSIONS = ['EMPRESAS_CREAR', 'EMPRESAS_CREAR_DESDE_CLIENTES'];
const EMPRESAS_EDIT_PERMISSIONS = ['EMPRESAS_EDITAR'];
const EMPRESAS_DELETE_PERMISSIONS = ['EMPRESAS_ELIMINAR'];

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
const META_EMPRESA_FIELDS = new Set(['updated_by', 'created_by']);
const CONTEXT_EMPRESA_FIELDS = new Set([
  'rbac_context',
  'contexto_origen',
  'contexto',
  '_context'
]);

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

const parseBooleanValue = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 't', 'si', 'activo'].includes(normalized)) return true;
    if (['false', '0', 'f', 'no', 'inactivo'].includes(normalized)) return false;
  }
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

const resolveUserId = (req) => req.user?.id_usuario ?? null;
const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop
  }
};
const toNullableTrimmedText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const validateEmpresaContactData = (payload = {}) => {
  const correo = toNullableTrimmedText(payload.texto_correo ?? payload.correo ?? payload.email ?? payload.direccion_correo);
  if (correo && !isSafeEmail(correo)) {
    return 'texto_correo debe ser un correo valido.';
  }

  const telefono = toNullableTrimmedText(payload.texto_telefono ?? payload.telefono);
  if (telefono && !isSafePhoneHN(telefono)) {
    return 'texto_telefono debe tener formato ####-####.';
  }

  return null;
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
  async searchWithPagination({
    capabilities,
    page,
    limit,
    searchName = '',
    estado = null,
    tenantId = null
  }) {
    const filters = [];
    const params = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replaceAll('$IDX', `$${params.length}`));
    };

    if (searchName) {
      const value = `%${searchName}%`;
      const searchFragments = [
        'e.id_empresa::TEXT ILIKE $IDX',
        "COALESCE(e.rtn::TEXT, '') ILIKE $IDX",
        "COALESCE(e.nombre_empresa, '') ILIKE $IDX",
        "COALESCE(t.telefono, '') ILIKE $IDX",
        "COALESCE(c.direccion_correo, '') ILIKE $IDX",
        "COALESCE(d.direccion, '') ILIKE $IDX"
      ];
      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`e.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (tenantId) {
      pushFilter('e.id_empresa = $IDX', tenantId);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const fields = [
      'e.id_empresa',
      'e.rtn',
      'e.nombre_empresa',
      'e.id_telefono',
      'e.id_direccion',
      'e.id_correo',
      't.telefono',
      'd.direccion',
      'c.direccion_correo AS correo'
    ];

    if (capabilities.softDeleteField) {
      fields.push(`e.${capabilities.softDeleteField}`);
      if (capabilities.softDeleteField !== 'estado') {
        fields.push(`e.${capabilities.softDeleteField} AS estado`);
      }
    }
    fields.push('COUNT(*) OVER()::INT AS __total__');

    const joinsSql = `
      LEFT JOIN telefonos t ON t.id_telefono = e.id_telefono
      LEFT JOIN direcciones d ON d.id_direccion = e.id_direccion
      LEFT JOIN correos c ON c.id_correo = e.id_correo
    `;

    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM empresas e
      ${joinsSql}
      ${where}
      ORDER BY e.id_empresa DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const dataResult = await pool.query(dataQuery, dataParams);
    let total = Number(dataResult.rows?.[0]?.__total__) || 0;

    const data = dataResult.rows.map((row) => {
      const { __total__, ...empresa } = row;
      if (!capabilities.softDeleteField) return empresa;

      const estadoActual = parseBooleanValue(empresa?.[capabilities.softDeleteField] ?? empresa?.estado);
      const safeEstado = estadoActual === null ? false : Boolean(estadoActual);

      return {
        ...empresa,
        [capabilities.softDeleteField]: safeEstado,
        estado: safeEstado
      };
    });

    if (data.length === 0) {
      const totalQuery = `
        SELECT COUNT(*)::INT AS total
        FROM empresas e
        ${joinsSql}
        ${where}
      `;
      const totalResult = await pool.query(totalQuery, params);
      total = Number(totalResult.rows?.[0]?.total) || 0;
    }

    return {
      data,
      total
    };
  },

  async findById(idEmpresa, capabilities, db = pool) {
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

    const result = await db.query(query, [idEmpresa]);
    return result.rows[0] || null;
  },

  async create(data, db = pool) {
    const result = await db.query(
      'SELECT fn_guardar_empresa($1::json) AS id_empresa',
      [JSON.stringify(data)]
    );
    return result.rows[0]?.id_empresa ?? null;
  },

  async updateWithFunction(idEmpresa, data, db = pool) {
    await db.query(
      'SELECT fn_actualizar_empresa($1::INT, $2::json) AS id_empresa',
      [idEmpresa, JSON.stringify(data)]
    );
  },

  async updateField(idEmpresa, campo, valor, db = pool) {
    await db.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['empresas', campo, String(valor), 'id_empresa', String(idEmpresa)]
    );
  },

  async hardDelete(idEmpresa, db = pool) {
    await db.query(
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
    datosDespues = null,
    db = pool
  }) {
    if (!capabilities.hasBitacorasTable || !idUsuario) return;
    const descripcionSafe = truncateText(descripcion, 100);
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

const empresaService = {
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
        body: { error: true, message: 'La tabla empresas no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const { data, total } = await empresaRepository.searchWithPagination({
      capabilities,
      page,
      limit,
      searchName: effectiveSearch,
      estado,
      tenantId
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

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== empresa.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para esta empresa' } };
    }

    if (capabilities.softDeleteField) {
      const estadoActual = parseBooleanValue(empresa[capabilities.softDeleteField]);
      const safeEstado = estadoActual === null ? false : Boolean(estadoActual);
      return {
        status: 200,
        body: {
          ...empresa,
          [capabilities.softDeleteField]: safeEstado,
          estado: safeEstado
        }
      };
    }

    return { status: 200, body: empresa };
  },

  async create(req) {
    const capabilities = await getSchemaCapabilities();
    const rawBody = isPlainObject(req.body) ? req.body : {};
    const payload = normalizeEmpresaFunctionPayload(rawBody);
    const hasGeneralCreatePermission = await requestHasAnyPermission(req, ['EMPRESAS_CREAR']);

    if (!hasGeneralCreatePermission) {
      const hasContextualCreatePermission = await requestHasAnyPermission(req, ['EMPRESAS_CREAR_DESDE_CLIENTES']);
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
            message: 'Acceso denegado: EMPRESAS_CREAR_DESDE_CLIENTES solo aplica en flujo de clientes.'
          })
        };
      }
    }

    const allowedFields = new Set([...FN_EMPRESA_FIELDS, 'estado', 'created_by', 'updated_by']);
    const unknownFields = unknownFieldsFromPayload(
      rawBody,
      new Set([...allowedFields, ...Object.keys(LEGACY_TEXT_MAPPINGS), ...CONTEXT_EMPRESA_FIELDS])
    );
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

    const estadoSolicitado = Object.prototype.hasOwnProperty.call(rawBody, 'estado')
      ? parseBooleanValue(rawBody.estado)
      : null;

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar un objeto con datos validos.' })
      };
    }

    if (!payload.nombre_empresa || typeof payload.nombre_empresa !== 'string') {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'nombre_empresa es obligatorio.' })
      };
    }

    if (Object.prototype.hasOwnProperty.call(rawBody, 'estado') && estadoSolicitado === null) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado debe ser booleano.' })
      };
    }

    const contactValidationError = validateEmpresaContactData(rawBody);
    if (contactValidationError) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: contactValidationError })
      };
    }

    const insertData = { ...payload };
    const idUsuario = resolveUserId(req);

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const createdId = await empresaRepository.create(insertData, client);

      if (capabilities.softDeleteField && estadoSolicitado !== null && createdId) {
        await empresaRepository.updateField(createdId, capabilities.softDeleteField, estadoSolicitado, client);
      }

      await empresaRepository.addAuditLog({
        accion: 'EMPRESA_CREAR',
        descripcion: `Empresa creada: ${payload.nombre_empresa}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'EMPRESAS',
        tablaAfectada: 'empresas',
        idRegistro: createdId,
        datosDespues: insertData,
        db: client
      });

      await client.query('COMMIT');
      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Empresa creada exitosamente.',
          id_empresa: createdId
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
    const idEmpresa = parsePositiveInt(req.params.id);
    const body = req.body;
    const hasCampoValor = isPlainObject(body)
      && Object.prototype.hasOwnProperty.call(body, 'campo')
      && Object.prototype.hasOwnProperty.call(body, 'valor');

    if (!idEmpresa) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    if (!isPlainObject(body)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar un objeto con datos validos.' })
      };
    }

    const current = await empresaRepository.findById(idEmpresa, capabilities);
    if (!current) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Empresa no encontrada.' }) };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== current.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para esta empresa.' })
      };
    }

    const rawUpdates = hasCampoValor
      ? { [body.campo]: body.valor }
      : body;

    const allowedFields = new Set([
      ...FN_EMPRESA_FIELDS,
      capabilities.softDeleteField || 'estado',
      ...META_EMPRESA_FIELDS
    ]);
    const unknownFields = unknownFieldsFromPayload(
      rawUpdates,
      new Set([...allowedFields, ...Object.keys(LEGACY_TEXT_MAPPINGS), ...CONTEXT_EMPRESA_FIELDS])
    );
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

    const normalizedUpdates = normalizeEmpresaFunctionPayload(rawUpdates);
    const idUsuario = resolveUserId(req);
    const contactValidationError = validateEmpresaContactData(rawUpdates);
    if (contactValidationError) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: contactValidationError })
      };
    }

    if (capabilities.softDeleteField && Object.prototype.hasOwnProperty.call(rawUpdates, capabilities.softDeleteField)) {
      const estadoSolicitado = parseBooleanValue(rawUpdates[capabilities.softDeleteField]);
      if (estadoSolicitado === null) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: `${capabilities.softDeleteField} debe ser booleano.`
          })
        };
      }
      rawUpdates[capabilities.softDeleteField] = estadoSolicitado;
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'nombre_empresa')) {
      const nombreEmpresa = toNullableTrimmedText(rawUpdates.nombre_empresa);
      if (!nombreEmpresa) {
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'nombre_empresa no puede quedar vacio.' })
        };
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let touched = false;
      let estadoActualizado = false;

      if (capabilities.softDeleteField && Object.prototype.hasOwnProperty.call(rawUpdates, capabilities.softDeleteField)) {
        await empresaRepository.updateField(
          idEmpresa,
          capabilities.softDeleteField,
          rawUpdates[capabilities.softDeleteField],
          client
        );
        touched = true;
        estadoActualizado = true;
      }

      if (Object.keys(normalizedUpdates).length > 0) {
        await empresaRepository.updateWithFunction(idEmpresa, normalizedUpdates, client);
        touched = true;
      }

      if (!touched) {
        await rollbackQuietly(client);
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'No hay campos validos para actualizar.' })
        };
      }

      if (capabilities.hasUpdatedBy && idUsuario) {
        await empresaRepository.updateField(idEmpresa, 'updated_by', idUsuario, client);
      }

      const updatedFields = Object.keys(normalizedUpdates);
      if (estadoActualizado) {
        updatedFields.push(capabilities.softDeleteField);
      }

      const datosAntes = updatedFields.reduce((acc, field) => {
        acc[field] = current[field] ?? null;
        return acc;
      }, {});
      const datosDespues = updatedFields.reduce((acc, field) => {
        acc[field] = rawUpdates[field] ?? normalizedUpdates[field] ?? null;
        return acc;
      }, {});

      await empresaRepository.addAuditLog({
        accion: 'EMPRESA_ACTUALIZAR',
        descripcion: `Empresa ${idEmpresa} actualizada: ${updatedFields.join(', ') || 'sin detalle'}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'EMPRESAS',
        tablaAfectada: 'empresas',
        idRegistro: idEmpresa,
        datosAntes,
        datosDespues,
        db: client
      });

      await client.query('COMMIT');
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    return {
      status: 200,
      body: { ok: true, error: false, message: 'Empresa actualizada correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idEmpresa = parsePositiveInt(req.params.id);

    if (!idEmpresa) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    const current = await empresaRepository.findById(idEmpresa, capabilities);
    if (!current) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Empresa no encontrada.' }) };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && tenantId !== current.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para esta empresa.' })
      };
    }

    const idUsuario = resolveUserId(req);
    const client = await pool.connect();
    let message = 'Empresa eliminada correctamente';

    try {
      await client.query('BEGIN');

      if (capabilities.softDeleteField) {
        await empresaRepository.updateField(idEmpresa, capabilities.softDeleteField, false, client);
        if (capabilities.hasUpdatedBy && idUsuario) {
          await empresaRepository.updateField(idEmpresa, 'updated_by', idUsuario, client);
        }
        message = 'Empresa inactivada correctamente';
      } else {
        await empresaRepository.hardDelete(idEmpresa, client);
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
    console.error('Empresas API error:', err.message);
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
      defaultMessage: 'No se pudo procesar la solicitud de empresas.'
    });

    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({ code: mapped.code, message: mapped.message })
      );
    }

    return res.status(500).json(
      buildErrorBody({ code: 'INTERNAL_ERROR', message: 'No se pudo procesar la solicitud de empresas.' })
    );
  }
};

/* =======================
   GET - LISTAR EMPRESAS
======================= */
router.get('/empresas', checkPermission(EMPRESAS_LIST_PERMISSIONS), asyncHandler(empresaService.list));

/* =======================
   GET - LISTAR EMPRESAS POR ID
======================= */
router.get('/empresas/:id', checkPermission(EMPRESAS_DETAIL_PERMISSIONS), asyncHandler(empresaService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/empresas', checkPermission(EMPRESAS_CREATE_PERMISSIONS), asyncHandler(empresaService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/empresas/:id', checkPermission(EMPRESAS_EDIT_PERMISSIONS), asyncHandler(empresaService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/empresas/:id', checkPermission(EMPRESAS_DELETE_PERMISSIONS), asyncHandler(empresaService.remove));


export default router;
