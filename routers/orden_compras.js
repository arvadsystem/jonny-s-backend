import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
// AM: hardening RBAC para evitar bypass por rutas CRUD legacy.
const PERM_OC_VIEW_LEGACY = [
  'INVENTARIO_ORDENES_COMPRA_VER',
  'INVENTARIO_ORDENES_COMPRA_CREAR',
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS'
];
const PERM_OC_CREATE_LEGACY = ['INVENTARIO_ORDENES_COMPRA_CREAR'];
const PERM_OC_MANAGE_LEGACY = [
  'INVENTARIO_ORDENES_COMPRA_GESTIONAR',
  'INVENTARIO_ORDENES_COMPRA_CONVERTIR',
  'INVENTARIO_ORDENES_COMPRA_ABASTECER'
];
const LEGACY_DISABLED_MESSAGE = 'Este endpoint quedó deshabilitado. Use el workflow oficial de órdenes de compra.';

const blockLegacyWrite = (_req, res) => {
  return res.status(409).json({ error: true, message: LEGACY_DISABLED_MESSAGE });
};

// GET: Obtener orden_compras
router.get('/orden_compras', checkPermission(PERM_OC_VIEW_LEGACY), async (req, res) => {
  try {
    const tabla = 'orden_compras';
    // AM: incluye correlativo visible de negocio sin reemplazar el id tecnico interno.
    const columnas = 'id_orden_compra, numero_oc_visible, id_usuario, fecha, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener orden_compras:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear orden_compra
router.post('/orden_compras', checkPermission(PERM_OC_CREATE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// PUT: Actualizar orden_compra (1 campo)
router.put('/orden_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// DELETE: Eliminar orden_compra
router.delete('/orden_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

export default router;
