/**
 * middleware/requirePasswordChange.js
 * Bloquea el acceso a modulos protegidos cuando el JWT indica
 * que el usuario debe cambiar su contrasena.
 */

const ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED = new Set([
  'GET /perfil',
  'PUT /perfil/password',
  'GET /seguridad/configuracion/password',
  'POST /usuarios/v2/change-password',
]);

const normalizePath = (value) => {
  const raw = String(value || '').split('?')[0].trim();
  if (!raw) return '/';
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
};

const buildRouteSignature = (method, path) =>
  `${String(method || 'GET').trim().toUpperCase()} ${normalizePath(path)}`;

export const requirePasswordChange = (req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') return next();

  const mustChangePassword = Boolean(req.user?.must_change_password);
  if (!mustChangePassword) return next();

  const signature = buildRouteSignature(method, req.path || req.originalUrl || '/');
  if (ALLOWED_WHEN_PASSWORD_CHANGE_REQUIRED.has(signature)) return next();

  return res.status(403).json({
    error: true,
    code: 'PASSWORD_CHANGE_REQUIRED',
    message: 'Debe cambiar su contrasena para continuar'
  });
};

