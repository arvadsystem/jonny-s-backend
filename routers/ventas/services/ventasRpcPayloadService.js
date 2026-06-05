import { roundMoney } from '../utils/moneyUtils.js';
import { normalizeTipoItem } from '../utils/parseUtils.js';
import {
  buildComplementLineConfig,
  buildComplementSnapshot
} from './ventasPayloadService.js';

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
      id_combo: line.id_combo || null,
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
      id_combo: line.id_combo || null,
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
  items: buildVentaRpcItems(venta)
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
    id_producto: line.id_producto || null,
    id_combo: line.id_combo || null,
    id_receta: line.id_receta || null,
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
      costo_envio: roundMoney(pedidoPendiente.delivery?.costo_envio),
      nombre_receptor: pedidoPendiente.delivery?.nombre_receptor || null,
      telefono_receptor: pedidoPendiente.delivery?.telefono_receptor || null,
      direccion_entrega: pedidoPendiente.delivery?.direccion_entrega || null,
      referencia_entrega: pedidoPendiente.delivery?.referencia_entrega || null,
      observacion_delivery: pedidoPendiente.delivery?.observacion_delivery || null
    }
    : null
});
