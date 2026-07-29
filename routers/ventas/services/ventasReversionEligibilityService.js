// Elegibilidad minima de Cocina/Pedido para reversion de venta (Fase 2).
// Solo valida si el pedido PUEDE reversarse (bloqueo binario). El calculo
// de cantidad EFECTIVA visible en el tablero de Cocina (original - ya
// reversado) es responsabilidad de la Fase 3 y no se toca aqui.
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

const ALLOWED_PEDIDO_STATE_CODES = new Set(['PENDIENTE', 'EN_COCINA']);

const resolvePedidoStateCode = (descripcion) => {
  const normalized = normalizeTextKey(descripcion);
  for (const [code, aliases] of Object.entries(ESTADO_PEDIDO_CODES)) {
    if (aliases.has(normalized)) return code;
  }
  return null;
};

/**
 * Bloquea (FOR UPDATE) y valida el pedido asociado a la factura, si existe.
 * Permite unicamente PENDIENTE/EN_COCINA con en_preparacion_at IS NULL.
 * Bloquea EN_PREPARACION, LISTO_PARA_ENTREGA, COMPLETADO, NO_ENTREGADO,
 * CANCELADO, cualquier estado no reconocido, y cualquier pedido con
 * en_preparacion_at NOT NULL incluso si el texto del estado dice EN_COCINA.
 *
 * Venta directa (factura sin id_pedido): no hay Cocina que validar: se
 * permite sin inventar un estado. Retorna null en ese caso.
 */
export const assertPedidoEligibleForReversion = async ({ client, idPedido }) => {
  const pedidoId = Number.isSafeInteger(Number(idPedido)) && Number(idPedido) > 0 ? Number(idPedido) : null;
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
      FOR UPDATE OF p
    `,
    [pedidoId]
  );

  if (!result.rowCount) return null;

  const pedido = result.rows[0];
  const stateCode = resolvePedidoStateCode(pedido.estado_descripcion);
  const preparacionIniciada = pedido.en_preparacion_at !== null && pedido.en_preparacion_at !== undefined;
  const isAllowedState = ALLOWED_PEDIDO_STATE_CODES.has(stateCode);

  if (!isAllowedState || preparacionIniciada) {
    throw createReversionEligibilityError(
      409,
      'VENTAS_REVERSION_PREPARACION_INICIADA',
      'La venta ya inició preparación y no puede reversarse.'
    );
  }

  return {
    id_pedido: pedidoId,
    estado: stateCode,
    en_preparacion_at: pedido.en_preparacion_at
  };
};

/**
 * Resuelve el id_estado_pedido de CANCELADO por CODIGO (nunca hardcodeado).
 * Si el catalogo aun no tiene la fila (migracion de Fase 1 no aplicada
 * todavia en este entorno), NO cae de vuelta a PENDIENTE: aborta con un
 * codigo de configuracion explicito para que el pedido nunca quede en un
 * estado incorrecto.
 */
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
