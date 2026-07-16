import express from 'express';
import crypto from 'node:crypto';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { buildVentaDetailPayload } from './ventas/handlers/ventasReadHandlers.js';
import { enqueuePrintJob } from '../services/printQueueService.js';

const router = express.Router();

const buildFacturaDocument = (venta) => ({
  titulo: "JONNY'S WINGS",
  numero: venta.numero_venta || venta.codigo_venta || null,
  fecha: venta.fecha_hora_facturacion || null,
  sucursal: venta.nombre_sucursal || null,
  cajero: venta.nombre_usuario || null,
  cliente: venta?.contacto?.nombre_contacto || venta.cliente_nombre || 'Consumidor final',
  items: (Array.isArray(venta.items) ? venta.items : []).map((item) => ({
    cantidad: Number(item.cantidad || 0),
    descripcion: String(item.nombre_item || item.nombre_producto || 'Item').slice(0, 200),
    precio_unitario: Number(item.precio_unitario || 0),
    total: Number(item.total_linea || item.subtotal || 0)
  })),
  subtotal: Number(venta.subtotal || 0),
  descuento: Number(venta.descuento_total || venta.total_descuento || 0),
  total: Number(venta.total || venta.total_factura || 0),
  pie: venta?.facturacion?.ticket?.texto_pie_ticket || null
});

const buildComandaDocument = (venta) => ({
  titulo: 'COMANDA COCINA',
  numero: venta.numero_venta || venta.codigo_venta || null,
  fecha: venta.fecha_hora_facturacion || null,
  sucursal: venta.nombre_sucursal || null,
  cliente: venta?.contacto?.nombre_contacto || venta.cliente_nombre || null,
  items: (Array.isArray(venta.items) ? venta.items : []).map((item) => ({
    cantidad: Number(item.cantidad || 0),
    descripcion: [item.nombre_item || item.nombre_producto || 'Item', item.observacion].filter(Boolean).join(' - ').slice(0, 300),
    total: 0
  })),
  total: 0,
  pie: null
});

router.post('/ventas/:id/print-jobs', checkPermission(['VENTAS_IMPRIMIR', 'VENTAS_CREAR']), async (req, res) => {
  try {
    const idFactura = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isInteger(idFactura) || idFactura <= 0) return res.status(400).json({ ok: false, message: 'ID de factura invalido.' });
    const tipoDocumento = String(req.body?.tipo_documento || 'factura').trim().toLowerCase();
    if (!['factura', 'comanda'].includes(tipoDocumento)) return res.status(400).json({ ok: false, message: 'Tipo de documento invalido.' });

    const detail = await buildVentaDetailPayload(req, { idFactura, includePrintAssets: false });
    if (detail.status !== 200) return res.status(detail.status).json(detail.body);
    const venta = detail.body;
    const isReprint = req.body?.es_reimpresion === true;
    const requestKey = String(req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '').trim();
    const idempotencyKey = requestKey || (isReprint ? '' : `${tipoDocumento}:${idFactura}:inicial`);
    if (!idempotencyKey) return res.status(400).json({ ok: false, code: 'PRINT_IDEMPOTENCY_REQUIRED', message: 'Idempotency-Key es obligatorio para reimpresiones.' });

    const job = await enqueuePrintJob({
      idSucursal: Number(venta.id_sucursal),
      tipoDocumento,
      idempotencyKey,
      idFactura,
      idPedido: Number(venta.id_pedido || 0) || null,
      idUsuario: Number(req.user?.id_usuario || 0) || null,
      esReimpresion: isReprint,
      payload: {
        schema_version: 1,
        tipo_documento: tipoDocumento,
        impresora_logica: tipoDocumento === 'comanda' ? 'cocina' : 'factura',
        ancho_mm: Number(venta?.facturacion?.ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
        documento: tipoDocumento === 'comanda' ? buildComandaDocument(venta) : buildFacturaDocument(venta),
        solicitud_id: crypto.randomUUID()
      }
    });
    return res.status(202).json({ ok: true, message: 'Trabajo enviado a impresion.', job });
  } catch (error) {
    console.error('[printing.enqueue] fallo', { code: error?.code || null });
    return res.status(error?.status || 500).json({ ok: false, code: error?.code || 'PRINT_ENQUEUE_FAILED', message: error?.status ? error.message : 'No se pudo enviar el trabajo de impresion.' });
  }
});

router.get('/ventas/print-jobs/:id', checkPermission(['VENTAS_IMPRIMIR', 'VENTAS_CREAR']), async (req, res) => {
  const idTrabajo = Number.parseInt(String(req.params.id || ''), 10);
  if (!Number.isInteger(idTrabajo) || idTrabajo <= 0) return res.status(400).json({ ok: false, message: 'ID invalido.' });
  const scope = await resolveRequestUserSucursalScope(req, pool);
  const result = await pool.query(
    `SELECT id_trabajo,id_sucursal,tipo_documento,estado,intentos,fecha_creacion,finalizado_at,error_sanitizado
     FROM public.trabajos_impresion WHERE id_trabajo=$1`, [idTrabajo]
  );
  const job = result.rows[0];
  if (!job || (!scope.isSuperAdmin && !scope.allowedSucursalIds.includes(Number(job.id_sucursal)))) return res.status(404).json({ ok: false, message: 'Trabajo no encontrado.' });
  return res.json({ ok: true, job });
});

export default router;
