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
