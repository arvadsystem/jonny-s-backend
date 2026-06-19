import express from 'express';
import { checkPermission } from '../../middleware/checkPermission.js';
import {
  changeInsumoPresentacionEstado,
  createInsumoPresentacion,
  listPresentaciones,
  updateInsumoPresentacion
} from './service.js';
import {
  normalizeEstadoPayload,
  normalizePresentationPayload,
  parsePositiveIntegerId
} from './validators.js';

const router = express.Router();

const INSUMO_PRESENTACIONES_VIEW_PERMISSIONS = ['INVENTARIO_INSUMOS_VER', 'INVENTARIO_INSUMOS_DETALLE_VER'];
const INSUMO_PRESENTACIONES_CREATE_PERMISSIONS = ['INVENTARIO_INSUMOS_CREAR', 'INVENTARIO_INSUMOS_EDITAR'];
const INSUMO_PRESENTACIONES_EDIT_PERMISSIONS = ['INVENTARIO_INSUMOS_EDITAR'];
const INSUMO_PRESENTACIONES_STATE_PERMISSIONS = ['INVENTARIO_INSUMOS_ESTADO_CAMBIAR', 'INVENTARIO_INSUMOS_EDITAR'];

const sendError = (res, err, fallbackMessage) => {
  const status = Number.isSafeInteger(err?.status) ? err.status : 500;
  if (status >= 500) console.error('Error en admin_insumo_presentaciones:', err?.message || err);
  return res.status(status).json({
    error: true,
    ...(err?.code ? { code: err.code } : {}),
    message: status >= 500 ? fallbackMessage : err.message
  });
};

const parseRouteIds = (req, res, { includePresentacion = false } = {}) => {
  const idInsumo = parsePositiveIntegerId(req.params.id_insumo, 'id_insumo');
  if (!idInsumo.ok) {
    res.status(400).json({ error: true, message: idInsumo.message });
    return null;
  }
  if (!includePresentacion) return { idInsumo: idInsumo.value };

  const idPresentacion = parsePositiveIntegerId(req.params.id_presentacion, 'id_presentacion');
  if (!idPresentacion.ok) {
    res.status(400).json({ error: true, message: idPresentacion.message });
    return null;
  }
  return { idInsumo: idInsumo.value, idPresentacion: idPresentacion.value };
};

router.get(
  '/:id_insumo/presentaciones',
  checkPermission(INSUMO_PRESENTACIONES_VIEW_PERMISSIONS),
  async (req, res) => {
    try {
      const ids = parseRouteIds(req, res);
      if (!ids) return;
      return res.status(200).json(await listPresentaciones(ids.idInsumo));
    } catch (err) {
      return sendError(res, err, 'No se pudieron cargar las presentaciones del insumo.');
    }
  }
);

router.post(
  '/:id_insumo/presentaciones',
  checkPermission(INSUMO_PRESENTACIONES_CREATE_PERMISSIONS),
  async (req, res) => {
    try {
      const ids = parseRouteIds(req, res);
      if (!ids) return;
      const normalized = normalizePresentationPayload(req.body, { currentEstado: true });
      if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

      const created = await createInsumoPresentacion(ids.idInsumo, normalized.data);
      return res.status(201).json({
        error: false,
        message: 'Presentacion de insumo creada correctamente.',
        ...created
      });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({
          error: true,
          message: 'Ya existe una presentacion predeterminada activa para este insumo.'
        });
      }
      return sendError(res, err, 'No se pudo crear la presentacion del insumo.');
    }
  }
);

router.put(
  '/:id_insumo/presentaciones/:id_presentacion',
  checkPermission(INSUMO_PRESENTACIONES_EDIT_PERMISSIONS),
  async (req, res) => {
    try {
      const ids = parseRouteIds(req, res, { includePresentacion: true });
      if (!ids) return;
      const normalized = normalizePresentationPayload(req.body);
      if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

      const updated = await updateInsumoPresentacion(ids.idInsumo, ids.idPresentacion, normalized.data);
      return res.status(200).json({
        error: false,
        message: 'Presentacion de insumo actualizada correctamente.',
        ...updated
      });
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({
          error: true,
          message: 'Ya existe una presentacion predeterminada activa para este insumo.'
        });
      }
      return sendError(res, err, 'No se pudo actualizar la presentacion del insumo.');
    }
  }
);

router.patch(
  '/:id_insumo/presentaciones/:id_presentacion/estado',
  checkPermission(INSUMO_PRESENTACIONES_STATE_PERMISSIONS),
  async (req, res) => {
    try {
      const ids = parseRouteIds(req, res, { includePresentacion: true });
      if (!ids) return;
      const normalized = normalizeEstadoPayload(req.body);
      if (!normalized.ok) return res.status(400).json({ error: true, message: normalized.message });

      const updated = await changeInsumoPresentacionEstado(
        ids.idInsumo,
        ids.idPresentacion,
        normalized.data.estado
      );
      return res.status(200).json({
        error: false,
        message: 'Estado de la presentacion actualizado correctamente.',
        ...updated
      });
    } catch (err) {
      return sendError(res, err, 'No se pudo cambiar el estado de la presentacion del insumo.');
    }
  }
);

export default router;
