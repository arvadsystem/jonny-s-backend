import {
  PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO
} from '../constants.js';
import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';
import {
  applyPedidoInitialOperationalRouting,
  readPedidoOperationalRouting
} from './pedidoOperationalRoutingService.js';

const asPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const requireAffectedPedido = (result) => {
  if (result?.rowCount === 1) return;
  throw Object.assign(new Error('No se pudo reconciliar el pedido de la venta inmediata.'), {
    code: 'VENTAS_PEDIDO_PAGO_RECONCILIACION_FALLIDA'
  });
};

const normalizeEstadoPedidoCode = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/\s+/g, '_');

const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

export const readPersistedVentaPedidoState = async ({ client, idPedido }) => {
  const pedidoId = asPositiveInteger(idPedido);
  if (!pedidoId || typeof client?.query !== 'function') {
    throw Object.assign(new Error('No se pudo consultar el estado persistido del pedido.'), {
      code: 'VENTAS_PEDIDO_ESTADO_CONSULTA_INVALIDA'
    });
  }

  const result = await client.query(
    `SELECT p.id_pedido,
            p.estado_pago,
            p.canal,
            p.tipo_entrega AS modalidad,
            p.id_estado_pedido,
            p.visible_en_cocina_at,
            ep.descripcion AS estado_pedido
     FROM public.pedidos p
     LEFT JOIN public.estados_pedido ep
       ON ep.id_estado_pedido = p.id_estado_pedido
     WHERE p.id_pedido = $1
     LIMIT 1`,
    [pedidoId]
  );
  const row = result.rows?.[0];
  if (!row) {
    throw Object.assign(new Error('No se encontro el pedido persistido para reconciliar la respuesta.'), {
      code: 'VENTAS_PEDIDO_ESTADO_NO_ENCONTRADO'
    });
  }

  return {
    id_pedido: pedidoId,
    estado_pago: row.estado_pago ?? null,
    canal: row.canal ?? null,
    modalidad: row.modalidad ?? null,
    id_estado_pedido: asPositiveInteger(row.id_estado_pedido),
    estado_pedido: normalizeEstadoPedidoCode(row.estado_pedido),
    visible_en_cocina_at: row.visible_en_cocina_at ?? null
  };
};

export const reconcileVentaResponseWithPersistedPedidoState = async ({ client, response }) => {
  const persisted = await readPersistedVentaPedidoState({
    client,
    idPedido: response?.id_pedido
  });
  const routing = await readPedidoOperationalRouting({
    client,
    idPedido: persisted.id_pedido
  });
  const reconciled = {
    ...(isPlainObject(response) ? response : {}),
    ...persisted,
    ...routing
  };

  if (isPlainObject(response?.contexto)) {
    reconciled.contexto = {
      ...response.contexto,
      canal: persisted.canal,
      modalidad: persisted.modalidad
    };
  }
  if (isPlainObject(response?.pedido)) {
    reconciled.pedido = {
      ...response.pedido,
      id_pedido: persisted.id_pedido,
      id_estado_pedido: persisted.id_estado_pedido,
      estado_pedido: persisted.estado_pedido,
      visible_en_cocina_at: persisted.visible_en_cocina_at,
      ...routing
    };
  }

  return reconciled;
};

export const persistImmediateSalePaymentState = async ({
  client,
  idPedido,
  idFactura,
  venta
}) => {
  const pedidoId = asPositiveInteger(idPedido);
  const facturaId = asPositiveInteger(idFactura);
  const userId = asPositiveInteger(venta?.id_usuario);
  const sessionId = asPositiveInteger(venta?.id_sesion_caja);
  const total = Number(venta?.total);
  const canal = String(venta?.contexto?.canal || '').trim().toUpperCase();
  const modalidad = String(venta?.contexto?.modalidad || '').trim().toUpperCase();

  if (!pedidoId || !facturaId || !userId || !sessionId || !Number.isFinite(total) || total <= 0 || !canal || !modalidad) {
    throw Object.assign(new Error('Contexto incompleto para confirmar la venta inmediata.'), {
      code: 'VENTAS_PEDIDO_PAGO_CONTEXTO_INVALIDO'
    });
  }

  const estadoPedidoPendienteId = await resolveEstadoPedidoIdByCode(client, 'PENDIENTE');
  if (!asPositiveInteger(estadoPedidoPendienteId)) {
    throw Object.assign(new Error('No existe el estado PENDIENTE para inicializar el pedido.'), {
      code: 'VENTAS_PEDIDO_ESTADO_PENDIENTE_NO_ENCONTRADO'
    });
  }

  const estadoPagoResult = await client.query(
    `SELECT id_estado_pago_pedido
     FROM public.cat_pedidos_estados_pago
     WHERE UPPER(TRIM(codigo)) = $1
       AND COALESCE(estado, true) = true
     LIMIT 1`,
    [PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO]
  );
  const estadoPagoId = asPositiveInteger(estadoPagoResult.rows?.[0]?.id_estado_pago_pedido);
  if (!estadoPagoId) {
    throw Object.assign(new Error('No existe el estado de pago PAGADO_CONFIRMADO.'), {
      code: 'VENTAS_PEDIDO_ESTADO_PAGO_NO_ENCONTRADO'
    });
  }

  const pedidoResult = await client.query(
    `UPDATE public.pedidos
     SET estado_pago = $2,
         pago_confirmado_at = COALESCE(pago_confirmado_at, (NOW() AT TIME ZONE 'America/Tegucigalpa')),
         id_usuario_pago_confirmado = COALESCE(id_usuario_pago_confirmado, $3),
         validacion_pago_vence_at = NULL,
         cancelado_por_timeout_at = NULL,
         canal = $4,
         tipo_entrega = $5,
         id_estado_pedido = $6,
         visible_en_cocina_at = NULL
     WHERE id_pedido = $1`,
    [
      pedidoId,
      PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO,
      userId,
      canal,
      modalidad,
      Number(estadoPedidoPendienteId)
    ]
  );
  requireAffectedPedido(pedidoResult);

  const controlResult = await client.query(
    `SELECT id_pedido_pago_control
     FROM public.pedidos_pago_control
     WHERE id_pedido = $1
     ORDER BY id_pedido_pago_control DESC
     LIMIT 1
     FOR UPDATE`,
    [pedidoId]
  );
  const controlId = asPositiveInteger(controlResult.rows?.[0]?.id_pedido_pago_control);

  if (controlId) {
    await client.query(
      `UPDATE public.pedidos_pago_control
       SET id_estado_pago_pedido = $2,
           id_motivo_pago_pendiente = NULL,
           monto_total = $3,
           monto_pagado = $3,
           monto_pendiente = 0,
           fecha_pago_confirmado = COALESCE(fecha_pago_confirmado, (NOW() AT TIME ZONE 'America/Tegucigalpa')),
           id_usuario_confirma_pago = COALESCE(id_usuario_confirma_pago, $4),
           id_sesion_caja_pago = COALESCE(id_sesion_caja_pago, $5),
           id_factura = COALESCE(id_factura, $6),
           fecha_actualizacion = (NOW() AT TIME ZONE 'America/Tegucigalpa')
       WHERE id_pedido_pago_control = $1`,
      [controlId, estadoPagoId, total, userId, sessionId, facturaId]
    );
  } else {
    await client.query(
      `INSERT INTO public.pedidos_pago_control (
         id_pedido,
         id_estado_pago_pedido,
         id_motivo_pago_pendiente,
         monto_total,
         monto_pagado,
         monto_pendiente,
         fecha_pago_confirmado,
         id_usuario_confirma_pago,
         id_sesion_caja_pago,
         id_factura,
         observacion_pago
       )
       VALUES ($1, $2, NULL, $3, $3, 0,
         (NOW() AT TIME ZONE 'America/Tegucigalpa'), $4, $5, $6, NULL)`,
      [pedidoId, estadoPagoId, total, userId, sessionId, facturaId]
    );
  }

  await applyPedidoInitialOperationalRouting({ client, idPedido: pedidoId });
};
