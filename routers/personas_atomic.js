import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../middleware/checkPermission.js';
import {
  normalizeEmpleadoAtomicPayload,
  normalizeClienteAtomicPayload,
  resolveOrCreatePersona,
  resolveOrCreateEmpresa
} from '../services/entityComposer.js';
import {
  buildErrorBody,
  mapDbErrorToSafe,
  unknownFieldsFromPayload,
  sanitizeApiErrorMessage,
  isValidDateOnly,
  isFutureDateOnly
} from '../utils/security/personasHardening.js';

const router = express.Router();

const EMPLEADOS_CREATE_PERMISSIONS = ['EMPLEADOS_CREAR'];
const CLIENTES_CREATE_PERMISSIONS = ['CLIENTES_CREAR'];
const EMPLEADO_ATOMIC_ALLOWED_FIELDS = new Set([
  'fecha_ingreso',
  'salario_base',
  'estado',
  'id_sucursal',
  'id_persona',
  'cargo',
  'nombre_referencia',
  'telefono_referencia',
  'id_empresa'
]);
const CLIENTE_ATOMIC_ALLOWED_FIELDS = new Set([
  'fecha_ingreso',
  'puntos',
  'id_tipo_cliente',
  'id_persona',
  'id_empresa_cliente',
  'id_empresa',
  'id_sucursal',
  'estado',
  'origen'
]);
const TIPO_CLIENTE_LABEL_CANDIDATES = ['tipo_cliente', 'descripcion', 'nombre'];
let tipoClienteLabelColumnCache = null;
let tipoClienteLabelCheckedAt = 0;
let hasClienteEmpresaFieldCache = null;
let hasClienteEmpresaFieldCheckedAt = 0;
let fnGuardarClienteSupportsEmpresaClienteCache = null;
let fnGuardarClienteSupportCheckedAt = 0;
const ATOMIC_SCHEMA_CACHE_TTL_MS = 60_000;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
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

const extractIdFromUnknown = (value, candidateKeys = []) => {
  const seen = new Set();
  const dynamicKeys = [
    ...candidateKeys,
    'resultado',
    'id',
    'id_cliente',
    'cliente_id'
  ];

  const walk = (node, depth = 0) => {
    if (depth > 5 || node === null || node === undefined) return null;
    const direct = parsePositiveInt(node);
    if (direct) return direct;

    if (typeof node === 'string') {
      const parsedNode = safeParseJson(node);
      if (parsedNode !== node) {
        const nested = walk(parsedNode, depth + 1);
        if (nested) return nested;
      }
      return null;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const nested = walk(item, depth + 1);
        if (nested) return nested;
      }
      return null;
    }

    if (typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);

    for (const key of dynamicKeys) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
      const nested = walk(node[key], depth + 1);
      if (nested) return nested;
    }

    const heuristicIdKeys = Object.keys(node).filter((key) => /(^id$|^id_|_id$)/i.test(String(key)));
    for (const key of heuristicIdKeys) {
      const nested = walk(node[key], depth + 1);
      if (nested) return nested;
    }

    for (const nestedValue of Object.values(node)) {
      const nested = walk(nestedValue, depth + 1);
      if (nested) return nested;
    }

    return null;
  };

  return walk(value, 0);
};

const isSchemaMissingError = (error) => ['42P01', '42703'].includes(String(error?.code || '').trim());

const resolveTenantContextForRequest = async (req, client = pool) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req).catch(() => false);
  const fromToken = parsePositiveInt(req?.user?.id_empresa ?? req?.user?.id_empresa_contexto);
  if (fromToken) return { tenantId: fromToken, isSuperAdmin };

  if (isSuperAdmin) {
    const fromPayload = parsePositiveInt(
      req?.body?.cliente?.id_empresa_tenant
      ?? req?.body?.id_empresa_tenant
      ?? req?.body?.tenant_id
    );
    return { tenantId: fromPayload || null, isSuperAdmin };
  }

  const idUsuario = parsePositiveInt(req?.user?.id_usuario);
  if (!idUsuario) return { tenantId: null, isSuperAdmin };

  try {
    const tenantResult = await client.query(
      `
        SELECT
          COALESCE(u.id_empresa, p_emp.id_empresa) AS id_empresa_resuelta
        FROM public.usuarios u
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN public.personas p_emp ON p_emp.id_persona = e.id_persona
        WHERE u.id_usuario = $1
        LIMIT 1
      `,
      [idUsuario]
    );
    return {
      tenantId: parsePositiveInt(tenantResult.rows?.[0]?.id_empresa_resuelta),
      isSuperAdmin
    };
  } catch {
    return { tenantId: null, isSuperAdmin };
  }
};

const getTipoClienteLabelColumn = async (client, { forceRefresh = false } = {}) => {
  const now = Date.now();
  const shouldRefresh = forceRefresh
    || !tipoClienteLabelCheckedAt
    || (now - tipoClienteLabelCheckedAt) > ATOMIC_SCHEMA_CACHE_TTL_MS;

  if (!shouldRefresh) return tipoClienteLabelColumnCache;

  tipoClienteLabelCheckedAt = now;
  try {
    const rs = await client.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tipo_cliente'
      `
    );
    const columns = new Set((rs.rows || []).map((row) => String(row.column_name || '').trim()));
    tipoClienteLabelColumnCache = TIPO_CLIENTE_LABEL_CANDIDATES.find((name) => columns.has(name)) || null;
  } catch {
    tipoClienteLabelColumnCache = null;
  }

  return tipoClienteLabelColumnCache;
};

const hasClienteEmpresaField = async (client, { forceRefresh = false } = {}) => {
  const now = Date.now();
  const shouldRefresh = forceRefresh
    || !hasClienteEmpresaFieldCheckedAt
    || (now - hasClienteEmpresaFieldCheckedAt) > ATOMIC_SCHEMA_CACHE_TTL_MS;

  if (!shouldRefresh && hasClienteEmpresaFieldCache !== null) {
    return hasClienteEmpresaFieldCache;
  }

  hasClienteEmpresaFieldCheckedAt = now;
  try {
    const rs = await client.query(
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'clientes'
          AND column_name = 'id_empresa_cliente'
        LIMIT 1
      `
    );
    hasClienteEmpresaFieldCache = Boolean(rs.rows?.length);
  } catch {
    hasClienteEmpresaFieldCache = false;
  }

  return hasClienteEmpresaFieldCache;
};

const resolveTipoClienteIdAtomic = async (client, preferredId) => {
  const preferred = parsePositiveInt(preferredId);
  const tableExistsRs = await client.query(`SELECT to_regclass('public.tipo_cliente') AS regclass`);
  const hasTipoClienteTable = Boolean(tableExistsRs.rows?.[0]?.regclass);
  if (!hasTipoClienteTable) return preferred;

  if (preferred) {
    const existsRs = await client.query(
      'SELECT 1 FROM public.tipo_cliente WHERE id_tipo_cliente = $1 LIMIT 1',
      [preferred]
    );
    if (existsRs.rows.length > 0) return preferred;
  }

  const generalRs = await client.query(
    'SELECT id_tipo_cliente FROM public.tipo_cliente WHERE id_tipo_cliente = 2 LIMIT 1'
  );
  const generalId = parsePositiveInt(generalRs.rows?.[0]?.id_tipo_cliente);
  if (generalId) return generalId;

  const firstRs = await client.query(
    'SELECT id_tipo_cliente FROM public.tipo_cliente ORDER BY id_tipo_cliente ASC LIMIT 1'
  );
  return parsePositiveInt(firstRs.rows?.[0]?.id_tipo_cliente);
};

const fnGuardarClienteSupportsEmpresaCliente = async (client, { forceRefresh = false } = {}) => {
  const now = Date.now();
  const shouldRefresh = forceRefresh
    || !fnGuardarClienteSupportCheckedAt
    || (now - fnGuardarClienteSupportCheckedAt) > ATOMIC_SCHEMA_CACHE_TTL_MS;

  if (!shouldRefresh && fnGuardarClienteSupportsEmpresaClienteCache !== null) {
    return fnGuardarClienteSupportsEmpresaClienteCache;
  }

  fnGuardarClienteSupportCheckedAt = now;
  try {
    const rs = await client.query(
      "SELECT pg_get_functiondef('public.fn_guardar_cliente(json)'::regprocedure) AS ddl"
    );
    const ddl = String(rs.rows?.[0]?.ddl || '').toLowerCase();
    fnGuardarClienteSupportsEmpresaClienteCache = ddl.includes('id_empresa_cliente');
  } catch {
    // Fallback seguro: usar deteccion de columna.
    fnGuardarClienteSupportsEmpresaClienteCache = await hasClienteEmpresaField(client, { forceRefresh });
  }

  return fnGuardarClienteSupportsEmpresaClienteCache;
};

const isLegacyClienteRelationError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('id_persona o id_empresa');
};

const parsePositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

const toTrimmedText = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const rollbackQuietly = async (client) => {
  try {
    await client.query('ROLLBACK');
  } catch {
    // noop: preserve original error
  }
};

const mapDbError = (err) => {
  if (String(err?.code || '').trim() === '23514') {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Los datos del cliente no cumplen las reglas de validacion.'
    };
  }
  return mapDbErrorToSafe(err, {
    defaultMessage: 'No se pudo procesar la solicitud atomica.'
  });
};

const asyncHandler = (handler) => async (req, res) => {
  try {
    const result = await handler(req, res);
    return res.status(result.status).json(result.body);
  } catch (err) {
    const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
    if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
      return res.status(httpStatus).json(
        buildErrorBody({
          code: err.code || 'REQUEST_ERROR',
          message: sanitizeApiErrorMessage(err.message, httpStatus)
        })
      );
    }

    const mapped = mapDbError(err);
    if (mapped) {
      return res.status(mapped.status).json(
        buildErrorBody({ code: mapped.code, message: mapped.message })
      );
    }

    console.error('Personas atomic API error:', {
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      where: err?.where
    });
    return res.status(500).json(
      buildErrorBody({
        code: 'INTERNAL_ERROR',
        message: 'No se pudo procesar la solicitud atomica.'
      })
    );
  }
};

const buildAtomicSuccessData = ({ entidadTipo, entidad, idPrincipal, idPersona = null, idEmpresa = null, personaCreada = false, empresaCreada = false }) => ({
  entidad_tipo: entidadTipo,
  entidad: entidad || null,
  id_principal: idPrincipal ?? null,
  id_persona: idPersona,
  id_empresa: idEmpresa,
  persona_creada: Boolean(personaCreada),
  empresa_creada: Boolean(empresaCreada)
});

const findEmpleadoDetail = async (client, idEmpleado) => {
  try {
    const rs = await client.query('SELECT * FROM empleados_listar() WHERE id_empleado = $1 LIMIT 1', [idEmpleado]);
    return rs.rows?.[0] || null;
  } catch {
    const rs = await client.query(
      `
        SELECT
          e.id_empleado,
          e.id_persona,
          e.id_sucursal,
          e.fecha_ingreso,
          e.salario_base,
          e.estado,
          e.cargo,
          e.nombre_referencia,
          e.telefono_referencia,
          TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS nombre_completo,
          p.dni,
          t.telefono,
          c.direccion_correo AS correo,
          d.direccion,
          s.nombre_sucursal AS sucursal
        FROM public.empleados e
        LEFT JOIN public.personas p ON p.id_persona = e.id_persona
        LEFT JOIN public.telefonos t ON t.id_telefono = p.id_telefono
        LEFT JOIN public.correos c ON c.id_correo = p.id_correo
        LEFT JOIN public.direcciones d ON d.id_direccion = p.id_direccion
        LEFT JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
        WHERE e.id_empleado = $1
        LIMIT 1
      `,
      [idEmpleado]
    );
    return rs.rows?.[0] || null;
  }
};

const findClienteDetail = async (client, idCliente) => {
  let empresaRelationExpr = 'CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END';
  if (await hasClienteEmpresaField(client)) {
    empresaRelationExpr = 'COALESCE(c.id_empresa_cliente, CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END)';
  }

  const rs = await client.query(
    `
      SELECT
        c.id_cliente,
        c.id_persona,
        ${empresaRelationExpr} AS id_empresa_cliente,
        c.id_empresa,
        c.id_sucursal,
        c.id_tipo_cliente,
        c.fecha_ingreso,
        c.puntos,
        c.estado,
        TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS persona_nombre_completo,
        p.dni AS persona_dni,
        e.nombre_empresa,
        e.rtn AS empresa_rtn,
        NULL::TEXT AS tipo_cliente
      FROM public.clientes c
      LEFT JOIN public.personas p ON p.id_persona = c.id_persona
      LEFT JOIN public.empresas e ON e.id_empresa = ${empresaRelationExpr}
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  const row = rs.rows?.[0] || null;
  if (!row) return null;

  const idTipoCliente = parsePositiveInt(row.id_tipo_cliente);
  if (!idTipoCliente) return row;

  try {
    let labelColumn = await getTipoClienteLabelColumn(client);
    if (!labelColumn) return row;

    let tipoRs;
    try {
      tipoRs = await client.query(
        `SELECT ${labelColumn} AS tipo_cliente FROM public.tipo_cliente WHERE id_tipo_cliente = $1 LIMIT 1`,
        [idTipoCliente]
      );
    } catch (error) {
      if (!isSchemaMissingError(error)) throw error;
      labelColumn = await getTipoClienteLabelColumn(client, { forceRefresh: true });
      if (!labelColumn) return row;
      tipoRs = await client.query(
        `SELECT ${labelColumn} AS tipo_cliente FROM public.tipo_cliente WHERE id_tipo_cliente = $1 LIMIT 1`,
        [idTipoCliente]
      );
    }

    const tipoLabel = toTrimmedText(tipoRs.rows?.[0]?.tipo_cliente);
    if (tipoLabel) row.tipo_cliente = tipoLabel;
  } catch (error) {
    if (!isSchemaMissingError(error)) throw error;
  }

  return row;
};

const trySetClienteSucursal = async (client, idCliente, idSucursal) => {
  const parsedCliente = parsePositiveInt(idCliente);
  const parsedSucursal = parsePositiveInt(idSucursal);
  if (!parsedCliente || !parsedSucursal) return;
  try {
    await client.query(
      'UPDATE public.clientes SET id_sucursal = $1 WHERE id_cliente = $2',
      [parsedSucursal, parsedCliente]
    );
  } catch (error) {
    if (error?.code === '42703') return;
    throw error;
  }
};

const ensureClientesSucursalesTableAtomic = async (client) => {
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.clientes_sucursales (
        id_cliente INTEGER NOT NULL REFERENCES public.clientes(id_cliente) ON DELETE CASCADE,
        id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
        estado BOOLEAN NOT NULL DEFAULT TRUE,
        es_principal BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('America/Tegucigalpa', now()),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('America/Tegucigalpa', now()),
        PRIMARY KEY (id_cliente, id_sucursal)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_clientes_sucursales_id_sucursal ON public.clientes_sucursales(id_sucursal)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_clientes_sucursales_id_cliente ON public.clientes_sucursales(id_cliente)');
    return true;
  } catch {
    return false;
  }
};

const tryUpsertClienteSucursalLink = async (client, idCliente, idSucursal, { setPrincipal = false } = {}) => {
  const parsedCliente = parsePositiveInt(idCliente);
  const parsedSucursal = parsePositiveInt(idSucursal);
  if (!parsedCliente || !parsedSucursal) return;
  try {
    await client.query(
      `INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
       VALUES ($1, $2, TRUE, $3)
       ON CONFLICT (id_cliente, id_sucursal)
       DO UPDATE SET
         estado = TRUE,
         es_principal = CASE
           WHEN EXCLUDED.es_principal THEN TRUE
           ELSE public.clientes_sucursales.es_principal
         END,
         updated_at = timezone('America/Tegucigalpa', now())`,
      [parsedCliente, parsedSucursal, Boolean(setPrincipal)]
    );
    if (setPrincipal) {
      await client.query(
        `UPDATE public.clientes_sucursales
         SET es_principal = CASE WHEN id_sucursal = $2 THEN TRUE ELSE FALSE END,
             updated_at = timezone('America/Tegucigalpa', now())
         WHERE id_cliente = $1
           AND COALESCE(estado, TRUE) = TRUE`,
        [parsedCliente, parsedSucursal]
      );
    }
  } catch (error) {
    if (['42P01', '42P10'].includes(error?.code)) {
      const bootstrapped = await ensureClientesSucursalesTableAtomic(client);
      if (!bootstrapped) return;
      try {
        await client.query(
          `INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
           VALUES ($1, $2, TRUE, $3)
           ON CONFLICT (id_cliente, id_sucursal)
           DO UPDATE SET
             estado = TRUE,
             es_principal = CASE
               WHEN EXCLUDED.es_principal THEN TRUE
               ELSE public.clientes_sucursales.es_principal
             END,
             updated_at = timezone('America/Tegucigalpa', now())`,
          [parsedCliente, parsedSucursal, Boolean(setPrincipal)]
        );
        if (setPrincipal) {
          await client.query(
            `UPDATE public.clientes_sucursales
             SET es_principal = CASE WHEN id_sucursal = $2 THEN TRUE ELSE FALSE END,
                 updated_at = timezone('America/Tegucigalpa', now())
             WHERE id_cliente = $1
               AND COALESCE(estado, TRUE) = TRUE`,
            [parsedCliente, parsedSucursal]
          );
        }
      } catch (retryError) {
        if (['42P01', '42703', '42P10'].includes(retryError?.code)) return;
        throw retryError;
      }
      return;
    }
    if (error?.code === '42703') {
      try {
        await client.query(
          `INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal)
           VALUES ($1, $2)
           ON CONFLICT (id_cliente, id_sucursal) DO NOTHING`,
          [parsedCliente, parsedSucursal]
        );
      } catch (fallbackError) {
        if (['42P01', '42703', '42P10'].includes(fallbackError?.code)) return;
        throw fallbackError;
      }
      return;
    }
    throw error;
  }
};

const syncClienteEmpresaContext = async (client, idCliente, idEmpresaCliente, idEmpresaTenant = null) => {
  const parsedCliente = parsePositiveInt(idCliente);
  const parsedEmpresaCliente = parsePositiveInt(idEmpresaCliente);
  if (!parsedCliente || !parsedEmpresaCliente) return;

  const hasEmpresaCliente = await hasClienteEmpresaField(client, { forceRefresh: true });
  if (!hasEmpresaCliente) return;

  const parsedTenant = parsePositiveInt(idEmpresaTenant);
  if (parsedTenant) {
    await client.query(
      `UPDATE public.clientes
       SET id_empresa = $1,
           id_empresa_cliente = $2
       WHERE id_cliente = $3`,
      [parsedTenant, parsedEmpresaCliente, parsedCliente]
    );
  } else {
    await client.query(
      `UPDATE public.clientes
       SET id_empresa_cliente = COALESCE(id_empresa_cliente, $1)
       WHERE id_cliente = $2`,
      [parsedEmpresaCliente, parsedCliente]
    );
  }
};

const validateAtomicSucursalInput = (payload) => {
  if (!isPlainObject(payload)) return { ok: true, parsed: null };
  const hasField = Object.prototype.hasOwnProperty.call(payload, 'id_sucursal');
  if (!hasField) return { ok: true, parsed: null };
  const raw = payload.id_sucursal;
  if (raw === null || raw === undefined || raw === '') return { ok: true, parsed: null };
  const parsed = parsePositiveInt(raw);
  if (!parsed) return { ok: false, parsed: null };
  return { ok: true, parsed };
};

const linkClienteToSucursales = async ({
  client,
  idCliente,
  effectiveSucursalId
}) => {
  const targetSucursal = parsePositiveInt(effectiveSucursalId);
  if (!targetSucursal) return [];

  await trySetClienteSucursal(client, idCliente, targetSucursal);
  await tryUpsertClienteSucursalLink(client, idCliente, targetSucursal, {
    setPrincipal: true
  });
  return [targetSucursal];
};

const findReusableClienteAtomic = async (client, { idPersona = null, idEmpresaCliente = null } = {}) => {
  const parsedPersona = parsePositiveInt(idPersona);
  const parsedEmpresa = parsePositiveInt(idEmpresaCliente);

  if (parsedPersona) {
    const rs = await client.query(
      `SELECT c.id_cliente
       FROM public.clientes c
       WHERE c.id_persona = $1
       ORDER BY c.id_cliente ASC
       LIMIT 1`,
      [parsedPersona]
    );
    const found = parsePositiveInt(rs.rows?.[0]?.id_cliente);
    if (found) return found;
  }

  if (parsedEmpresa) {
    const hasEmpresaCliente = await hasClienteEmpresaField(client, { forceRefresh: true });
    const empresaRelationExpr = hasEmpresaCliente
      ? 'COALESCE(c.id_empresa_cliente, CASE WHEN c.id_persona IS NULL THEN c.id_empresa ELSE NULL END)'
      : 'c.id_empresa';
    const empresaOnlyGuard = hasEmpresaCliente ? '' : ' AND c.id_persona IS NULL';
    const rs = await client.query(
      `SELECT c.id_cliente
       FROM public.clientes c
       WHERE ${empresaRelationExpr} = $1${empresaOnlyGuard}
       ORDER BY c.id_cliente ASC
       LIMIT 1`,
      [parsedEmpresa]
    );
    const found = parsePositiveInt(rs.rows?.[0]?.id_cliente);
    if (found) return found;
  }

  return null;
};

const atomicService = {
  async createEmpleado(req) {
    const body = isPlainObject(req.body) ? req.body : {};
    const empleadoPayload = isPlainObject(body.empleado) ? body.empleado : { ...body };
    delete empleadoPayload.persona;
    delete empleadoPayload.empresa;
    delete empleadoPayload.cliente;

    if (!isPlainObject(empleadoPayload)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Payload invalido para crear empleado atomico.'
        })
      };
    }

    const unknownFields = unknownFieldsFromPayload(empleadoPayload, EMPLEADO_ATOMIC_ALLOWED_FIELDS);
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

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { idPersona, created: personaCreada } = await resolveOrCreatePersona({
        client,
        req,
        idPersona: body.id_persona ?? empleadoPayload.id_persona,
        personaPayload: body.persona,
        allowClientesContext: false
      });

      const normalizedEmpleado = normalizeEmpleadoAtomicPayload({
        ...empleadoPayload,
        id_persona: idPersona
      });

      if (!normalizedEmpleado.id_persona || !normalizedEmpleado.id_sucursal) {
        const error = new Error('Empleado atomico requiere id_persona e id_sucursal validos');
        error.httpStatus = 400;
        throw error;
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'salario_base')) {
        const salarioBase = Number(empleadoPayload.salario_base);
        if (!Number.isFinite(salarioBase) || salarioBase < 0) {
          const error = new Error('salario_base debe ser un numero mayor a 0');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'fecha_ingreso')) {
        const fecha = toTrimmedText(empleadoPayload.fecha_ingreso);
        if (fecha && (!isValidDateOnly(fecha) || isFutureDateOnly(fecha))) {
          const error = new Error('fecha_ingreso invalida');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(empleadoPayload, 'estado')) {
        const parsedEstado = parseBooleanValue(empleadoPayload.estado);
        if (parsedEstado === null) {
          const error = new Error('estado de empleado debe ser booleano');
          error.httpStatus = 400;
          throw error;
        }
      }

      const createResult = await client.query('SELECT empleados_crear($1::json) AS id_empleado', [
        JSON.stringify(normalizedEmpleado)
      ]);

      const idEmpleado = parsePositiveInt(createResult.rows?.[0]?.id_empleado);
      if (!idEmpleado) {
        const error = new Error('No se pudo crear empleado en flujo atomico');
        error.httpStatus = 500;
        throw error;
      }

      const empleado = await findEmpleadoDetail(client, idEmpleado);

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Empleado creado en flujo atomico',
          data: {
            ...buildAtomicSuccessData({
              entidadTipo: 'empleado',
              entidad: empleado,
              idPrincipal: idEmpleado,
              idPersona,
              personaCreada,
              empresaCreada: false
            }),
            id_empleado: idEmpleado,
            empleado
          }
        }
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  },

  async createCliente(req) {
    const body = isPlainObject(req.body) ? req.body : {};
    const clientePayload = isPlainObject(body.cliente) ? body.cliente : { ...body };
    delete clientePayload.persona;
    delete clientePayload.empresa;
    delete clientePayload.empleado;

    if (!isPlainObject(clientePayload)) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'Payload invalido para crear cliente atomico.'
        })
      };
    }

    const unknownFields = unknownFieldsFromPayload(clientePayload, CLIENTE_ATOMIC_ALLOWED_FIELDS);
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

    const origenRaw = String(body.origen ?? clientePayload.origen ?? '').trim().toLowerCase();
    const origen = origenRaw === 'empresa' ? 'empresa' : origenRaw === 'persona' ? 'persona' : null;

    if (!origen) {
      return {
        status: 400,
        body: buildErrorBody({
          code: 'VALIDATION_ERROR',
          message: 'origen debe ser "persona" o "empresa".'
        })
      };
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const { tenantId: resolvedTenantId, isSuperAdmin } = await resolveTenantContextForRequest(req, client);
      if (!resolvedTenantId && !isSuperAdmin) {
        const error = new Error('No se pudo resolver la empresa del usuario para crear el cliente.');
        error.httpStatus = 403;
        throw error;
      }
      const requestWithTenant = resolvedTenantId
        ? {
            ...req,
            user: {
              ...(req.user || {}),
              id_empresa: resolvedTenantId
            }
          }
        : req;

      let idPersona = parsePositiveInt(body.id_persona ?? clientePayload.id_persona);
      let idEmpresa = parsePositiveInt(
        body.id_empresa_cliente ?? clientePayload.id_empresa_cliente ?? body.id_empresa ?? clientePayload.id_empresa
      );
      let personaCreada = false;
      let empresaCreada = false;

      if (origen === 'empresa') {
        const empresaResult = await resolveOrCreateEmpresa({
          client,
          req: requestWithTenant,
          idEmpresa,
          empresaPayload: body.empresa,
          allowClientesContext: true
        });
        idEmpresa = empresaResult.idEmpresa;
        empresaCreada = empresaResult.created;
        idPersona = null;
      } else {
        const personaResult = await resolveOrCreatePersona({
          client,
          req: requestWithTenant,
          idPersona,
          personaPayload: body.persona,
          allowClientesContext: true
        });
        idPersona = personaResult.idPersona;
        personaCreada = personaResult.created;
        idEmpresa = null;
      }

      const userSucursalId = parsePositiveInt(req.user?.id_sucursal);

      const supportsEmpresaClienteInFn = await fnGuardarClienteSupportsEmpresaCliente(client);

      let normalizedCliente = normalizeClienteAtomicPayload({
        ...clientePayload,
        id_persona: idPersona,
        id_empresa_cliente: idEmpresa
      });
      const tenantId = resolvedTenantId;
      if (tenantId && supportsEmpresaClienteInFn && !isSuperAdmin) {
        normalizedCliente = {
          ...normalizedCliente,
          id_empresa: tenantId
        };
      }

      const sucursalValidation = validateAtomicSucursalInput(clientePayload);
      if (!sucursalValidation.ok) {
        const error = new Error('id_sucursal debe ser un entero positivo.');
        error.httpStatus = 400;
        throw error;
      }

      const payloadSucursalId = parsePositiveInt(normalizedCliente.id_sucursal);
      const effectiveSucursalId = payloadSucursalId || userSucursalId || null;
      if (!effectiveSucursalId) {
        const error = new Error('No se pudo resolver la sucursal del cliente. Selecciona una sucursal valida.');
        error.httpStatus = 400;
        throw error;
      }
      if (effectiveSucursalId) {
        normalizedCliente = {
          ...normalizedCliente,
          id_sucursal: effectiveSucursalId
        };
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'puntos')) {
        const rawPuntos = Number(clientePayload.puntos);
        if (!Number.isFinite(rawPuntos) || rawPuntos < 0) {
          const error = new Error('puntos debe ser un numero mayor o igual a 0');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'fecha_ingreso')) {
        const fechaIngreso = toTrimmedText(clientePayload.fecha_ingreso);
        if (fechaIngreso && (!isValidDateOnly(fechaIngreso) || isFutureDateOnly(fechaIngreso))) {
          const error = new Error('fecha_ingreso invalida');
          error.httpStatus = 400;
          throw error;
        }
      }

      if (Object.prototype.hasOwnProperty.call(clientePayload, 'estado')) {
        const parsedEstado = parseBooleanValue(clientePayload.estado);
        if (parsedEstado === null) {
          const error = new Error('estado de cliente debe ser booleano');
          error.httpStatus = 400;
          throw error;
        }
      }

      const empresaRelacionId = parsePositiveInt(normalizedCliente.id_empresa_cliente ?? idEmpresa);
      if ((normalizedCliente.id_persona ? 1 : 0) + (empresaRelacionId ? 1 : 0) !== 1) {
        const error = new Error('Cliente atomico requiere exactamente una relacion: persona o empresa');
        error.httpStatus = 400;
        throw error;
      }

      if (empresaRelacionId) {
        normalizedCliente.id_persona = null;
      }

      const reusableClienteId = await findReusableClienteAtomic(client, {
        idPersona: normalizedCliente.id_persona,
        idEmpresaCliente: empresaRelacionId
      });
      if (reusableClienteId) {
        if (empresaRelacionId) {
          await syncClienteEmpresaContext(
            client,
            reusableClienteId,
            empresaRelacionId,
            !isSuperAdmin ? tenantId : null
          );
        }
        const sucursalLinks = await linkClienteToSucursales({
          client,
          idCliente: reusableClienteId,
          effectiveSucursalId: normalizedCliente.id_sucursal
        });

        let clienteVinculado = null;
        try {
          clienteVinculado = await findClienteDetail(client, reusableClienteId);
        } catch (error) {
          console.warn('Clientes atomico: no se pudo cargar detalle post-vinculacion:', error?.message || error);
        }

        await client.query('COMMIT');
        return {
          status: 200,
          body: {
            ok: true,
            error: false,
            vinculado: true,
            message: 'Cliente existente vinculado a esta sucursal.',
            data: {
              ...buildAtomicSuccessData({
                entidadTipo: 'cliente',
                entidad: clienteVinculado,
                idPrincipal: reusableClienteId,
                idPersona: normalizedCliente.id_persona ?? null,
                idEmpresa: empresaRelacionId ?? null,
                personaCreada,
                empresaCreada
              }),
              id_cliente: reusableClienteId,
              id_sucursales_vinculadas: sucursalLinks,
              cliente: clienteVinculado
            }
          }
        };
      }

      const resolvedTipoClienteId = await resolveTipoClienteIdAtomic(client, normalizedCliente.id_tipo_cliente);
      if (!resolvedTipoClienteId) {
        const error = new Error('No existe un tipo de cliente disponible para crear el registro');
        error.httpStatus = 400;
        throw error;
      }
      normalizedCliente.id_tipo_cliente = resolvedTipoClienteId;

      const clienteFnPayload = { ...normalizedCliente };
      if (supportsEmpresaClienteInFn) {
        clienteFnPayload.id_empresa_cliente = empresaRelacionId;
      } else {
        delete clienteFnPayload.id_empresa_cliente;
        if (empresaRelacionId) clienteFnPayload.id_empresa = empresaRelacionId;
      }

      let createResult;
      try {
        createResult = await client.query('SELECT public.fn_guardar_cliente($1::json) AS id_cliente', [
          JSON.stringify(clienteFnPayload)
        ]);
      } catch (error) {
        // Compatibilidad en caliente: si la funcion sigue en contrato legacy, reintenta con id_empresa.
        if (supportsEmpresaClienteInFn && empresaRelacionId && isLegacyClienteRelationError(error)) {
          const legacyPayload = { ...clienteFnPayload, id_empresa: empresaRelacionId };
          delete legacyPayload.id_empresa_cliente;
          createResult = await client.query('SELECT public.fn_guardar_cliente($1::json) AS id_cliente', [
            JSON.stringify(legacyPayload)
          ]);
          fnGuardarClienteSupportsEmpresaClienteCache = false;
        } else {
          throw error;
        }
      }

      const idCliente = extractIdFromUnknown(createResult.rows?.[0]?.id_cliente, [
        'id_cliente',
        'id',
        'cliente_id'
      ]) || extractIdFromUnknown(createResult.rows?.[0]?.resultado, [
        'id_cliente',
        'id',
        'cliente_id'
      ]);
      if (!idCliente) {
        const error = new Error('No se pudo crear cliente en flujo atomico');
        error.httpStatus = 500;
        throw error;
      }

      if (empresaRelacionId) {
        await syncClienteEmpresaContext(
          client,
          idCliente,
          empresaRelacionId,
          !isSuperAdmin ? tenantId : null
        );
      }
      const sucursalLinks = await linkClienteToSucursales({
        client,
        idCliente,
        effectiveSucursalId: normalizedCliente.id_sucursal
      });

      let cliente = null;
      try {
        cliente = await findClienteDetail(client, idCliente);
      } catch (error) {
        console.warn('Clientes atomico: no se pudo cargar detalle post-creacion:', error?.message || error);
      }

      await client.query('COMMIT');

      return {
        status: 201,
        body: {
          ok: true,
          error: false,
          message: 'Cliente creado en flujo atomico',
          data: {
            ...buildAtomicSuccessData({
              entidadTipo: 'cliente',
              entidad: cliente,
              idPrincipal: idCliente,
              idPersona: normalizedCliente.id_persona ?? null,
              idEmpresa: empresaRelacionId ?? null,
              personaCreada,
              empresaCreada
            }),
            id_cliente: idCliente,
            id_sucursales_vinculadas: sucursalLinks,
            cliente
          }
        }
      };
    } catch (err) {
      await rollbackQuietly(client);
      throw err;
    } finally {
      client.release();
    }
  }
};

router.post('/empleados/atomico', checkPermission(EMPLEADOS_CREATE_PERMISSIONS), asyncHandler(atomicService.createEmpleado));
router.post('/clientes/atomico', checkPermission(CLIENTES_CREATE_PERMISSIONS), asyncHandler(atomicService.createCliente));

export default router;
