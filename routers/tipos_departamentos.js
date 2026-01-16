import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// =====================================================
// GET: LISTAR TIPO_DEPARTAMENTO
// =====================================================
router.get('/tipo_departamento', async (req, res) => {
  try {
    const tabla = 'tipo_departamento';
    const columnas = 'id_tipo_departamento,nombre_departamento,descripcion,estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows?.[0]?.resultado || [];
    return res.status(200).json(datos);
  } catch (err) {
    console.error('ERROR GET /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// POST: CREAR TIPO_DEPARTAMENTO
// BODY ESPERADO (EJEMPLO):
// { "nombre_departamento": "Hamburguesas", "descripcion": "...", "estado": true }
// =====================================================
router.post('/tipo_departamento', async (req, res) => {
  try {
    const tabla = 'tipo_departamento';
    const datos = req.body;

    // VALIDACION MINIMA
    if (!datos || !String(datos.nombre_departamento || '').trim()) {
      return res.status(400).json({ error: true, message: 'NOMBRE_DEPARTAMENTO ES OBLIGATORIO' });
    }

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    return res.status(201).json({ message: 'TIPO_DEPARTAMENTO CREADO EXITOSAMENTE.' });
  } catch (err) {
    console.error('ERROR POST /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// PUT: ACTUALIZAR (1 CAMPO POR PETICION)
// BODY ESPERADO:
// {
//   "campo": "nombre_departamento",
//   "valor": "Tacos",
//   "id_campo": "id_tipo_departamento",
//   "id_valor": 2
// }
// =====================================================
router.put('/tipo_departamento', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    // VALIDACION MINIMA
    if (!campo || id_valor === undefined || !id_campo) {
      return res.status(400).json({ error: true, message: 'FALTAN CAMPOS OBLIGATORIOS' });
    }

    const tabla = 'tipo_departamento';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    await pool.query(query, [
      tabla,
      String(campo),
      String(valor),
      String(id_campo),
      String(id_valor),
    ]);

    return res.status(200).json({ message: 'TIPO_DEPARTAMENTO ACTUALIZADO CORRECTAMENTE.' });
  } catch (err) {
    console.error('ERROR PUT /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// DELETE: ELIMINAR
// BODY ESPERADO:
// { "columna_id": "id_tipo_departamento", "valor_id": 2 }
// =====================================================
router.delete('/tipo_departamento', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    // VALIDACION MINIMA
    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'FALTAN DATOS PARA ELIMINAR' });
    }

    const tabla = 'tipo_departamento';
    const query = 'CALL pa_delete($1, $2, $3)';

    await pool.query(query, [tabla, String(columna_id), String(valor_id)]);

    return res.status(200).json({ message: 'TIPO_DEPARTAMENTO ELIMINADO.' });
  } catch (err) {
    console.error('ERROR DELETE /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
