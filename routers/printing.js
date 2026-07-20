import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission, requestHasAnyRole } from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { buildVentaDetailPayload } from './ventas/handlers/ventasReadHandlers.js';
import { buildPedidoKitchenPrintPayload } from './ventas/services/pedidoKitchenPrintPayloadService.js';
import { enqueuePrintJob } from '../services/printQueueService.js';
import { obtenerConfiguracionImpresorasRuntime } from '../services/impresorasConfigSucursalService.js';
import {
  createCanonicalPrintJob,
  resolveCanonicalPrintWidth
} from '../services/printJobDocumentService.js';
import {
  getPrintJobEvents,
  listAmbiguousPrintJobs,
  resolvePrintJobAdministratively
} from '../services/printQueueAdminService.js';
import { markPedidoVisibleInKitchen } from './ventas/services/pedidoKitchenVisibilityService.js';

const router = express.Router();
const ADMIN_ROLE_CODES = Object.freeze(['ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN']);

const parsePositiveId = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseStrictPositiveId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveAllowedSucursal = async (
  req,
  requestedId,
  queryRunner = pool,
  resolveScope = resolveRequestUserSucursalScope
) => {
  const idSucursal = parsePositiveId(requestedId);
  if (!idSucursal) throw Object.assign(new Error('Sucursal invalida.'), { status: 400, code: 'PRINT_SUCURSAL_INVALID' });
  const scope = await resolveScope(req, queryRunner);
  if (!scope.isSuperAdmin && !scope.allowedSucursalIds.includes(idSucursal)) {
    throw Object.assign(new Error('No tiene permiso para operar esta sucursal.'), { status: 403, code: 'PRINT_SUCURSAL_FORBIDDEN' });
  }
  return idSucursal;
};

const createPrintRequestError = (message, { status = 400, code } = {}) =>
  Object.assign(new Error(message), { status, code });

export const enqueuePedidoComandaPrintJob = async ({
  req,
  idPedido,
  tipoDocumento,
  esReimpresion = false,
  idempotencyKey = '',
  queryRunner = pool,
  loadPedido = buildPedidoKitchenPrintPayload,
  resolveScope = resolveRequestUserSucursalScope,
  loadPrinterConfig = obtenerConfiguracionImpresorasRuntime,
  createPayload = createCanonicalPrintJob,
  enqueue = enqueuePrintJob
}) => {
  const normalizedIdPedido = parseStrictPositiveId(idPedido);
  if (!normalizedIdPedido) {
    throw createPrintRequestError('ID de pedido invalido.', { code: 'PRINT_PEDIDO_INVALID' });
  }

  if (String(tipoDocumento || '').trim().toLowerCase() !== 'comanda') {
    throw createPrintRequestError('Tipo de documento invalido.', { code: 'PRINT_DOCUMENT_TYPE_INVALID' });
  }

  const pedido = await loadPedido(queryRunner, normalizedIdPedido);
  if (!pedido) {
    throw createPrintRequestError('Pedido no encontrado.', { status: 404, code: 'PRINT_PEDIDO_NOT_FOUND' });
  }
  if (parseStrictPositiveId(pedido.id_pedido) !== normalizedIdPedido
    || parseStrictPositiveId(pedido.id_factura)
    || parseStrictPositiveId(pedido.pago?.id_factura)) {
    throw createPrintRequestError('El origen de impresion no corresponde al pedido solicitado.', {
      status: 409,
      code: 'PRINT_PEDIDO_SOURCE_INVALID'
    });
  }

  const idSucursal = await resolveAllowedSucursal(
    req,
    pedido.id_sucursal,
    queryRunner,
    resolveScope
  );
  const isReprint = esReimpresion === true;
  const requestKey = String(idempotencyKey || '').trim();
  const initialKey = `comanda:pedido:${normalizedIdPedido}:inicial`;
  const reprintKeyPrefix = `comanda:pedido-reprint:${normalizedIdPedido}:`;
  if (!isReprint && requestKey && requestKey !== initialKey) {
    throw createPrintRequestError('Idempotency-Key invalido para la impresion inicial.', {
      code: 'PRINT_IDEMPOTENCY_INVALID'
    });
  }
  if (isReprint && !requestKey) {
    throw createPrintRequestError('Idempotency-Key unico es obligatorio para reimpresiones.', {
      code: 'PRINT_IDEMPOTENCY_REQUIRED'
    });
  }
  if (isReprint && (!requestKey.startsWith(reprintKeyPrefix)
    || requestKey.slice(reprintKeyPrefix.length).trim().length === 0)) {
    throw createPrintRequestError('Idempotency-Key invalido para la reimpresion solicitada.', {
      code: 'PRINT_IDEMPOTENCY_INVALID'
    });
  }
  const resolvedIdempotencyKey = isReprint ? requestKey : initialKey;

  const printerConfig = await loadPrinterConfig({
    idSucursal,
    idCaja: Number(pedido.id_caja || 0) || null
  }).catch(() => null);
  const widthMm = resolveCanonicalPrintWidth({
    tipoDocumento: 'comanda',
    venta: pedido,
    printerConfig
  });
  const createdDocument = await createPayload({
    tipoDocumento: 'comanda',
    venta: pedido,
    widthMm
  });
  const payload = createdDocument?.payload || createdDocument;

  const enqueueParams = {
    idSucursal,
    tipoDocumento: 'comanda',
    idempotencyKey: resolvedIdempotencyKey,
    idFactura: null,
    idPedido: normalizedIdPedido,
    idUsuario: Number(req?.user?.id_usuario || 0) || null,
    esReimpresion: isReprint,
    payload
  };
  if (createdDocument?.document) enqueueParams.canonicalDocument = createdDocument.document;
  if (!isReprint) {
    enqueueParams.onInsertedTransaction = ({ client }) => markPedidoVisibleInKitchen({
      client,
      idPedido: normalizedIdPedido
    });
  }
  return enqueue(enqueueParams);
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

export const buildPedidoPrintEnqueueErrorResponse = (error) => ({
  status: error?.status || 500,
  body: {
    ok: false,
    code: error?.status ? (error.code || 'PRINT_ENQUEUE_FAILED') : 'PRINT_ENQUEUE_FAILED',
    message: error?.status ? error.message : 'No se pudo enviar el trabajo de impresion.'
  }
});

router.post('/ventas/pedidos/:idPedido/print-jobs', checkPermission(['VENTAS_IMPRIMIR', 'VENTAS_CREAR']), async (req, res) => {
  try {
    const job = await enqueuePedidoComandaPrintJob({
      req,
      idPedido: req.params.idPedido,
      tipoDocumento: req.body?.tipo_documento,
      esReimpresion: req.body?.es_reimpresion,
      idempotencyKey: req.headers['idempotency-key'] || req.headers['x-idempotency-key']
    });
    return res.status(202).json({ ok: true, message: 'Trabajo enviado a impresion.', job });
  } catch (error) {
    console.error('[printing.enqueue-pedido] fallo', { code: error?.code || null });
    const response = buildPedidoPrintEnqueueErrorResponse(error);
    return res.status(response.status).json(response.body);
  }
});

router.post('/ventas/:id/print-jobs', checkPermission(['VENTAS_IMPRIMIR', 'VENTAS_CREAR']), async (req, res) => {
  try {
    const idFactura = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isInteger(idFactura) || idFactura <= 0) return res.status(400).json({ ok: false, message: 'ID de factura invalido.' });
    const tipoDocumento = String(req.body?.tipo_documento || 'factura').trim().toLowerCase();
    if (!['factura', 'comanda'].includes(tipoDocumento)) return res.status(400).json({ ok: false, message: 'Tipo de documento invalido.' });

    const detail = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: tipoDocumento === 'factura',
      useHistoricalFacturacionSnapshot: true
    });
    if (detail.status !== 200) return res.status(detail.status).json(detail.body);
    const venta = detail.body;
    const isReprint = req.body?.es_reimpresion === true;
    const requestKey = String(req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '').trim();
    const idempotencyKey = requestKey || (isReprint ? '' : `${tipoDocumento}:${idFactura}:inicial`);
    if (!idempotencyKey) return res.status(400).json({ ok: false, code: 'PRINT_IDEMPOTENCY_REQUIRED', message: 'Idempotency-Key es obligatorio para reimpresiones.' });

    const printerConfig = tipoDocumento === 'comanda'
      ? await obtenerConfiguracionImpresorasRuntime({
        idSucursal: Number(venta.id_sucursal),
        idCaja: Number(venta.id_caja || 0) || null
      }).catch(() => null)
      : null;
    const widthMm = resolveCanonicalPrintWidth({ tipoDocumento, venta, printerConfig });
    const createdDocument = await createCanonicalPrintJob({
      tipoDocumento,
      venta,
      widthMm
    });

    const enqueueParams = {
      idSucursal: Number(venta.id_sucursal),
      tipoDocumento,
      idempotencyKey,
      idFactura,
      idPedido: Number(venta.id_pedido || 0) || null,
      idUsuario: Number(req.user?.id_usuario || 0) || null,
      esReimpresion: isReprint,
      payload: createdDocument.payload,
      canonicalDocument: createdDocument.document
    };
    if (tipoDocumento === 'comanda' && !isReprint) {
      enqueueParams.onInsertedTransaction = ({ client }) => markPedidoVisibleInKitchen({
        client,
        idPedido: Number(venta.id_pedido)
      });
    }
    const job = await enqueuePrintJob(enqueueParams);
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
