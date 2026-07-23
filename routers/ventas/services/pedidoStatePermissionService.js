import {
  requestHasAnyPermission,
  requestHasAnyRole
} from '../../../middleware/checkPermission.js';

const ADMIN_OPERATIONAL_ROLES = Object.freeze(['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN', 'ROOT']);

const PERMISSIONS_BY_TARGET_STATE = Object.freeze({
  EN_COCINA: Object.freeze([
    'VENTAS_CREAR',
    'MENU_PEDIDO_CONFIRMAR',
    'COCINA_PEDIDO_INICIAR'
  ]),
  EN_PREPARACION: Object.freeze(['COCINA_PEDIDO_INICIAR']),
  COMPLETADO: Object.freeze(['VENTAS_CREAR', 'COCINA_PEDIDO_ENTREGAR']),
  NO_ENTREGADO: Object.freeze(['VENTAS_CREAR', 'COCINA_PEDIDO_ENTREGAR'])
});

export const getPedidoStatePermissions = (targetState) => (
  PERMISSIONS_BY_TARGET_STATE[String(targetState || '').trim().toUpperCase()] || []
);

export const canRequestPedidoStateTransition = async ({
  req,
  targetState,
  queryRunner = null,
  hasAnyPermission = requestHasAnyPermission,
  hasAnyRole = requestHasAnyRole
}) => {
  if (await hasAnyRole(req, ADMIN_OPERATIONAL_ROLES, queryRunner)) return true;
  const permissions = getPedidoStatePermissions(targetState);
  if (permissions.length === 0) return false;
  return hasAnyPermission(req, permissions, queryRunner);
};
