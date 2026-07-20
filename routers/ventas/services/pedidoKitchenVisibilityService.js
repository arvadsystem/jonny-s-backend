import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export const isInitialKitchenDispatchEvent = (event = {}) => (
  String(event.tipo_documento || '').trim().toUpperCase() === 'COMANDA'
  && String(event.estado || '').trim().toUpperCase() === 'ENVIADA'
  && String(event.metadata?.promptAction || '').trim().toLowerCase() === 'initial'
);

export const initializePedidoPendingKitchen = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  const estadoPendienteId = await resolveEstadoPedidoIdByCode(client, 'PENDIENTE');
  if (!pedidoId || !toPositiveInteger(estadoPendienteId)) {
    throw Object.assign(new Error('No se pudo inicializar el pedido fuera de cocina.'), {
      code: 'VENTAS_PEDIDO_ESTADO_PENDIENTE_NO_ENCONTRADO'
    });
  }

  const result = await client.query(
    `UPDATE public.pedidos
     SET id_estado_pedido = $2,
         visible_en_cocina_at = NULL
     WHERE id_pedido = $1`,
    [pedidoId, Number(estadoPendienteId)]
  );
  if (result.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para inicializar su estado de cocina.'), {
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }
};

export const markPedidoVisibleInKitchen = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  if (!pedidoId) {
    throw Object.assign(new Error('ID de pedido invalido para enviar a cocina.'), {
      status: 400,
      code: 'PRINT_PEDIDO_INVALID'
    });
  }

  const estadoEnCocinaId = await resolveEstadoPedidoIdByCode(client, 'EN_COCINA');
  if (!toPositiveInteger(estadoEnCocinaId)) {
    throw Object.assign(new Error('No existe el estado EN_COCINA.'), {
      status: 409,
      code: 'PRINT_KITCHEN_STATE_NOT_FOUND'
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
      code: 'PRINT_PEDIDO_NOT_FOUND'
    });
  }

  return result.rows[0];
};
