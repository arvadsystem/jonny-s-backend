import pool from '../../../config/db-connection.js';
import {
  obtenerConfiguracionImpresorasRuntime
} from '../../../services/impresorasConfigSucursalService.js';
import { buildVentaDetailPayload } from './ventasReadHandlers.js';
import {
  normalizePrintEventPayload,
  registerVentaPrintEvent
} from '../services/ventasPrintAuditService.js';
import {
  getQzCertificateText,
  hasQzSigningConfigured,
  signQzMessage
} from '../services/qzTraySigningService.js';
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

const buildVentaKitchenPrintPayload = (venta = {}, printerConfig = null) => {
  const cocinaConfig = (Array.isArray(printerConfig?.impresoras) ? printerConfig.impresoras : [])
    .find((item) => String(item?.tipo_impresora || '').trim().toUpperCase() === 'COCINA');
  const items = (Array.isArray(venta?.items) ? venta.items : []).map((item, index) => ({
    linea: index + 1,
    id_detalle: Number(item?.id_detalle || 0) || null,
    tipo_item: String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
    cantidad: Number(item?.cantidad ?? 0) || 0,
    nombre_item: String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
    observacion: String(item?.observacion || '').trim() || null,
    extras: toKitchenExtras(item?.extras),
    complementos: toKitchenComplementos(item)
  }));

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
      printMode: cocinaConfig?.modo_impresion || 'BROWSER',
      printerType: 'COCINA',
      logicalPrinterName: 'COCINA',
      systemPrinterName: cocinaConfig?.nombre_impresora_sistema || null,
      width_mm: Number(cocinaConfig?.ancho_mm) === 58 ? 58 : 80,
      id_impresora: Number(cocinaConfig?.id_impresora || 0) || null,
      ip_impresora: cocinaConfig?.ip_impresora || null,
      puerto_impresora: Number(cocinaConfig?.puerto_impresora || 0) || 9100
    }
  };
};

export const getVentasPrinterConfigHandler = async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.query?.id_sucursal);
    const idCaja = parsePositiveInt(req.query?.id_caja);
    if (!idSucursal) {
      return res.status(400).json({ error: true, message: 'id_sucursal es obligatorio.' });
    }

    const data = await obtenerConfiguracionImpresorasRuntime({
      idSucursal,
      idCaja
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error al obtener configuracion runtime de impresoras:', error);
    return sendVentasInternalError(res, 'No se pudo obtener la configuracion de impresion.');
  }
};

export const getQzCertificateHandler = async (_req, res) => {
  try {
    const certificate = await getQzCertificateText();
    if (!certificate) {
      return res.status(503).json({
        error: true,
        code: 'QZ_SIGNING_NOT_CONFIGURED',
        message: 'La firma segura de QZ Tray no esta configurada.'
      });
    }

    return res.status(200).json({
      ok: true,
      configured: await hasQzSigningConfigured(),
      certificate
    });
  } catch (error) {
    console.error('Error al obtener certificado de QZ Tray:', error);
    return sendVentasInternalError(res, 'No se pudo obtener el certificado de impresion.');
  }
};

export const signQzRequestHandler = async (req, res) => {
  try {
    const request = String(req.body?.request || '');
    if (!request) {
      return res.status(400).json({
        error: true,
        code: 'QZ_SIGN_REQUEST_INVALID',
        message: 'request es obligatorio.'
      });
    }

    const signature = await signQzMessage(request);
    return res.status(200).json({ ok: true, signature });
  } catch (error) {
    if (error?.code === 'QZ_SIGNING_NOT_CONFIGURED') {
      return res.status(503).json({
        error: true,
        code: error.code,
        message: 'La firma segura de QZ Tray no esta configurada.'
      });
    }
    if (error?.code === 'QZ_SIGN_REQUEST_INVALID') {
      return res.status(400).json({
        error: true,
        code: error.code,
        message: 'request es obligatorio.'
      });
    }

    console.error('Error al firmar solicitud de QZ Tray:', error);
    return sendVentasInternalError(res, 'No se pudo firmar la solicitud de impresion.');
  }
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

    const printerConfig = await obtenerConfiguracionImpresorasRuntime({
      idSucursal: result.body?.id_sucursal,
      idCaja: result.body?.id_caja
    }).catch(() => null);

    return res.status(200).json(buildVentaKitchenPrintPayload(result.body, printerConfig));
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
