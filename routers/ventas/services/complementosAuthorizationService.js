import { validateComplementSelectionBounds } from './complementosCatalogService.js';

export const VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR_PERMISSION = 'VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR';

export const resolveComplementosIncompleteAuthorization = ({
  selectedCount = 0,
  minimo = 0,
  maximo = 0,
  nombreItem,
  requestedOverride = false,
  serverAuthorized = false,
  authorizedByUserId = null
} = {}) => {
  const normalValidation = validateComplementSelectionBounds({
    selectedCount,
    minimo,
    maximo,
    allowIncomplete: false,
    nombreItem
  });
  if (normalValidation.ok || normalValidation.code !== 'VENTAS_COMPLEMENTOS_INCOMPLETOS') {
    return normalValidation;
  }

  if (requestedOverride !== true) return normalValidation;
  if (serverAuthorized !== true) {
    return {
      ok: false,
      status: 403,
      code: 'VENTAS_COMPLEMENTOS_INCOMPLETOS_NO_AUTORIZADO',
      message: 'No tienes permiso para autorizar complementos incompletos.'
    };
  }

  return {
    ok: true,
    authorized: true,
    authorization: {
      complementos_incompletos_autorizados: true,
      complementos_incompletos_autorizado_por: Number(authorizedByUserId) || null,
      complementos_incompletos_permiso: VENTAS_COMPLEMENTOS_INCOMPLETOS_AUTORIZAR_PERMISSION
    }
  };
};
