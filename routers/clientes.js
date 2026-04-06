import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { getClientIp } from '../utils/security/clientInfo.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  sanitizeApiErrorMessage,
  unknownFieldsFromPayload,
  isSafeEmail,
  isValidDateOnly,
  isFutureDateOnly
} from '../utils/security/personasHardening.js';

const router = express.Router();
const CLIENTES_LIST_PERMISSIONS = ['CLIENTES_LISTADO_VER'];
const CLIENTES_DETAIL_PERMISSIONS = ['CLIENTES_DETALLE_VER'];
const CLIENTES_CREATE_PERMISSIONS = ['CLIENTES_CREAR'];
const CLIENTES_EDIT_PERMISSIONS = ['CLIENTES_EDITAR'];
const CLIENTES_DELETE_PERMISSIONS = ['CLIENTES_ELIMINAR'];

const MAX_LIMIT = 100;
const BASE_FIELDS = ['id_cliente', 'fecha_ingreso', 'puntos', 'id_tipo_cliente', 'id_persona', 'id_empresa', 'id_sucursal', 'estado'];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FN_CLIENTE_FIELDS = new Set([
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa',
  'estado'
]);
const META_UPDATE_FIELDS = new Set(['updated_by']);
const NULLABLE_CLIENTE_COLUMNS = Object.freeze({
  id_persona: 'UPDATE clientes SET id_persona = NULL WHERE id_cliente = $1',
  id_empresa: 'UPDATE clientes SET id_empresa = NULL WHERE id_cliente = $1',
  id_tipo_cliente: 'UPDATE clientes SET id_tipo_cliente = NULL WHERE id_cliente = $1',
  id_sucursal: 'UPDATE clientes SET id_sucursal = NULL WHERE id_cliente = $1',
  fecha_ingreso: 'UPDATE clientes SET fecha_ingreso = NULL WHERE id_cliente = $1'
});

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

const parseNullablePositiveInt = (value) => {
  if (value === null || value === undefined || value === '') return null;
  return parsePositiveInt(value);
};

const resolveUserId = (req) => req.user?.id_usuario ?? null;
const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop
  }
};

const validatePuntosValue = (value) => {
  if (value === null || value === undefined || value === '') return true;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0;
};

const validateFechaIngreso = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return true;
  const text = String(value).trim();
  return isValidDateOnly(text) && !isFutureDateOnly(text);
};

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
    id_sucursal: row?.id_sucursal ?? null,
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
    telefono: phoneToDisplay(telefono),
    correo: correo || 'No registrado',
    direccion: firstNonEmptyValue(
      row?.direccion,
      row?.persona_direccion,
      row?.empresa_direccion,
      'No registrada'
    ),
    puntos: puntos,
    fecha_ingreso: fechaIngreso,
    estado: estado,
    id_persona: row?.id_persona ?? null,
    id_empresa: row?.id_empresa ?? null
  };
};

const phoneToDisplay = (val) => {
  if (!val) return 'Sin teléfono';
  // Formatear si es necesario, o devolver tal cual
  return val;
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

      const personasColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'personas'
      `;

      const empresasColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'empresas'
      `;

      const empleadosColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'empleados'
      `;

      const relatedTablesQuery = `
        SELECT
          to_regclass('public.personas') AS personas_table,
          to_regclass('public.empresas') AS empresas_table,
          to_regclass('public.empleados') AS empleados_table,
          to_regclass('public.tipo_cliente') AS tipo_cliente_table,
          to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [columnsResult, personasColumnsResult, empresasColumnsResult, empleadosColumnsResult, relatedTablesResult] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(personasColumnsQuery),
        pool.query(empresasColumnsQuery),
        pool.query(empleadosColumnsQuery),
        pool.query(relatedTablesQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const personasColumns = new Set(personasColumnsResult.rows.map((row) => row.column_name));
      const empresasColumns = new Set(empresasColumnsResult.rows.map((row) => row.column_name));
      const empleadosColumns = new Set(empleadosColumnsResult.rows.map((row) => row.column_name));
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
        hasClienteSucursalField: columns.has('id_sucursal'),
        hasPersonasTable: Boolean(relatedTables.personas_table),
        hasPersonaSucursalField: personasColumns.has('id_sucursal'),
        hasEmpresasTable: Boolean(relatedTables.empresas_table),
        hasEmpresaSucursalField: empresasColumns.has('id_sucursal'),
        hasEmpleadosTable: Boolean(relatedTables.empleados_table),
        hasEmpleadoSucursalField: empleadosColumns.has('id_sucursal'),
        hasEmpleadoPersonaField: empleadosColumns.has('id_persona'),
        hasEmpleadoIdField: empleadosColumns.has('id_empleado'),
        hasDerivedSucursalFromEmpleado:
          Boolean(relatedTables.empleados_table) &&
          empleadosColumns.has('id_sucursal') &&
          empleadosColumns.has('id_persona') &&
          empleadosColumns.has('id_empleado'),
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
    tenantId = null,
    idSucursal = null
  }) {
    const filters = [];
    const countFilters = [];
    const params = [];
    const countParams = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      countParams.push(value);
      filters.push(fragment.replace(/\$IDX/g, `$${params.length}`));
      countFilters.push(fragment.replace(/\$IDX/g, `$${countParams.length}`));
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
        searchFragments.push("COALESCE(dir_e.direccion, '') ILIKE $IDX");
      }

      if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
        searchFragments.push(`COALESCE(tc.${capabilities.tipoClienteLabelField}, '') ILIKE $IDX`);
      }

      pushFilter(`(${searchFragments.join(' OR ')})`, value);
    }

    if (estado !== null && capabilities.softDeleteField) {
      pushFilter(`c.${capabilities.softDeleteField} = $IDX`, estado);
    }

    if (idSucursal) {
      const sucursalFragments = [];
      if (capabilities.hasClienteSucursalField) {
        sucursalFragments.push('c.id_sucursal = $IDX');
      }
      if (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) {
        sucursalFragments.push('p.id_sucursal = $IDX');
      }
      if (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) {
        sucursalFragments.push('e.id_sucursal = $IDX');
      }
      if (capabilities.hasDerivedSucursalFromEmpleado) {
        sucursalFragments.push('emp_cli.id_sucursal = $IDX');
      }

      if (sucursalFragments.length) {
        pushFilter(`(${sucursalFragments.join(' OR ')})`, idSucursal);
      }
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

    if (capabilities.hasClienteSucursalField) {
      fields.push('c.id_sucursal');
    } else {
      fields.push('NULL::INT AS id_sucursal');
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
      fields.push('dir_p.direccion AS persona_direccion');
      if (capabilities.hasPersonaSucursalField) {
        if (capabilities.hasDerivedSucursalFromEmpleado) {
          fields.push('COALESCE(p.id_sucursal, emp_cli.id_sucursal) AS persona_id_sucursal');
        } else {
          fields.push('p.id_sucursal AS persona_id_sucursal');
        }
      } else if (capabilities.hasDerivedSucursalFromEmpleado) {
        fields.push('emp_cli.id_sucursal AS persona_id_sucursal');
      } else {
        fields.push('NULL::INT AS persona_id_sucursal');
      }
    } else {
      fields.push('NULL::TEXT AS persona_nombre');
      fields.push('NULL::TEXT AS persona_apellido');
      fields.push('NULL::TEXT AS persona_dni');
      fields.push('NULL::TEXT AS persona_nombre_completo');
      fields.push('NULL::TEXT AS persona_telefono');
      fields.push('NULL::TEXT AS telefono_persona');
      fields.push('NULL::TEXT AS persona_correo');
      fields.push('NULL::TEXT AS correo_persona');
      fields.push('NULL::TEXT AS persona_direccion');
      if (capabilities.hasDerivedSucursalFromEmpleado) {
        fields.push('emp_cli.id_sucursal AS persona_id_sucursal');
      } else {
        fields.push('NULL::INT AS persona_id_sucursal');
      }
    }

    if (capabilities.hasEmpresasTable) {
      fields.push('e.nombre_empresa');
      fields.push('e.rtn AS empresa_rtn');
      fields.push('telf_e.telefono AS empresa_telefono');
      fields.push('telf_e.telefono AS telefono_empresa');
      fields.push('cor_e.direccion_correo AS empresa_correo');
      fields.push('cor_e.direccion_correo AS correo_empresa');
      fields.push('dir_e.direccion AS empresa_direccion');
      if (capabilities.hasEmpresaSucursalField) {
        fields.push('e.id_sucursal AS empresa_id_sucursal');
      } else {
        fields.push('NULL::INT AS empresa_id_sucursal');
      }
    } else {
      fields.push('NULL::TEXT AS nombre_empresa');
      fields.push('NULL::TEXT AS empresa_rtn');
      fields.push('NULL::TEXT AS empresa_telefono');
      fields.push('NULL::TEXT AS telefono_empresa');
      fields.push('NULL::TEXT AS empresa_correo');
      fields.push('NULL::TEXT AS correo_empresa');
      fields.push('NULL::TEXT AS empresa_direccion');
      fields.push('NULL::INT AS empresa_id_sucursal');
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
      // Fix: Join robusto para telefonos (identifica el telefono por ID directo o por id_persona si el link directo es NULL)
      // REVERTED: telefonos table does not have id_persona. Reverting to direct link.
      joins.push(`LEFT JOIN telefonos telf_p ON telf_p.id_telefono = p.id_telefono`);
      // Fix: Join robusto para correos (prioriza p.id_correo, pero busca cor_p.id_persona si no hay link directo)
      joins.push(`LEFT JOIN correos cor_p ON (
        cor_p.id_correo = p.id_correo OR (p.id_correo IS NULL AND cor_p.id_persona = p.id_persona)
      )`);
      joins.push('LEFT JOIN direcciones dir_p ON dir_p.id_direccion = p.id_direccion');
    }
    if (capabilities.hasEmpresasTable) {
      joins.push('LEFT JOIN empresas e ON e.id_empresa = c.id_empresa');
      joins.push('LEFT JOIN telefonos telf_e ON telf_e.id_telefono = e.id_telefono');
      joins.push('LEFT JOIN correos cor_e ON cor_e.id_correo = e.id_correo');
      joins.push('LEFT JOIN direcciones dir_e ON dir_e.id_direccion = e.id_direccion');
    }
    if (capabilities.hasDerivedSucursalFromEmpleado) {
      joins.push(`LEFT JOIN LATERAL (
        SELECT em.id_sucursal
        FROM empleados em
        WHERE em.id_persona = c.id_persona
        ORDER BY em.id_empleado DESC
        LIMIT 1
      ) emp_cli ON TRUE`);
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

  async findById(idCliente, capabilities, db = pool) {
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

    const result = await db.query(query, [idCliente]);
    return result.rows[0] || null;
  },

  async create(data, db = pool) {
    const result = await db.query(
      'SELECT fn_guardar_cliente($1::json) AS id_cliente',
      [JSON.stringify(data)]
    );
    return result.rows[0]?.id_cliente ?? null;
  },

  async updateWithFunction(idCliente, data, db = pool) {
    await db.query(
      'SELECT fn_actualizar_cliente($1::INT, $2::json) AS id_cliente',
      [idCliente, JSON.stringify(data)]
    );
  },

  async updateField(idCliente, campo, valor, db = pool) {
    if (valor === null) {
      const sql = NULLABLE_CLIENTE_COLUMNS[campo];
      if (!sql) {
        const error = new Error(`No se permite limpiar el campo ${campo}`);
        error.httpStatus = 400;
        throw error;
      }
      await db.query(sql, [idCliente]);
      return;
    }

    await db.query(
      'CALL pa_update($1::TEXT, $2::TEXT, $3::TEXT, $4::TEXT, $5::TEXT)',
      ['clientes', campo, String(valor), 'id_cliente', String(idCliente)]
    );
  },

  async hardDelete(idCliente, db = pool) {
    await db.query(
      'CALL pa_delete($1::TEXT, $2::TEXT, $3::TEXT)',
      ['clientes', 'id_cliente', String(idCliente)]
    );
  },

  async addAuditLog({
    accion,
    descripcion,
    idUsuario,
    capabilities,
    req,
    modulo = 'CLIENTES',
    tablaAfectada = 'clientes',
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
  },

  async personaExists(idPersona, db = pool) {
    const result = await db.query('SELECT 1 FROM personas WHERE id_persona = $1 LIMIT 1', [idPersona]);
    return result.rows.length > 0;
  },

  async empresaExists(idEmpresa, db = pool) {
    const result = await db.query('SELECT 1 FROM empresas WHERE id_empresa = $1 LIMIT 1', [idEmpresa]);
    return result.rows.length > 0;
  },

  async tipoClienteExists(idTipoCliente, capabilities, db = pool) {
    if (!capabilities?.hasTipoClienteTable) return true;
    const result = await db.query('SELECT 1 FROM tipo_cliente WHERE id_tipo_cliente = $1 LIMIT 1', [idTipoCliente]);
    return result.rows.length > 0;
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
    const idSucursal = req.query.id_sucursal === undefined ? null : parsePositiveInt(req.query.id_sucursal);

    if (req.query.estado !== undefined && estado === null) {
      return { status: 400, body: { error: true, message: 'El filtro estado debe ser booleano' } };
    }

    if (req.query.id_sucursal !== undefined && !idSucursal) {
      return { status: 400, body: { error: true, message: 'El filtro id_sucursal debe ser entero positivo' } };
    }

    if (req.query.estado !== undefined && !capabilities.softDeleteField) {
      return {
        status: 400,
        body: { error: true, message: 'La tabla clientes no soporta filtro por estado' }
      };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const sucursalFilterSupported = Boolean(
      capabilities.hasClienteSucursalField ||
      (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) ||
      (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) ||
      capabilities.hasDerivedSucursalFromEmpleado
    );

    const { data, total } = await clienteRepository.searchWithPagination({
      capabilities,
      page,
      limit,
      searchTerm: effectiveSearch,
      estado,
      tenantId,
      idSucursal: sucursalFilterSupported ? idSucursal : null
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
        limit,
        scope_info: {
          id_sucursal: idSucursal,
          applied: idSucursal ? sucursalFilterSupported : false,
          mode: idSucursal
            ? (sucursalFilterSupported ? 'sql_filter' : 'global_fallback')
            : 'none'
        }
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
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'Debe enviar un objeto con datos validos.' })
      };
    }

    const allowedFields = new Set([...FN_CLIENTE_FIELDS, 'created_by', 'updated_by', 'id_sucursal']);
    const unknownFields = unknownFieldsFromPayload(payload, allowedFields);
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

    const estadoSolicitado = Object.prototype.hasOwnProperty.call(payload, 'estado')
      ? parseBooleanValue(payload.estado)
      : null;
    if (Object.prototype.hasOwnProperty.call(payload, 'estado') && estadoSolicitado === null) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado debe ser booleano.' })
      };
    }

    if (!validatePuntosValue(payload.puntos)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'puntos debe ser un entero mayor o igual a 0.' })
      };
    }

    if (!validateFechaIngreso(payload.fecha_ingreso)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'fecha_ingreso no es valida.' })
      };
    }

    const insertData = normalizeClienteFunctionPayload(payload);
    const idUsuario = resolveUserId(req);
    const tenantId = parsePositiveInt(req.user?.id_empresa);
    const personaId = parseNullablePositiveInt(insertData.id_persona);
    const empresaId = parseNullablePositiveInt(insertData.id_empresa);
    const requestedSucursal = Object.prototype.hasOwnProperty.call(payload, 'id_sucursal')
      ? parseNullablePositiveInt(payload.id_sucursal)
      : null;

    if (
      Object.prototype.hasOwnProperty.call(payload, 'id_sucursal')
      && payload.id_sucursal !== null
      && payload.id_sucursal !== ''
      && !requestedSucursal
    ) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal debe ser un entero positivo.' })
      };
    }

    if ((personaId ? 1 : 0) + (empresaId ? 1 : 0) !== 1) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe seleccionar solo una relacion: persona o empresa.'
        })
      };
    }

    if (capabilities.hasTenantField && tenantId) {
      if (empresaId && empresaId !== tenantId) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede crear clientes para otra empresa.' })
        };
      }
    }

    if (!insertData.id_tipo_cliente || !(await clienteRepository.tipoClienteExists(insertData.id_tipo_cliente, capabilities))) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_tipo_cliente no es valido.' })
      };
    }

    if (personaId && !(await clienteRepository.personaExists(personaId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La persona seleccionada no existe.' })
      };
    }

    if (empresaId && !(await clienteRepository.empresaExists(empresaId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La empresa seleccionada no existe.' })
      };
    }

    insertData.id_persona = personaId;
    insertData.id_empresa = empresaId;
    if (estadoSolicitado !== null) {
      insertData.estado = estadoSolicitado;
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const createdId = await clienteRepository.create(insertData, client);
      if (capabilities.hasClienteSucursalField && requestedSucursal) {
        await clienteRepository.updateField(createdId, 'id_sucursal', requestedSucursal, client);
      }
      await clienteRepository.addAuditLog({
        accion: 'CLIENTE_CREAR',
        descripcion: `Cliente creado: ${personaId ? `persona ${personaId}` : `empresa ${empresaId}`}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'CLIENTES',
        tablaAfectada: 'clientes',
        idRegistro: createdId,
        datosDespues: {
          ...insertData,
          ...(capabilities.hasClienteSucursalField ? { id_sucursal: requestedSucursal } : {})
        },
        db: client
      });

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Cliente creado exitosamente.',
          id_cliente: createdId
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
    const idCliente = parsePositiveInt(req.params.id);
    const body = req.body;

    if (!idCliente) {
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

    const hasCampoValor = Object.prototype.hasOwnProperty.call(body, 'campo')
      && Object.prototype.hasOwnProperty.call(body, 'valor');
    const rawUpdates = hasCampoValor ? { [body.campo]: body.valor } : { ...body };

    const allowedFields = new Set([...BASE_FIELDS.filter((field) => field !== 'id_cliente')]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (capabilities.hasTenantField) allowedFields.add('id_empresa');
    if (!capabilities.hasClienteSucursalField) allowedFields.delete('id_sucursal');

    const unknownFields = unknownFieldsFromPayload(rawUpdates, new Set([...allowedFields, ...META_UPDATE_FIELDS]));
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

    const updateEntries = Object.entries(rawUpdates).filter(([field, value]) => field && value !== undefined);
    if (!updateEntries.length) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'No hay campos validos para actualizar.' })
      };
    }

    const invalidField = updateEntries.find(([field]) => !allowedFields.has(field));
    if (invalidField) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: `El campo ${invalidField[0]} no es valido para actualizacion.`
        })
      };
    }

    const current = await clienteRepository.findById(idCliente, capabilities);
    if (!current) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Cliente no encontrado.' }) };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para este cliente.' }) };
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'estado')) {
      const estadoParsed = parseBooleanValue(rawUpdates.estado);
      if (estadoParsed === null) {
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'estado debe ser booleano.' })
        };
      }
      rawUpdates.estado = estadoParsed;
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'puntos') && !validatePuntosValue(rawUpdates.puntos)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'puntos debe ser un entero mayor o igual a 0.' })
      };
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'fecha_ingreso') && !validateFechaIngreso(rawUpdates.fecha_ingreso)) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'fecha_ingreso no es valida.' })
      };
    }

    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'id_sucursal')) {
      const nextSucursalId = parseNullablePositiveInt(rawUpdates.id_sucursal);
      if (rawUpdates.id_sucursal !== null && rawUpdates.id_sucursal !== '' && !nextSucursalId) {
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_sucursal debe ser un entero positivo.' })
        };
      }
      rawUpdates.id_sucursal = nextSucursalId;
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
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_persona debe ser un entero positivo.' })
      };
    }

    if (touchesEmpresa && rawUpdates.id_empresa !== null && rawUpdates.id_empresa !== '' && !nextEmpresaId) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_empresa debe ser un entero positivo.' })
      };
    }

    if (touchesPersona || touchesEmpresa) {
      if ((nextPersonaId ? 1 : 0) + (nextEmpresaId ? 1 : 0) !== 1) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'Debe mantener solo una relacion activa: persona o empresa.'
          })
        };
      }
    }

    if (capabilities.hasTenantField && tenantId && nextEmpresaId && nextEmpresaId !== tenantId) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede mover clientes a otra empresa.' })
      };
    }

    if (nextPersonaId && !(await clienteRepository.personaExists(nextPersonaId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La persona seleccionada no existe.' })
      };
    }

    if (nextEmpresaId && !(await clienteRepository.empresaExists(nextEmpresaId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La empresa seleccionada no existe.' })
      };
    }

    const nextTipoClienteId = Object.prototype.hasOwnProperty.call(rawUpdates, 'id_tipo_cliente')
      ? parseNullablePositiveInt(rawUpdates.id_tipo_cliente)
      : parseNullablePositiveInt(current.id_tipo_cliente);
    if (!nextTipoClienteId || !(await clienteRepository.tipoClienteExists(nextTipoClienteId, capabilities))) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_tipo_cliente no es valido.' })
      };
    }

    if (touchesPersona) rawUpdates.id_persona = nextPersonaId;
    if (touchesEmpresa) rawUpdates.id_empresa = nextEmpresaId;
    if (Object.prototype.hasOwnProperty.call(rawUpdates, 'id_tipo_cliente')) {
      rawUpdates.id_tipo_cliente = nextTipoClienteId;
    }

    const functionPayload = normalizeClienteFunctionPayload(rawUpdates);
    const idUsuario = resolveUserId(req);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      let touched = false;

      if (touchesPersona && nextPersonaId === null) delete functionPayload.id_persona;
      if (touchesEmpresa && nextEmpresaId === null) delete functionPayload.id_empresa;

      if (Object.keys(functionPayload).length > 0) {
        await clienteRepository.updateWithFunction(idCliente, functionPayload, client);
        touched = true;
      }

      // `fn_actualizar_cliente` usa COALESCE y no limpia FKs a NULL; limpieza puntual segura.
      if (touchesPersona && nextPersonaId === null) {
        await clienteRepository.updateField(idCliente, 'id_persona', null, client);
        touched = true;
      }
      if (touchesEmpresa && nextEmpresaId === null) {
        await clienteRepository.updateField(idCliente, 'id_empresa', null, client);
        touched = true;
      }

      for (const [field, value] of updateEntries) {
        if (FN_CLIENTE_FIELDS.has(field)) continue;
        await clienteRepository.updateField(idCliente, field, rawUpdates[field] ?? value, client);
        touched = true;
      }

      if (!touched) {
        await rollbackQuietly(client);
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'No hay campos validos para actualizar.' })
        };
      }

      if (capabilities.hasUpdatedBy && idUsuario && !Object.prototype.hasOwnProperty.call(rawUpdates, 'updated_by')) {
        await clienteRepository.updateField(idCliente, 'updated_by', idUsuario, client);
      }

      const changedFields = updateEntries.map(([field]) => field);
      const datosAntes = changedFields.reduce((acc, field) => {
        acc[field] = current[field] ?? null;
        return acc;
      }, {});
      const datosDespues = changedFields.reduce((acc, field) => {
        acc[field] = rawUpdates[field] ?? null;
        return acc;
      }, {});

      await clienteRepository.addAuditLog({
        accion: 'CLIENTE_ACTUALIZAR',
        descripcion: `Cliente ${idCliente} actualizado: ${changedFields.join(', ')}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'CLIENTES',
        tablaAfectada: 'clientes',
        idRegistro: idCliente,
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
      body: { ok: true, error: false, message: 'Cliente actualizado correctamente' }
    };
  },

  async remove(req) {
    const capabilities = await getSchemaCapabilities();
    const idCliente = parsePositiveInt(req.params.id);

    if (!idCliente) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo.' })
      };
    }

    const current = await clienteRepository.findById(idCliente, capabilities);
    if (!current) {
      return { status: 404, body: buildErrorBody({ code: 'NOT_FOUND', message: 'Cliente no encontrado.' }) };
    }

    const tenantId = parsePositiveInt(req.user?.id_empresa);
    if (tenantId && capabilities.hasTenantField && tenantId !== current.id_empresa) {
      return { status: 403, body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para este cliente.' }) };
    }

    const idUsuario = resolveUserId(req);
    const client = await pool.connect();
    let message = 'Cliente eliminado correctamente';

    try {
      await client.query('BEGIN');

      if (capabilities.softDeleteField) {
        await clienteRepository.updateField(idCliente, capabilities.softDeleteField, false, client);
        if (capabilities.hasUpdatedBy && idUsuario) {
          await clienteRepository.updateField(idCliente, 'updated_by', idUsuario, client);
        }
        message = 'Cliente inactivado correctamente';
      } else {
        await clienteRepository.hardDelete(idCliente, client);
      }

      await clienteRepository.addAuditLog({
        accion: 'CLIENTE_ELIMINAR',
        descripcion: `Cliente ${idCliente} eliminado. Modo: ${capabilities.softDeleteField ? 'soft' : 'hard'}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'CLIENTES',
        tablaAfectada: 'clientes',
        idRegistro: idCliente,
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
    console.error('Clientes API error:', err.message);
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
      defaultMessage: 'No se pudo procesar la solicitud de clientes.'
    });

    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({ code: mapped.code, message: mapped.message })
      );
    }

    return res.status(500).json(
      buildErrorBody({ code: 'INTERNAL_ERROR', message: 'No se pudo procesar la solicitud de clientes.' })
    );
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
