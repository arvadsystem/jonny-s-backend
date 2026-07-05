import { roundMoney } from '../utils/moneyUtils.js';
import { normalizeTipoItem } from '../utils/parseUtils.js';
import {
  buildComplementLineConfig,
  buildComplementSnapshot
} from './ventasPayloadService.js';

export const VENTA_MONTO_COBRO_INVALIDO_CODE = 'VENTA_MONTO_COBRO_INVALIDO';
export const VENTA_MONTO_COBRO_INVALIDO_MESSAGE = 'No se pudo determinar un monto válido para la venta.';

export const validateVentaMontoCobro = ({ venta, payload = null } = {}) => {
  const directProductLines = (Array.isArray(venta?.all_lines) ? venta.all_lines : [])
    .filter((line) => line?.kind === 'PRODUCTO');
  const hasInvalidProductPrice = directProductLines.some((line) => {
    const price = Number(line?.precio_unitario);
    return !Number.isFinite(price) || price <= 0;
  });
  const total = Number(venta?.total);
  const cobroMonto = payload ? Number(payload?.cobro?.monto) : total;

  if (hasInvalidProductPrice || !Number.isFinite(total) || total <= 0 || !Number.isFinite(cobroMonto) || cobroMonto <= 0) {
    return {
      ok: false,
      status: 409,
      code: VENTA_MONTO_COBRO_INVALIDO_CODE,
      message: VENTA_MONTO_COBRO_INVALIDO_MESSAGE
    };
  }

  return { ok: true };
};

const buildVentaRpcItems = (venta) =>
  (Array.isArray(venta?.all_lines) ? venta.all_lines : []).map((line, index) => {
    const tipoItem = normalizeTipoItem(line.kind);
    const configuracionMenu = buildComplementLineConfig(line);
    const complementSnapshot = buildComplementSnapshot(line);
    const origenSnapshot = {
      tipo_item: tipoItem,
      nombre_item: line.nombre_item || null,
      id_producto: line.id_producto || null,
      id_receta: line.id_receta || null,
      id_extra: line.id_extra || null,
      es_linea_extra_independiente: Boolean(line.es_linea_extra_independiente),
      cantidad: Number(line.cantidad || 0),
      precio_unitario: roundMoney(line.precio_unitario),
      total_detalle: roundMoney(line.total_linea),
      subtotal_extras: roundMoney(line.subtotal_extras),
      descuento: roundMoney(line.descuento),
      descuento_linea: roundMoney(line.descuento_linea),
      descuento_global: roundMoney(line.descuento_global),
      id_descuento_catalogo_linea: line.id_descuento_catalogo_linea_aplicado || null,
      id_descuento_catalogo_global: line.id_descuento_catalogo_global || null,
      observacion: line.observacion || null,
      componentes: complementSnapshot,
      extras: Array.isArray(line.extras_detalle) ? line.extras_detalle : []
    };

    return {
      item_index: index,
      tipo_item: tipoItem,
      id_producto: line.id_producto || null,
      id_receta: line.id_receta || null,
      id_extra: line.id_extra || null,
      id_descuento_catalogo: line.id_descuento_catalogo || null,
      cantidad: Number(line.cantidad || 0),
      precio_unitario: roundMoney(line.precio_unitario),
      sub_total: roundMoney(line.sub_total),
      total_linea: roundMoney(line.total_linea),
      descuento: roundMoney(line.descuento),
      observacion: line.observacion || null,
      configuracion_menu: configuracionMenu,
      origen_snapshot: origenSnapshot,
      nombre_item: line.nombre_item || null
    };
  });

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const toPositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const buildLineRef = (line, index) => {
  const cartKey = String(line?.cart_key || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return cartKey ? `line-${index}-${cartKey}` : `line-${index}`;
};

const normalizeRpcSnapshotNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildExtraConsumption = (extra, lineRef) => {
  const idExtra = toPositiveInt(extra?.id_extra);
  const idInsumo = toPositiveInt(extra?.id_insumo);
  const idAlmacen = toPositiveInt(extra?.id_almacen);
  const cantidadSeleccionada = toPositiveNumber(extra?.cantidad_total ?? extra?.cantidad);
  const cantidadBaseUnidad = toPositiveNumber(extra?.cantidad_insumo ?? extra?.cant);
  const cantidadBaseTotal = cantidadSeleccionada && cantidadBaseUnidad
    ? cantidadSeleccionada * cantidadBaseUnidad
    : null;
  if (!idExtra || !idInsumo || !idAlmacen || !cantidadBaseTotal) {
    throw new Error(`POS_RPC_EXTRA_SNAPSHOT_INVALIDO:${lineRef}`);
  }
  return {
    origen_consumo: 'EXTRA',
    tipo_recurso: 'insumo',
    id_producto: null,
    id_insumo: idInsumo,
    id_almacen: idAlmacen,
    cantidad: cantidadBaseTotal,
    id_extra: idExtra,
    id_salsa: null,
    snapshot: {
      id_extra: idExtra,
      id_insumo: idInsumo,
      id_almacen: idAlmacen,
      cantidad_total: cantidadSeleccionada,
      cantidad_base_total: cantidadBaseTotal,
      id_unidad_consumo: toPositiveInt(extra?.id_unidad_medida),
      id_unidad_base: toPositiveInt(extra?.id_unidad_medida)
    }
  };
};

const buildSalsaConsumption = (entry, lineRef) => {
  const inventory = entry?.inventario || {};
  const idSalsa = toPositiveInt(entry?.id_salsa || entry?.id_complemento || inventory?.id_salsa);
  const idInsumo = toPositiveInt(inventory?.id_insumo);
  const idAlmacen = toPositiveInt(inventory?.id_almacen);
  const cantidadBaseTotal = toPositiveNumber(inventory?.cantidad_base_total);
  if (!idSalsa || !idInsumo || !idAlmacen || !cantidadBaseTotal) {
    throw new Error(`POS_RPC_SALSA_SNAPSHOT_INVALIDO:${lineRef}`);
  }
  return {
    origen_consumo: 'SALSA',
    tipo_recurso: 'insumo',
    id_producto: null,
    id_insumo: idInsumo,
    id_almacen: idAlmacen,
    cantidad: cantidadBaseTotal,
    id_extra: null,
    id_salsa: idSalsa,
    snapshot: {
      id_salsa: idSalsa,
      id_insumo: idInsumo,
      id_almacen: idAlmacen,
      cantidad_base_total: cantidadBaseTotal,
      id_unidad_consumo: toPositiveInt(inventory?.id_unidad_consumo),
      id_unidad_base: toPositiveInt(inventory?.id_unidad_base)
    }
  };
};

const consolidateConsumptions = (consumos) => {
  const grouped = new Map();
  for (const consumo of consumos) {
    const resourceKey = consumo.id_producto
      ? `producto:${consumo.id_producto}`
      : `insumo:${consumo.id_insumo}`;
    const key = [
      consumo.line_ref,
      consumo.origen_consumo,
      consumo.id_almacen,
      resourceKey,
      consumo.id_extra || '',
      consumo.id_salsa || ''
    ].join('|');
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...consumo, cantidad: Number(consumo.cantidad) });
    } else {
      current.cantidad += Number(consumo.cantidad);
      if (current.snapshot?.cantidad_base_total !== undefined) {
        current.snapshot.cantidad_base_total = normalizeRpcSnapshotNumber(current.snapshot.cantidad_base_total) + Number(consumo.cantidad);
      }
    }
  }
  return [...grouped.values()].map(({ line_ref: _lineRef, ...consumo }) => consumo);
};

const buildRpcLineConsumptions = (line, lineRef) => {
  const consumos = [];
  if (line.kind === 'PRODUCTO') {
    const idProducto = toPositiveInt(line.id_producto);
    const idAlmacen = toPositiveInt(line.id_almacen);
    const cantidad = toPositiveNumber(line.cantidad);
    if (!idProducto || !idAlmacen || !cantidad) throw new Error(`POS_RPC_PRODUCTO_CONSUMO_INCONSISTENTE:${lineRef}`);
    consumos.push({
      line_ref: lineRef,
      origen_consumo: 'PRODUCTO',
      tipo_recurso: 'producto',
      id_producto: idProducto,
      id_insumo: null,
      id_almacen: idAlmacen,
      cantidad,
      snapshot: {
        id_producto: idProducto,
        id_almacen: idAlmacen,
        cantidad
      }
    });
  }

  if (line.kind === 'RECETA') {
    const componentes = Array.isArray(line.componentes_receta || line.componentes)
      ? (line.componentes_receta || line.componentes)
      : [];
    for (const component of componentes) {
      const idInsumo = toPositiveInt(component?.id_insumo);
      const idAlmacen = toPositiveInt(component?.id_almacen || line.id_almacen);
      const cantidadBase = toPositiveNumber(component?.cantidad ?? component?.cant);
      const cantidadLinea = toPositiveNumber(line.cantidad);
      if (!idInsumo || !idAlmacen || !cantidadBase || !cantidadLinea) {
        throw new Error(`POS_RPC_RECETA_CONSUMO_INCONSISTENTE:${lineRef}`);
      }
      consumos.push({
        line_ref: lineRef,
        origen_consumo: 'RECETA',
        tipo_recurso: 'insumo',
        id_producto: null,
        id_insumo: idInsumo,
        id_almacen: idAlmacen,
        cantidad: cantidadBase * cantidadLinea,
        snapshot: {
          id_insumo: idInsumo,
          cantidad_base_total: cantidadBase * cantidadLinea
        }
      });
    }
  }

  for (const extra of Array.isArray(line.extras_detalle) ? line.extras_detalle : []) {
    consumos.push({ ...buildExtraConsumption(extra, lineRef), line_ref: lineRef });
  }
  for (const salsa of Array.isArray(line.complementos_detalle) ? line.complementos_detalle : []) {
    if (salsa?.inventario) consumos.push({ ...buildSalsaConsumption(salsa, lineRef), line_ref: lineRef });
  }

  return consolidateConsumptions(consumos);
};

const buildVentaRpcTraceableItems = (venta) =>
  (Array.isArray(venta?.all_lines) ? venta.all_lines : []).map((line, index) => {
    const base = buildVentaRpcItems({ all_lines: [line] })[0];
    const lineRef = buildLineRef(line, index);
    return {
      ...base,
      item_index: index,
      line_ref: lineRef,
      consumos: buildRpcLineConsumptions(line, lineRef)
    };
  });

export const buildVentaRpcPayload = ({ venta, correlativoVenta, facturacionVenta, facturacionNormalizada }) => ({
  pedido: {
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    sub_total: venta.pedido_subtotal,
    isv: venta.pedido_isv,
    total: venta.pedido_total,
    id_estado_pedido: venta.id_estado_pedido,
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario
  },
  factura: {
    id_caja: venta.id_caja,
    id_sucursal: venta.id_sucursal,
    id_usuario: venta.id_usuario,
    id_cliente: venta.id_cliente,
    codigo_venta: correlativoVenta.codigo,
    fecha_operacion: correlativoVenta.fecha_operacion,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    isv_15: 0,
    id_sesion_caja: venta.id_sesion_caja
  },
  cobro: {
    id_metodo_pago: venta.id_metodo_pago,
    monto: venta.total,
    referencia: venta.referencia_pago || null
  },
  venta: {
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario,
    id_caja: venta.id_caja,
    id_sesion_caja: venta.id_sesion_caja,
    metodo_pago: venta.metodo_pago,
    metodo_pago_codigo: venta.metodo_pago_codigo,
    referencia_pago: venta.referencia_pago || null,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    subtotal: venta.subtotal,
    descuento: venta.descuento,
    isv: venta.isv,
    total: venta.total
  },
  correlativo: {
    codigo: correlativoVenta.codigo,
    fecha_operacion: correlativoVenta.fecha_operacion
  },
  snapshot_fiscal: {
    id_config_facturacion: facturacionVenta.idConfig || null,
    facturacion_snapshot: facturacionVenta.snapshot || {}
  },
  ticket_facturacion: facturacionNormalizada || {},
  contacto: venta.contacto || null,
  contexto: venta.contexto || null,
  items: buildVentaRpcItems(venta)
});

export const buildVentaRpcV2Payload = ({ venta }) => ({
  pedido: {
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    sub_total: venta.pedido_subtotal,
    isv: venta.pedido_isv,
    total: venta.pedido_total,
    id_estado_pedido: venta.id_estado_pedido,
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario
  },
  factura: {
    id_caja: venta.id_caja,
    id_sucursal: venta.id_sucursal,
    id_usuario: venta.id_usuario,
    id_cliente: venta.id_cliente,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    isv_15: 0,
    id_sesion_caja: venta.id_sesion_caja
  },
  cobro: {
    id_metodo_pago: venta.id_metodo_pago,
    monto: venta.total,
    referencia: venta.referencia_pago || null
  },
  venta: {
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario,
    id_caja: venta.id_caja,
    id_sesion_caja: venta.id_sesion_caja,
    metodo_pago: venta.metodo_pago,
    metodo_pago_codigo: venta.metodo_pago_codigo,
    referencia_pago: venta.referencia_pago || null,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    subtotal: venta.subtotal,
    descuento: venta.descuento,
    isv: venta.isv,
    total: venta.total
  },
  contacto: venta.contacto || null,
  contexto: venta.contexto || null,
  items: buildVentaRpcItems(venta)
});

export const buildVentaRpcV3Payload = ({ venta, idempotencyKey, requestHash }) => ({
  schema_version: 3,
  idempotency: {
    key: idempotencyKey,
    request_hash: requestHash
  },
  pedido: {
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    sub_total: venta.pedido_subtotal,
    isv: venta.pedido_isv,
    total: venta.pedido_total,
    id_estado_pedido: venta.id_estado_pedido,
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario
  },
  factura: {
    id_caja: venta.id_caja,
    id_sucursal: venta.id_sucursal,
    id_usuario: venta.id_usuario,
    id_cliente: venta.id_cliente,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    isv_15: 0,
    id_sesion_caja: venta.id_sesion_caja
  },
  cobro: {
    id_metodo_pago: venta.id_metodo_pago,
    monto: venta.total,
    referencia: venta.referencia_pago || null
  },
  venta: {
    id_sucursal: venta.id_sucursal,
    id_cliente: venta.id_cliente,
    id_usuario: venta.id_usuario,
    id_caja: venta.id_caja,
    id_sesion_caja: venta.id_sesion_caja,
    metodo_pago: venta.metodo_pago,
    metodo_pago_codigo: venta.metodo_pago_codigo,
    referencia_pago: venta.referencia_pago || null,
    efectivo_entregado: venta.efectivo_entregado,
    cambio: venta.cambio,
    descripcion_pedido: venta.descripcion_pedido,
    descripcion_envio: venta.descripcion_envio,
    subtotal: venta.subtotal,
    descuento: venta.descuento,
    isv: venta.isv,
    total: venta.total
  },
  contacto: venta.contacto || null,
  contexto: venta.contexto || null,
  items: buildVentaRpcTraceableItems(venta)
});

export const buildPedidoPendienteRpcPayload = (pedidoPendiente = {}) => ({
  descripcion_pedido: pedidoPendiente.descripcion_pedido,
  descripcion_envio: pedidoPendiente.descripcion_envio,
  subtotal: roundMoney(pedidoPendiente.subtotal),
  isv: roundMoney(pedidoPendiente.isv),
  total: roundMoney(pedidoPendiente.total),
  id_estado_pedido: pedidoPendiente.id_estado_pedido || null,
  id_sucursal: pedidoPendiente.id_sucursal || null,
  id_cliente: pedidoPendiente.id_cliente || null,
  id_usuario: pedidoPendiente.id_usuario || null,
  canal: pedidoPendiente.canal || null,
  modalidad: pedidoPendiente.modalidad || null,
  id_canal_pedido: pedidoPendiente.id_canal_pedido || null,
  id_modalidad_entrega: pedidoPendiente.id_modalidad_entrega || null,
  id_sesion_caja: pedidoPendiente.id_sesion_caja || null,
  observacion_contexto: pedidoPendiente.observacion_contexto || null,
  contacto: {
    nombre_contacto: pedidoPendiente.contacto?.nombre_contacto || null,
    telefono_contacto: pedidoPendiente.contacto?.telefono_contacto || null,
    telefono_normalizado: pedidoPendiente.contacto?.telefono_normalizado || null,
    dni: pedidoPendiente.contacto?.dni || null,
    rtn: pedidoPendiente.contacto?.rtn || null,
    correo: pedidoPendiente.contacto?.correo || null
  },
  id_estado_pago_pedido: pedidoPendiente.id_estado_pago_pedido || null,
  id_motivo_pago_pendiente: pedidoPendiente.id_motivo_pago_pendiente || null,
  observacion_pago: pedidoPendiente.observacion_pago || null,
  pedido_lines: (Array.isArray(pedidoPendiente.pedido_lines) ? pedidoPendiente.pedido_lines : []).map((line, index) => ({
    item_index: index,
    sub_total: roundMoney(line.sub_total),
    total_linea: roundMoney(line.total_linea),
    cantidad: Number(line.cantidad || 0),
    id_producto: line.id_producto || null,
    id_receta: line.id_receta || null,
    id_extra: line.id_extra || null,
    observacion: line.observacion || null,
    descuento: roundMoney(line.descuento),
    id_descuento_catalogo: line.id_descuento_catalogo || null,
    configuracion_menu: buildComplementLineConfig(line),
    extras_detalle: Array.isArray(line.extras_detalle)
      ? line.extras_detalle.map((extra) => ({
        id_extra: extra.id_extra || null,
        codigo: extra.codigo || null,
        nombre: extra.nombre || null,
        cantidad: Number(extra.cantidad || 0),
        cantidad_por_orden: Number(extra.cantidad_por_orden ?? (extra.cantidad || 0)),
        cantidad_total: Number(extra.cantidad_total ?? (extra.cantidad || 0)),
        precio_unitario: roundMoney(extra.precio_unitario),
        subtotal: roundMoney(extra.subtotal),
        id_insumo: extra.id_insumo || null,
        cantidad_insumo: Number(extra.cantidad_insumo || 0),
        id_unidad_medida: extra.id_unidad_medida || null,
        id_detalle_pedido_extra: extra.id_detalle_pedido_extra || null
      }))
      : []
  })),
  delivery: pedidoPendiente.modalidad === 'DELIVERY'
    ? {
      id_estado_delivery: pedidoPendiente.id_estado_delivery || null,
      costo_envio: pedidoPendiente.delivery?.costo_envio === null
        ? null
        : roundMoney(pedidoPendiente.delivery?.costo_envio),
      nombre_receptor: pedidoPendiente.delivery?.nombre_receptor || null,
      telefono_receptor: pedidoPendiente.delivery?.telefono_receptor || null,
      direccion_entrega: pedidoPendiente.delivery?.direccion_entrega || null,
      referencia_entrega: pedidoPendiente.delivery?.referencia_entrega || null,
      observacion_delivery: pedidoPendiente.delivery?.observacion_delivery || null
    }
    : null
});

export const buildPedidoPendienteRpcV2Payload = ({ pedidoPendiente, idempotencyKey, requestHash }) => ({
  ...buildPedidoPendienteRpcPayload(pedidoPendiente),
  schema_version: 2,
  idempotency: {
    key: idempotencyKey,
    request_hash: requestHash
  },
  pedido_lines: (Array.isArray(pedidoPendiente?.pedido_lines) ? pedidoPendiente.pedido_lines : []).map((line, index) => {
    const base = buildPedidoPendienteRpcPayload({ pedido_lines: [line] }).pedido_lines[0];
    const lineRef = buildLineRef(line, index);
    return {
      ...base,
      item_index: index,
      line_ref: lineRef,
      tipo_item: normalizeTipoItem(line.kind),
      consumos: buildRpcLineConsumptions(line, lineRef)
    };
  })
});
