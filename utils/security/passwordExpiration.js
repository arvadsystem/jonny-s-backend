import pool from '../../config/db-connection.js';

export const PASSWORD_EXPIRATION_DAYS = 60;
export const PASSWORD_CHANGED_AT_COLUMN = 'fecha_cambio_clave';

const DAY_MS = 24 * 60 * 60 * 1000;

let ensurePasswordChangedAtColumnPromise = null;

const normalizeRoleName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

const parseDate = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const isClienteUser = ({ roles = [], tipoUsuario = '' } = {}) => {
  const tipo = normalizeRoleName(tipoUsuario);
  if (tipo === 'CLIENTE') return true;

  const roleList = Array.isArray(roles) ? roles : [roles];
  return roleList.map(normalizeRoleName).includes('CLIENTE');
};

export const evaluatePasswordExpiration = ({
  roles = [],
  tipoUsuario = '',
  mustChangePassword = false,
  passwordChangedAt = null,
  createdAt = null,
  now = new Date(),
  maxAgeDays = PASSWORD_EXPIRATION_DAYS,
} = {}) => {
  const excludedByClienteRole = isClienteUser({ roles, tipoUsuario });
  const referenceDate = parseDate(passwordChangedAt) || parseDate(createdAt);
  const nowDate = parseDate(now) || new Date();

  let ageDays = null;
  if (referenceDate) {
    const diffMs = nowDate.getTime() - referenceDate.getTime();
    ageDays = diffMs < 0 ? 0 : Math.floor(diffMs / DAY_MS);
  }

  const manualMustChange = Boolean(mustChangePassword);
  const expiredByAge = !excludedByClienteRole && ageDays !== null && ageDays >= maxAgeDays;
  const mustChange = !excludedByClienteRole && (manualMustChange || expiredByAge);

  return {
    excludedByClienteRole,
    manualMustChange,
    expiredByAge,
    mustChangePassword: mustChange,
    ageDays,
    referenceDate,
  };
};

const ensureColumnWithRunner = async (queryRunner) => {
  await queryRunner.query(`
    ALTER TABLE public.usuarios
    ADD COLUMN IF NOT EXISTS ${PASSWORD_CHANGED_AT_COLUMN} timestamp without time zone
  `);
};

export const ensurePasswordChangedAtColumn = async (queryRunner = pool) => {
  if (queryRunner !== pool) {
    await ensureColumnWithRunner(queryRunner);
    return;
  }

  if (!ensurePasswordChangedAtColumnPromise) {
    ensurePasswordChangedAtColumnPromise = ensureColumnWithRunner(pool).catch((error) => {
      ensurePasswordChangedAtColumnPromise = null;
      throw error;
    });
  }

  await ensurePasswordChangedAtColumnPromise;
};

