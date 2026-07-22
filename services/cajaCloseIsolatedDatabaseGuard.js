const DISPOSABLE_DATABASE_PREFIX = 'jonnys_caja_close_test_';
const DISPOSABLE_MARKER_TABLE = 'public.__jonnys_disposable_test_database';
const DISPOSABLE_MARKER_PURPOSE = 'CAJA_CLOSE_ISOLATED_TEST';

const FORBIDDEN_PROJECT_REFS = Object.freeze([
  'cluideiojeikzcmmizhe',
  'ooofeoziqaoqcufifqci'
]);

const FORBIDDEN_HOST_PARTS = Object.freeze([
  'supabase.co',
  'pooler.supabase.com',
  'aws-0-'
]);

const FORBIDDEN_DATABASE_NAMES = new Set([
  'postgres',
  'production',
  'prod',
  'qa',
  'jonnys'
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LOCAL_SERVER_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const parseCsvSet = (value) => new Set(
  String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
);

const createGuardError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const normalizeDatabaseName = (pathname) => decodeURIComponent(String(pathname || ''))
  .replace(/^\/+/, '')
  .trim()
  .toLowerCase();

export const assertQaSharedPaymentCatalogWriteForbidden = (query) => {
  const sql = typeof query === 'string' ? query : query?.text;
  if (
    typeof sql === 'string'
    && /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:public\.)?cat_metodos_pago\b/i.test(sql)
  ) {
    const error = createGuardError(
      'QA_CAJAS_SHARED_CATALOG_MUTATION_FORBIDDEN',
      'El smoke de QA compartido no puede modificar public.cat_metodos_pago.'
    );
    throw error;
  }
};

export const assertIsolatedDatabaseUrlAllowed = ({
  connectionString,
  allowDestructive = process.env.CAJA_CLOSE_ISOLATED_ALLOW_DESTRUCTIVE,
  allowedTestHosts = process.env.CAJA_CLOSE_ISOLATED_ALLOWED_TEST_HOSTS,
  allowedServerAddresses = process.env.CAJA_CLOSE_ISOLATED_ALLOWED_SERVER_ADDRS
} = {}) => {
  if (allowDestructive !== 'true') {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_DESTRUCTIVE_NOT_ALLOWED',
      'CAJA_CLOSE_ISOLATED_ALLOW_DESTRUCTIVE=true es obligatorio antes de cualquier DDL destructivo.'
    );
  }
  if (!connectionString) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_DATABASE_URL_REQUIRED', 'CAJA_CLOSE_ISOLATED_DATABASE_URL es obligatorio.');
  }

  const rawConnectionString = String(connectionString).trim();
  const lowerConnectionString = rawConnectionString.toLowerCase();
  if (FORBIDDEN_PROJECT_REFS.some((projectRef) => lowerConnectionString.includes(projectRef))) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_SUPABASE_PROJECT_FORBIDDEN', 'Un project ref de QA o produccion no puede usarse como base aislada.');
  }

  let url;
  try {
    url = new URL(rawConnectionString);
  } catch {
    throw createGuardError('CAJA_CLOSE_ISOLATED_DATABASE_URL_INVALID', 'CAJA_CLOSE_ISOLATED_DATABASE_URL no es una URL PostgreSQL valida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_DATABASE_URL_INVALID', 'La URL aislada debe usar postgres:// o postgresql://.');
  }

  const hostname = String(url.hostname || '').trim().toLowerCase();
  if (!hostname || FORBIDDEN_HOST_PARTS.some((part) => hostname.includes(part))) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_HOST_FORBIDDEN', 'No se permiten hosts Supabase o hosts no identificados para el harness destructivo.');
  }

  const authorizedTestHosts = parseCsvSet(allowedTestHosts);
  const isLocalHost = LOCAL_HOSTS.has(hostname);
  if (!isLocalHost && !authorizedTestHosts.has(hostname)) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_HOST_NOT_AUTHORIZED',
      'El host debe ser local o un contenedor de prueba explicitamente autorizado.'
    );
  }

  const databaseName = normalizeDatabaseName(url.pathname);
  if (FORBIDDEN_DATABASE_NAMES.has(databaseName)) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_DATABASE_FORBIDDEN', `La base ${databaseName} esta expresamente prohibida.`);
  }
  if (!databaseName.startsWith(DISPOSABLE_DATABASE_PREFIX)) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_DATABASE_NAME_INVALID',
      `La base aislada debe comenzar exactamente con ${DISPOSABLE_DATABASE_PREFIX}.`
    );
  }

  return {
    databaseName,
    hostname,
    isLocalHost,
    allowedServerAddresses: parseCsvSet(allowedServerAddresses)
  };
};

export const assertIsolatedDatabaseServerAndMarker = async ({
  queryRunner,
  expectedTarget
}) => {
  if (!queryRunner || typeof queryRunner.query !== 'function') {
    throw createGuardError('CAJA_CLOSE_ISOLATED_QUERY_RUNNER_REQUIRED', 'Se requiere una conexion PostgreSQL para verificar la base aislada.');
  }
  if (!expectedTarget?.databaseName) {
    throw createGuardError('CAJA_CLOSE_ISOLATED_TARGET_REQUIRED', 'La politica de URL debe validarse antes de verificar PostgreSQL.');
  }

  const identity = await queryRunner.query(`
    SELECT current_database() AS database_name,
           inet_server_addr()::text AS server_address
  `);
  const databaseName = String(identity.rows?.[0]?.database_name || '').trim().toLowerCase();
  const serverAddress = String(identity.rows?.[0]?.server_address || '')
    .trim()
    .toLowerCase()
    .replace(/\/\d+$/, '');

  if (databaseName !== expectedTarget.databaseName || !databaseName.startsWith(DISPOSABLE_DATABASE_PREFIX)) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_CURRENT_DATABASE_MISMATCH',
      'current_database() no coincide con la base desechable autorizada.'
    );
  }

  const isLocalAddress = LOCAL_SERVER_ADDRESSES.has(serverAddress);
  const isAuthorizedContainerAddress = !expectedTarget.isLocalHost
    && expectedTarget.allowedServerAddresses.has(serverAddress);
  if (!isLocalAddress && !isAuthorizedContainerAddress) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_SERVER_ADDRESS_FORBIDDEN',
      'inet_server_addr() no corresponde a localhost ni a un contenedor de prueba autorizado.'
    );
  }

  const markerTable = await queryRunner.query(
    `SELECT to_regclass($1) IS NOT NULL AS marker_exists`,
    [DISPOSABLE_MARKER_TABLE]
  );
  if (markerTable.rows?.[0]?.marker_exists !== true) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_MARKER_MISSING',
      `Falta la tabla marcadora ${DISPOSABLE_MARKER_TABLE}.`
    );
  }

  const marker = await queryRunner.query(`
    SELECT EXISTS (
      SELECT 1
      FROM public.__jonnys_disposable_test_database
      WHERE purpose = $1
    ) AS valid_marker
  `, [DISPOSABLE_MARKER_PURPOSE]);
  if (marker.rows?.[0]?.valid_marker !== true) {
    throw createGuardError(
      'CAJA_CLOSE_ISOLATED_MARKER_INVALID',
      `La base no contiene el marcador purpose=${DISPOSABLE_MARKER_PURPOSE}.`
    );
  }

  return { databaseName, serverAddress, markerPurpose: DISPOSABLE_MARKER_PURPOSE };
};

export const ISOLATED_DATABASE_GUARD_CONSTANTS = Object.freeze({
  DISPOSABLE_DATABASE_PREFIX,
  DISPOSABLE_MARKER_TABLE,
  DISPOSABLE_MARKER_PURPOSE
});
