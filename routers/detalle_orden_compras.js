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

// GET: Obtener detalle_orden_compras
router.get('/detalle_orden_compras', checkPermission(PERM_OC_VIEW_LEGACY), async (req, res) => {
  try {
    const tabla = 'detalle_orden_compras';
    // AM: expone ambos tipos de item para compatibilidad con detalle mixto (insumo/producto).
    const columnas = 'id_detalle_orden, cantidad_orden, id_orden_compra, id_insumo, id_producto';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener detalle_orden_compras:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear detalle_orden_compra
router.post('/detalle_orden_compras', checkPermission(PERM_OC_CREATE_LEGACY), async (req, res) => {
  try {
    const tabla = 'detalle_orden_compras';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Detalle de orden creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear detalle_orden_compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar detalle_orden_compra (1 campo)
router.put('/detalle_orden_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'detalle_orden_compras';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Detalle de orden actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar detalle_orden_compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar detalle_orden_compra
router.delete('/detalle_orden_compras', checkPermission(PERM_OC_MANAGE_LEGACY), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'detalle_orden_compras';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Detalle de orden eliminado.' });

  } catch (err) {
    console.error('Error al eliminar detalle_orden_compra:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
