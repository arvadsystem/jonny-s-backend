import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';

export const PEDIDO_OPERATIONAL_ACTION = Object.freeze({
  SEND_TO_KITCHEN: 'ENVIAR_COCINA',
  READY_FOR_DELIVERY: 'LISTO_PARA_ENTREGA',
  COMPLETE: 'COMPLETAR',
  REVIEW: 'REQUIERE_REVISION'
});

const toPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeCode = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, '_');

const buildLineReference = (line, index) => ({
  id_detalle_pedido: toPositiveInteger(line?.id_detalle_pedido ?? line?.id_detalle) || null,
  indice: index,
  id_producto: toPositiveInteger(line?.id_producto),
  id_receta: toPositiveInteger(line?.id_receta)
});

export const classifyPedidoOperationalRouting = (lines, context = {}) => {
  const sourceLines = Array.isArray(lines) ? lines : [];
  const productos = [];
  const recetas = [];
  const lineasInvalidas = [];

  sourceLines.forEach((line, index) => {
    const reference = buildLineReference(line, index);
    const hasProducto = Boolean(reference.id_producto);
    const hasReceta = Boolean(reference.id_receta);

    if (hasProducto === hasReceta) {
      lineasInvalidas.push(reference);
    } else if (hasProducto) {
      productos.push(reference);
    } else {
      recetas.push(reference);
    }
  });

  if (sourceLines.length === 0) {
    lineasInvalidas.push({
      id_detalle_pedido: null,
      indice: null,
      id_producto: null,
      id_receta: null,
      motivo: 'PEDIDO_SIN_DETALLE'
    });
  }

  const requiereRevision = lineasInvalidas.length > 0;
  const requiereCocina = !requiereRevision && recetas.length > 0;
  const estadoPago = normalizeCode(context.estado_pago);
  const canal = normalizeCode(context.canal);
  const modalidad = normalizeCode(context.modalidad ?? context.tipo_entrega);
  const isPaidLocalConsumption = estadoPago === 'PAGADO_CONFIRMADO'
    && ['LOCAL', 'POS', 'CAJA'].includes(canal)
    && ['CONSUMO_LOCAL', 'LOCAL', 'EN_LOCAL'].includes(modalidad);

  let accionOperativa;
  let estadoInicial;
  if (requiereRevision) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.REVIEW;
    estadoInicial = 'PENDIENTE';
  } else if (requiereCocina) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.SEND_TO_KITCHEN;
    estadoInicial = 'PENDIENTE';
  } else if (isPaidLocalConsumption) {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.COMPLETE;
    estadoInicial = 'COMPLETADO';
  } else {
    accionOperativa = PEDIDO_OPERATIONAL_ACTION.READY_FOR_DELIVERY;
    estadoInicial = 'LISTO_PARA_ENTREGA';
  }

  return {
    requiere_cocina: requiereCocina,
    items_preparables: recetas,
    items_entrega_conjunta: productos,
    items_sin_clasificar: lineasInvalidas,
    productos,
    recetas,
    requiere_revision: requiereRevision,
    lineas_invalidas: lineasInvalidas,
    accion_operativa: accionOperativa,
    estado_operativo_inicial: estadoInicial
  };
};

export const readPedidoOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  if (!pedidoId || typeof client?.query !== 'function') {
    throw Object.assign(new Error('No se pudo clasificar el ruteo operativo del pedido.'), {
      code: 'VENTAS_PEDIDO_RUTEO_CONTEXTO_INVALIDO'
    });
  }

  const [pedidoResult, detailResult] = await Promise.all([
    client.query(
      `SELECT estado_pago, canal, tipo_entrega AS modalidad
       FROM public.pedidos
       WHERE id_pedido = $1
       LIMIT 1`,
      [pedidoId]
    ),
    client.query(
      `SELECT id_detalle_pedido, id_producto, id_receta
       FROM public.detalle_pedido
       WHERE id_pedido = $1
         AND COALESCE(estado, true) = true
       ORDER BY id_detalle_pedido`,
      [pedidoId]
    )
  ]);

  if (!pedidoResult.rows?.[0]) {
    throw Object.assign(new Error('Pedido no encontrado para clasificar su ruteo operativo.'), {
      status: 404,
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return {
    id_pedido: pedidoId,
    ...classifyPedidoOperationalRouting(detailResult.rows, pedidoResult.rows[0])
  };
};

export const applyPedidoInitialOperationalRouting = async ({ client, idPedido }) => {
  const pedidoId = toPositiveInteger(idPedido);
  const routing = await readPedidoOperationalRouting({ client, idPedido: pedidoId });
  const targetStateId = await resolveEstadoPedidoIdByCode(client, routing.estado_operativo_inicial);

  if (!toPositiveInteger(targetStateId)) {
    throw Object.assign(new Error(`No existe el estado ${routing.estado_operativo_inicial}.`), {
      code: 'VENTAS_PEDIDO_ESTADO_OPERATIVO_NO_ENCONTRADO'
    });
  }

  const updateResult = await client.query(
    `UPDATE public.pedidos
     SET id_estado_pedido = $2,
         visible_en_cocina_at = NULL
     WHERE id_pedido = $1
     RETURNING id_pedido, id_estado_pedido, visible_en_cocina_at`,
    [pedidoId, Number(targetStateId)]
  );
  if (updateResult.rowCount !== 1) {
    throw Object.assign(new Error('Pedido no encontrado para aplicar su ruteo operativo.'), {
      code: 'VENTAS_PEDIDO_NO_ENCONTRADO'
    });
  }

  return {
    ...routing,
    id_estado_pedido: Number(targetStateId),
    estado_pedido: routing.estado_operativo_inicial,
    visible_en_cocina_at: null
  };
};
