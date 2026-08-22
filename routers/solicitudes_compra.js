import express from 'express';
import { requestHasAnyPermission } from '../middleware/checkPermission.js';
import {
  SolicitudesCompraError,
  solicitudesCompraService
} from '../services/solicitudesCompraService.js';
import { solicitudesCompraRevisionService } from '../services/solicitudesCompraRevisionService.js';
import { solicitudesCompraRecepcionService } from '../services/solicitudesCompraRecepcionService.js';
import { capturasCompraRapidaService } from '../services/capturasCompraRapidaService.js';

const router = express.Router();

const CREATE_PERMISSIONS = ['INVENTARIO_OC_CREAR_SOLICITUD', 'INVENTARIO_ORDENES_COMPRA_CREAR'];
const VIEW_PERMISSIONS = [
  'INVENTARIO_OC_VER_FLUJO',
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const CATALOG_PERMISSIONS = Array.from(new Set([...CREATE_PERMISSIONS, ...VIEW_PERMISSIONS]));
const APPROVE_PERMISSIONS = ['INVENTARIO_OC_APROBAR', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const REJECT_PERMISSIONS = ['INVENTARIO_OC_RECHAZAR', 'INVENTARIO_ORDENES_COMPRA_GESTIONAR'];
const REVIEW_PERMISSIONS = Array.from(new Set([...APPROVE_PERMISSIONS, ...REJECT_PERMISSIONS]));
const RECEIVE_PERMISSIONS = ['INVENTARIO_OC_RECEPCIONAR', 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'];
const EVIDENCE_PERMISSIONS = Array.from(new Set([
  'INVENTARIO_OC_VER_EVIDENCIAS',
  'INVENTARIO_OC_VER_DETALLE',
  ...VIEW_PERMISSIONS,
  ...RECEIVE_PERMISSIONS
]));
const QUICK_CAPTURE_CREATE = ['INVENTARIO_OC_CAPTURA_RAPIDA_CREAR'];
const QUICK_CAPTURE_VIEW = ['INVENTARIO_OC_CAPTURA_RAPIDA_VER'];

const requirePermissions = (permissions) => async (req, res, next) => {
  const idUsuario = Number.parseInt(String(req?.user?.id_usuario ?? ''), 10);
  if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
    return res.status(401).json({ ok: false, error: true, code: 'UNAUTHORIZED', message: 'No autorizado.' });
  }
  try {
    if (await requestHasAnyPermission(req, permissions)) return next();
    return res.status(403).json({ ok: false, error: true, code: 'FORBIDDEN', message: 'Permisos insuficientes.' });
  } catch (error) {
    console.error('[solicitudes_compra] permission error', {
      code: error?.code || null,
      message: error?.message || 'Unexpected error'
    });
    return res.status(500).json({ ok: false, error: true, code: 'INTERNAL_ERROR', message: 'No se pudo validar el acceso.' });
  }
};

const sendError = (res, error) => {
  const known = error instanceof SolicitudesCompraError;
  const status = known ? error.status : 500;
  if (!known) {
    console.error('[solicitudes_compra] error', {
      code: error?.code || null,
      message: error?.message || 'Unexpected error'
    });
  }
  return res.status(status).json({
    ok: false,
    error: true,
    code: known ? error.code : 'INTERNAL_ERROR',
    message: known ? error.message : 'No se pudo completar la operacion solicitada.'
  });
};

const handler = (operation, successStatus = null) => async (req, res) => {
  try {
    const result = await operation(req);
    return res.status(successStatus || (operation === solicitudesCompraService.create ? 201 : 200)).json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

router.get('/catalogo', requirePermissions(CATALOG_PERMISSIONS), handler(solicitudesCompraService.listCatalog));
router.get('/proveedores', requirePermissions(REVIEW_PERMISSIONS), handler(solicitudesCompraRevisionService.listProviders));
router.post('/capturas-rapidas', requirePermissions(QUICK_CAPTURE_CREATE), handler(capturasCompraRapidaService.create, 201));
router.post('/capturas-rapidas/:id_captura/evidencias/factura', requirePermissions(QUICK_CAPTURE_CREATE), handler(capturasCompraRapidaService.uploadInvoice));
router.delete('/capturas-rapidas/:id_captura/evidencias/:id_evidencia', requirePermissions(QUICK_CAPTURE_CREATE), handler(capturasCompraRapidaService.deleteEvidence));
router.delete('/capturas-rapidas/:id_captura', requirePermissions(QUICK_CAPTURE_CREATE), handler(capturasCompraRapidaService.discard));
router.put('/capturas-rapidas/:id_captura/enviar', requirePermissions(QUICK_CAPTURE_CREATE), handler(capturasCompraRapidaService.send));
router.get('/capturas-rapidas', requirePermissions(QUICK_CAPTURE_VIEW), handler(capturasCompraRapidaService.list));
router.get('/capturas-rapidas/:id_captura/evidencias', requirePermissions(QUICK_CAPTURE_VIEW), handler(capturasCompraRapidaService.listEvidence));
router.get('/capturas-rapidas/:id_captura', requirePermissions(QUICK_CAPTURE_VIEW), handler(capturasCompraRapidaService.detail));
router.post('/', requirePermissions(CREATE_PERMISSIONS), handler(solicitudesCompraService.create));
router.get('/', requirePermissions(VIEW_PERMISSIONS), handler(solicitudesCompraService.list));
router.put('/:id_solicitud_compra/aprobar', requirePermissions(APPROVE_PERMISSIONS), handler(solicitudesCompraRevisionService.approve));
router.put('/:id_solicitud_compra/rechazar', requirePermissions(REJECT_PERMISSIONS), handler(solicitudesCompraRevisionService.reject));
router.post('/:id_solicitud_compra/evidencias/factura', requirePermissions(RECEIVE_PERMISSIONS), handler(solicitudesCompraRecepcionService.uploadInvoiceEvidence));
router.delete('/:id_solicitud_compra/evidencias/:id_evidencia', requirePermissions(RECEIVE_PERMISSIONS), handler(solicitudesCompraRecepcionService.deleteInvoiceEvidence));
router.post('/:id_solicitud_compra/recibir', requirePermissions(RECEIVE_PERMISSIONS), handler(solicitudesCompraRecepcionService.receive));
router.get('/:id_solicitud_compra/evidencias', requirePermissions(EVIDENCE_PERMISSIONS), handler(solicitudesCompraRecepcionService.listEvidence));
router.get('/:id_solicitud_compra', requirePermissions(VIEW_PERMISSIONS), handler(solicitudesCompraService.getById));

export default router;
