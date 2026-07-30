import { ESTADO_PEDIDO_CODES } from '../constants.js';
import { normalizeTextKey } from '../utils/parseUtils.js';
import { resolveEstadoPedidoIdByCode } from './catalogLookupService.js';

const createReversionEligibilityError = (httpStatus, code, message) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const resolvePedidoStateCode = (descripcion) => {
  const normalized = normalizeTextKey(descripcion);
  for (const [code, aliases] of Object.entries(ESTADO_PEDIDO_CODES)) {
    if (aliases.has(normalized)) return code;
  }
  return null;
};

/**
 * Bloquea y carga el contexto operativo del pedido asociado. El avance de
 * Cocina no impide la reversion financiera: este contexto alimenta la
 * politica unica de inventario por linea.
 */
export const resolvePedidoReversionContext = async ({ client, idPedido, forUpdate = true }) => {
  const pedidoId = Number.isSafeInteger(Number(idPedido)) && Number(idPedido) > 0
    ? Number(idPedido)
    : null;
  if (!pedidoId) return null;

  const result = await client.query(
    `
      SELECT
        p.id_pedido,
        p.en_preparacion_at,
        ep.descripcion AS estado_descripcion
      FROM public.pedidos p
      LEFT JOIN public.estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      WHERE p.id_pedido = $1
      ${forUpdate ? 'FOR UPDATE OF p' : ''}
    `,
    [pedidoId]
  );

  if (!result.rowCount) return null;

  const pedido = result.rows[0];
  const stateCode = resolvePedidoStateCode(pedido.estado_descripcion);
  const preparacionIniciada = Boolean(
    pedido.en_preparacion_at
    || ['EN_PREPARACION', 'LISTO_PARA_ENTREGA', 'COMPLETADO', 'NO_ENTREGADO'].includes(stateCode)
  );

  return {
    id_pedido: pedidoId,
    estado: stateCode || 'DESCONOCIDO',
    en_preparacion_at: pedido.en_preparacion_at,
    preparacion_iniciada: preparacionIniciada
  };
};

// Alias conservado para no romper importadores existentes. Ya no rechaza por
// estado de Cocina; devuelve el contexto bloqueado del pedido.
export const assertPedidoEligibleForReversion = resolvePedidoReversionContext;

export const resolveCancelledEstadoPedidoIdOrThrow = async (client) => {
  const idEstadoCancelado = await resolveEstadoPedidoIdByCode(client, 'CANCELADO');
  if (!idEstadoCancelado) {
    throw createReversionEligibilityError(
      409,
      'VENTAS_REVERSION_ESTADO_CANCELADO_NO_CONFIGURADO',
      'El estado CANCELADO de pedidos no está configurado en este entorno.'
    );
  }
  return Number(idEstadoCancelado);
};
