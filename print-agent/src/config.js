const required = (env, key) => {
  const value = String(env[key] || '').trim();
  if (!value) throw new Error(`CONFIG_REQUIRED:${key}`);
  return value;
};
const integer = (env, key, fallback, min, max) => {
  const value = Number.parseInt(String(env[key] ?? fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`CONFIG_INVALID:${key}`);
  return value;
};
export const loadConfig = (env = process.env) => {
  const apiBaseUrl = required(env, 'API_BASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(apiBaseUrl) && !/^https:\/\/localhost(?::\d+)?$/i.test(apiBaseUrl)) throw new Error('CONFIG_INVALID:API_BASE_URL_HTTPS_REQUIRED');
  const qzHost = String(env.QZ_HOST || 'localhost').trim().toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(qzHost)) throw new Error('CONFIG_INVALID:QZ_HOST_MUST_BE_LOCALHOST');
  let printerMap;
  try { printerMap = JSON.parse(required(env, 'PRINTER_MAP_JSON')); } catch { throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON'); }
  if (!printerMap || typeof printerMap !== 'object' || Array.isArray(printerMap)) throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON');
  for (const [logical, physical] of Object.entries(printerMap)) {
    if (!['factura', 'cocina', 'caja'].includes(logical) || !String(physical || '').trim()) throw new Error('CONFIG_INVALID:PRINTER_MAP_JSON');
  }
  return {
    apiBaseUrl,
    agentId: required(env, 'PRINT_AGENT_ID'),
    token: required(env, 'PRINT_AGENT_TOKEN'),
    branchId: integer(env, 'BRANCH_ID', null, 1, 2147483647),
    qzHost,
    qzSecurePort: integer(env, 'QZ_SECURE_PORT', 8181, 1, 65535),
    pollIntervalMs: integer(env, 'POLL_INTERVAL_MS', 3000, 500, 60000),
    heartbeatIntervalMs: integer(env, 'HEARTBEAT_INTERVAL_MS', 30000, 5000, 300000),
    leaseSeconds: integer(env, 'LEASE_SECONDS', 90, 30, 600),
    printerMap,
    logDir: String(env.LOG_DIR || './logs').trim()
  };
};
