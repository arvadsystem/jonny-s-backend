import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../middleware/checkPermission.js';
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
const CLIENTES_CREATE_PERMISSIONS = ['CLIENTES_CREAR', 'CLIENTES_CREAR_DESDE_CLIENTES'];
const CLIENTES_EDIT_PERMISSIONS = ['CLIENTES_EDITAR'];
const CLIENTES_DELETE_PERMISSIONS = ['CLIENTES_ELIMINAR'];

const MAX_LIMIT = 100;
const CLIENTE_EMPRESA_RELATION_FIELD = 'id_empresa_cliente';
const BASE_FIELDS = ['id_cliente', 'fecha_ingreso', 'puntos', 'id_tipo_cliente', 'id_persona', 'id_empresa'];
const CLIENTE_MUTABLE_FIELDS = [
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa',
  'id_sucursal',
  'estado',
  CLIENTE_EMPRESA_RELATION_FIELD
];
const OPTIONAL_SOFT_DELETE_FIELDS = ['estado', 'activo', 'habilitado'];
const FN_CLIENTE_FIELDS = new Set([
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa_cliente',
  'id_empresa',
  'estado'
]);
const META_UPDATE_FIELDS = new Set(['updated_by']);
const NULLABLE_CLIENTE_COLUMNS = Object.freeze({
  id_persona: 'UPDATE public.clientes SET id_persona = NULL WHERE id_cliente = $1',
  id_empresa: 'UPDATE public.clientes SET id_empresa = NULL WHERE id_cliente = $1',
  id_empresa_cliente: 'UPDATE public.clientes SET id_empresa_cliente = NULL WHERE id_cliente = $1',
  id_tipo_cliente: 'UPDATE public.clientes SET id_tipo_cliente = NULL WHERE id_cliente = $1',
  id_sucursal: 'UPDATE public.clientes SET id_sucursal = NULL WHERE id_cliente = $1',
  fecha_ingreso: 'UPDATE public.clientes SET fecha_ingreso = NULL WHERE id_cliente = $1'
});

let schemaCapabilitiesPromise;
let schemaCapabilitiesCachedAt = 0;
const SCHEMA_CAPABILITIES_TTL_MS = 60_000;

const invalidateSchemaCapabilitiesCache = () => {
  schemaCapabilitiesPromise = null;
  schemaCapabilitiesCachedAt = 0;
};

const isSchemaDriftError = (err) => {
  const code = String(err?.code || '').trim();
  return code === '42703' || code === '42P01';
};

const hasClientesSucursalesTable = async (db = pool) => {
  try {
    const result = await db.query("SELECT to_regclass('public.clientes_sucursales') AS table_name");
    return Boolean(result.rows?.[0]?.table_name);
  } catch {
    return false;
  }
};

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

const getCurrentDateInTegucigalpa = () => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Tegucigalpa',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

const normalizeDocKey = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  return text || null;
};

const resolveUserId = (req) => req.user?.id_usuario ?? null;
const resolveTenantIdForRequest = async (req) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (isSuperAdmin) return null;

  const tenantFromToken = parsePositiveInt(req.user?.id_empresa ?? req.user?.id_empresa_contexto);
  if (tenantFromToken) return tenantFromToken;
  const idSucursalToken = parsePositiveInt(req.user?.id_sucursal);
  if (idSucursalToken) {
    try {
      const bySucursal = await pool.query(
        `
          SELECT id_empresa
          FROM public.sucursales
          WHERE id_sucursal = $1
          LIMIT 1
        `,
        [idSucursalToken]
      );
      const tenantFromSucursal = parsePositiveInt(bySucursal.rows?.[0]?.id_empresa);
      if (tenantFromSucursal) return tenantFromSucursal;
    } catch {
      // noop
    }
  }

  const idUsuario = resolveUserId(req);
  if (!idUsuario) return null;

  try {
    const tenantResult = await pool.query(
      `
        SELECT
          COALESCE(
            u.id_empresa,
            p_emp.id_empresa,
            c.id_empresa_cliente,
            s_emp.id_empresa
          ) AS id_empresa_resuelta
        FROM public.usuarios u
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas p_emp ON p_emp.id_persona = e.id_persona
        LEFT JOIN public.clientes c ON c.id_cliente = u.id_cliente
        LEFT JOIN public.sucursales s_emp ON s_emp.id_sucursal = e.id_sucursal
        WHERE u.id_usuario = $1
        LIMIT 1
      `,
      [idUsuario]
    );
    return parsePositiveInt(tenantResult.rows?.[0]?.id_empresa_resuelta);
  } catch {
    // noop
  }

  // Fallback final para cajero: empresa desde asignacion activa de caja.
  try {
    const tenantByCaja = await pool.query(
      `
        SELECT s.id_empresa
        FROM public.cajas_usuarios_autorizados cua
        INNER JOIN public.cajas c ON c.id_caja = cua.id_caja
        INNER JOIN public.sucursales s ON s.id_sucursal = c.id_sucursal
        WHERE cua.id_usuario = $1
          AND COALESCE(cua.estado, true) = true
        ORDER BY cua.fecha_actualizacion DESC, cua.id_caja_usuario_autorizado DESC
        LIMIT 1
      `,
      [idUsuario]
    );
    return parsePositiveInt(tenantByCaja.rows?.[0]?.id_empresa);
  } catch {
    return null;
  }
};
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
  if (row?.id_empresa_cliente || row?.id_empresa_relacion || row?.id_empresa) return 'empresa';
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
    id_sucursal_vinculada: row?.id_sucursal_vinculada ?? row?.id_sucursal_contexto ?? null,
    codigo_cliente: codigoCliente,
    origen_cliente: origenCliente,
    origen_label: firstNonEmptyValue(
      row?.origen_label,
      origenCliente === 'empresa' ? 'Cliente Empresa' : 'Cliente Persona'
    ),
    nombre_completo: nombrePrincipal,
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
    tipo_cliente: tipoCliente || null,
    puntos: puntos,
    fecha_ingreso: fechaIngreso,
    persona_genero: firstNonEmptyValue(row?.persona_genero, row?.genero) || null,
    genero: firstNonEmptyValue(row?.persona_genero, row?.genero) || null,
    persona_fecha_nacimiento: firstNonEmptyValue(row?.persona_fecha_nacimiento, row?.fecha_nacimiento) || null,
    fecha_nacimiento: firstNonEmptyValue(row?.persona_fecha_nacimiento, row?.fecha_nacimiento) || null,
    estado: estado,
    id_persona: row?.id_persona ?? null,
    id_empresa_cliente: row?.id_empresa_cliente ?? row?.id_empresa_relacion ?? null,
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

    if (['id_tipo_cliente', 'id_persona', 'id_empresa', 'id_empresa_cliente'].includes(key)) {
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

const getSchemaCapabilities = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();
  const ttlExpired = !schemaCapabilitiesCachedAt || (now - schemaCapabilitiesCachedAt) > SCHEMA_CAPABILITIES_TTL_MS;

  if (forceRefresh || !schemaCapabilitiesPromise || ttlExpired) {
    schemaCapabilitiesCachedAt = now;
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

      const usuariosColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'usuarios'
      `;

      const clientesSucursalesColumnsQuery = `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'clientes_sucursales'
      `;

      const relatedTablesQuery = `
        SELECT
          to_regclass('public.personas') AS personas_table,
          to_regclass('public.empresas') AS empresas_table,
          to_regclass('public.empleados') AS empleados_table,
          to_regclass('public.usuarios') AS usuarios_table,
          to_regclass('public.clientes_sucursales') AS clientes_sucursales_table,
          to_regclass('public.tipo_cliente') AS tipo_cliente_table,
          to_regclass('public.bitacoras') AS bitacoras_table
      `;

      const [
        columnsResult,
        personasColumnsResult,
        empresasColumnsResult,
        empleadosColumnsResult,
        usuariosColumnsResult,
        clientesSucursalesColumnsResult,
        relatedTablesResult
      ] = await Promise.all([
        pool.query(tableColumnsQuery),
        pool.query(personasColumnsQuery),
        pool.query(empresasColumnsQuery),
        pool.query(empleadosColumnsQuery),
        pool.query(usuariosColumnsQuery),
        pool.query(clientesSucursalesColumnsQuery),
        pool.query(relatedTablesQuery)
      ]);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const personasColumns = new Set(personasColumnsResult.rows.map((row) => row.column_name));
      const empresasColumns = new Set(empresasColumnsResult.rows.map((row) => row.column_name));
      const empleadosColumns = new Set(empleadosColumnsResult.rows.map((row) => row.column_name));
      const usuariosColumns = new Set(usuariosColumnsResult.rows.map((row) => row.column_name));
      const clientesSucursalesColumns = new Set(clientesSucursalesColumnsResult.rows.map((row) => row.column_name));
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
        hasEmpresaClienteField: columns.has(CLIENTE_EMPRESA_RELATION_FIELD),
        hasClienteSucursalField: columns.has('id_sucursal'),
        hasPersonasTable: Boolean(relatedTables.personas_table),
        hasPersonaSucursalField: personasColumns.has('id_sucursal'),
        hasEmpresasTable: Boolean(relatedTables.empresas_table),
        hasEmpresaSucursalField: empresasColumns.has('id_sucursal'),
        hasClientesSucursalesTable: Boolean(relatedTables.clientes_sucursales_table),
        hasClientesSucursalesEstadoField: clientesSucursalesColumns.has('estado'),
        hasClientesSucursalesPrincipalField: clientesSucursalesColumns.has('es_principal'),
        hasEmpleadosTable: Boolean(relatedTables.empleados_table),
        hasEmpleadoSucursalField: empleadosColumns.has('id_sucursal'),
        hasEmpleadoPersonaField: empleadosColumns.has('id_persona'),
        hasEmpleadoIdField: empleadosColumns.has('id_empleado'),
        hasUsuariosTable: Boolean(relatedTables.usuarios_table),
        hasUsuarioEmpleadoField: usuariosColumns.has('id_empleado'),
        hasDerivedSucursalFromEmpleado:
          Boolean(relatedTables.empleados_table) &&
          empleadosColumns.has('id_sucursal') &&
          empleadosColumns.has('id_persona') &&
          empleadosColumns.has('id_empleado'),
        hasDerivedSucursalFromCreator:
          columns.has('created_by') &&
          Boolean(relatedTables.usuarios_table) &&
          usuariosColumns.has('id_empleado') &&
          Boolean(relatedTables.empleados_table) &&
          empleadosColumns.has('id_sucursal') &&
          empleadosColumns.has('id_empleado'),
        hasTipoClienteTable,
        tipoClienteLabelField,
        hasBitacorasTable: Boolean(relatedTables.bitacoras_table)
      };
    })().catch((err) => {
      invalidateSchemaCapabilitiesCache();
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
    origen = null,
    tenantId = null,
    idSucursal = null
  }) {
    const empresaRelationExpr = capabilities.hasEmpresaClienteField
      ? `COALESCE(c.${CLIENTE_EMPRESA_RELATION_FIELD}, CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END)`
      : 'c.id_empresa';

    const filters = [];
    const params = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace(/\$IDX/g, `$${params.length}`));
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
        searchFragments.push("NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') ILIKE $IDX");
        searchFragments.push("NULLIF(TRIM(CONCAT(COALESCE(p.apellido, ''), ' ', COALESCE(p.nombre, ''))), '') ILIKE $IDX");
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

    if (origen === 'persona') {
      filters.push('c.id_persona IS NOT NULL');
    } else if (origen === 'empresa') {
      filters.push(`c.id_persona IS NULL AND ${empresaRelationExpr} IS NOT NULL`);
    }

    if (idSucursal) {
      if (capabilities.hasClientesSucursalesTable) {
        const sucursalEstadoFilter = capabilities.hasClientesSucursalesEstadoField
          ? ' AND COALESCE(csf.estado, TRUE) = TRUE'
          : '';
        const anyBridgeStateFilter = capabilities.hasClientesSucursalesEstadoField
          ? ' AND COALESCE(cs_any.estado, TRUE) = TRUE'
          : '';
        const fallbackFragments = [];
        if (capabilities.hasClienteSucursalField) fallbackFragments.push('c.id_sucursal = $IDX');
        if (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) fallbackFragments.push('p.id_sucursal = $IDX');
        if (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) fallbackFragments.push('e.id_sucursal = $IDX');
        if (capabilities.hasDerivedSucursalFromEmpleado) fallbackFragments.push('emp_cli.id_sucursal = $IDX');
        if (capabilities.hasDerivedSucursalFromCreator) fallbackFragments.push('creator_emp.id_sucursal = $IDX');

        const fallbackWhenMissingBridge = fallbackFragments.length
          ? ` OR (
              NOT EXISTS (
                SELECT 1
                FROM public.clientes_sucursales cs_any
                WHERE cs_any.id_cliente = c.id_cliente${anyBridgeStateFilter}
              )
              AND (${fallbackFragments.join(' OR ')})
            )`
          : '';
        const bridgeMatchFragment = `(
            EXISTS (
              SELECT 1
              FROM public.clientes_sucursales csf
              WHERE csf.id_cliente = c.id_cliente
                AND csf.id_sucursal = $IDX${sucursalEstadoFilter}
            )${fallbackWhenMissingBridge}
          )`;
        pushFilter(bridgeMatchFragment, idSucursal);
      } else {
        const legacySucursalFragments = [];
        if (capabilities.hasClienteSucursalField) {
          legacySucursalFragments.push('c.id_sucursal = $IDX');
        }
        if (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) {
          legacySucursalFragments.push('p.id_sucursal = $IDX');
        }
        if (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) {
          legacySucursalFragments.push('e.id_sucursal = $IDX');
        }
        if (capabilities.hasDerivedSucursalFromEmpleado) {
          legacySucursalFragments.push('emp_cli.id_sucursal = $IDX');
        }
        if (capabilities.hasDerivedSucursalFromCreator) {
          legacySucursalFragments.push('creator_emp.id_sucursal = $IDX');
        }

        if (legacySucursalFragments.length) {
          pushFilter(`(${legacySucursalFragments.join(' OR ')})`, idSucursal);
        } else {
          // Si no hay ninguna fuente de sucursal disponible, no devolvemos registros ambiguos.
          filters.push('1 = 0');
        }
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

    if (capabilities.hasEmpresaClienteField) {
      fields.push(`${empresaRelationExpr} AS id_empresa_cliente`);
    } else if (capabilities.hasTenantField) {
      fields.push(`CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END AS id_empresa_cliente`);
    } else {
      fields.push('NULL::INT AS id_empresa_cliente');
    }

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
    if (capabilities.hasClientesSucursalesTable) {
      const linkedSucursalExprParts = ['cs_scope.id_sucursal'];
      if (capabilities.hasClienteSucursalField) linkedSucursalExprParts.push('c.id_sucursal');
      if (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) linkedSucursalExprParts.push('p.id_sucursal');
      if (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) linkedSucursalExprParts.push('e.id_sucursal');
      if (capabilities.hasDerivedSucursalFromEmpleado) linkedSucursalExprParts.push('emp_cli.id_sucursal');
      if (capabilities.hasDerivedSucursalFromCreator) linkedSucursalExprParts.push('creator_emp.id_sucursal');
      fields.push(`COALESCE(${linkedSucursalExprParts.join(', ')}) AS id_sucursal_vinculada`);
    } else {
      const legacySucursalExprParts = [];
      if (capabilities.hasClienteSucursalField) legacySucursalExprParts.push('c.id_sucursal');
      if (capabilities.hasPersonasTable && capabilities.hasPersonaSucursalField) legacySucursalExprParts.push('p.id_sucursal');
      if (capabilities.hasEmpresasTable && capabilities.hasEmpresaSucursalField) legacySucursalExprParts.push('e.id_sucursal');
      if (capabilities.hasDerivedSucursalFromEmpleado) legacySucursalExprParts.push('emp_cli.id_sucursal');
      if (capabilities.hasDerivedSucursalFromCreator) legacySucursalExprParts.push('creator_emp.id_sucursal');
      if (legacySucursalExprParts.length) {
        fields.push(`COALESCE(${legacySucursalExprParts.join(', ')}) AS id_sucursal_vinculada`);
      } else {
        fields.push('NULL::INT AS id_sucursal_vinculada');
      }
    }

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push('p.genero AS persona_genero');
      fields.push('p.fecha_nacimiento AS persona_fecha_nacimiento');
      fields.push('p.genero AS genero');
      fields.push('p.fecha_nacimiento AS fecha_nacimiento');
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
      fields.push('NULL::TEXT AS persona_genero');
      fields.push('NULL::DATE AS persona_fecha_nacimiento');
      fields.push('NULL::TEXT AS genero');
      fields.push('NULL::DATE AS fecha_nacimiento');
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
      WHEN c.id_persona IS NOT NULL THEN 'persona'
      WHEN ${empresaRelationExpr} IS NOT NULL THEN 'empresa'
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
      joins.push('LEFT JOIN public.personas p ON p.id_persona = c.id_persona');
      // Fix: Join robusto para telefonos (identifica el telefono por ID directo o por id_persona si el link directo es NULL)
      // REVERTED: telefonos table does not have id_persona. Reverting to direct link.
      joins.push(`LEFT JOIN public.telefonos telf_p ON telf_p.id_telefono = p.id_telefono`);
      // Fix: Join robusto para correos (prioriza p.id_correo, pero busca cor_p.id_persona si no hay link directo)
      joins.push(`LEFT JOIN public.correos cor_p ON (
        cor_p.id_correo = p.id_correo OR (p.id_correo IS NULL AND cor_p.id_persona = p.id_persona)
      )`);
      joins.push('LEFT JOIN public.direcciones dir_p ON dir_p.id_direccion = p.id_direccion');
    }
    if (capabilities.hasEmpresasTable) {
      joins.push(`LEFT JOIN public.empresas e ON e.id_empresa = ${empresaRelationExpr}`);
      joins.push('LEFT JOIN public.telefonos telf_e ON telf_e.id_telefono = e.id_telefono');
      joins.push('LEFT JOIN public.correos cor_e ON cor_e.id_correo = e.id_correo');
      joins.push('LEFT JOIN public.direcciones dir_e ON dir_e.id_direccion = e.id_direccion');
    }
    if (capabilities.hasClientesSucursalesTable) {
      const estadoFilter = capabilities.hasClientesSucursalesEstadoField
        ? 'AND COALESCE(cs.estado, TRUE) = TRUE'
        : '';
      const principalSort = capabilities.hasClientesSucursalesPrincipalField
        ? 'ORDER BY COALESCE(cs.es_principal, FALSE) DESC, cs.id_sucursal ASC'
        : 'ORDER BY cs.id_sucursal ASC';
      joins.push(`LEFT JOIN LATERAL (
        SELECT cs.id_sucursal
        FROM public.clientes_sucursales cs
        WHERE cs.id_cliente = c.id_cliente
        ${estadoFilter}
        ${principalSort}
        LIMIT 1
      ) cs_scope ON TRUE`);
    }
    if (capabilities.hasDerivedSucursalFromEmpleado) {
      joins.push(`LEFT JOIN LATERAL (
        SELECT em.id_sucursal
        FROM public.empleados em
        WHERE em.id_persona = c.id_persona
        ORDER BY em.id_empleado DESC
        LIMIT 1
      ) emp_cli ON TRUE`);
    }
    if (capabilities.hasDerivedSucursalFromCreator) {
      joins.push(`LEFT JOIN LATERAL (
        SELECT em_creator.id_sucursal
        FROM public.usuarios u_creator
        INNER JOIN public.empleados em_creator ON em_creator.id_empleado = u_creator.id_empleado
        WHERE u_creator.id_usuario = c.created_by
        ORDER BY em_creator.id_empleado DESC
        LIMIT 1
      ) creator_emp ON TRUE`);
    }
    if (capabilities.hasTipoClienteTable && capabilities.tipoClienteLabelField) {
      joins.push('LEFT JOIN public.tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente');
    }

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];
    const fieldsWithTotal = [...fields, 'COUNT(*) OVER()::INT AS __total__'];

    const dataQuery = `
      SELECT ${fieldsWithTotal.join(', ')}
      FROM public.clientes c${joinsSql}
      ${where}
      ORDER BY c.id_cliente DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const dataResult = await pool.query(dataQuery, dataParams);
    const data = dataResult.rows.map(({ __total__, ...row }) => row);
    let total = Number(dataResult.rows?.[0]?.__total__) || 0;

    if (data.length === 0) {
      const totalQuery = `
        SELECT COUNT(*)::INT AS total
        FROM public.clientes c${joinsSql}
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

  async findById(idCliente, capabilities, db = pool) {
    const empresaRelationExpr = capabilities.hasEmpresaClienteField
      ? `COALESCE(c.${CLIENTE_EMPRESA_RELATION_FIELD}, CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END)`
      : 'c.id_empresa';

    const fields = BASE_FIELDS.map((field) => `c.${field}`);
    if (capabilities.hasEmpresaClienteField) {
      fields.push(`c.${CLIENTE_EMPRESA_RELATION_FIELD}`);
      fields.push(`${empresaRelationExpr} AS id_empresa_relacion`);
    } else {
      fields.push('NULL::INT AS id_empresa_cliente');
      fields.push('c.id_empresa AS id_empresa_relacion');
    }
    if (capabilities.hasClientesSucursalesTable) {
      fields.push('cs_scope.id_sucursal AS id_sucursal_vinculada');
    } else {
      fields.push('NULL::INT AS id_sucursal_vinculada');
    }
    if (capabilities.softDeleteField && !BASE_FIELDS.includes(capabilities.softDeleteField)) {
      fields.push(`c.${capabilities.softDeleteField}`);
    }
    if (capabilities.hasCreatedBy) fields.push('c.created_by');
    if (capabilities.hasUpdatedBy) fields.push('c.updated_by');

    if (capabilities.hasPersonasTable) {
      fields.push('p.nombre AS persona_nombre');
      fields.push('p.apellido AS persona_apellido');
      fields.push('p.dni AS persona_dni');
      fields.push('p.genero AS persona_genero');
      fields.push('p.fecha_nacimiento AS persona_fecha_nacimiento');
      fields.push('p.genero AS genero');
      fields.push('p.fecha_nacimiento AS fecha_nacimiento');
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
      joins.push('LEFT JOIN public.personas p ON p.id_persona = c.id_persona');
      joins.push('LEFT JOIN public.telefonos telf ON telf.id_telefono = p.id_telefono');
      joins.push('LEFT JOIN public.correos cor ON cor.id_correo = p.id_correo');
    }
    if (capabilities.hasEmpresasTable) {
      joins.push(`LEFT JOIN public.empresas e ON e.id_empresa = ${empresaRelationExpr}`);
      joins.push('LEFT JOIN public.telefonos telf_emp ON telf_emp.id_telefono = e.id_telefono');
      joins.push('LEFT JOIN public.correos cor_emp ON cor_emp.id_correo = e.id_correo');
    }
    if (capabilities.hasClientesSucursalesTable) {
      const estadoFilter = capabilities.hasClientesSucursalesEstadoField
        ? 'AND COALESCE(cs.estado, TRUE) = TRUE'
        : '';
      const principalSort = capabilities.hasClientesSucursalesPrincipalField
        ? 'ORDER BY COALESCE(cs.es_principal, FALSE) DESC, cs.id_sucursal ASC'
        : 'ORDER BY cs.id_sucursal ASC';
      joins.push(`LEFT JOIN LATERAL (
        SELECT cs.id_sucursal
        FROM public.clientes_sucursales cs
        WHERE cs.id_cliente = c.id_cliente
        ${estadoFilter}
        ${principalSort}
        LIMIT 1
      ) cs_scope ON TRUE`);
    }
    if (capabilities.hasTipoClienteTable) joins.push('LEFT JOIN public.tipo_cliente tc ON tc.id_tipo_cliente = c.id_tipo_cliente');

    const joinsSql = joins.length ? `\n${joins.join('\n')}` : '';
    const query = `
      SELECT ${fields.join(', ')}
      FROM public.clientes c${joinsSql}
      WHERE c.id_cliente = $1
      LIMIT 1
    `;

    const result = await db.query(query, [idCliente]);
    return result.rows[0] || null;
  },

  async create(data, db = pool) {
    const result = await db.query(
      'SELECT public.fn_guardar_cliente($1::json) AS id_cliente',
      [JSON.stringify(data)]
    );
    return result.rows[0]?.id_cliente ?? null;
  },

  async updateWithFunction(idCliente, data, db = pool) {
    await db.query(
      'SELECT public.fn_actualizar_cliente($1::INT, $2::json) AS id_cliente',
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
        INSERT INTO public.bitacoras (
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
    const result = await db.query('SELECT 1 FROM public.personas WHERE id_persona = $1 LIMIT 1', [idPersona]);
    return result.rows.length > 0;
  },

  async empresaExists(idEmpresa, db = pool) {
    const result = await db.query('SELECT 1 FROM public.empresas WHERE id_empresa = $1 LIMIT 1', [idEmpresa]);
    return result.rows.length > 0;
  },

  async tipoClienteExists(idTipoCliente, capabilities, db = pool) {
    if (!capabilities?.hasTipoClienteTable) return true;
    const result = await db.query('SELECT 1 FROM public.tipo_cliente WHERE id_tipo_cliente = $1 LIMIT 1', [idTipoCliente]);
    return result.rows.length > 0;
  },

  async resolveTipoClienteIdForInsert(idTipoCliente, capabilities, db = pool) {
    const preferred = parseNullablePositiveInt(idTipoCliente);
    if (!capabilities?.hasTipoClienteTable) return preferred;

    if (preferred && (await this.tipoClienteExists(preferred, capabilities, db))) {
      return preferred;
    }

    const defaultGeneral = await db.query(
      'SELECT id_tipo_cliente FROM public.tipo_cliente WHERE id_tipo_cliente = 2 LIMIT 1'
    );
    const idGeneral = parsePositiveInt(defaultGeneral.rows?.[0]?.id_tipo_cliente);
    if (idGeneral) return idGeneral;

    const firstAvailable = await db.query(
      'SELECT id_tipo_cliente FROM public.tipo_cliente ORDER BY id_tipo_cliente ASC LIMIT 1'
    );
    return parsePositiveInt(firstAvailable.rows?.[0]?.id_tipo_cliente);
  },

  async syncEmpresaClienteContext(idCliente, empresaClienteId, tenantId, capabilities, db = pool) {
    const parsedCliente = parsePositiveInt(idCliente);
    const parsedEmpresaCliente = parsePositiveInt(empresaClienteId);
    if (!parsedCliente || !parsedEmpresaCliente || !capabilities?.hasEmpresaClienteField) return;

    const parsedTenant = parsePositiveInt(tenantId);
    if (parsedTenant) {
      await db.query(
        `UPDATE public.clientes
         SET id_empresa = $1,
             id_empresa_cliente = $2
         WHERE id_cliente = $3`,
        [parsedTenant, parsedEmpresaCliente, parsedCliente]
      );
      return;
    }

    await db.query(
      `UPDATE public.clientes
       SET id_empresa_cliente = COALESCE(id_empresa_cliente, $1)
       WHERE id_cliente = $2`,
      [parsedEmpresaCliente, parsedCliente]
    );
  },

  async findReusableClienteId({
    personaId = null,
    empresaClienteId = null,
    tenantId = null,
    capabilities,
    db = pool
  }) {
    const empresaRelationExpr = capabilities.hasEmpresaClienteField
      ? `COALESCE(c.${CLIENTE_EMPRESA_RELATION_FIELD}, CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END)`
      : 'c.id_empresa';
    const tenantFilterSqlPersona = capabilities.hasTenantField && tenantId
      ? ' AND c.id_empresa = $2'
      : '';
    const tenantParamsPersona = capabilities.hasTenantField && tenantId ? [tenantId] : [];
    const tenantFilterSqlEmpresa = capabilities.hasTenantField && tenantId && !capabilities.hasEmpresaClienteField
      ? ' AND c.id_empresa = $2'
      : '';
    const tenantParamsEmpresa = capabilities.hasTenantField && tenantId && !capabilities.hasEmpresaClienteField
      ? [tenantId]
      : [];
    const empresaOnlyGuard = capabilities.hasEmpresaClienteField ? '' : ' AND c.id_persona IS NULL';

    if (personaId) {
      const byPersona = await db.query(
        `SELECT c.id_cliente
         FROM public.clientes c
         WHERE c.id_persona = $1${tenantFilterSqlPersona}
         ORDER BY c.id_cliente ASC
         LIMIT 1`,
        [personaId, ...tenantParamsPersona]
      );
      if (byPersona.rows.length) return parsePositiveInt(byPersona.rows[0]?.id_cliente);

      if (capabilities.hasPersonasTable) {
        const dniResult = await db.query(
          'SELECT dni FROM public.personas WHERE id_persona = $1 LIMIT 1',
          [personaId]
        );
        const dniKey = normalizeDocKey(dniResult.rows?.[0]?.dni);
        if (dniKey) {
          const byDni = await db.query(
            `SELECT c.id_cliente
             FROM public.clientes c
             INNER JOIN public.personas p ON p.id_persona = c.id_persona
             WHERE LOWER(TRIM(COALESCE(p.dni::TEXT, ''))) = $1${tenantFilterSqlPersona}
             ORDER BY c.id_cliente ASC
             LIMIT 1`,
            [dniKey, ...tenantParamsPersona]
          );
          if (byDni.rows.length) return parsePositiveInt(byDni.rows[0]?.id_cliente);
        }
      }
    }

    if (empresaClienteId) {
      const byEmpresa = await db.query(
        `SELECT c.id_cliente
         FROM public.clientes c
         WHERE ${empresaRelationExpr} = $1${empresaOnlyGuard}${tenantFilterSqlEmpresa}
         ORDER BY c.id_cliente ASC
         LIMIT 1`,
        [empresaClienteId, ...tenantParamsEmpresa]
      );
      if (byEmpresa.rows.length) return parsePositiveInt(byEmpresa.rows[0]?.id_cliente);

      if (capabilities.hasEmpresasTable) {
        const rtnResult = await db.query(
          'SELECT rtn FROM public.empresas WHERE id_empresa = $1 LIMIT 1',
          [empresaClienteId]
        );
        const rtnKey = normalizeDocKey(rtnResult.rows?.[0]?.rtn);
        if (rtnKey) {
          const byRtn = await db.query(
            `SELECT c.id_cliente
             FROM public.clientes c
             INNER JOIN public.empresas e ON e.id_empresa = ${empresaRelationExpr}
             WHERE LOWER(TRIM(COALESCE(e.rtn::TEXT, ''))) = $1${empresaOnlyGuard}${tenantFilterSqlEmpresa}
             ORDER BY c.id_cliente ASC
             LIMIT 1`,
            [rtnKey, ...tenantParamsEmpresa]
          );
          if (byRtn.rows.length) return parsePositiveInt(byRtn.rows[0]?.id_cliente);
        }
      }
    }

    return null;
  },

  async upsertClienteSucursalLink(idCliente, idSucursal, capabilities, db = pool, { setPrincipal = false } = {}) {
    let effectiveCapabilities = capabilities || {};
    if (!effectiveCapabilities?.hasClientesSucursalesTable) {
      const tableExists = await hasClientesSucursalesTable(db);
      if (!tableExists) return;
      invalidateSchemaCapabilitiesCache();
      effectiveCapabilities = {
        ...effectiveCapabilities,
        hasClientesSucursalesTable: true,
        hasClientesSucursalesEstadoField: true,
        hasClientesSucursalesPrincipalField: true
      };
    }
    const parsedCliente = parsePositiveInt(idCliente);
    const parsedSucursal = parsePositiveInt(idSucursal);
    if (!parsedCliente || !parsedSucursal) return;

    const hasEstadoField = Boolean(effectiveCapabilities.hasClientesSucursalesEstadoField);
    const hasPrincipalField = Boolean(effectiveCapabilities.hasClientesSucursalesPrincipalField);

    const columns = ['id_cliente', 'id_sucursal'];
    const values = ['$1', '$2'];
    const updateSet = ['updated_at = timezone(\'America/Tegucigalpa\', now())'];

    if (hasEstadoField) {
      columns.push('estado');
      values.push('TRUE');
      updateSet.push('estado = TRUE');
    }
    if (hasPrincipalField) {
      columns.push('es_principal');
      values.push(setPrincipal ? 'TRUE' : 'FALSE');
      updateSet.push('es_principal = clientes_sucursales.es_principal OR EXCLUDED.es_principal');
    }

    await db.query(
      `INSERT INTO public.clientes_sucursales (${columns.join(', ')})
       VALUES (${values.join(', ')})
       ON CONFLICT (id_cliente, id_sucursal)
       DO UPDATE SET ${updateSet.join(', ')}`,
      [parsedCliente, parsedSucursal]
    );

    if (setPrincipal && hasPrincipalField) {
      const estadoGuard = hasEstadoField ? 'AND COALESCE(estado, TRUE) = TRUE' : '';
      await db.query(
        `UPDATE public.clientes_sucursales
         SET es_principal = CASE WHEN id_sucursal = $2 THEN TRUE ELSE FALSE END,
             updated_at = timezone('America/Tegucigalpa', now())
         WHERE id_cliente = $1
         ${estadoGuard}`,
        [parsedCliente, parsedSucursal]
      );
    }
  }
};

const clienteService = {
  async list(req) {
    let capabilities = await getSchemaCapabilities();
    const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : parsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'page y limit deben ser enteros positivos' })
      };
    }

    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const searchName = typeof req.query.nombre === 'string' ? req.query.nombre.trim() : '';
    const effectiveSearch = search || searchQuery || searchName;
    const origenRaw = typeof req.query.origen === 'string' ? req.query.origen.trim().toLowerCase() : '';
    const origen = origenRaw === '' ? null : (origenRaw === 'persona' || origenRaw === 'empresa' ? origenRaw : null);
    const estado = parseBooleanFilter(req.query.estado);
    if (req.query.estado !== undefined && estado === null) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El filtro estado debe ser booleano' })
      };
    }
    if (req.query.origen !== undefined && origen === null) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El filtro origen debe ser "persona" o "empresa".' })
      };
    }

    // FASE 7: clientes deja de depender de sucursal; mantenemos compatibilidad ignorando el query id_sucursal.

    if (effectiveSearch && effectiveSearch.length > 120) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El parametro de busqueda supera el maximo permitido.' })
      };
    }

    if (req.query.estado !== undefined && !capabilities.softDeleteField) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'La tabla clientes no soporta filtro por estado'
        })
      };
    }

    const tenantId = await resolveTenantIdForRequest(req);
    const { data, total } = await clienteRepository.searchWithPagination({
      capabilities,
      page,
      limit,
      searchTerm: effectiveSearch,
      estado,
      origen,
      tenantId,
      idSucursal: null
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
          id_sucursal: null,
          applied: false,
          mode: 'disabled'
        }
      }
    };
  },

  async getById(req) {
    const capabilities = await getSchemaCapabilities();
    const idCliente = parsePositiveInt(req.params.id);

    if (!idCliente) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'El id debe ser un entero positivo' })
      };
    }

    const cliente = await clienteRepository.findById(idCliente, capabilities);
    if (!cliente) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'Cliente no encontrado' })
      };
    }

    const normalizedCliente = normalizeClienteDto(cliente, capabilities.softDeleteField);

    if (capabilities.softDeleteField && normalizedCliente.estado === false) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'Cliente no encontrado' })
      };
    }

    const tenantId = await resolveTenantIdForRequest(req);
    if (tenantId && capabilities.hasTenantField && tenantId !== normalizedCliente.id_empresa) {
      return {
        status: 403,
        body: buildErrorBody({ code: 'FORBIDDEN', message: 'Acceso denegado para este cliente' })
      };
    }

    return { status: 200, body: normalizedCliente };
  },

  async create(req) {
    let capabilities = await getSchemaCapabilities();
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

    const insertData = normalizeClienteFunctionPayload(payload);
    const idUsuario = resolveUserId(req);
    const tenantId = await resolveTenantIdForRequest(req);
    const personaId = parseNullablePositiveInt(insertData.id_persona);
    const empresaClienteFromModern = parseNullablePositiveInt(insertData.id_empresa_cliente);
    const empresaClienteFromLegacy = parseNullablePositiveInt(insertData.id_empresa);
    const empresaClienteId = empresaClienteFromModern || empresaClienteFromLegacy;
    if (empresaClienteFromModern && !capabilities.hasEmpresaClienteField) {
      capabilities = await getSchemaCapabilities({ forceRefresh: true });
    }
    const requestedSucursal = Object.prototype.hasOwnProperty.call(payload, 'id_sucursal')
      ? parseNullablePositiveInt(payload.id_sucursal)
      : null;
    const userSucursal = parsePositiveInt(req.user?.id_sucursal);
    const effectiveSucursal = requestedSucursal || userSucursal || null;
    let persistableSucursal = effectiveSucursal;
    let canPersistSucursalScope = Boolean(capabilities.hasClientesSucursalesTable || capabilities.hasClienteSucursalField);

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
    if (effectiveSucursal && !canPersistSucursalScope) {
      const tableExists = await hasClientesSucursalesTable(pool);
      if (tableExists) {
        invalidateSchemaCapabilitiesCache();
        capabilities = await getSchemaCapabilities({ forceRefresh: true });
        canPersistSucursalScope = Boolean(capabilities.hasClientesSucursalesTable || capabilities.hasClienteSucursalField);
      }
    }
    if (effectiveSucursal && !canPersistSucursalScope) {
      persistableSucursal = null;
    }
    const sucursalLinksToApply = canPersistSucursalScope && persistableSucursal
      ? [parsePositiveInt(persistableSucursal)].filter(Boolean)
      : [];

    if (
      capabilities.hasEmpresaClienteField
      && empresaClienteFromModern
      && empresaClienteFromLegacy
      && empresaClienteFromModern !== empresaClienteFromLegacy
    ) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'id_empresa e id_empresa_cliente no pueden tener valores distintos.'
        })
      };
    }

    if ((personaId ? 1 : 0) + (empresaClienteId ? 1 : 0) !== 1) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Debe seleccionar solo una relacion: persona o empresa.'
        })
      };
    }

    if (capabilities.hasTenantField && tenantId) {
      if (
        !capabilities.hasEmpresaClienteField
        && empresaClienteId
        && empresaClienteId !== tenantId
      ) {
        return {
          status: 403,
          body: buildErrorBody({ code: 'FORBIDDEN', message: 'No puede crear clientes para otra empresa.' })
        };
      }
    }

    if (personaId && !(await clienteRepository.personaExists(personaId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La persona seleccionada no existe.' })
      };
    }

    if (empresaClienteId && !(await clienteRepository.empresaExists(empresaClienteId))) {
      return {
        status: 404,
        body: buildErrorBody({ code: 'NOT_FOUND', message: 'La empresa seleccionada no existe.' })
      };
    }

    insertData.id_persona = personaId;
    if (capabilities.hasEmpresaClienteField) {
      insertData.id_empresa_cliente = empresaClienteId;
      if (capabilities.hasTenantField) {
        insertData.id_empresa = tenantId || parseNullablePositiveInt(payload.id_empresa);
      }
    } else {
      insertData.id_empresa = empresaClienteId;
    }
    if (estadoSolicitado !== null) {
      insertData.estado = estadoSolicitado;
    }

    if (capabilities.hasCreatedBy && idUsuario) insertData.created_by = idUsuario;
    if (capabilities.hasUpdatedBy && idUsuario) insertData.updated_by = idUsuario;
    // Alta de cliente controlada por backend:
    // - fecha de ingreso = hoy
    // - puntos iniciales = 0
    insertData.fecha_ingreso = getCurrentDateInTegucigalpa();
    insertData.puntos = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const reusableId = await clienteRepository.findReusableClienteId({
        personaId,
        empresaClienteId,
        tenantId,
        capabilities,
        db: client
      });

      if (reusableId) {
        if (empresaClienteId && capabilities.hasEmpresaClienteField) {
          await clienteRepository.syncEmpresaClienteContext(
            reusableId,
            empresaClienteId,
            tenantId,
            capabilities,
            client
          );
        }
        if (capabilities.hasClienteSucursalField && persistableSucursal) {
          await clienteRepository.updateField(reusableId, 'id_sucursal', persistableSucursal, client);
        }
        if (capabilities.hasClientesSucursalesTable && sucursalLinksToApply.length) {
          for (const sucursalId of sucursalLinksToApply) {
            await clienteRepository.upsertClienteSucursalLink(
              reusableId,
              sucursalId,
              capabilities,
              client,
              { setPrincipal: false }
            );
          }
        }

        await clienteRepository.addAuditLog({
          accion: 'CLIENTE_VINCULAR',
          descripcion: `Cliente existente vinculado a sucursal ${persistableSucursal ?? 'N/A'}: ${reusableId}`,
          idUsuario,
          capabilities,
          req,
          modulo: 'CLIENTES',
          tablaAfectada: 'clientes',
          idRegistro: reusableId,
          datosDespues: {
            id_cliente: reusableId,
            id_sucursal: persistableSucursal,
            id_sucursales_vinculadas: sucursalLinksToApply,
            modo: 'vinculacion'
          },
          db: client
        });

        await client.query('COMMIT');
        return {
          status: 200,
          body: {
            ok: true,
            error: false,
            vinculado: true,
            message: 'Cliente existente vinculado a esta sucursal.',
            id_cliente: reusableId,
            id_sucursal: persistableSucursal
          }
        };
      }

      const resolvedTipoClienteId = await clienteRepository.resolveTipoClienteIdForInsert(
        2,
        capabilities,
        client
      );

      if (capabilities.hasTipoClienteTable && !resolvedTipoClienteId) {
        await client.query('ROLLBACK');
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'No existe un tipo de cliente disponible para crear el registro.'
          })
        };
      }

      if (resolvedTipoClienteId) insertData.id_tipo_cliente = resolvedTipoClienteId;
      else delete insertData.id_tipo_cliente;

      const createdIdRaw = await clienteRepository.create(insertData, client);
      const createdId = parsePositiveInt(createdIdRaw);
      if (!createdId) {
        const error = new Error('No se pudo crear cliente (id_cliente invalido).');
        error.httpStatus = 500;
        throw error;
      }
      if (empresaClienteId && capabilities.hasEmpresaClienteField) {
        await clienteRepository.syncEmpresaClienteContext(
          createdId,
          empresaClienteId,
          tenantId,
          capabilities,
          client
        );
      }
      if (capabilities.hasClienteSucursalField && persistableSucursal) {
        await clienteRepository.updateField(createdId, 'id_sucursal', persistableSucursal, client);
      }
      if (capabilities.hasClientesSucursalesTable && sucursalLinksToApply.length) {
        for (const sucursalId of sucursalLinksToApply) {
          await clienteRepository.upsertClienteSucursalLink(
            createdId,
            sucursalId,
            capabilities,
            client,
            { setPrincipal: sucursalId === persistableSucursal || (!persistableSucursal && sucursalId === sucursalLinksToApply[0]) }
          );
        }
      }
      await clienteRepository.addAuditLog({
        accion: 'CLIENTE_CREAR',
        descripcion: `Cliente creado: ${personaId ? `persona ${personaId}` : `empresa ${empresaClienteId}`}`,
        idUsuario,
        capabilities,
        req,
        modulo: 'CLIENTES',
        tablaAfectada: 'clientes',
        idRegistro: createdId,
        datosDespues: {
          ...insertData,
          ...(capabilities.hasClienteSucursalField ? { id_sucursal: persistableSucursal } : {}),
          id_sucursales_vinculadas: sucursalLinksToApply
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
          id_cliente: createdId,
          id_sucursal: persistableSucursal
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

    const allowedFields = new Set([...CLIENTE_MUTABLE_FIELDS]);
    if (capabilities.softDeleteField) allowedFields.add(capabilities.softDeleteField);
    if (capabilities.hasUpdatedBy) allowedFields.add('updated_by');
    if (!capabilities.hasEmpresaClienteField) {
      allowedFields.delete(CLIENTE_EMPRESA_RELATION_FIELD);
    }
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

    const tenantId = await resolveTenantIdForRequest(req);
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

    if (
      capabilities.hasEmpresaClienteField
      && Object.prototype.hasOwnProperty.call(rawUpdates, 'id_empresa')
      && !Object.prototype.hasOwnProperty.call(rawUpdates, CLIENTE_EMPRESA_RELATION_FIELD)
    ) {
      rawUpdates[CLIENTE_EMPRESA_RELATION_FIELD] = rawUpdates.id_empresa;
    }
    if (
      capabilities.hasEmpresaClienteField
      && Object.prototype.hasOwnProperty.call(rawUpdates, 'id_empresa')
      && Object.prototype.hasOwnProperty.call(rawUpdates, CLIENTE_EMPRESA_RELATION_FIELD)
    ) {
      const legacyEmpresa = parseNullablePositiveInt(rawUpdates.id_empresa);
      const modernEmpresa = parseNullablePositiveInt(rawUpdates[CLIENTE_EMPRESA_RELATION_FIELD]);
      if (legacyEmpresa && modernEmpresa && legacyEmpresa !== modernEmpresa) {
        return {
          status: 400,
          body: buildErrorBody({
            code: 'VALIDATION_ERROR',
            message: 'id_empresa e id_empresa_cliente no pueden tener valores distintos.'
          })
        };
      }
    }

    const touchesPersona = Object.prototype.hasOwnProperty.call(rawUpdates, 'id_persona');
    const touchesEmpresa = Object.prototype.hasOwnProperty.call(rawUpdates, CLIENTE_EMPRESA_RELATION_FIELD)
      || (!capabilities.hasEmpresaClienteField && Object.prototype.hasOwnProperty.call(rawUpdates, 'id_empresa'));
    const nextPersonaId = touchesPersona
      ? parseNullablePositiveInt(rawUpdates.id_persona)
      : parseNullablePositiveInt(current.id_persona);
    const currentEmpresaClienteId = parseNullablePositiveInt(
      current?.id_empresa_cliente ?? current?.id_empresa_relacion ?? current?.id_empresa
    );
    const nextEmpresaId = touchesEmpresa
      ? parseNullablePositiveInt(
          capabilities.hasEmpresaClienteField
            ? rawUpdates[CLIENTE_EMPRESA_RELATION_FIELD]
            : rawUpdates.id_empresa
        )
      : currentEmpresaClienteId;

    if (touchesPersona && rawUpdates.id_persona !== null && rawUpdates.id_persona !== '' && !nextPersonaId) {
      return {
        status: 400,
        body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_persona debe ser un entero positivo.' })
      };
    }

    const rawEmpresaValueForValidation = capabilities.hasEmpresaClienteField
      ? rawUpdates[CLIENTE_EMPRESA_RELATION_FIELD]
      : rawUpdates.id_empresa;
    if (
      touchesEmpresa
      && rawEmpresaValueForValidation !== null
      && rawEmpresaValueForValidation !== ''
      && !nextEmpresaId
    ) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: `${capabilities.hasEmpresaClienteField ? CLIENTE_EMPRESA_RELATION_FIELD : 'id_empresa'} debe ser un entero positivo.`
        })
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

    if (
      !capabilities.hasEmpresaClienteField
      && capabilities.hasTenantField
      && tenantId
      && nextEmpresaId
      && nextEmpresaId !== tenantId
    ) {
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

    const touchesTipoCliente = Object.prototype.hasOwnProperty.call(rawUpdates, 'id_tipo_cliente');
    const nextTipoClienteId = touchesTipoCliente
      ? parseNullablePositiveInt(rawUpdates.id_tipo_cliente)
      : parseNullablePositiveInt(current.id_tipo_cliente);
    if (touchesTipoCliente) {
      if (!nextTipoClienteId || !(await clienteRepository.tipoClienteExists(nextTipoClienteId, capabilities))) {
        return {
          status: 400,
          body: buildErrorBody({ code: 'VALIDATION_ERROR', message: 'id_tipo_cliente no es valido.' })
        };
      }
      rawUpdates.id_tipo_cliente = nextTipoClienteId;
    }

    if (touchesPersona) rawUpdates.id_persona = nextPersonaId;
    if (touchesEmpresa) {
      if (capabilities.hasEmpresaClienteField) {
        rawUpdates[CLIENTE_EMPRESA_RELATION_FIELD] = nextEmpresaId;
      } else {
        rawUpdates.id_empresa = nextEmpresaId;
      }
    }
    const functionPayload = normalizeClienteFunctionPayload(rawUpdates);
    if (capabilities.hasEmpresaClienteField && Object.prototype.hasOwnProperty.call(functionPayload, 'id_empresa')) {
      delete functionPayload.id_empresa;
    }
    const idUsuario = resolveUserId(req);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      let touched = false;

      if (touchesPersona && nextPersonaId === null) delete functionPayload.id_persona;
      if (touchesEmpresa && nextEmpresaId === null) {
        if (capabilities.hasEmpresaClienteField) {
          delete functionPayload[CLIENTE_EMPRESA_RELATION_FIELD];
        } else {
          delete functionPayload.id_empresa;
        }
      }

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
        await clienteRepository.updateField(
          idCliente,
          capabilities.hasEmpresaClienteField ? CLIENTE_EMPRESA_RELATION_FIELD : 'id_empresa',
          null,
          client
        );
        touched = true;
      }

      for (const [field, value] of updateEntries) {
        if (FN_CLIENTE_FIELDS.has(field) || (capabilities.hasEmpresaClienteField && field === 'id_empresa')) continue;
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

      const changedFields = updateEntries.map(([field]) =>
        capabilities.hasEmpresaClienteField && field === 'id_empresa'
          ? CLIENTE_EMPRESA_RELATION_FIELD
          : field
      );
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

    const tenantId = await resolveTenantIdForRequest(req);
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

const runWithSchemaRetry = async (handler, req, res) => {
  try {
    return await handler(req, res);
  } catch (err) {
    if (isSchemaDriftError(err) && !req.__clientesSchemaRetry) {
      req.__clientesSchemaRetry = true;
      invalidateSchemaCapabilitiesCache();
      return handler(req, res);
    }
    throw err;
  }
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await runWithSchemaRetry(handler, req, res);
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
