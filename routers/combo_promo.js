import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// =====================================================
// MÓDULO 6 - MENÚ
// Router de Combos / Promociones
// NOTA IMPORTANTE:
// - En esta BD, los combos son PRODUCTOS con un id_tipo_departamento = "Combos"
// - El contenido del combo va en la tabla detalle_combo (se verá en otra HU)
// - Se mantiene el patrón del proyecto: function_select, pa_insert, pa_update, pa_delete
// =====================================================

// ==============================
// Helpers internos del router
// ==============================

// // Obtiene el id_tipo_departamento a partir del nombre (ej: "Combos")
const obtenerIdDepartamentoPorNombre = async (nombreDepartamento) => {
  // // Tabla real de departamentos (según tu lista de tablas: tipo_departamento)
  const tabla = 'tipo_departamento';

  // // Columnas mínimas para encontrar el id por nombre
  const columnas = 'id_tipo_departamento, nombre_departamento';

  // // Usamos la función estándar del proyecto para leer
  const query = 'SELECT function_select($1, $2) as resultado';
  const result = await pool.query(query, [tabla, columnas]);

  const departamentos = result.rows[0].resultado || [];

  // // Buscamos por nombre ignorando mayúsculas/minúsculas
  const dep = departamentos.find(
    (d) =>
      String(d.nombre_departamento || '').trim().toLowerCase() ===
      String(nombreDepartamento || '').trim().toLowerCase()
  );

  return dep ? dep.id_tipo_departamento : null;
};

// =====================================================
// GET: Obtener combos (productos filtrados por departamento "Combos")
// URL: /menu/combos
// =====================================================
router.get('/menu/combos', async (req, res) => {
  try {
    // // Nombre del departamento donde caen los combos en tu BD
    const nombreDepartamento = 'Combos';

    // // Buscamos el id del departamento "Combos"
    const idDepartamento = await obtenerIdDepartamentoPorNombre(nombreDepartamento);

    if (!idDepartamento) {
      return res.status(404).json({
        error: true,
        message: 'No existe el departamento "Combos" en tipo_departamento.'
      });
    }

    // // En esta BD, los combos se guardan como productos
    const tabla = 'productos';

    // // Columnas existentes según el router productos.js del equipo
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento';

    // // SELECT estándar del proyecto
    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];

    // // Filtramos solo los productos que pertenecen al departamento "Combos"
    const combos = datos.filter((p) => Number(p.id_tipo_departamento) === Number(idDepartamento));

    // // Devolvemos el arreglo filtrado
    res.status(200).json(combos);

  } catch (err) {
    console.error('Error al obtener combos:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// POST: Crear combo (insert en productos con id_tipo_departamento = "Combos")
// URL: /menu/combos
// =====================================================
router.post('/menu/combos', async (req, res) => {
  try {
    const nombreDepartamento = 'Combos';
    const idDepartamento = await obtenerIdDepartamentoPorNombre(nombreDepartamento);

    if (!idDepartamento) {
      return res.status(404).json({
        error: true,
        message: 'No existe el departamento "Combos" en tipo_departamento.'
      });
    }

    const tabla = 'productos';
    const datos = req.body;

    // // Validación mínima para evitar inserts vacíos
    if (!datos || Object.keys(datos).length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No se recibieron datos para crear el combo.'
      });
    }

    // // Forzamos que el combo SIEMPRE pertenezca a departamento "Combos"
    // // Esto evita que por error lo creen en otro departamento
    datos.id_tipo_departamento = idDepartamento;

    // // INSERT estándar del proyecto
    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Combo creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear combo:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// PUT: Actualizar combo (1 campo) en productos
// URL: /menu/combos
// Body: { campo, valor, id_campo, id_valor }
// NOTA: id_campo debe ser "id_producto"
// =====================================================
router.put('/menu/combos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    // // Tabla real donde viven los combos (productos)
    const tabla = 'productos';

    // // Evitar modificar el identificador por este endpoint
    if (String(campo).toLowerCase() === String(id_campo).toLowerCase()) {
      return res.status(400).json({
        error: true,
        message: 'No se permite modificar el campo identificador'
      });
    }

    // // UPDATE estándar del proyecto (1 campo)
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Combo actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar combo:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// =====================================================
// DELETE: Eliminar combo (delete en productos)
// URL: /menu/combos
// Body: { columna_id, valor_id } -> columna_id debería ser "id_producto"
// =====================================================
router.delete('/menu/combos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'productos';

    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Combo eliminado.' });

  } catch (err) {
    console.error('Error al eliminar combo:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
