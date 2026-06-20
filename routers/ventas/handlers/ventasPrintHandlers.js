import pool from '../../../config/db-connection.js';
import { buildVentaDetailPayload } from './ventasReadHandlers.js';
import {
  normalizePrintEventPayload,
  registerVentaPrintEvent
} from '../services/ventasPrintAuditService.js';
import { parsePositiveInt } from '../utils/parseUtils.js';

const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de impresión.'
) => res.status(500).json({ error: true, message });

const toKitchenExtras = (extras = []) =>
  (Array.isArray(extras) ? extras : []).map((extra) => ({
    id_extra: Number(extra?.id_extra || 0) || null,
    nombre: String(extra?.nombre || extra?.nombre_extra || 'Extra').trim(),
    cantidad: Number(extra?.cantidad ?? 0) || 0
  }));

const toKitchenComplementos = (item = {}) => {
  const snapshot = item?.origen_snapshot && typeof item.origen_snapshot === 'object'
    ? item.origen_snapshot
    : {};
  const componentes = Array.isArray(snapshot?.componentes) ? snapshot.componentes : [];
  return componentes
    .map((entry) => ({
      id_complemento: Number(entry?.id_complemento || 0) || null,
      nombre: String(entry?.nombre || 'Complemento').trim()
    }))
    .filter((entry) => entry.id_complemento || entry.nombre);
};

const buildVentaKitchenPrintPayload = (venta = {}) => {
  const items = (Array.isArray(venta?.items) ? venta.items : []).map((item, index) => {
    const isStandaloneExtra = Boolean(item?.origen_snapshot?.es_linea_extra_independiente);
    return {
      linea: index + 1,
      id_detalle: Number(item?.id_detalle || 0) || null,
      tipo_item: String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
      cantidad: Number(item?.cantidad ?? 0) || 0,
      nombre_item: String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
      observacion: String(item?.observacion || '').trim() || null,
      es_linea_extra_independiente: isStandaloneExtra,
      extras: isStandaloneExtra ? [] : toKitchenExtras(item?.extras),
      complementos: toKitchenComplementos(item)
    };
  });

  const totalProductos = items.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad || 0)), 0);

  return {
    id_factura: Number(venta?.id_factura || 0) || null,
    id_pedido: Number(venta?.id_pedido || 0) || null,
    numero_venta: venta?.numero_venta || venta?.codigo_venta || null,
    numero_pedido: venta?.numero_venta || venta?.codigo_venta || null,
    fecha_hora_pedido: venta?.fecha_hora_pedido || venta?.fecha_hora_facturacion || null,
    fecha_hora_facturacion: venta?.fecha_hora_facturacion || venta?.fecha_hora_pedido || null,
    id_sucursal: Number(venta?.id_sucursal || 0) || null,
    nombre_sucursal: venta?.nombre_sucursal || null,
    id_usuario: Number(venta?.id_usuario || 0) || null,
    nombre_usuario: venta?.nombre_usuario || null,
    id_caja: Number(venta?.id_caja || 0) || null,
    nombre_caja: venta?.nombre_caja || venta?.codigo_caja || null,
    cliente_nombre: venta?.cliente_nombre || null,
    modalidad: venta?.modalidad || venta?.contexto?.modalidad || null,
    canal: venta?.contexto?.canal || null,
    contacto: venta?.contacto || null,
    delivery: venta?.delivery || null,
    total_productos: totalProductos,
    items,
    print_config: {
      printMode: 'BROWSER',
      printerType: 'COCINA',
      logicalPrinterName: 'COCINA',
      systemPrinterName: null,
      width_mm: 80
    }
  };
};

export const getVentaKitchenComandaByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (result.status !== 200) {
      return res.status(result.status).json(result.body);
    }

    return res.status(200).json(buildVentaKitchenPrintPayload(result.body));
  } catch (error) {
    console.error('Error al obtener comanda de cocina:', error);
    return sendVentasInternalError(res, 'No se pudo generar la comanda de cocina.');
  }
};

export const createVentaPrintEventHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const normalized = normalizePrintEventPayload(req.body);
    if (!normalized.ok) {
      return res.status(400).json({ error: true, message: normalized.message });
    }

    const detailResult = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (detailResult.status !== 200) {
      return res.status(detailResult.status).json(detailResult.body);
    }

    const auditResult = await registerVentaPrintEvent({
      client: pool,
      idFactura,
      idPedido: detailResult.body?.id_pedido || null,
      idUsuario: req.user?.id_usuario || null,
      idSucursal: detailResult.body?.id_sucursal || null,
      payload: normalized.value
    });

    return res.status(200).json({
      ok: true,
      ...auditResult
    });
  } catch (error) {
    console.error('Error al registrar auditoria de impresion:', error);
    return sendVentasInternalError(res, 'No se pudo registrar el evento de impresión.');
  }
};
