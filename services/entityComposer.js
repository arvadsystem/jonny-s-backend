import { requestHasAnyPermission } from '../middleware/checkPermission.js';

import {
  unknownFieldsFromPayload,
  isSafeDni,
  isSafeEmail,
  isSafePhoneHN,
  isSafeHumanName,
  isValidDateOnly,
  isFutureDateOnly
} from '../utils/security/personasHardening.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const ENTITY_COMPOSER_SCHEMA_CACHE_TTL_MS = 60_000;
let personasTenantColumnCache = null;
let personasTenantColumnCheckedAt = 0;
const PERSONA_ALLOWED_FIELDS = new Set([
  'id_persona',
  'nombre',
  'apellido',
  'fecha_nacimiento',
  'genero',
  'dni',
  'rtn',
  'texto_direccion',
  'texto_telefono',
  'texto_correo',
  'direccion',
  'telefono',
  'correo',
  'email',
  'direccion_correo',
  'id_empresa'
]);
const EMPRESA_ALLOWED_FIELDS = new Set([
  'id_empresa',
  'rtn',
  'nombre_empresa',
  'nombre',
  'estado',
  'texto_direccion',
  'texto_telefono',
  'texto_correo',
  'direccion',
  'telefono',
  'correo',
  'email',
  'direccion_correo'
]);

const toNullableTrimmed = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
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

const safeParseJson = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
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
    'id_persona',
    'persona_id',
    'id_persona_creada',
    'id_empresa',
    'empresa_id',
    'id_empresa_creada',
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

    if (!isPlainObject(node)) return null;
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

const hasPersonasTenantColumn = async (client, { forceRefresh = false } = {}) => {
  const now = Date.now();
  const shouldRefresh = forceRefresh
    || !personasTenantColumnCheckedAt
    || (now - personasTenantColumnCheckedAt) > ENTITY_COMPOSER_SCHEMA_CACHE_TTL_MS;

  if (!shouldRefresh && personasTenantColumnCache !== null) {
    return personasTenantColumnCache;
  }

  personasTenantColumnCheckedAt = now;
  const rs = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'personas'
        AND column_name = 'id_empresa'
      LIMIT 1
    `
  );
  personasTenantColumnCache = Boolean(rs.rows?.length);
  return personasTenantColumnCache;
};

const getPersonaTenantId = async (client, idPersona) => {
  const hasTenantColumn = await hasPersonasTenantColumn(client);
  if (!hasTenantColumn) {
    return null;
  }
  const rs = await client.query('SELECT id_empresa FROM personas WHERE id_persona = $1 LIMIT 1', [idPersona]);
  return parsePositiveInt(rs.rows?.[0]?.id_empresa);
};

const getEmpresaTenantId = async (client, idEmpresa) => {
  const rs = await client.query('SELECT id_empresa FROM empresas WHERE id_empresa = $1 LIMIT 1', [idEmpresa]);
  return parsePositiveInt(rs.rows?.[0]?.id_empresa);
};

const validatePersonaPayload = (payload = {}, { allowOptionalLastName = false } = {}) => {
  if (!isPlainObject(payload)) return 'Payload de persona invalido.';

  const unknownFields = unknownFieldsFromPayload(payload, PERSONA_ALLOWED_FIELDS);
  if (unknownFields.length) return `Campos no permitidos en persona: ${unknownFields.join(', ')}`;

  const nombre = toNullableTrimmed(payload.nombre);
  const apellido = toNullableTrimmed(payload.apellido);
  if (!nombre || !isSafeHumanName(nombre)) return 'nombre de persona no es valido.';
  if ((!allowOptionalLastName && !apellido) || (apellido && !isSafeHumanName(apellido))) {
    return 'apellido de persona no es valido.';
  }

  const dni = toNullableTrimmed(payload.dni);
  if (dni && !isSafeDni(dni)) return 'dni de persona no es valido.';

  const telefono = toNullableTrimmed(payload.texto_telefono ?? payload.telefono);
  if (telefono && !isSafePhoneHN(telefono)) return 'telefono de persona debe tener formato ####-####.';

  const correo = toNullableTrimmed(payload.texto_correo ?? payload.correo ?? payload.email ?? payload.direccion_correo);
  if (correo && !isSafeEmail(correo)) return 'correo de persona no es valido.';

  const fechaNacimiento = toNullableTrimmed(payload.fecha_nacimiento);
  if (fechaNacimiento && (!isValidDateOnly(fechaNacimiento) || isFutureDateOnly(fechaNacimiento))) {
    return 'fecha_nacimiento de persona no es valida.';
  }

  return null;
};

const validateEmpresaPayload = (payload = {}) => {
  if (!isPlainObject(payload)) return 'Payload de empresa invalido.';

  const unknownFields = unknownFieldsFromPayload(payload, EMPRESA_ALLOWED_FIELDS);
  if (unknownFields.length) return `Campos no permitidos en empresa: ${unknownFields.join(', ')}`;

  const nombreEmpresa = toNullableTrimmed(payload.nombre_empresa ?? payload.nombre);
  if (!nombreEmpresa) return 'nombre_empresa es obligatorio.';

  const telefono = toNullableTrimmed(payload.texto_telefono ?? payload.telefono);
  if (telefono && !isSafePhoneHN(telefono)) return 'telefono de empresa debe tener formato ####-####.';

  const correo = toNullableTrimmed(payload.texto_correo ?? payload.correo ?? payload.email ?? payload.direccion_correo);
  if (correo && !isSafeEmail(correo)) return 'correo de empresa no es valido.';

  if (Object.prototype.hasOwnProperty.call(payload, 'estado')) {
    const estado = parseBooleanValue(payload.estado);
    if (estado === null) return 'estado de empresa debe ser booleano.';
  }

  return null;
};

const normalizePersonaPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {
    nombre: toNullableTrimmed(payload.nombre),
    apellido: toNullableTrimmed(payload.apellido),
    fecha_nacimiento: toNullableTrimmed(payload.fecha_nacimiento),
    genero: toNullableTrimmed(payload.genero),
    dni: toNullableTrimmed(payload.dni),
    rtn: toNullableTrimmed(payload.rtn),
    texto_direccion: toNullableTrimmed(payload.texto_direccion ?? payload.direccion),
    texto_telefono: toNullableTrimmed(payload.texto_telefono ?? payload.telefono),
    texto_correo: toNullableTrimmed(
      payload.texto_correo ?? payload.correo ?? payload.email ?? payload.direccion_correo
    ),
    id_empresa: parsePositiveInt(payload.id_empresa)
  };

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null));
};

const normalizeEmpresaPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {
    rtn: toNullableTrimmed(payload.rtn),
    nombre_empresa: toNullableTrimmed(payload.nombre_empresa ?? payload.nombre),
    texto_direccion: toNullableTrimmed(payload.texto_direccion ?? payload.direccion),
    texto_telefono: toNullableTrimmed(payload.texto_telefono ?? payload.telefono),
    texto_correo: toNullableTrimmed(
      payload.texto_correo ?? payload.correo ?? payload.email ?? payload.direccion_correo
    )
  };

  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null));
};

const CONTACT_LOOKUPS = Object.freeze({
  direccion: { table: 'direcciones', idColumn: 'id_direccion', valueColumn: 'direccion' },
  telefono: { table: 'telefonos', idColumn: 'id_telefono', valueColumn: 'telefono' },
  correo: { table: 'correos', idColumn: 'id_correo', valueColumn: 'direccion_correo' }
});

const resolveOrCreateContactLookup = async (client, lookupKey, value) => {
  const text = toNullableTrimmed(value);
  if (!text) return null;
  const lookup = CONTACT_LOOKUPS[lookupKey];
  if (!lookup) throw new Error('Catalogo de contacto no soportado');
  const inserted = await client.query(
    `INSERT INTO public.${lookup.table} (${lookup.valueColumn})
     VALUES ($1)
     ON CONFLICT DO NOTHING
     RETURNING ${lookup.idColumn}`,
    [text]
  );
  const insertedId = parsePositiveInt(inserted.rows?.[0]?.[lookup.idColumn]);
  if (insertedId) return insertedId;
  const existing = await client.query(
    `SELECT ${lookup.idColumn}
     FROM public.${lookup.table}
     WHERE ${lookup.valueColumn} = $1
     ORDER BY ${lookup.idColumn} ASC
     LIMIT 1`,
    [text]
  );
  return parsePositiveInt(existing.rows?.[0]?.[lookup.idColumn]);
};

const createPersonaWithEmptyLastName = async (client, normalizedPersona) => {
  const idDireccion = await resolveOrCreateContactLookup(client, 'direccion', normalizedPersona.texto_direccion);
  const idTelefono = await resolveOrCreateContactLookup(client, 'telefono', normalizedPersona.texto_telefono);
  const idCorreo = await resolveOrCreateContactLookup(client, 'correo', normalizedPersona.texto_correo);
  const hasTenantColumn = await hasPersonasTenantColumn(client);
  const columns = [
    'nombre', 'apellido', 'fecha_nacimiento', 'genero', 'dni', 'rtn',
    'id_direccion', 'id_telefono', 'id_correo'
  ];
  const values = [
    normalizedPersona.nombre,
    '',
    normalizedPersona.fecha_nacimiento || null,
    normalizedPersona.genero || null,
    normalizedPersona.dni || null,
    normalizedPersona.rtn || null,
    idDireccion,
    idTelefono,
    idCorreo
  ];
  if (hasTenantColumn) {
    columns.push('id_empresa');
    values.push(parsePositiveInt(normalizedPersona.id_empresa));
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const result = await client.query(
    `INSERT INTO public.personas (${columns.join(', ')})
     VALUES (${placeholders})
     RETURNING id_persona`,
    values
  );
  return parsePositiveInt(result.rows?.[0]?.id_persona);
};

export const normalizeEmpleadoAtomicPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {
    fecha_ingreso: toNullableTrimmed(payload.fecha_ingreso),
    salario_base: payload.salario_base,
    estado: payload.estado,
    id_sucursal: parsePositiveInt(payload.id_sucursal),
    id_persona: parsePositiveInt(payload.id_persona),
    id_cargo: parsePositiveInt(payload.id_cargo),
    cargo: toNullableTrimmed(payload.cargo),
    nombre_referencia: toNullableTrimmed(payload.nombre_referencia),
    telefono_referencia: toNullableTrimmed(payload.telefono_referencia)
  };

  if (normalized.estado === null || normalized.estado === undefined) delete normalized.estado;
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== undefined));
};

export const normalizeClienteAtomicPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {
    id_persona: parsePositiveInt(payload.id_persona),
    id_empresa_cliente: parsePositiveInt(payload.id_empresa_cliente ?? payload.id_empresa),
    id_empresa: parsePositiveInt(payload.id_empresa),
    id_sucursal: parsePositiveInt(payload.id_sucursal),
    estado: payload.estado
  };

  if (normalized.estado === null || normalized.estado === undefined) delete normalized.estado;
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== undefined));
};

export const resolveOrCreatePersona = async ({
  client,
  req,
  idPersona,
  personaPayload,
  allowClientesContext = false,
  allowOptionalLastName = false
}) => {
  const tenantId = parsePositiveInt(req?.user?.id_empresa);
  const explicitId = parsePositiveInt(idPersona);
  if (explicitId) {
    const exists = await client.query('SELECT 1 FROM personas WHERE id_persona = $1 LIMIT 1', [explicitId]);
    if (!exists.rows.length) {
      const error = new Error(`La persona ${explicitId} no existe`);
      error.httpStatus = 404;
      throw error;
    }
    if (tenantId) {
      const personaTenant = await getPersonaTenantId(client, explicitId);
      if (personaTenant && personaTenant !== tenantId) {
        const error = new Error('No puede usar una persona de otra empresa');
        error.httpStatus = 403;
        throw error;
      }
    }
    return { idPersona: explicitId, created: false };
  }

  const validationError = validatePersonaPayload(personaPayload, { allowOptionalLastName });
  if (validationError) {
    const error = new Error(validationError);
    error.httpStatus = 400;
    throw error;
  }

  const normalizedPersona = normalizePersonaPayload(personaPayload);
  if (allowOptionalLastName && !normalizedPersona.apellido) normalizedPersona.apellido = '';
  if (!Object.keys(normalizedPersona).length) {
    const error = new Error('Debe seleccionar una persona existente o completar datos de persona nueva');
    error.httpStatus = 400;
    throw error;
  }

  if (!normalizedPersona.nombre || (!allowOptionalLastName && !normalizedPersona.apellido)) {
    const error = new Error(allowOptionalLastName
      ? 'Persona nueva requiere nombre'
      : 'Persona nueva requiere nombre y apellido');
    error.httpStatus = 400;
    throw error;
  }

  const canCreatePersona = await requestHasAnyPermission(req, ['PERSONAS_CREAR']);
  const canCreatePersonaFromClientes = allowClientesContext
    ? await requestHasAnyPermission(req, ['PERSONAS_CREAR_DESDE_CLIENTES'])
    : false;

  if (!canCreatePersona && !canCreatePersonaFromClientes) {
    const error = new Error('No tiene permiso para crear persona en flujo atomico');
    error.httpStatus = 403;
    throw error;
  }

  if (tenantId) {
    const requestedTenant = parsePositiveInt(normalizedPersona.id_empresa);
    if (requestedTenant && requestedTenant !== tenantId) {
      const error = new Error('No puede crear personas para otra empresa');
      error.httpStatus = 403;
      throw error;
    }
    if (!requestedTenant) normalizedPersona.id_empresa = tenantId;
  }

  let idPersonaCreada = null;
  if (allowOptionalLastName && normalizedPersona.apellido === '') {
    idPersonaCreada = await createPersonaWithEmptyLastName(client, normalizedPersona);
  } else {
    const createResult = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
      JSON.stringify(normalizedPersona)
    ]);
    idPersonaCreada = extractIdFromUnknown(createResult.rows?.[0]?.resultado, [
      'id_persona',
      'id',
      'persona_id'
    ]);
  }

  if (!idPersonaCreada && normalizedPersona.dni) {
    const fallbackByDni = await client.query(
      `
        SELECT p.id_persona
        FROM public.personas p
        WHERE LOWER(TRIM(COALESCE(p.dni::TEXT, ''))) = LOWER(TRIM($1::TEXT))
        ORDER BY p.id_persona DESC
        LIMIT 1
      `,
      [normalizedPersona.dni]
    );
    idPersonaCreada = parsePositiveInt(fallbackByDni.rows?.[0]?.id_persona);
  }
  if (!idPersonaCreada && normalizedPersona.nombre && normalizedPersona.apellido) {
    const fallbackByName = await client.query(
      `
        SELECT p.id_persona
        FROM public.personas p
        WHERE LOWER(TRIM(COALESCE(p.nombre, ''))) = LOWER(TRIM($1::TEXT))
          AND LOWER(TRIM(COALESCE(p.apellido, ''))) = LOWER(TRIM($2::TEXT))
        ORDER BY p.id_persona DESC
        LIMIT 1
      `,
      [normalizedPersona.nombre, normalizedPersona.apellido]
    );
    idPersonaCreada = parsePositiveInt(fallbackByName.rows?.[0]?.id_persona);
  }

  if (!idPersonaCreada) {
    const error = new Error('No se pudo obtener id_persona de la creacion atomica');
    error.httpStatus = 500;
    throw error;
  }

  return { idPersona: idPersonaCreada, created: true };
};

export const resolveOrCreateEmpresa = async ({ client, req, idEmpresa, empresaPayload, allowClientesContext = false }) => {
  const tenantId = parsePositiveInt(req?.user?.id_empresa);
  const explicitId = parsePositiveInt(idEmpresa);
  if (explicitId) {
    const exists = await client.query('SELECT 1 FROM empresas WHERE id_empresa = $1 LIMIT 1', [explicitId]);
    if (!exists.rows.length) {
      const error = new Error(`La empresa ${explicitId} no existe`);
      error.httpStatus = 404;
      throw error;
    }
    if (tenantId) {
      const empresaTenant = await getEmpresaTenantId(client, explicitId);
      if (empresaTenant && empresaTenant !== tenantId) {
        const error = new Error('No puede usar una empresa de otra empresa');
        error.httpStatus = 403;
        throw error;
      }
    }
    return { idEmpresa: explicitId, created: false };
  }

  const validationError = validateEmpresaPayload(empresaPayload);
  if (validationError) {
    const error = new Error(validationError);
    error.httpStatus = 400;
    throw error;
  }

  const normalizedEmpresa = normalizeEmpresaPayload(empresaPayload);
  if (!Object.keys(normalizedEmpresa).length) {
    const error = new Error('Debe seleccionar una empresa existente o completar datos de empresa nueva');
    error.httpStatus = 400;
    throw error;
  }

  if (!normalizedEmpresa.nombre_empresa) {
    const error = new Error('Empresa nueva requiere nombre_empresa');
    error.httpStatus = 400;
    throw error;
  }

  const canCreateEmpresa = await requestHasAnyPermission(req, ['EMPRESAS_CREAR']);
  const canCreateEmpresaFromClientes = allowClientesContext
    ? await requestHasAnyPermission(req, ['EMPRESAS_CREAR_DESDE_CLIENTES'])
    : false;

  if (!canCreateEmpresa && !canCreateEmpresaFromClientes) {
    const error = new Error('No tiene permiso para crear empresa en flujo atomico');
    error.httpStatus = 403;
    throw error;
  }

  const createResult = await client.query('SELECT fn_guardar_empresa($1::json) AS id_empresa', [
    JSON.stringify(normalizedEmpresa)
  ]);

  let idEmpresaCreada = extractIdFromUnknown(createResult.rows?.[0]?.id_empresa, [
    'id_empresa',
    'id',
    'empresa_id'
  ]);
  if (!idEmpresaCreada) {
    idEmpresaCreada = extractIdFromUnknown(createResult.rows?.[0]?.resultado, [
      'id_empresa',
      'id',
      'empresa_id'
    ]);
  }
  if (!idEmpresaCreada && normalizedEmpresa.rtn) {
    const fallbackByRtn = await client.query(
      `
        SELECT e.id_empresa
        FROM public.empresas e
        WHERE LOWER(TRIM(COALESCE(e.rtn::TEXT, ''))) = LOWER(TRIM($1::TEXT))
        ORDER BY e.id_empresa DESC
        LIMIT 1
      `,
      [normalizedEmpresa.rtn]
    );
    idEmpresaCreada = parsePositiveInt(fallbackByRtn.rows?.[0]?.id_empresa);
  }
  if (!idEmpresaCreada && normalizedEmpresa.nombre_empresa) {
    const fallbackByName = await client.query(
      `
        SELECT e.id_empresa
        FROM public.empresas e
        WHERE LOWER(TRIM(COALESCE(e.nombre_empresa, ''))) = LOWER(TRIM($1::TEXT))
        ORDER BY e.id_empresa DESC
        LIMIT 1
      `,
      [normalizedEmpresa.nombre_empresa]
    );
    idEmpresaCreada = parsePositiveInt(fallbackByName.rows?.[0]?.id_empresa);
  }
  if (!idEmpresaCreada) {
    const error = new Error('No se pudo obtener id_empresa de la creacion atomica');
    error.httpStatus = 500;
    throw error;
  }

  return { idEmpresa: idEmpresaCreada, created: true };
};

