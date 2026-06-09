import { timestampAsHNToISO } from '../../utils/dates.js';

export const PERMISOS_NOTIFICACIONES = [
  'SEGURIDAD_VER',
  'SEGURIDAD_SESIONES_VER_GLOBAL',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER',
  'SEGURIDAD_LOGINS_VER'
];

export const SESSION_ACTIONS = new Set([
  'CERRAR_SESION',
  'CERRAR_OTRAS_SESIONES',
  'CERRAR_SESION_GLOBAL',
  'CERRAR_SESIONES_GLOBALES',
  'CERRAR_SESIONES_USUARIO'
]);

export const ROLE_PERMISSION_TABLES = new Set([
  'ROLES',
  'PERMISOS',
  'ROLES_PERMISOS',
  'ROLES_USUARIOS'
]);

export const clampInt = (value, def, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const normalizeToken = (value) => String(value ?? '').trim().toUpperCase();

const toSafeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : 0;
};

export const resolveSecurityNotificationEventType = (row) => {
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
  return desc || 'Se ejecuto un cierre de sesion de seguridad.';
};

export const buildSecurityNotificationFromAuditRow = (row) => {
  const eventType = resolveSecurityNotificationEventType(row);
  if (!eventType) return null;

  const actor = String(row?.actor_nombre || row?.actor_usuario || '').trim() || 'N/D';
  const createdAtIso = timestampAsHNToISO(row?.fecha_hora || new Date());
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
      title: 'Cambio de politicas de contrasena',
      message: `El usuario ${actor} actualizo politicas de contrasena.`,
      created_at: createdAtIso,
      actions: [{ label: 'Ver politicas', route: '/dashboard/seguridad?tab=password' }]
    };
  }

  if (eventType === 'role_permission_change') {
    const desc = String(row?.descripcion || '').trim();
    return {
      id,
      kind: eventType,
      severity: 'warning',
      title: 'Cambios de roles/permisos',
      message: desc || `Se detecto un cambio de roles/permisos por ${actor}.`,
      created_at: createdAtIso,
      actions: [{ label: 'Ver bitacoras', route: '/dashboard/seguridad?tab=bitacoras' }]
    };
  }

  const desc = String(row?.descripcion || '').trim();
  return {
    id,
    kind: 'critical_audit_event',
    severity: 'critical',
    title: 'Evento critico de auditoria',
    message: desc || `Se detecto una accion sensible registrada por ${actor}.`,
    created_at: createdAtIso,
    actions: [{ label: 'Ver bitacora', route: '/dashboard/seguridad?tab=bitacoras' }]
  };
};

export const mapSecurityNotificationRows = (rows = []) =>
  (Array.isArray(rows) ? rows : [])
    .map((row) => buildSecurityNotificationFromAuditRow(row))
    .filter(Boolean);
