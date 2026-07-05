/**
 * routers/Seguridad/configuracion.js
 * HU81: gestionar políticas de contraseña en configuracion_sistema.
 */

import express from 'express';
import pool from '../../config/db-connection.js';

import { checkPermission } from '../../middleware/checkPermission.js';
import { insertSecurityAuditLog } from './auditLogger.js';
import { securityReadLimiter, securityWriteLimiter } from './securityRateLimit.js';

const router = express.Router();

const allowPasswordPolicyReadDuringRequiredChange = (req, res, next) => {
  if (Boolean(req.user?.must_change_password)) return next();
  return checkPermission(['SEGURIDAD_VER', 'SEGURIDAD_CONFIG_EDITAR'])(req, res, next);
};

/**
 * GET /seguridad/configuracion/password
 * Retorna políticas actuales (password_*).
 */
router.get(
  '/configuracion/password',
  securityReadLimiter,
  allowPasswordPolicyReadDuringRequiredChange,
  async (req, res) => {
  try {
    const sql = `
      SELECT clave, valor, descripcion
      FROM configuracion_sistema
      WHERE clave LIKE 'password_%'
      ORDER BY clave
    `;

    const result = await pool.query(sql);

    return res.json({ error: false, policies: result.rows });
  } catch (err) {
    console.error('GET /seguridad/configuracion/password error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
  }
);

/**
 * PUT /seguridad/configuracion/password
 * Actualiza políticas.
 * Body ejemplo:
 * {
 *   "password_min_length": "10",
 *   "password_require_upper": "true",
 *   "password_require_number": "true",
 *   "password_require_symbol": "false"
 * }
 */
router.put('/configuracion/password', securityWriteLimiter, checkPermission('SEGURIDAD_CONFIG_EDITAR'), async (req, res) => {
  const client = await pool.connect();

  try {
    const actor = req.user || req.usuario;
    const allowedKeys = new Set([
      'password_min_length',
      'password_require_upper',
      'password_require_number',
      'password_require_symbol'
    ]);

    // Validar que solo manden claves permitidas
    const entries = Object.entries(req.body || {}).filter(([k]) => allowedKeys.has(k));

    if (entries.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No se enviaron políticas válidas para actualizar'
      });
    }

    // Validaciones mínimas
    for (const [k, v] of entries) {
      if (k === 'password_min_length') {
        const n = parseInt(v, 10);
        if (Number.isNaN(n) || n < 6 || n > 64) {
          return res.status(400).json({
            error: true,
            message: 'password_min_length debe ser un número entre 6 y 64'
          });
        }
      } else {
        // booleanos en string: "true" / "false"
        if (!(v === 'true' || v === 'false' || v === true || v === false)) {
          return res.status(400).json({
            error: true,
            message: `${k} debe ser true o false`
          });
        }
      }
    }

    const currentPoliciesRes = await client.query(
      `
      SELECT clave, valor
      FROM configuracion_sistema
      WHERE clave = ANY($1::text[])
      `,
      [entries.map(([clave]) => clave)]
    );

    const datosAntes = {};
    for (const row of currentPoliciesRes.rows) {
      datosAntes[row.clave] = row.valor;
    }

    const datosDespues = {};
    for (const [clave, valorRaw] of entries) {
      datosDespues[clave] = String(valorRaw);
    }

    await client.query('BEGIN');

    for (const [clave, valorRaw] of entries) {
      const valor = String(valorRaw);

      await client.query(
        `
        UPDATE configuracion_sistema
        SET valor = $1,
            actualizado_en = CURRENT_TIMESTAMP
        WHERE clave = $2
        `,
        [valor, clave]
      );
    }

    await client.query('COMMIT');

    try {
      await insertSecurityAuditLog({
        req,
        actorId: actor?.id_usuario ?? null,
        accion: 'ACTUALIZAR_POLITICAS_PASSWORD',
        objetivo: { tabla_afectada: 'configuracion_sistema' },
        descripcion: `Usuario ${actor?.id_usuario ?? 'N/A'} actualizo politicas de password`,
        detalle: {
          actor_id: actor?.id_usuario ?? null,
          claves_actualizadas: Object.keys(datosDespues),
          total_cambios: Object.keys(datosDespues).length
        },
        datosAntes,
        datosDespues
      });
    } catch (auditErr) {
      console.error('Audit log error (configuracion/password):', auditErr);
    }

    return res.json({ error: false, message: 'Políticas actualizadas correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /seguridad/configuracion/password error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

export default router;
