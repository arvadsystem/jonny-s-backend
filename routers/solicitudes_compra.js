import express from 'express';
import { requestHasAnyPermission } from '../middleware/checkPermission.js';
import {
  SolicitudesCompraError,
  solicitudesCompraService
} from '../services/solicitudesCompraService.js';

const router = express.Router();

const CREATE_PERMISSIONS = ['INVENTARIO_OC_CREAR_SOLICITUD', 'INVENTARIO_ORDENES_COMPRA_CREAR'];
const VIEW_PERMISSIONS = [
  'INVENTARIO_OC_VER_FLUJO',
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const CATALOG_PERMISSIONS = Array.from(new Set([...CREATE_PERMISSIONS, ...VIEW_PERMISSIONS]));

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

const handler = (operation) => async (req, res) => {
  try {
    const result = await operation(req);
    return res.status(operation === solicitudesCompraService.create ? 201 : 200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
};

router.get('/catalogo', requirePermissions(CATALOG_PERMISSIONS), handler(solicitudesCompraService.listCatalog));
router.post('/', requirePermissions(CREATE_PERMISSIONS), handler(solicitudesCompraService.create));
router.get('/', requirePermissions(VIEW_PERMISSIONS), handler(solicitudesCompraService.list));
router.get('/:id_solicitud_compra', requirePermissions(VIEW_PERMISSIONS), handler(solicitudesCompraService.getById));

export default router;
