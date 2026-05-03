import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const CORREOS_LIST_PERMISSIONS = [
  'PERSONAS_LISTADO_VER',
  'CLIENTES_LISTADO_VER',
  'EMPLEADOS_LISTADO_VER',
  'USUARIOS_LISTADO_VER',
  'EMPRESAS_LISTADO_VER'
];

router.get('/correos', checkPermission(CORREOS_LIST_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_correo, direccion_correo
      FROM correos
      ORDER BY id_correo;
    `);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al obtener correos:', err.message);
    res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;
