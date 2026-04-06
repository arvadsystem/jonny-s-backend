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
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
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
  const direct = parsePositiveInt(value);
  if (direct) return direct;

  const parsed = safeParseJson(value);
  const parsedDirect = parsePositiveInt(parsed);
  if (parsedDirect) return parsedDirect;

  if (!isPlainObject(parsed)) return null;

  for (const key of candidateKeys) {
    const candidate = parsePositiveInt(parsed[key]);
    if (candidate) return candidate;
  }

  if (isPlainObject(parsed.data)) {
    for (const key of candidateKeys) {
      const candidate = parsePositiveInt(parsed.data[key]);
      if (candidate) return candidate;
    }
  }

  return null;
};

const getPersonaTenantId = async (client, idPersona) => {
  try {
    const rs = await client.query('SELECT id_empresa FROM personas WHERE id_persona = $1 LIMIT 1', [idPersona]);
    return parsePositiveInt(rs.rows?.[0]?.id_empresa);
  } catch {
    return null;
  }
};

const getEmpresaTenantId = async (client, idEmpresa) => {
  try {
    const rs = await client.query('SELECT id_empresa FROM empresas WHERE id_empresa = $1 LIMIT 1', [idEmpresa]);
    return parsePositiveInt(rs.rows?.[0]?.id_empresa);
  } catch {
    return null;
  }
};

const validatePersonaPayload = (payload = {}) => {
  if (!isPlainObject(payload)) return 'Payload de persona invalido.';

  const unknownFields = unknownFieldsFromPayload(payload, PERSONA_ALLOWED_FIELDS);
  if (unknownFields.length) return `Campos no permitidos en persona: ${unknownFields.join(', ')}`;

  const nombre = toNullableTrimmed(payload.nombre);
  const apellido = toNullableTrimmed(payload.apellido);
  if (!nombre || !isSafeHumanName(nombre)) return 'nombre de persona no es valido.';
  if (!apellido || !isSafeHumanName(apellido)) return 'apellido de persona no es valido.';

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

export const normalizeEmpleadoAtomicPayload = (payload) => {
  if (!isPlainObject(payload)) return {};

  const normalized = {
    fecha_ingreso: toNullableTrimmed(payload.fecha_ingreso),
    salario_base: payload.salario_base,
    estado: payload.estado,
    id_sucursal: parsePositiveInt(payload.id_sucursal),
    id_persona: parsePositiveInt(payload.id_persona),
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
    fecha_ingreso: toNullableTrimmed(payload.fecha_ingreso),
    puntos: payload.puntos,
    id_tipo_cliente: parsePositiveInt(payload.id_tipo_cliente),
    id_persona: parsePositiveInt(payload.id_persona),
    id_empresa: parsePositiveInt(payload.id_empresa),
    id_sucursal: parsePositiveInt(payload.id_sucursal),
    estado: payload.estado
  };

  if (normalized.estado === null || normalized.estado === undefined) delete normalized.estado;
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== null && value !== undefined));
};

export const resolveOrCreatePersona = async ({ client, req, idPersona, personaPayload, allowClientesContext = false }) => {
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

  const validationError = validatePersonaPayload(personaPayload);
  if (validationError) {
    const error = new Error(validationError);
    error.httpStatus = 400;
    throw error;
  }

  const normalizedPersona = normalizePersonaPayload(personaPayload);
  if (!Object.keys(normalizedPersona).length) {
    const error = new Error('Debe seleccionar una persona existente o completar datos de persona nueva');
    error.httpStatus = 400;
    throw error;
  }

  if (!normalizedPersona.nombre || !normalizedPersona.apellido) {
    const error = new Error('Persona nueva requiere nombre y apellido');
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

  const createResult = await client.query('SELECT fn_guardar_persona($1::json) AS resultado', [
    JSON.stringify(normalizedPersona)
  ]);

  const idPersonaCreada = extractIdFromUnknown(createResult.rows?.[0]?.resultado, [
    'id_persona',
    'id',
    'persona_id'
  ]);

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

  const idEmpresaCreada = parsePositiveInt(createResult.rows?.[0]?.id_empresa);
  if (!idEmpresaCreada) {
    const error = new Error('No se pudo obtener id_empresa de la creacion atomica');
    error.httpStatus = 500;
    throw error;
  }

  return { idEmpresa: idEmpresaCreada, created: true };
};

