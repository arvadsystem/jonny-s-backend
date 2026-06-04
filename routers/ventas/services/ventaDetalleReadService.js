import { roundMoney } from '../utils/moneyUtils.js';
import { normalizeObservation } from '../utils/parseUtils.js';

export const mergeVentaWithFacturacion = (venta = {}, facturacion = {}) => {
  const emisor = facturacion?.emisor || {};
  const ticket = facturacion?.ticket || {};
  const ticketFlags = {
    mostrar_datos_fiscales: ticket?.mostrar_datos_fiscales !== false,
    mostrar_cai_ticket: ticket?.mostrar_cai_ticket !== false,
    mostrar_numero_fiscal_ticket: ticket?.mostrar_numero_fiscal_ticket !== false,
    mostrar_codigo_interno_ticket: ticket?.mostrar_codigo_interno_ticket !== false,
    aplicar_impuestos: Boolean(ticket?.aplicar_impuestos),
    mostrar_impuestos_ticket: Boolean(ticket?.mostrar_impuestos_ticket),
    mostrar_importe_exento: Boolean(ticket?.mostrar_importe_exento),
    mostrar_importe_gravado_15: Boolean(ticket?.mostrar_importe_gravado_15),
    mostrar_isv_15: Boolean(ticket?.mostrar_isv_15),
    mostrar_importe_gravado_18: Boolean(ticket?.mostrar_importe_gravado_18),
    mostrar_isv_18: Boolean(ticket?.mostrar_isv_18),
    mostrar_total_isv: Boolean(ticket?.mostrar_total_isv),
    mostrar_descuento_linea: ticket?.mostrar_descuento_linea !== false,
    mostrar_descuento_porcentaje_linea: ticket?.mostrar_descuento_porcentaje_linea !== false,
    mostrar_descuento_total: ticket?.mostrar_descuento_total !== false,
    imprimir_comprobante_reversion: ticket?.imprimir_comprobante_reversion !== false,
    mostrar_venta_original_reversion: ticket?.mostrar_venta_original_reversion !== false,
    mostrar_codigo_reversion: ticket?.mostrar_codigo_reversion !== false,
    mostrar_usuario_reversion: ticket?.mostrar_usuario_reversion !== false,
    mostrar_caja_sesion_reversion: ticket?.mostrar_caja_sesion_reversion !== false,
    mostrar_motivo_reversion: ticket?.mostrar_motivo_reversion !== false,
    mostrar_detalle_reversion: ticket?.mostrar_detalle_reversion !== false,
    mostrar_total_reversion: ticket?.mostrar_total_reversion !== false
  };
  return {
    ...venta,
    facturacion: {
      emisor: {
        nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
        rtn_emisor: emisor?.rtn_emisor || null,
        direccion_emisor: emisor?.direccion_emisor || null,
        telefono_emisor: emisor?.telefono_emisor || null,
        correo_emisor: emisor?.correo_emisor || null,
        logo_url: emisor?.logo_url || null
      },
      ticket: {
        ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
        mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
        mostrar_rtn: Boolean(ticket?.mostrar_rtn),
        mostrar_direccion: Boolean(ticket?.mostrar_direccion),
        mostrar_telefono: Boolean(ticket?.mostrar_telefono),
        mostrar_correo: Boolean(ticket?.mostrar_correo),
        ...ticketFlags,
        texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
        texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra'
      },
      fiscal: {
        modo_fiscal: 'NO_INTEGRADO',
        cai: '0',
        numero_factura_fiscal: '0'
      }
    },
    nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
    rtn_emisor: emisor?.rtn_emisor || null,
    sucursal_direccion: emisor?.direccion_emisor || null,
    sucursal_telefono: emisor?.telefono_emisor || null,
    sucursal_correo: emisor?.correo_emisor || null,
    logo_url: emisor?.logo_url || null,
    ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
    mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
    mostrar_rtn: Boolean(ticket?.mostrar_rtn),
    mostrar_direccion: Boolean(ticket?.mostrar_direccion),
    mostrar_telefono: Boolean(ticket?.mostrar_telefono),
    mostrar_correo: Boolean(ticket?.mostrar_correo),
    ...ticketFlags,
    texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
    texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra',
    modo_fiscal: 'NO_INTEGRADO',
    cai: '0',
    numero_factura_fiscal: '0',
    id_rango_cai: null
  };
};

const formatVentaNumero = (idVenta) => `VTA-${String(idVenta).padStart(5, '0')}`;

export const resolveVentaNumero = (row) =>
  String(row?.codigo_venta || '').trim() || formatVentaNumero(row?.id_factura);

export const inferKitchenItemQuantity = (rawSubtotal, rawUnitPrice) => {
  const subtotal = Number(rawSubtotal || 0);
  const unitPrice = Number(rawUnitPrice || 0);

  if (!Number.isFinite(subtotal) || subtotal <= 0) return 1;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 1;

  const inferred = Math.round(subtotal / unitPrice);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 1;
};

export const buildDirectSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    tipo_item: String(row.tipo_item || 'PRODUCTO').toUpperCase(),
    nombre_item: row.nombre_item || row.nombre_producto || 'Producto',
    nombre_producto: row.nombre_producto || row.nombre_item || 'Producto',
    cantidad: Number(row.cantidad ?? 0) || 0,
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    descuento_linea: roundMoney(row.descuento_linea),
    descuento_global: roundMoney(row.descuento_global),
    observacion: null
  }));

export const buildKitchenSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    nombre_item: row.nombre_item || 'Item de cocina',
    nombre_producto: row.nombre_item || 'Item de cocina',
    cantidad:
      Number(row.cantidad ?? 0) > 0
        ? Number(row.cantidad)
        : inferKitchenItemQuantity(row.sub_total, row.precio_unitario),
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    descuento_linea: roundMoney(row.descuento_linea),
    descuento_global: roundMoney(row.descuento_global),
    observacion: normalizeObservation(row.observacion)
  }));
