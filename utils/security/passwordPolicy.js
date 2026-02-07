/**
 * utils/security/passwordPolicy.js
 * Lee configuracion_sistema y valida la contraseña según políticas (HU81).
 */

import pool from '../../config/db-connection.js';

async function getPolicyMap() {
  const sql = `SELECT clave, valor FROM configuracion_sistema`;
  const result = await pool.query(sql);

  const map = {};
  for (const row of result.rows) {
    map[row.clave] = row.valor;
  }
  return map;
}

/**
 * Valida una contraseña nueva según políticas en BD.
 * Retorna { ok: true } o { ok:false, message:"..." }
 */
export async function validatePasswordPolicy(password) {
  const policy = await getPolicyMap();

  const minLen = parseInt(policy.password_min_length || '8', 10);
  const requireUpper = (policy.password_require_upper || 'true') === 'true';
  const requireNumber = (policy.password_require_number || 'true') === 'true';
  const requireSymbol = (policy.password_require_symbol || 'false') === 'true';

  if (!password || password.length < minLen) {
    return { ok: false, message: `La contraseña debe tener al menos ${minLen} caracteres.` };
  }

  if (requireUpper && !/[A-Z]/.test(password)) {
    return { ok: false, message: 'La contraseña debe incluir al menos una mayúscula.' };
  }

  if (requireNumber && !/[0-9]/.test(password)) {
    return { ok: false, message: 'La contraseña debe incluir al menos un número.' };
  }

  if (requireSymbol && !/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\];'`~]/.test(password)) {
    return { ok: false, message: 'La contraseña debe incluir al menos un símbolo.' };
  }

  return { ok: true };
}
