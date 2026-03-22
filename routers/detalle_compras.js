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

// GET: Obtener detalle_compras
router.get('/detalle_compras', checkPermission(PERM_OC_VIEW_LEGACY), async (req, res) => {
  try {
    const tabla = 'detalle_compras';
    // AM: expone ambos tipos de item para compatibilidad con detalle mixto (insumo/producto).
    const columnas =
      'id_detalle_compra, id_insumo, id_producto, id_compra, cantidad, sub_total, descuento, total_detalle_compra';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener detalle_compras:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear detalle_compra
router.post('/detalle_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// PUT: Actualizar detalle_compra (1 campo)
router.put('/detalle_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

// DELETE: Eliminar detalle_compra
router.delete('/detalle_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  return blockLegacyWrite(req, res);
});

export default router;
