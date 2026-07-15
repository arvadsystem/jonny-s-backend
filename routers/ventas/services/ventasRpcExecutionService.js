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
  POS_RPC_CONFIGURACION_MENU_DUPLICADA: 409,
  POS_RPC_CONSUMOS_INCOMPLETOS: 409,
  POS_RPC_EXTRA_NO_DISPONIBLE_SUCURSAL: 409,
  POS_RPC_EXTRA_NO_PERMITIDO: 409,
  POS_RPC_EXTRA_SNAPSHOT_DUPLICADO: 409,
  POS_RPC_EXTRA_SNAPSHOT_INVALIDO: 409,
  POS_RPC_FACTURA_INVALIDA: 500,
  POS_RPC_FACTURACION_CONTEXTO_INVALIDO: 500,
  POS_RPC_IDEMPOTENCY_CONFLICT: 409,
  POS_RPC_IDEMPOTENCY_IN_PROGRESS: 409,
  POS_RPC_STOCK_INSUFICIENTE: 409,
  POS_RPC_ALMACEN_INVALIDO: 409,
  POS_RPC_ORIGEN_RECURSO_INCOMPATIBLE: 409,
  POS_RPC_PEDIDO_INVALIDO: 409,
  POS_RPC_PRODUCTO_CONSUMO_INCONSISTENTE: 409,
  POS_RPC_RECETA_CONSUMO_DUPLICADO: 409,
  POS_RPC_RECETA_CONSUMO_INCOMPLETO: 409,
  POS_RPC_RECETA_CONSUMO_INCONSISTENTE: 409,
  POS_RPC_RECETA_INVALIDA: 409,
  POS_RPC_RECURSO_INVALIDO: 409,
  POS_RPC_RECURSO_MAPEO_AMBIGUO: 409,
  POS_RPC_RECURSO_MAPEO_NO_VALIDADO: 409,
  POS_RPC_RECURSO_SIN_ASIGNACION: 409,
  POS_RPC_RECURSO_ASIGNACION_AMBIGUA: 409,
  POS_RPC_SALSA_NO_PERMITIDA: 409,
  POS_RPC_SALSA_SNAPSHOT_DUPLICADO: 409,
  POS_RPC_SALSA_SNAPSHOT_INVALIDO: 409,
  POS_RPC_TRAZABILIDAD_INVALIDA: 409,
  POS_RPC_LINE_REF_INVALIDO: 409,
  POS_RPC_LINE_REF_DUPLICADO: 409,
  POS_RPC_INVENTARIO_YA_PROCESADO: 409,
  POS_RPC_TOTAL_INCONSISTENTE: 409,
  POS_RPC_RESPUESTA_BASE_INVALIDA: 500,
  POS_RPC_IDEMPOTENCY_RESERVA_FALLO: 500,
  POS_RPC_IDEMPOTENCY_FINALIZACION_FALLO: 500,
  POS_RPC_IDEMPOTENCY_ESTADO_INVALIDO: 500,
  POS_RPC_UNIDAD_BASE_INVALIDA: 409,
  POS_RPC_UNIDAD_CONSUMO_INVALIDA: 409,
  POS_RPC_UNIDAD_CONVERSION_AMBIGUA: 409,
  POS_RPC_UNIDAD_SIN_CONVERSION: 409
});

const normalizePgRpcCode = (error) => {
  const message = String(error?.message || '').trim();
  const messageMatch = message.match(/\b(POS_RPC_[A-Z0-9_]+)\b/);
  if (messageMatch) return messageMatch[1];
  const code = String(error?.code || '').trim();
  const codeMatch = code.match(/\b(POS_RPC_[A-Z0-9_]+)\b/);
  return codeMatch ? codeMatch[1] : 'POS_RPC_ERROR';
};

const PUBLIC_MESSAGE_BY_STATUS = Object.freeze({
  400: 'La solicitud de venta contiene datos invalidos.',
  403: 'No tienes autorizacion para completar esta operacion.',
  409: 'No se pudo completar la operacion por una inconsistencia de inventario o configuracion.',
  500: 'No se pudo completar la venta por RPC.'
});

export const mapVentasRpcError = (error) => {
  const code = normalizePgRpcCode(error);
  const httpStatus = POS_RPC_ERROR_STATUS[code] || 500;
  return {
    httpStatus,
    code,
    publicMessage: PUBLIC_MESSAGE_BY_STATUS[httpStatus] || PUBLIC_MESSAGE_BY_STATUS[500]
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
