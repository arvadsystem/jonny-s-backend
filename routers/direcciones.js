import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const DIRECCIONES_LIST_PERMISSIONS = [
  'PERSONAS_LISTADO_VER',
  'CLIENTES_LISTADO_VER',
  'EMPLEADOS_LISTADO_VER',
  'USUARIOS_LISTADO_VER',
  'EMPRESAS_LISTADO_VER'
];

router.get('/direcciones', checkPermission(DIRECCIONES_LIST_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_direccion, direccion
      FROM direcciones
      ORDER BY id_direccion;
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener direcciones:', err.message);
    res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;
