import express from 'express';
import pool from '../../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from '../../utils/dates.js';
import { securityReadLimiter } from './securityRateLimit.js';
import {
  PERMISOS_NOTIFICACIONES,
  SESSION_ACTIONS,
  ROLE_PERMISSION_TABLES,
  clampInt,
  mapSecurityNotificationRows
} from './securityNotificationsShared.js';
import { openSecurityNotificationsStream } from './securityNotificationsStream.js';

const router = express.Router();

const requireSuperAdmin = async (req, res) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (!isSuperAdmin) {
    res.status(403).json({ error: true, message: 'Acceso denegado: solo Super Admin' });
    return false;
  }
  return true;
};

router.get(
  '/notificaciones/stream',
  checkPermission(PERMISOS_NOTIFICACIONES),
  async (req, res) => {
    try {
      const actor = req.user || req.usuario;
      if (!actor?.id_usuario) {
        return res.status(401).json({ error: true, message: 'No autenticado' });
      }
      if (!(await requireSuperAdmin(req, res))) return;

      openSecurityNotificationsStream(req, res);
    } catch (err) {
      console.error('GET /seguridad/notificaciones/stream error:', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: true, message: 'Error interno del servidor' });
      }
      return res.end();
    }
  }
);

router.get(
  '/notificaciones',
  securityReadLimiter,
  checkPermission(PERMISOS_NOTIFICACIONES),
  async (req, res) => {
    try {
      const actor = req.user || req.usuario;
      if (!actor?.id_usuario) {
        return res.status(401).json({ error: true, message: 'No autenticado' });
      }
      if (!(await requireSuperAdmin(req, res))) return;

      const hasTableRes = await pool.query(`SELECT to_regclass('public.bitacoras') AS reg`);
      if (!hasTableRes.rows?.[0]?.reg) {
        return res.json({
          error: false,
          generated_at: timestampAsHNToISO(new Date()),
          unread: 0,
          total: 0,
          rows: []
        });
      }

      const limit = clampInt(req.query.limit, 25, 1, 60);

      const sql = `
        SELECT
          b.id_bitacora,
          b.accion,
          COALESCE(b.descripcion, '') AS descripcion,
          b.fecha_hora,
          COALESCE(b.modulo, '') AS modulo,
          COALESCE(b.tabla_afectada, '') AS tabla_afectada,
          b.id_registro,
          b.datos_despues,
          u.nombre_usuario AS actor_usuario,
          NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') AS actor_nombre
        FROM bitacoras b
        LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario
        LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
        LEFT JOIN personas p ON p.id_persona = e.id_persona
        WHERE
          UPPER(COALESCE(b.accion, '')) = ANY($1::text[])
          OR UPPER(COALESCE(b.accion, '')) = 'ACTUALIZAR_POLITICAS_PASSWORD'
          OR UPPER(COALESCE(b.tabla_afectada, '')) = ANY($2::text[])
          OR UPPER(COALESCE(b.accion, '')) LIKE '%ROL%'
          OR UPPER(COALESCE(b.accion, '')) LIKE '%PERMISO%'
          OR UPPER(COALESCE(b.accion, '')) LIKE '%ELIMINAR%'
          OR UPPER(COALESCE(b.accion, '')) LIKE '%INACTIVAR%'
          OR UPPER(COALESCE(b.descripcion, '')) LIKE '%MASIV%'
        ORDER BY b.fecha_hora DESC, b.id_bitacora DESC
        LIMIT $3
      `;

      const rowsRes = await pool.query(sql, [
        [...SESSION_ACTIONS],
        [...ROLE_PERMISSION_TABLES],
        limit
      ]);

      const notifications = mapSecurityNotificationRows(rowsRes.rows || []);

      return res.json({
        error: false,
        generated_at: timestampAsHNToISO(new Date()),
        unread: notifications.length,
        total: notifications.length,
        rows: notifications
      });
    } catch (err) {
      console.error('GET /seguridad/notificaciones error:', err);
      return res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
  }
);

export default router;
