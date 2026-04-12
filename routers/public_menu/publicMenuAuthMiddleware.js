import { authRequired, csrfProtect } from '../../middleware/auth.js';

// Convierte cualquier entrada a entero positivo. Devuelve null si no cumple.
const toPositiveInt = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

// Reutiliza authRequired/csrfProtect globales y agrega regla de negocio:
// solo clientes autenticados pueden crear pedidos desde menu publico.
export const requireAuthenticatedPublicCustomer = [
  authRequired,
  csrfProtect,
  (req, res, next) => {
    const tipoUsuario = String(req.user?.tipo_usuario || '').trim().toUpperCase();
    const idUsuario = toPositiveInt(req.user?.id_usuario);
    const idCliente = toPositiveInt(req.user?.id_cliente);

    if (tipoUsuario !== 'CLIENTE') {
      return res.status(403).json({
        ok: false,
        message: 'Solo clientes autenticados pueden crear pedidos.'
      });
    }

    if (!idUsuario || !idCliente) {
      return res.status(401).json({
        ok: false,
        message: 'Sesion de cliente invalida. Inicia sesion nuevamente.'
      });
    }

    req.publicMenu = {
      ...(req.publicMenu || {}),
      auth: {
        idUsuario,
        idCliente,
        tipoUsuario
      }
    };

    return next();
  }
];
