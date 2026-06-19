import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
// AM: hardening RBAC para evitar bypass por rutas CRUD legacy.
const PERM_OC_VIEW_LEGACY = [
  'INVENTARIO_ORDENES_COMPRA_VER_TODAS',
  'INVENTARIO_ORDENES_COMPRA_GESTIONAR',
  'INVENTARIO_ORDENES_COMPRA_CONVERTIR',
  'INVENTARIO_ORDENES_COMPRA_ABASTECER'
];
const PERM_OC_MANAGE_LEGACY = [
  'INVENTARIO_ORDENES_COMPRA_GESTIONAR',
  'INVENTARIO_ORDENES_COMPRA_CONVERTIR',
  'INVENTARIO_ORDENES_COMPRA_ABASTECER'
];
const LEGACY_DISABLED_MESSAGE = 'Este endpoint quedó deshabilitado. Use el workflow oficial de órdenes de compra.';

const blockLegacyWrite = (_req, res) => {
  return res.status(409).json({ error: true, message: LEGACY_DISABLED_MESSAGE });
};

// GET: Obtener compras
router.get('/compras', checkPermission(PERM_OC_VIEW_LEGACY), async (req, res) => {
  try {
    const tabla = 'compras';
    const columnas =
      'id_compra, id_orden_compra, id_proveedor, fecha, total, estado, sub_total, descuento, isv, total_detalle';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener compras:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear compra
router.post('/compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// PUT: Actualizar compra (1 campo)
router.put('/compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// DELETE: Eliminar compra
router.delete('/compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

export default router;
