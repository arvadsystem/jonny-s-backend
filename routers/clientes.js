import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const CLIENTES_LIST_PERMISSIONS = ['CLIENTES_LISTADO_VER'];
const CLIENTES_DETAIL_PERMISSIONS = ['CLIENTES_DETALLE_VER'];
const CLIENTES_CREATE_PERMISSIONS = ['CLIENTES_CREAR'];
const CLIENTES_EDIT_PERMISSIONS = ['CLIENTES_EDITAR'];
const CLIENTES_DELETE_PERMISSIONS = ['CLIENTES_ELIMINAR'];

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_cliente', 'fecha_ingreso', 'puntos', 'id_tipo_cliente', 'id_persona', 'id_empresa', 'estado'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FN_CLIENTE_FIELDS = new Set([
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa',
  'estado'
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

const parseNullablePositiveInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return parsePositiveInt(value);
};

const resolveUserId = (req) => req.user?.id_usuario ?? null;

const firstNonEmptyValue = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
};

const resolveClienteOrigen = (row) => {
  const raw = String(row?.origen_cliente ?? '').trim().toLowerCase();
  if (raw === 'persona' || raw === 'empresa') return raw;
  if (row?.id_persona) return 'persona';
  if (row?.id_empresa) return 'empresa';
  return 'persona';
};

const resolveClienteEstado = (row, softDeleteField) => {
  if (softDeleteField && row?.[softDeleteField] !== undefined) {
    const parsed = parseBooleanValue(row?.[softDeleteField]);
    if (parsed !== null) return parsed;
  }
  const fromEstado = parseBooleanValue(row?.estado);
  if (fromEstado !== null) return fromEstado;
  return true;
};

const normalizeClienteDto = (row, softDeleteField = null) => {
  const origenCliente = resolveClienteOrigen(row);
  const personaNombre = firstNonEmptyValue(
    row?.persona_nombre_completo,
    `${row?.persona_nombre ?? row?.nombre ?? ''} ${row?.persona_apellido ?? row?.apellido ?? ''}`.trim()
  );
  const empresaNombre = firstNonEmptyValue(
    row?.nombre_empresa,
    row?.empresa_nombre,
    row?.empresa
  );
  const nombrePrincipal = firstNonEmptyValue(
    row?.nombre_principal,
    origenCliente === 'empresa' ? empresaNombre : personaNombre,
    personaNombre,
    empresaNombre
  );

  const dni = firstNonEmptyValue(row?.dni, row?.persona_dni);
  const rtn = firstNonEmptyValue(row?.rtn, row?.empresa_rtn, row?.rtn_empresa);
  const documentoValor = firstNonEmptyValue(
    row?.documento_valor,
    origenCliente === 'empresa' ? rtn : dni,
    origenCliente === 'empresa' ? dni : rtn
  );
  const documentoTipo = firstNonEmptyValue(
    row?.documento_tipo,
    documentoValor ? (origenCliente === 'empresa' ? 'rtn' : 'dni') : null
  );

  const personaTelefono = firstNonEmptyValue(row?.persona_telefono, row?.telefono_persona);
  const empresaTelefono = firstNonEmptyValue(row?.empresa_telefono, row?.telefono_empresa);
  const telefonoGenerico = firstNonEmptyValue(row?.telefono, row?.telefono_numero, row?.numero_telefono);
  const telefono = firstNonEmptyValue(
    row?.telefono,
    origenCliente === 'empresa'
      ? firstNonEmptyValue(empresaTelefono, telefonoGenerico, personaTelefono)
      : firstNonEmptyValue(personaTelefono, telefonoGenerico, empresaTelefono)
  );

  const personaCorreo = firstNonEmptyValue(row?.persona_correo, row?.correo_persona);
  const empresaCorreo = firstNonEmptyValue(row?.empresa_correo, row?.correo_empresa);
  const correoGenerico = firstNonEmptyValue(row?.correo, row?.direccion_correo, row?.email);
  const correo = firstNonEmptyValue(
    row?.correo,
    origenCliente === 'empresa'
      ? firstNonEmptyValue(empresaCorreo, correoGenerico, personaCorreo)
      : firstNonEmptyValue(personaCorreo, correoGenerico, empresaCorreo)
  );

  const tipoCliente = firstNonEmptyValue(
    row?.tipo_cliente,
    row?.tipo_cliente_nombre,
    row?.nombre_tipo_cliente
  );
  const rawPuntos = Number(row?.puntos);
  const puntos = Number.isFinite(rawPuntos) ? rawPuntos : 0;
  const fechaIngreso = row?.fecha_ingreso ?? null;
  const estado = resolveClienteEstado(row, softDeleteField);
  const codigoCliente = firstNonEmptyValue(
    row?.codigo_cliente,
    row?.codigo,
    row?.id_cliente ? `CLI-${row.id_cliente}` : null
  );

  return {
    ...row,
    codigo_cliente: codigoCliente,
    origen_cliente: origenCliente,
    origen_label: firstNonEmptyValue(
      row?.origen_label,
      origenCliente === 'empresa' ? 'Cliente Empresa' : 'Cliente Persona'
    ),
    nombre_principal: nombrePrincipal,
    subtitulo_principal: firstNonEmptyValue(
      row?.subtitulo_principal,
      origenCliente === 'empresa' ? empresaNombre : tipoCliente
    ),
    documento_tipo: documentoTipo,
    documento_valor: documentoValor,
    documento_label: firstNonEmptyValue(
      row?.documento_label,
      documentoTipo ? String(documentoTipo).toUpperCase() : null
    ),
    dni: dni,
    rtn: rtn,
    telefono: telefono,
    correo: correo,
    tipo_cliente: tipoCliente,
    puntos,
    fecha_ingreso: fechaIngreso,
    estado,
    id_persona: row?.id_persona ?? null,
    id_empresa: row?.id_empresa ?? null
  };
};

const normalizeClienteFunctionPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {};

  for (const [key, rawValue] of Object.entries(payload)) {
    if (!FN_CLIENTE_FIELDS.has(key) || rawValue === undefined) continue;

    if (['id_tipo_cliente', 'id_persona', 'id_empresa'].includes(key)) {
      const parsed = parseNullablePositiveInt(rawValue);
      normalized[key] = parsed;
      continue;
    }

    if (key === 'puntos') {
      if (rawValue === null || rawValue === '') {
        normalized[key] = null;
        continue;
      }
      const parsed = Number.parseInt(rawValue, 10);
      if (Number.isInteger(parsed)) normalized[key] = parsed;
      continue;
    }

    if (key === 'fecha_ingreso') {
      if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
        normalized[key] = null;
      } else {
        normalized[key] = String(rawValue).trim();
      }
      continue;
    }

    if (key === 'estado') {
      const parsed = parseBooleanValue(rawValue);
      if (parsed !== null) normalized[key] = parsed;
      continue;
    }

    normalized[key] = rawValue;
  }

  return normalized;
};

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
  async searchWithPagination({
    capabilities,
    page,
    limit,
    searchTerm = '',
    estado = null,
    tenantId = null
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

    if (searchTerm) {
      const value = `%${searchTerm}%`;
      const searchFragments = [
        'c.id_cliente::TEXT ILIKE $IDX',
        "CONCAT('CLI-', c.id_cliente) ILIKE $IDX",
        "COALESCE(c.fecha_ingreso::TEXT, '') ILIKE $IDX",
        "COALESCE(c.puntos::TEXT, '') ILIKE $IDX"
      ];

      if (capabilities.softDeleteField) {
        searchFragments.push(`COALESCE(c.${capabilities.softDeleteField}::TEXT, '') ILIKE $IDX`);
      }

      if (capabilities.hasPersonasTable) {
        searchFragments.push("COALESCE(p.nombre, '') ILIKE $IDX");
        searchFragments.push("COALESCE(p.apellido, '') ILIKE $IDX");
        searchFragments.push("COALESCE(p.dni::TEXT, '') ILIKE $IDX");
        searchFragments.push("COALESCE(telf_p.telefono, '') ILIKE $IDX");
        searchFragments.push("COALESCE(cor_p.direccion_correo, '') ILIKE $IDX");
      }

      if (capabilities.hasEmpresasTable) {
        searchFragments.push("COALESCE(e.nombre_empresa, '') ILIKE $IDX");
        searchFragments.push("COALESCE(e.rtn::TEXT, '') ILIKE $IDX");
        searchFragments.push("COALESCE(telf_e.telefono, '') ILIKE $IDX");
        searchFragments.push("COALESCE(cor_e.direccion_correo, '') ILIKE $IDX");
      }

      if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
        searchFragments.push(`COALESCE(tc.${capabilities.tipoClienteLabelField}, '') ILIKE $IDX`);
      }

      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`c.${capabilities.softDeleteField} = $IDX`, estado);
    }

    // Conserva comportamiento legacy: scoping por id_empresa del cliente.
    if (tenantId && capabilities.hasTenantField) {
      pushFilter('c.id_empresa = $IDX', tenantId);
    }

    const fields = [
      'c.id_cliente',
      'c.fecha_ingreso',
      'c.puntos',
      'c.id_tipo_cliente',
      'c.id_persona',
      capabilities.hasTenantField ? 'c.id_empresa' : 'NULL::INT AS id_empresa'
    ];

    if (capabilities.softDeleteField) {
      fields.push(`c.${capabilities.softDeleteField}`);
      if (capabilities.softDeleteField !== 'estado') {
        fields.push(`c.${capabilities.softDeleteField} AS estado`);
      }
    } else {
      fields.push('NULL::BOOLEAN AS estado');
    }

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push(`TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS persona_nombre_completo`);
      fields.push('telf_p.telefono AS persona_telefono');
      fields.push('telf_p.telefono AS telefono_persona');
      fields.push('cor_p.direccion_correo AS persona_correo');
      fields.push('cor_p.direccion_correo AS correo_persona');
    } else {
      fields.push('NULL::TEXT AS persona_nombre');
      fields.push('NULL::TEXT AS persona_apellido');
      fields.push('NULL::TEXT AS persona_dni');
      fields.push('NULL::TEXT AS persona_nombre_completo');
      fields.push('NULL::TEXT AS persona_telefono');
      fields.push('NULL::TEXT AS telefono_persona');
      fields.push('NULL::TEXT AS persona_correo');
      fields.push('NULL::TEXT AS correo_persona');
    }

    if (capabilities.hasEmpresasTable) {
      fields.push('e.nombre_empresa');
      fields.push('e.rtn AS empresa_rtn');
      fields.push('telf_e.telefono AS empresa_telefono');
      fields.push('telf_e.telefono AS telefono_empresa');
      fields.push('cor_e.direccion_correo AS empresa_correo');
      fields.push('cor_e.direccion_correo AS correo_empresa');
    } else {
      fields.push('NULL::TEXT AS nombre_empresa');
      fields.push('NULL::TEXT AS empresa_rtn');
      fields.push('NULL::TEXT AS empresa_telefono');
      fields.push('NULL::TEXT AS telefono_empresa');
      fields.push('NULL::TEXT AS empresa_correo');
      fields.push('NULL::TEXT AS correo_empresa');
    }

    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      fields.push(`tc.${capabilities.tipoClienteLabelField} AS tipo_cliente_nombre`);
    } else {
      fields.push('NULL::TEXT AS tipo_cliente_nombre');
    }

    fields.push(`CASE
      WHEN c.id_empresa IS NOT NULL AND c.id_persona IS NULL THEN 'empresa'
      WHEN c.id_persona IS NOT NULL AND c.id_empresa IS NULL THEN 'persona'
      WHEN c.id_empresa IS NOT NULL THEN 'empresa'
      ELSE 'persona'
    END AS origen_cliente`);

    const personaNombreExpr = capabilities.hasPersonasTable
      ? "NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '')"
      : 'NULL';
    const empresaNombreExpr = capabilities.hasEmpresasTable
      ? "NULLIF(TRIM(COALESCE(e.nombre_empresa, '')), '')"
      : 'NULL';
    fields.push(`COALESCE(${personaNombreExpr}, ${empresaNombreExpr}) AS nombre_principal`);

    const joins = [];
    if (capabilities.hasPersonasTable) {
      joins.push('LEFT JOIN personas p ON p.id_persona = c.id_persona');
      joins.push('LEFT JOIN telefonos telf_p ON telf_p.id_telefono = p.id_telefono');
      joins.push('LEFT JOIN correos cor_p ON cor_p.id_correo = p.id_correo');
    }
    if (capabilities.hasEmpresasTable) {
      joins.push('LEFT JOIN empresas e ON e.id_empresa = c.id_empresa');
      joins.push('LEFT JOIN telefonos telf_e ON telf_e.id_telefono = e.id_telefono');
      joins.push('LEFT JOIN correos cor_e ON cor_e.id_correo = e.id_correo');
    }
    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      joins.push('LEFT JOIN tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente');
    }

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countWhere = countFilters.length ? `WHERE ${countFilters.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];

    const dataQuery = `
      SELECT ${fields.join(', ')}
      FROM clientes c${joinsSql}
      ${where}
      ORDER BY c.id_cliente ASC
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
      total: Number(totalResult.rows?.[0]?.total) || 0
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
      fields.push('telf.telefono AS persona_telefono');
      fields.push('telf.telefono AS telefono_persona');
      fields.push('cor.direccion_correo AS persona_correo');
      fields.push('cor.direccion_correo AS correo_persona');
    }

    if (capabilities.hasEmpresasTable) {
      fields.push('e.nombre_empresa');
      fields.push('e.rtn AS empresa_rtn');
      fields.push('telf_emp.telefono AS empresa_telefono');
      fields.push('telf_emp.telefono AS telefono_empresa');
      fields.push('cor_emp.direccion_correo AS empresa_correo');
      fields.push('cor_emp.direccion_correo AS correo_empresa');
    }

    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      fields.push(`tc.${capabilities.tipoClienteLabelField} AS tipo_cliente_nombre`);
    }

    const joins = [];
    if (capabilities.hasPersonasTable) {
      joins.push('LEFT JOIN personas p ON p.id_persona = c.id_persona');
      joins.push('LEFT JOIN telefonos telf ON telf.id_telefono = p.id_telefono');
      joins.push('LEFT JOIN correos cor ON cor.id_correo = p.id_correo');
    }
    if (capabilities.hasEmpresasTable) {
      joins.push('LEFT JOIN empresas e ON e.id_empresa = c.id_empresa');
      joins.push('LEFT JOIN telefonos telf_emp ON telf_emp.id_telefono = e.id_telefono');
      joins.push('LEFT JOIN correos cor_emp ON cor_emp.id_correo = e.id_correo');
    }
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
    const result = await pool.query(
      'SELECT fn_guardar_cliente($1::json) AS id_cliente',
      [JSON.stringify(data)]
    );
    return result.rows[0]?.id_cliente ?? null;
  },

  async updateWithFunction(idCliente, data) {
    await pool.query(
      'SELECT fn_actualizar_cliente($1::INT, $2::json) AS id_cliente',
      [idCliente, JSON.stringify(data)]
    );
  },

  async updateField(idCliente, campo, valor) {
    if (valor === null) {
      await pool.query(
        `UPDATE clientes SET ${campo} = NULL WHERE id_cliente = $1`,
        [idCliente]
      );
      return;
    }

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
        body: { error: true, message: 'La tabla clientes no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const { data, total } = await clienteRepository.searchWithPagination({
      capabilities,
      page,
      limit,
      searchTerm: effectiveSearch,
      estado,
      tenantId
    });

    const normalizedData = (Array.isArray(data) ? data : []).map((row) =>
      normalizeClienteDto(row, capabilities.softDeleteField)
    );

    return {
      status: 200,
      body: {
        data: normalizedData,
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

    const normalizedCliente = normalizeClienteDto(cliente, capabilities.softDeleteField);

    if (capabilities.softDeleteField && normalizedCliente.estado === false) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== normalizedCliente.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este cliente' } };
    }

    return { status: 200, body: normalizedCliente };
  },

  async create(req) {
    const capabilities = await getSchemaCapabilities();
    const payload = req.body;

    if (!isPlainObject(payload) || Object.keys(payload).length === 0) {
      return { status: 400, body: { error: true, message: 'Debe enviar un objeto con datos validos' } };
    }

    const estadoSolicitado = Object.prototype.hasOwnProperty.call(payload, 'estado')
      ? parseBooleanValue(payload.estado)
      : null;
    if (Object.prototype.hasOwnProperty.call(payload, 'estado') && estadoSolicitado === null) {
      return { status: 400, body: { error: true, message: 'estado debe ser booleano' } };
    }

    const insertData = normalizeClienteFunctionPayload(payload);
    const idUsuario = resolveUserId(req);
    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const personaId = parseNullablePositiveInt(insertData.id_persona);
    const empresaId = parseNullablePositiveInt(insertData.id_empresa);

    if ((personaId ? 1 : 0) + (empresaId ? 1 : 0) !== 1) {
      return {
        status: 400,
        body: { error: true, message: 'Debe seleccionar solo una relacion: persona o empresa' }
      };
    }

    if (capabilities.hasTenantField && tenantId) {
      if (empresaId && empresaId !== tenantId) {
        return { status: 403, body: { error: true, message: 'No puede crear clientes para otra empresa' } };
      }
    }

    insertData.id_persona = personaId;
    insertData.id_empresa = empresaId;
    if (estadoSolicitado !== null) {
      insertData.estado = estadoSolicitado;
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const createdId = await clienteRepository.create(insertData);
    await clienteRepository.addAuditLog({
      accion: 'CLIENTE_CREAR',
      descripcion: `Cliente creado: ${personaId ? `persona ${personaId}` : `empresa ${empresaId}`}`,
      idUsuario,
      capabilities
    });

    return {
      status: 201,
      body: {
        message: 'Cliente creado exitosamente.',
        id_cliente: createdId
      }
    };
  },

  async update(req) {
    const capabilities = await getSchemaCapabilities();
    const idCliente = parsePositiveInt(req.params.id);
    const body = req.body;

    if (!idCliente) {
      return { status: 400, body: { error: true, message: 'El id debe ser un entero positivo' } };
    }

    if (!isPlainObject(body)) {
      return { status: 400, body: { error: true, message: 'Debe enviar un objeto con datos validos' } };
    }

    const hasCampoValor = Object.prototype.hasOwnProperty.call(body, 'campo')
      && Object.prototype.hasOwnProperty.call(body, 'valor');
    const rawUpdates = hasCampoValor ? { [body.campo]: body.valor } : { ...body };

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_cliente')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');

    const updateEntries = Object.entries(rawUpdates).filter(([field, value]) => field && value !== undefined);
    if (!updateEntries.length) {
      return { status: 400, body: { error: true, message: 'No hay campos validos para actualizar' } };
    }

    const invalidField = updateEntries.find(([field]) => !allowedFields.has(field));
    if (invalidField) {
      return { status: 400, body: { error: true, message: `El campo ${invalidField[0]} no es valido para actualizacion` } };
    }

    const current = await clienteRepository.findById(idCliente, capabilities);
    if (!current) {
      return { status: 404, body: { error: true, message: 'Cliente no encontrado' } };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: { error: true, message: 'Acceso denegado para este cliente' } };
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'estado')) {
      const estadoParsed = parseBooleanValue(rawUpdates.estado);
      if (estadoParsed === null) {
        return { status: 400, body: { error: true, message: 'estado debe ser booleano' } };
      }
      rawUpdates.estado = estadoParsed;
    }

    const touchesPersona = Object.prototype.hasOwnProperty.call(rawUpdates, 'id_persona');
    const touchesEmpresa = Object.prototype.hasOwnProperty.call(rawUpdates, 'id_empresa');
    const nextPersonaId = touchesPersona
      ? parseNullablePositiveInt(rawUpdates.id_persona)
      : parseNullablePositiveInt(current.id_persona);
    const nextEmpresaId = touchesEmpresa
      ? parseNullablePositiveInt(rawUpdates.id_empresa)
      : parseNullablePositiveInt(current.id_empresa);

    if (touchesPersona && rawUpdates.id_persona !== null && rawUpdates.id_persona !== '' && !nextPersonaId) {
      return { status: 400, body: { error: true, message: 'id_persona debe ser un entero positivo' } };
    }

    if (touchesEmpresa && rawUpdates.id_empresa !== null && rawUpdates.id_empresa !== '' && !nextEmpresaId) {
      return { status: 400, body: { error: true, message: 'id_empresa debe ser un entero positivo' } };
    }

    if (touchesPersona || touchesEmpresa) {
      if ((nextPersonaId ? 1 : 0) + (nextEmpresaId ? 1 : 0) !== 1) {
        return {
          status: 400,
          body: { error: true, message: 'Debe mantener solo una relacion activa: persona o empresa' }
        };
      }
    }

    if (capabilities.hasTenantField && tenantId && nextEmpresaId && nextEmpresaId !== tenantId) {
      return { status: 403, body: { error: true, message: 'No puede mover clientes a otra empresa' } };
    }

    if (touchesPersona) rawUpdates.id_persona = nextPersonaId;
    if (touchesEmpresa) rawUpdates.id_empresa = nextEmpresaId;

    const functionPayload = normalizeClienteFunctionPayload(rawUpdates);
    let touched = false;

    if (touchesPersona && nextPersonaId === null) delete functionPayload.id_persona;
    if (touchesEmpresa && nextEmpresaId === null) delete functionPayload.id_empresa;

    if (Object.keys(functionPayload).length > 0) {
      await clienteRepository.updateWithFunction(idCliente, functionPayload);
      touched = true;
    }

    // `fn_actualizar_cliente` usa COALESCE y no limpia FKs a NULL; se fuerza limpieza puntual aqui.
    if (touchesPersona && nextPersonaId === null) {
      await clienteRepository.updateField(idCliente, 'id_persona', null);
      touched = true;
    }
    if (touchesEmpresa && nextEmpresaId === null) {
      await clienteRepository.updateField(idCliente, 'id_empresa', null);
      touched = true;
    }

    for (const [field, value] of updateEntries) {
      if (FN_CLIENTE_FIELDS.has(field)) continue;
      await clienteRepository.updateField(idCliente, field, rawUpdates[field] ?? value);
      touched = true;
    }

    if (!touched) {
      return { status: 400, body: { error: true, message: 'No hay campos validos para actualizar' } };
    }

    const idUsuario = resolveUserId(req);
    if (capabilities.hasUpdatedBy && idUsuario && !Object.prototype.hasOwnProperty.call(rawUpdates, 'updated_by')) {
      await clienteRepository.updateField(idCliente, 'updated_by', idUsuario);
    }

    await clienteRepository.addAuditLog({
      accion: 'CLIENTE_ACTUALIZAR',
      descripcion: `Cliente ${idCliente} actualizado: ${updateEntries.map(([field]) => field).join(', ')}`,
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
router.get('/clientes-detalle', checkPermission(CLIENTES_LIST_PERMISSIONS), asyncHandler(clienteService.list));
router.get('/clientes', checkPermission(CLIENTES_LIST_PERMISSIONS), asyncHandler(clienteService.list));

/* =======================
   GET - CLIENTE POR ID
======================= */
router.get('/clientes/:id', checkPermission(CLIENTES_DETAIL_PERMISSIONS), asyncHandler(clienteService.getById));

/* =======================
   POST - INSERTAR
======================= */
router.post('/clientes', checkPermission(CLIENTES_CREATE_PERMISSIONS), asyncHandler(clienteService.create));

/* =======================
   PUT - ACTUALIZAR
======================= */
router.put('/clientes/:id', checkPermission(CLIENTES_EDIT_PERMISSIONS), asyncHandler(clienteService.update));

/* =======================
   DELETE - ELIMINAR
======================= */
router.delete('/clientes/:id', checkPermission(CLIENTES_DELETE_PERMISSIONS), asyncHandler(clienteService.remove));

export default router;
