import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';
import {
  applyPedidoInitialOperationalRouting,
  readPedidoOperationalRouting
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

  const estadoEnCocinaId = await resolveEstadoPedidoIdByCode(client, 'EN_COCINA');
  if (!toPositiveInteger(estadoEnCocinaId)) {
    throw Object.assign(new Error('No existe el estado EN_COCINA.'), {
      status: 409,
      code: 'VENTAS_PEDIDO_ESTADO_COCINA_NO_ENCONTRADO'
    });
  }

  const result = await client.query(
    `UPDATE public.pedidos
     SET id_estado_pedido = $2,
         visible_en_cocina_at = COALESCE(
           visible_en_cocina_at,
           (NOW() AT TIME ZONE 'America/Tegucigalpa')
         )
     WHERE id_pedido = $1
     RETURNING id_pedido, id_estado_pedido, visible_en_cocina_at`,
    [pedidoId, Number(estadoEnCocinaId)]
  );

  if (result.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para enviar a cocina.'), {
      status: 404,
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return { ...result.rows[0], ...routing };
};
