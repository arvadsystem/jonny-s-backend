const VALID_PROCESS_ROLES = new Set(['web', 'scheduler']);
const DB_POOL_MAX_LIMIT = 12;
const DEFAULT_POOL_MAX_BY_ROLE = Object.freeze({
  web: 5,
  scheduler: 2
});
const DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS = 15000;
const MIN_EMAIL_SCHEDULER_INTERVAL_MS = 5000;
const MAX_EMAIL_SCHEDULER_INTERVAL_MS = 300000;
const DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15000;

const parseInteger = (value, fallback = null) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'si', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const parsePort = (value, fallback = 3001) => {
  const parsed = parseInteger(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
};

const parseDbPoolMax = (value, processRole) => {
  const fallback = DEFAULT_POOL_MAX_BY_ROLE[processRole] || DEFAULT_POOL_MAX_BY_ROLE.web;
  const parsed = parseInteger(value, fallback);
  return clamp(Number.isInteger(parsed) ? parsed : fallback, 1, DB_POOL_MAX_LIMIT);
};

const parseIntervalMs = (value, fallback = DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS) => {
  const parsed = parseInteger(value, fallback);
  return clamp(
    Number.isInteger(parsed) ? parsed : fallback,
    MIN_EMAIL_SCHEDULER_INTERVAL_MS,
    MAX_EMAIL_SCHEDULER_INTERVAL_MS
  );
};

const parsePositiveTimeout = (value, fallback = DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS) => {
  const parsed = parseInteger(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const hasSmtpConfig = (env = process.env) => Boolean(
  String(env.SMTP_HOST ?? '').trim() &&
  String(env.SMTP_USER ?? '').trim() &&
  String(env.SMTP_PASS ?? '').trim() &&
  (
    String(env.SMTP_FROM_EMAIL ?? '').trim() ||
    String(env.SMTP_FROM ?? '').trim()
  )
);

export const getRuntimeConfig = (env = process.env) => {
  const processRole = String(env.PROCESS_ROLE || 'web').trim().toLowerCase();
  const emailSchedulerIntervalMs = parseIntervalMs(env.EMAIL_SCHEDULER_INTERVAL_MS);

  return {
    processRole,
    port: parsePort(env.PORT),
    dbPoolMax: parseDbPoolMax(env.DB_POOL_MAX, processRole),
    emailSchedulerEnabled: parseBoolean(env.EMAIL_SCHEDULER_ENABLED, true),
    emailSchedulerIntervalMs,
    emailSchedulerHeartbeatMs: parsePositiveTimeout(env.EMAIL_SCHEDULER_HEARTBEAT_MS, 60000),
    gracefulShutdownTimeoutMs: parsePositiveTimeout(env.GRACEFUL_SHUTDOWN_TIMEOUT_MS),
    smtpConfigured: hasSmtpConfig(env),
    bootstrapEntrypoints: {
      web: env.RUNTIME_BOOTSTRAP_WEB_MODULE || './server.js',
      scheduler: env.RUNTIME_BOOTSTRAP_SCHEDULER_MODULE || './scheduler.js'
    }
  };
};

export const validateRuntimeConfig = (config = getRuntimeConfig()) => {
  if (!VALID_PROCESS_ROLES.has(config.processRole)) {
    throw new Error(`PROCESS_ROLE_INVALID:${config.processRole}`);
  }
  if (!Number.isInteger(config.dbPoolMax) || config.dbPoolMax < 1 || config.dbPoolMax > DB_POOL_MAX_LIMIT) {
    throw new Error('DB_POOL_MAX_INVALID');
  }
  if (config.processRole === 'web') {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error('PORT_INVALID');
    }
    return config;
  }
  if (!config.emailSchedulerEnabled) {
    throw new Error('EMAIL_SCHEDULER_DISABLED_FOR_SCHEDULER_ROLE');
  }
  if (
    !Number.isInteger(config.emailSchedulerIntervalMs) ||
    config.emailSchedulerIntervalMs < MIN_EMAIL_SCHEDULER_INTERVAL_MS ||
    config.emailSchedulerIntervalMs > MAX_EMAIL_SCHEDULER_INTERVAL_MS
  ) {
    throw new Error('EMAIL_SCHEDULER_INTERVAL_INVALID');
  }
  if (!config.smtpConfigured) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }
  return config;
};

export const resolveRuntimeEntrypoint = (config = getRuntimeConfig()) =>
  config.processRole === 'web'
    ? config.bootstrapEntrypoints.web
    : config.bootstrapEntrypoints.scheduler;

export const runtimeConfigConstants = Object.freeze({
  DB_POOL_MAX_LIMIT,
  DEFAULT_POOL_MAX_BY_ROLE,
  DEFAULT_EMAIL_SCHEDULER_INTERVAL_MS,
  MIN_EMAIL_SCHEDULER_INTERVAL_MS,
  MAX_EMAIL_SCHEDULER_INTERVAL_MS,
  DEFAULT_GRACEFUL_SHUTDOWN_TIMEOUT_MS
});
