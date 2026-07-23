import {
  applyPedidoInitialOperationalRouting,
  readPedidoOperationalRouting,
  transitionPedidoToKitchenState
} from './pedidoOperationalRoutingService.js';

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const initializePedidoPendingKitchen = async ({ client, idPedido }) => {
  return applyPedidoInitialOperationalRouting({ client, idPedido });
};

export const markPedidoVisibleInKitchen = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  if (!pedidoId) {
    throw Object.assign(new Error('ID de pedido invalido para enviar a cocina.'), {
      status: 400,
      code: 'VENTAS_PEDIDO_INVALIDO'
    });
  }

  const routing = await readPedidoOperationalRouting({ client, idPedido: pedidoId });
  if (routing.requiere_revision) {
    throw Object.assign(new Error('El pedido tiene lineas invalidas y requiere revision.'), {
      status: 409,
      code: 'VENTAS_PEDIDO_RUTEO_REQUIERE_REVISION',
      routing
    });
  }
  if (!routing.requiere_cocina) {
    throw Object.assign(new Error('Este pedido no contiene preparaciones para cocina.'), {
      status: 409,
      code: 'VENTAS_PEDIDO_NO_REQUIERE_COCINA',
      routing
    });
  }

  const transitioned = await transitionPedidoToKitchenState({
    client,
    idPedido: pedidoId
  });
  return { ...transitioned, ...routing };
};
