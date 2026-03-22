import pool from '../../config/db-connection.js';
import {
  insertSecurityAuditLog,
  sanitizeAuditPayload
} from './auditLogger.js';

const METHOD_VERB_DEFAULT = {
  POST: 'CREAR',
  PUT: 'ACTUALIZAR',
  PATCH: 'ACTUALIZAR',
  DELETE: 'ELIMINAR'
};

const INTENT_LABEL = {
  CREAR: 'Creo',
  ACTUALIZAR: 'Actualizo',
  INACTIVAR: 'Inactivo',
  ACTIVAR: 'Activo',
  ELIMINAR: 'Elimino'
};

const MUTATING_METHODS = new Set(Object.keys(METHOD_VERB_DEFAULT));

const MODULES_WITH_NATIVE_AUDIT = new Set([
  'PERSONAS',
  'EMPRESAS',
  'CLIENTES',
  'EMPLEADOS',
  'SEGURIDAD'
]);

const KNOWN_SOFT_DELETE_MODULES = new Set([
  'PRODUCTOS',
  'INSUMOS',
  'CATEGORIAS_PRODUCTOS',
  'CATEGORIAS_INSUMOS'
]);

const GENERIC_FIELDS = new Set([
  'id',
  'created_by',
  'updated_by',
  'campo',
  'valor',
  'id_campo',
  'id_valor',
  'columna_id',
  'valor_id',
  '_ts'
]);

const NON_BUSINESS_DIFF_FIELDS = new Set([
  'updated_at',
  'updated_on',
  'updated_by',
  'created_at',
  'created_on',
  'fecha_modificacion',
  'fecha_actualizacion',
  'ultima_actualizacion',
  'last_update',
  'modificado_en'
]);

const ENTITY_NAME_FIELDS = [
  'nombre',
  'nombre_producto',
  'nombre_insumo',
  'nombre_categoria',
  'nombre_empresa',
  'nombre_usuario',
  'descripcion',
  'titulo'
];

const parsePositiveInt = (value) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const parseBooleanLike = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;

  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['true', '1', 't', 'si', 'yes', 'y', 'activo', 'activa'].includes(s)) return true;
  if (['false', '0', 'f', 'no', 'n', 'inactivo', 'inactiva'].includes(s)) return false;
  return null;
};

const normalizeToken = (value, { max = 60, fallback = 'N_D' } = {}) => {
  const normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toUpperCase();

  const safe = normalized || fallback;
  return safe.length > max ? safe.slice(0, max) : safe;
};

const truncate = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
};

const normalizeDbIdentifier = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

const normalizeFieldName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();

const cleanPath = (urlValue) => String(urlValue ?? '').split('?')[0];

const getPathSegments = (req) =>
  cleanPath(req?.originalUrl || req?.url || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

const isSafeIdentifier = (value) => /^[a-z_][a-z0-9_]*$/i.test(String(value ?? ''));

const singularize = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'registro';
  if (text.endsWith('es') && text.length > 4) return text.slice(0, -2);
  if (text.endsWith('s') && text.length > 3) return text.slice(0, -1);
  return text;
};

const valuesDiffer = (left, right) => {
  const normalize = (value) => {
    if (value === undefined) return '__undefined__';
    if (value === null) return '__null__';
    if (typeof value === 'string') return value.trim();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  return normalize(left) !== normalize(right);
};

const getBodyObject = (req) => {
  const body = sanitizeAuditPayload(req?.body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
};

const getMeaningfulBodyEntries = (body) =>
  Object.entries(body || {}).filter(([key, value]) => {
    if (value === undefined) return false;
    const normalized = normalizeFieldName(key);
    if (!normalized) return false;
    if (GENERIC_FIELDS.has(normalized)) return false;
    if (normalized === 'csrf_token' || normalized === 'token' || normalized === 'password') return false;
    if (/^id(_|$)/i.test(normalized)) return false;
    return true;
  });

const inferContext = (req) => {
  const segments = getPathSegments(req);
  if (!segments.length) {
    return {
      modulo: 'SISTEMA',
      tablaAfectada: 'SISTEMA',
      moduloRaw: 'sistema',
      tablaRaw: 'sistema'
    };
  }

  if (segments[0].toLowerCase() === 'api') {
    const moduloRaw = String(segments[1] || 'api').trim();
    const modulo = normalizeToken(moduloRaw || 'API', { max: 60, fallback: 'API' });
    const candidate = String(segments[2] || '').trim();
    const tableSource = candidate && !/^\d+$/.test(candidate) ? candidate : (segments[1] || 'API');
    const tablaAfectada = normalizeToken(tableSource, { max: 60, fallback: 'API' });
    return {
      modulo,
      tablaAfectada,
      moduloRaw,
      tablaRaw: String(tableSource).trim()
    };
  }

  const moduloRaw = String(segments[0] || 'sistema').trim();
  const modulo = normalizeToken(moduloRaw, { max: 60, fallback: 'SISTEMA' });
  const candidate = String(segments[1] || '').trim();
  const tableSource = candidate && !/^\d+$/.test(candidate) ? candidate : (segments[0] || 'SISTEMA');
  const tablaAfectada = normalizeToken(tableSource, { max: 60, fallback: modulo });
  return {
    modulo,
    tablaAfectada,
    moduloRaw,
    tablaRaw: String(tableSource).trim()
  };
};

const searchIdInObject = (obj) => {
  if (!obj || typeof obj !== 'object') return null;

  const entries = Object.entries(obj);
  for (const [key, value] of entries) {
    const normalized = normalizeFieldName(key);
    if (normalized === 'id' || /^id(_|$)/i.test(normalized) || /(_id)$/i.test(normalized)) {
      const parsed = parsePositiveInt(value);
      if (parsed) return parsed;
    }
  }

  return null;
};

const inferRegistroId = (req, responsePayload = null) => {
  const body = getBodyObject(req);
  const fromBody = parsePositiveInt(body.id_valor) || parsePositiveInt(body.valor_id) || searchIdInObject(body);
  if (fromBody) return fromBody;

  const paramValues = Object.values(req?.params || {});
  for (const value of paramValues) {
    const id = parsePositiveInt(value);
    if (id) return id;
  }

  const fromQuery = searchIdInObject(req?.query || {});
  if (fromQuery) return fromQuery;

  if (responsePayload && typeof responsePayload === 'object') {
    const fromResponse = searchIdInObject(responsePayload)
      || searchIdInObject(responsePayload.data)
      || searchIdInObject(responsePayload.resultado);
    if (fromResponse) return fromResponse;
  }

  return 0;
};

const inferIdColumn = (req, dbTableName) => {
  const body = getBodyObject(req);
  const bodyKey = String(body.id_campo || body.columna_id || '').trim();
  if (bodyKey && isSafeIdentifier(bodyKey)) return bodyKey.toLowerCase();

  const paramKey = Object.keys(req?.params || {}).find((k) => /^id(_|$)/i.test(k) && isSafeIdentifier(k));
  if (paramKey) return paramKey.toLowerCase();

  const fallback = `id_${singularize(dbTableName)}`;
  return isSafeIdentifier(fallback) ? fallback : 'id';
};

const deriveExplicitChanges = (req) => {
  const method = String(req?.method || '').toUpperCase();
  const body = getBodyObject(req);

  if (method === 'PUT' || method === 'PATCH') {
    if (typeof body.campo === 'string' && Object.prototype.hasOwnProperty.call(body, 'valor')) {
      const field = normalizeFieldName(body.campo);
      return field ? { [field]: body.valor } : {};
    }

    if (typeof body.columna === 'string' && Object.prototype.hasOwnProperty.call(body, 'valor')) {
      const field = normalizeFieldName(body.columna);
      return field ? { [field]: body.valor } : {};
    }
  }

  if (method === 'DELETE') {
    if (typeof body.columna_id === 'string' && Object.prototype.hasOwnProperty.call(body, 'valor_id')) {
      const field = normalizeFieldName(body.columna_id);
      return field ? { [field]: body.valor_id } : {};
    }
  }

  const meaningfulEntries = getMeaningfulBodyEntries(body).slice(0, 8);
  return Object.fromEntries(meaningfulEntries);
};

const pickRowValue = (row, field) => {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, field)) return row[field];

  const normalized = normalizeFieldName(field);
  const pair = Object.entries(row).find(([key]) => normalizeFieldName(key) === normalized);
  return pair ? pair[1] : undefined;
};

const extractEntityName = (row, fallbackChanges = {}) => {
  if (row && typeof row === 'object') {
    for (const field of ENTITY_NAME_FIELDS) {
      const value = pickRowValue(row, field);
      const text = String(value ?? '').trim();
      if (text) return text;
    }
  }

  for (const [field, value] of Object.entries(fallbackChanges || {})) {
    if (!/^nombre/.test(normalizeFieldName(field))) continue;
    const text = String(value ?? '').trim();
    if (text) return text;
  }

  return '';
};

const deriveRowDiff = (beforeRow, afterRow) => {
  if (!beforeRow || !afterRow) return [];

  const keys = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)]);
  const changes = [];

  for (const key of keys) {
    const normalized = normalizeFieldName(key);
    if (!normalized) continue;
    if (GENERIC_FIELDS.has(normalized)) continue;
    if (NON_BUSINESS_DIFF_FIELDS.has(normalized)) continue;
    if (/^id(_|$)/i.test(normalized)) continue;
    if (normalized === 'csrf_token' || normalized === 'token' || normalized === 'password') continue;

    const beforeValue = pickRowValue(beforeRow, key);
    const afterValue = pickRowValue(afterRow, key);
    if (!valuesDiffer(beforeValue, afterValue)) continue;

    changes.push({
      field: normalized,
      before: beforeValue,
      after: afterValue
    });
  }

  return changes.slice(0, 8);
};

const fetchRowSnapshot = async ({ dbTableName, idColumn, idValue }) => {
  if (!dbTableName || !idColumn || !idValue) return null;
  if (!isSafeIdentifier(dbTableName) || !isSafeIdentifier(idColumn)) return null;

  try {
    const sql = `
      SELECT *
      FROM "${dbTableName}"
      WHERE "${idColumn}" = $1
      LIMIT 1
    `;
    const result = await pool.query(sql, [idValue]);
    return result.rows?.[0] || null;
  } catch {
    return null;
  }
};

const buildMutationPayload = ({
  method,
  explicitCambios,
  beforeRow,
  afterRow,
  rawBody
}) => {
  const before = {};
  const after = {};

  for (const [field, requestedValue] of Object.entries(explicitCambios || {})) {
    const normalized = normalizeFieldName(field);
    if (!normalized) continue;

    const beforeValue = pickRowValue(beforeRow, normalized);
    const fromAfterRow = pickRowValue(afterRow, normalized);
    const resolvedAfter = fromAfterRow !== undefined ? fromAfterRow : requestedValue;

    if (method !== 'POST' && !valuesDiffer(beforeValue, resolvedAfter)) continue;
    if (beforeValue !== undefined) before[normalized] = beforeValue;
    if (resolvedAfter !== undefined) after[normalized] = resolvedAfter;
  }

  if (!Object.keys(after).length) {
    const diffRows = deriveRowDiff(beforeRow, afterRow);
    for (const change of diffRows) {
      const field = normalizeFieldName(change.field);
      if (!field) continue;
      if (change.before !== undefined) before[field] = change.before;
      if (change.after !== undefined) after[field] = change.after;
    }
  }

  if (!Object.keys(after).length && Object.keys(explicitCambios || {}).length) {
    for (const [field, value] of Object.entries(explicitCambios || {})) {
      const normalized = normalizeFieldName(field);
      if (!normalized) continue;
      if (value !== undefined) after[normalized] = value;
    }
  }

  if (method === 'POST' && !Object.keys(after).length) {
    const bodyEntries = getMeaningfulBodyEntries(rawBody).slice(0, 8);
    for (const [field, value] of bodyEntries) {
      const normalized = normalizeFieldName(field);
      if (!normalized) continue;
      after[normalized] = value;
    }
  }

  return {
    campos: Object.keys(after),
    before,
    after
  };
};

const inferBusinessIntent = ({
  method,
  modulo,
  mutation,
  beforeRow,
  afterRow,
  rawBody,
  responsePayload
}) => {
  if (method === 'POST') return 'CREAR';

  const fieldEstadoBody = normalizeFieldName(rawBody?.campo) === 'estado'
    ? parseBooleanLike(rawBody?.valor)
    : null;

  const beforeEstado = parseBooleanLike(
    mutation.before?.estado
    ?? pickRowValue(beforeRow, 'estado')
  );

  const afterEstado = parseBooleanLike(
    mutation.after?.estado
    ?? pickRowValue(afterRow, 'estado')
    ?? fieldEstadoBody
  );

  const hasEstado = Object.prototype.hasOwnProperty.call(mutation.before || {}, 'estado')
    || Object.prototype.hasOwnProperty.call(mutation.after || {}, 'estado')
    || fieldEstadoBody !== null
    || pickRowValue(beforeRow, 'estado') !== undefined
    || pickRowValue(afterRow, 'estado') !== undefined;

  const responseMessage = String(
    responsePayload?.message
    || responsePayload?.mensaje
    || ''
  ).toLowerCase();

  if (method === 'DELETE') {
    if (afterEstado === false) return 'INACTIVAR';
    if (responseMessage.includes('inactiv')) return 'INACTIVAR';
    if (KNOWN_SOFT_DELETE_MODULES.has(modulo)) return 'INACTIVAR';
    return 'ELIMINAR';
  }

  if (method === 'PUT' || method === 'PATCH') {
    if (hasEstado && afterEstado !== null && beforeEstado !== afterEstado) {
      return afterEstado ? 'ACTIVAR' : 'INACTIVAR';
    }
    return 'ACTUALIZAR';
  }

  return METHOD_VERB_DEFAULT[method] || 'EJECUTAR';
};

const buildAction = ({ modulo, tablaAfectada, intent }) => {
  const action = `${modulo}_${intent}_${tablaAfectada}`;
  return normalizeToken(action, { max: 50, fallback: 'SISTEMA_EJECUTAR_ACCION' });
};

const buildDescription = ({
  intent,
  tablaAfectada,
  idRegistro,
  campos,
  entityName
}) => {
  const verb = INTENT_LABEL[intent] || 'Realizo';
  const entidad = singularize(String(tablaAfectada || 'registro').toLowerCase()).replace(/_/g, ' ');
  const target = entityName
    ? `${entidad} "${entityName}"`
    : (idRegistro > 0 ? `${entidad} #${idRegistro}` : entidad);

  const includeFields = intent === 'ACTUALIZAR' && campos.length;
  const fieldsPart = includeFields
    ? `${campos.length === 1 ? campos[0] : campos.join(', ')} de `
    : '';

  return truncate(`${verb} ${fieldsPart}${target}`, 100);
};

const shouldAudit = (req) => {
  const method = String(req?.method || '').toUpperCase();
  if (!MUTATING_METHODS.has(method)) return false;

  const path = cleanPath(req?.originalUrl || req?.url || '').toLowerCase();
  if (path.startsWith('/status')) return false;
  return true;
};

const tryParseJsonString = (value) => {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const attachResponsePayloadCapture = (res) => {
  if (res.__auditResponseCaptureAttached) return;
  res.__auditResponseCaptureAttached = true;

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    res.__auditResponsePayload = sanitizeAuditPayload(body);
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (res.__auditResponsePayload === undefined) {
      const parsed = tryParseJsonString(body);
      if (parsed && typeof parsed === 'object') {
        res.__auditResponsePayload = sanitizeAuditPayload(parsed);
      }
    }
    return originalSend(body);
  };
};

const buildContext = async (req) => {
  const rawBody = getBodyObject(req);
  const method = String(req?.method || '').toUpperCase();
  const context = inferContext(req);

  context.rawBody = rawBody;
  context.method = method;
  context.explicitCambios = deriveExplicitChanges(req);
  context.idRegistro = inferRegistroId(req);
  context.dbTableName = normalizeDbIdentifier(context.tablaRaw || context.tablaAfectada);
  context.idColumn = inferIdColumn(req, context.dbTableName || context.moduloRaw || context.modulo);
  context.beforeRow = null;

  const shouldSkipNativeModule = MODULES_WITH_NATIVE_AUDIT.has(context.modulo);
  const shouldCaptureBefore = !shouldSkipNativeModule
    && (method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    && context.idRegistro > 0;

  if (shouldCaptureBefore) {
    context.beforeRow = await fetchRowSnapshot({
      dbTableName: context.dbTableName,
      idColumn: context.idColumn,
      idValue: context.idRegistro
    });
  }

  return context;
};

const persistAudit = async (req, res, context = {}) => {
  try {
    const user = req.user || req.usuario;
    const actorId = parsePositiveInt(user?.id_usuario);
    if (!actorId) return;

    const statusCode = Number(res?.statusCode || 0);
    if (statusCode < 200 || statusCode >= 400) return;

    const {
      modulo,
      tablaAfectada,
      dbTableName,
      idColumn,
      rawBody,
      explicitCambios
    } = context;

    if (MODULES_WITH_NATIVE_AUDIT.has(modulo)) return;

    const responsePayload = res.__auditResponsePayload;
    const idRegistro = context.idRegistro || inferRegistroId(req, responsePayload);

    const afterRow = await fetchRowSnapshot({
      dbTableName,
      idColumn,
      idValue: idRegistro
    });

    const mutation = buildMutationPayload({
      method: context.method,
      explicitCambios,
      beforeRow: context.beforeRow,
      afterRow,
      rawBody
    });

    const intent = inferBusinessIntent({
      method: context.method,
      modulo,
      mutation,
      beforeRow: context.beforeRow,
      afterRow,
      rawBody,
      responsePayload
    });

    const entityName = extractEntityName(afterRow, mutation.after)
      || extractEntityName(context.beforeRow, mutation.before)
      || extractEntityName(null, explicitCambios);

    const descripcion = buildDescription({
      intent,
      tablaAfectada,
      idRegistro,
      campos: mutation.campos,
      entityName
    });

    await insertSecurityAuditLog({
      req,
      actorId,
      accion: buildAction({ modulo, tablaAfectada, intent }),
      objetivo: { tabla_afectada: tablaAfectada, id_registro: idRegistro },
      modulo,
      descripcion,
      datosAntes: mutation.before,
      datosDespues: mutation.after
    });
  } catch (err) {
    console.error('Global audit interceptor error:', err);
  }
};

export const globalAuditMiddleware = async (req, res, next) => {
  if (req.__globalAuditHookAttached) return next();
  req.__globalAuditHookAttached = true;

  if (!shouldAudit(req)) return next();
  attachResponsePayloadCapture(res);

  try {
    const context = await buildContext(req);
    res.on('finish', () => {
      queueMicrotask(() => {
        void persistAudit(req, res, context);
      });
    });
  } catch (err) {
    console.error('Global audit setup error:', err);
  }

  return next();
};

export default globalAuditMiddleware;
