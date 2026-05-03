import express from 'express';
import pool from '../../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from '../../utils/dates.js';
import { securityReadLimiter } from './securityRateLimit.js';

const router = express.Router();

const PERMISOS_NOTIFICACIONES = [
  'SEGURIDAD_VER',
  'SEGURIDAD_SESIONES_VER_GLOBAL',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_LOGINS_VER'
];

const SESSION_ACTIONS = new Set([
  'CERRAR_SESION',
  'CERRAR_OTRAS_SESIONES',
  'CERRAR_SESION_GLOBAL',
  'CERRAR_SESIONES_GLOBALES',
  'CERRAR_SESIONES_USUARIO'
]);

const ROLE_PERMISSION_TABLES = new Set([
  'ROLES',
  'PERMISOS',
  'ROLES_PERMISOS',
  'ROLES_USUARIOS'
]);

const clampInt = (value, def, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const normalizeToken = (value) => String(value ?? '').trim().toUpperCase();

const toSafeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : 0;
};

const requireSuperAdmin = async (req, res) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (!isSuperAdmin) {
    res.status(403).json({ error: true, message: 'Acceso denegado: solo Super Admin' });
    return false;
  }
  return true;
};

const resolveEventType = (row) => {
  const action = normalizeToken(row?.accion);
  const table = normalizeToken(row?.tabla_afectada);
  const desc = normalizeToken(row?.descripcion);

  if (SESSION_ACTIONS.has(action)) return 'session_close';
  if (action === 'ACTUALIZAR_POLITICAS_PASSWORD') return 'password_policy_change';
  if (
    action.includes('ROL')
    || action.includes('PERMISO')
    || ROLE_PERMISSION_TABLES.has(table)
    || table.includes('ROL')
    || table.includes('PERMISO')
  ) {
    return 'role_permission_change';
  }
  if (
    action.includes('ELIMINAR')
    || action.includes('INACTIVAR')
    || action.includes('BORRAR')
    || desc.includes('MASIV')
    || desc.includes('SENSIBLE')
  ) {
    return 'critical_audit_event';
  }
  return null;
};

const buildSessionCloseMessage = (row) => {
  const action = normalizeToken(row?.accion);
  const detail = row?.datos_despues && typeof row.datos_despues === 'object'
    ? row.datos_despues
    : {};

  if (action === 'CERRAR_SESIONES_GLOBALES') {
    const count = toSafeInt(detail?.cerradas ?? detail?.sesiones_cerradas);
    return count > 0
      ? `Cierre global ejecutado (${count} sesiones cerradas).`
      : 'Cierre global ejecutado.';
  }

  if (action === 'CERRAR_SESIONES_USUARIO') {
    const username = String(detail?.username || '').trim();
    const count = toSafeInt(detail?.sesiones_cerradas ?? detail?.cerradas);
    if (username) {
      return count > 0
        ? `Se cerraron sesiones de ${username} (${count} cerradas).`
        : `Se cerraron sesiones de ${username}.`;
    }
    return 'Se cerraron sesiones de un usuario.';
  }

  const desc = String(row?.descripcion || '').trim();
  return desc || 'Se ejecutó un cierre de sesión de seguridad.';
};

const buildNotification = (row, eventType) => {
  const actor = String(row?.actor_nombre || row?.actor_usuario || '').trim() || 'N/D';
  const createdAtIso = timestampAsHNToISO(row?.fecha_hora);
  const id = `bitacora:${String(row?.id_bitacora || '').trim()}`;

  if (eventType === 'session_close') {
    return {
      id,
      kind: eventType,
      severity: 'warning',
      title: 'Cierre de sesiones',
      message: buildSessionCloseMessage(row),
      created_at: createdAtIso,
      actions: [{ label: 'Ver sesiones activas', route: '/dashboard/seguridad?tab=sesiones' }]
    };
  }

  if (eventType === 'password_policy_change') {
    return {
      id,
      kind: eventType,
      severity: 'info',
      title: 'Cambio de políticas de contraseña',
      message: `El usuario ${actor} actualizó políticas de contraseña.`,
      created_at: createdAtIso,
      actions: [{ label: 'Ver políticas', route: '/dashboard/seguridad?tab=password' }]
    };
  }

  if (eventType === 'role_permission_change') {
    const desc = String(row?.descripcion || '').trim();
    return {
      id,
      kind: eventType,
      severity: 'warning',
      title: 'Cambios de roles/permisos',
      message: desc || `Se detectó un cambio de roles/permisos por ${actor}.`,
      created_at: createdAtIso,
      actions: [{ label: 'Ver bitácoras', route: '/dashboard/seguridad?tab=bitacoras' }]
    };
  }

  const desc = String(row?.descripcion || '').trim();
  return {
    id,
    kind: 'critical_audit_event',
    severity: 'critical',
    title: 'Evento crítico de auditoría',
    message: desc || `Se detectó una acción sensible registrada por ${actor}.`,
    created_at: createdAtIso,
    actions: [{ label: 'Ver bitácora', route: '/dashboard/seguridad?tab=bitacoras' }]
  };
};

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

      const notifications = [];
      for (const row of rowsRes.rows || []) {
        const eventType = resolveEventType(row);
        if (!eventType) continue;
        notifications.push(buildNotification(row, eventType));
      }

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

