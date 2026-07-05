import { isPlainObject, parseOptionalPositiveInt } from '../utils/parseUtils.js';

const POS_RPC_ERROR_STATUS = Object.freeze({
  POS_RPC_PAYLOAD_INVALIDO: 400,
  POS_RPC_SCHEMA_VERSION_INVALIDA: 400,
  POS_RPC_ITEMS_REQUERIDOS: 400,
  POS_RPC_ITEM_INVALIDO: 400,
  POS_RPC_CONSUMO_INVALIDO: 400,
  POS_RPC_CONSUMOS_REQUERIDOS: 400,
  POS_RPC_IDEMPOTENCY_REQUERIDA: 400,
  POS_RPC_IDEMPOTENCY_KEY_INVALIDA: 400,
  POS_RPC_IDEMPOTENCY_HASH_INVALIDO: 400,
  POS_RPC_IDEMPOTENCY_OPERATION_INVALIDA: 400,
  POS_RPC_ACTOR_SCOPE_MISMATCH: 403,
  POS_RPC_IDEMPOTENCY_CONFLICT: 409,
  POS_RPC_IDEMPOTENCY_IN_PROGRESS: 409,
  POS_RPC_STOCK_INSUFICIENTE: 409,
  POS_RPC_ALMACEN_INVALIDO: 409,
  POS_RPC_RECURSO_INVALIDO: 409,
  POS_RPC_RECURSO_SIN_ASIGNACION: 409,
  POS_RPC_RECURSO_ASIGNACION_AMBIGUA: 409,
  POS_RPC_TRAZABILIDAD_INVALIDA: 409,
  POS_RPC_LINE_REF_INVALIDO: 409,
  POS_RPC_LINE_REF_DUPLICADO: 409,
  POS_RPC_INVENTARIO_YA_PROCESADO: 409,
  POS_RPC_TOTAL_INCONSISTENTE: 409
});

const normalizePgRpcCode = (error) => {
  const message = String(error?.message || '').trim();
  if (message.startsWith('POS_RPC_')) return message.split(/\s+/)[0];
  return String(error?.code || '').startsWith('POS_RPC_') ? String(error.code) : 'POS_RPC_ERROR';
};

export const mapVentasRpcError = (error) => {
  const code = normalizePgRpcCode(error);
  const httpStatus = POS_RPC_ERROR_STATUS[code] || (
    /STOCK_INSUFICIENTE|RECURSO|ALMACEN|TRAZABILIDAD/.test(code) ? 409 : 500
  );
  return {
    httpStatus,
    code,
    publicMessage: httpStatus === 500
      ? 'No se pudo completar la venta por RPC.'
      : 'No se pudo completar la venta. Revisa la solicitud o el inventario disponible.'
  };
};

export const buildVentasRpcActor = (venta) => ({
  id_usuario: venta.id_usuario,
  id_sucursal: venta.id_sucursal,
  id_caja: venta.id_caja,
  id_sesion_caja: venta.id_sesion_caja
});

export const executeVentasRpc = async ({
  client,
  sql,
  payload,
  actor,
  perf,
  callMetric,
  expectedVersion,
  invalidCode
}) => {
  const rpcCallStart = perf?.now?.() || 0;
  let result;
  try {
    result = await client.query(sql, [JSON.stringify(payload), JSON.stringify(actor)]);
  } catch (error) {
    throw mapVentasRpcError(error);
  } finally {
    perf?.add?.(callMetric, rpcCallStart);
  }

  const response = result.rows?.[0]?.response;
  if (!isPlainObject(response) || (expectedVersion && response.rpc_version !== expectedVersion)) {
    throw {
      httpStatus: 500,
      code: invalidCode,
      publicMessage: 'La venta fue procesada por RPC, pero la respuesta no es valida.'
    };
  }
  return response;
};

export const buildRpcFidelizacionJob = ({ response, venta }) => ({
  idFactura: parseOptionalPositiveInt(response?.id_factura),
  idPedido: parseOptionalPositiveInt(response?.id_pedido),
  idCliente: venta.id_cliente,
  idSucursal: venta.id_sucursal,
  idUsuarioEjecutor: venta.id_usuario,
  montoFactura: venta.total
});
