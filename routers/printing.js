import express from 'express';
import crypto from 'node:crypto';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyRole } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { buildVentaDetailPayload } from './ventas/handlers/ventasReadHandlers.js';
import { enqueuePrintJob } from '../services/printQueueService.js';
import {
  getPrintJobEvents,
  listAmbiguousPrintJobs,
  resolvePrintJobAdministratively
} from '../services/printQueueAdminService.js';

const router = express.Router();
const ADMIN_ROLE_CODES = Object.freeze(['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN']);

const parsePositiveId = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveAllowedSucursal = async (req, requestedId) => {
  const idSucursal = parsePositiveId(requestedId);
  if (!idSucursal) throw Object.assign(new Error('Sucursal invalida.'), { status: 400, code: 'PRINT_SUCURSAL_INVALID' });
  const scope = await resolveRequestUserSucursalScope(req, pool);
  if (!scope.isSuperAdmin && !scope.allowedSucursalIds.includes(idSucursal)) {
    throw Object.assign(new Error('No tiene permiso para operar esta sucursal.'), { status: 403, code: 'PRINT_SUCURSAL_FORBIDDEN' });
  }
  return idSucursal;
};

const requireAdministrativePrintRole = async (req) => {
  if (!(await requestHasAnyRole(req, ADMIN_ROLE_CODES))) {
    throw Object.assign(new Error('Resolucion exclusiva para administradores.'), { status: 403, code: 'PRINT_ADMIN_ROLE_REQUIRED' });
  }
};

const sendPrintAdminError = (res, error) => res.status(error?.status || 500).json({
  ok: false,
  code: error?.code || 'PRINT_ADMIN_FAILED',
  message: error?.status ? error.message : 'No se pudo procesar la resolucion de impresion.'
});

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

router.get('/ventas/print-jobs/ambiguous', checkPermission(['VENTAS_IMPRIMIR']), async (req, res) => {
  try {
    await requireAdministrativePrintRole(req);
    const idSucursal = await resolveAllowedSucursal(req, req.query?.id_sucursal);
    const jobs = await listAmbiguousPrintJobs({ idSucursal });
    return res.json({ ok: true, jobs });
  } catch (error) {
    return sendPrintAdminError(res, error);
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

router.get('/ventas/print-jobs/:id/events', checkPermission(['VENTAS_IMPRIMIR']), async (req, res) => {
  try {
    await requireAdministrativePrintRole(req);
    const jobId = parsePositiveId(req.params.id);
    if (!jobId) return res.status(400).json({ ok: false, code: 'PRINT_JOB_ID_INVALID', message: 'ID invalido.' });
    const jobResult = await pool.query('SELECT id_sucursal FROM public.trabajos_impresion WHERE id_trabajo=$1', [jobId]);
    const job = jobResult.rows[0];
    if (!job) return res.status(404).json({ ok: false, code: 'PRINT_JOB_NOT_FOUND', message: 'Trabajo no encontrado.' });
    const idSucursal = await resolveAllowedSucursal(req, job.id_sucursal);
    const events = await getPrintJobEvents({ idSucursal, jobId });
    return res.json({ ok: true, events });
  } catch (error) {
    return sendPrintAdminError(res, error);
  }
});

const resolvePrintJobHandler = (resolution) => async (req, res) => {
  try {
    await requireAdministrativePrintRole(req);
    const jobId = parsePositiveId(req.params.id);
    if (!jobId) return res.status(400).json({ ok: false, code: 'PRINT_JOB_ID_INVALID', message: 'ID invalido.' });
    const jobResult = await pool.query('SELECT id_sucursal FROM public.trabajos_impresion WHERE id_trabajo=$1', [jobId]);
    const job = jobResult.rows[0];
    if (!job) return res.status(404).json({ ok: false, code: 'PRINT_JOB_NOT_FOUND', message: 'Trabajo no encontrado.' });
    const idSucursal = await resolveAllowedSucursal(req, job.id_sucursal);
    const resolved = await resolvePrintJobAdministratively({
      idSucursal,
      jobId,
      userId: Number(req.user?.id_usuario),
      resolution,
      reason: req.body?.motivo
    });
    return res.json({ ok: true, job: resolved });
  } catch (error) {
    return sendPrintAdminError(res, error);
  }
};

router.post('/ventas/print-jobs/:id/resolve-printed', checkPermission(['VENTAS_IMPRIMIR']), resolvePrintJobHandler('printed'));
router.post('/ventas/print-jobs/:id/resolve-not-printed', checkPermission(['VENTAS_IMPRIMIR']), resolvePrintJobHandler('not_printed'));

export default router;
