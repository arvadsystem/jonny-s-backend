import express from 'express'; // Importa Express para crear rutas
import pool from '../config/db-connection.js'; // Importa el pool de conexión a PostgreSQL

const router = express.Router(); // Inicializa el router

// =====================================================
// MÓDULO 6 - MENÚ
// Combos definidos SOLO en detalle_combo
// - Usar: function_select, pa_insert, pa_update, pa_delete
// =====================================================

// =====================================================
// GET: Obtener combos (lista de productos del dep "Combos") - SOLO LECTURA
// URL: /menu/combos
// Nota: esto sirve para que el súper admin seleccione el id_producto_combo existente
// =====================================================
router.get('/menu/combos', async (req, res) => {
  try {
    // 1) Buscar el id del departamento "Combos" en tipo_departamento
    const tablaDep = 'tipo_departamento'; // Tabla de departamentos
    const columnasDep = 'id_tipo_departamento, nombre_departamento, estado'; // Columnas a leer

    const qDep = 'SELECT function_select($1, $2) as resultado'; // Select estándar del proyecto
    const rDep = await pool.query(qDep, [tablaDep, columnasDep]); // Ejecuta select

    const departamentos = rDep.rows[0].resultado || []; // Obtiene lista de departamentos
    const depCombos = departamentos.find(
      (d) =>
        String(d.nombre_departamento || '').trim().toLowerCase() === 'combos' &&
        (d.estado === true || d.estado === 'true' || d.estado === 1)
    ); // Encuentra el departamento "Combos" activo

    if (!depCombos) {
      return res.status(404).json({
        error: true,
        message: 'No existe el departamento "Combos" en tipo_departamento.'
      }); // Si no existe, retorna 404
    }

    // 2) Leer productos y filtrar por id_tipo_departamento = depCombos.id_tipo_departamento
    const tabla = 'productos'; // Tabla de productos (solo lectura)
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento'; // Columnas necesarias

    const q = 'SELECT function_select($1, $2) as resultado'; // Select estándar del proyecto
    const r = await pool.query(q, [tabla, columnas]); // Ejecuta select

    const datos = r.rows[0].resultado || []; // Lista de productos
    const combos = datos.filter(
      (p) => Number(p.id_tipo_departamento) === Number(depCombos.id_tipo_departamento)
    ); // Filtra los productos que pertenecen al departamento "Combos"

    return res.status(200).json(combos); // Devuelve combos encontrados
  } catch (err) {
    console.error('Error al obtener combos:', err.message); // Log de error
    return res.status(500).json({ error: true, message: err.message }); // Respuesta de error
  }
});

// =====================================================
// GET: Obtener detalle_combo
// URL: /menu/combos/detalle
// =====================================================
router.get('/menu/combos/detalle', async (req, res) => {
  try {
    const tabla = 'detalle_combo'; // Tabla detalle_combo
    const columnas = 'id_detalle_combo, id_producto_combo, id_producto_item, cantidad, estado'; // Columnas a leer

    const query = 'SELECT function_select($1, $2) as resultado'; // Select estándar del proyecto
    const result = await pool.query(query, [tabla, columnas]); // Ejecuta select

    const datos = result.rows[0].resultado || []; // Obtiene datos
    return res.status(200).json(datos); // Devuelve lista de detalle_combo
  } catch (err) {
    console.error('Error al obtener detalle_combo:', err.message); // Log de error
    return res.status(500).json({ error: true, message: err.message }); // Respuesta de error
  }
});

// =====================================================
// POST: Insertar detalle_combo (HU 6.1)
// URL: /menu/combos/detalle
// Body: { id_producto_combo, id_producto_item, cantidad }
// =====================================================
router.post('/menu/combos/detalle', async (req, res) => {
  try {
    const tabla = 'detalle_combo'; // Tabla objetivo
    const datos = req.body; // Body recibido

    // Validación mínima
    if (!datos || Object.keys(datos).length === 0) {
      return res.status(400).json({
        error: true,
        message: 'No se recibieron datos para crear el detalle del combo.'
      }); // Error si no hay datos
    }

    if (!datos.id_producto_combo || !datos.id_producto_item || datos.cantidad === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Faltan campos obligatorios: id_producto_combo, id_producto_item, cantidad'
      }); // Error si faltan campos
    }

    if (Number(datos.cantidad) <= 0) {
      return res.status(400).json({
        error: true,
        message: 'La cantidad debe ser mayor a 0'
      }); // Error si cantidad es inválida
    }

    // Forzamos estado por defecto
    if (datos.estado === undefined) {
      datos.estado = true; // Estado activo por defecto
    }

    // INSERT estándar del proyecto
    const query = 'CALL pa_insert($1, $2)'; // Procedimiento estándar de insert
    await pool.query(query, [tabla, datos]); // Ejecuta insert

    return res.status(201).json({ message: 'Detalle de combo creado exitosamente.' }); // Respuesta ok
  } catch (err) {
    console.error('Error al crear detalle_combo:', err.message); // Log error
    return res.status(500).json({ error: true, message: err.message }); // Respuesta error
  }
});

// =====================================================
// PUT: Actualizar detalle_combo (HU 61 / HU 62)
// URL: /menu/combos/detalle
// Body: { campo, valor, id_campo, id_valor }
// Ej cambiar cantidad:
//  { "campo":"cantidad","valor":3,"id_campo":"id_detalle_combo","id_valor":10 }
// Ej desactivar (HU 62):
//  { "campo":"estado","valor":false,"id_campo":"id_detalle_combo","id_valor":10 }
// =====================================================
router.put('/menu/combos/detalle', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body; // Lee parámetros

    // Validación mínima (misma estructura que productos)
    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' }); // Error si faltan campos
    }

    // Validación específica: si actualizan cantidad, debe ser > 0
    if (String(campo).toLowerCase() === 'cantidad' && Number(valor) <= 0) {
      return res.status(400).json({ error: true, message: 'La cantidad debe ser mayor a 0' }); // Error por cantidad inválida
    }

    const tabla = 'detalle_combo'; // Tabla objetivo
    const query = 'CALL pa_update($1, $2, $3, $4, $5)'; // Procedimiento estándar update
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]); // Ejecuta update

    return res.status(200).json({ message: 'Detalle de combo actualizado correctamente.' }); // Respuesta ok
  } catch (err) {
    console.error('Error al actualizar detalle_combo:', err.message); // Log error
    return res.status(500).json({ error: true, message: err.message }); // Respuesta error
  }
});

// =====================================================
// DELETE: Eliminar detalle_combo (CRUD completo)
// URL: /menu/combos/detalle
// Body: { columna_id, valor_id }
// Nota: HU 62 se cumple con PUT estado=false, pero CRUD completo incluye DELETE.
// =====================================================
router.delete('/menu/combos/detalle', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body; // Lee parámetros

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' }); // Error si faltan datos
    }

    const tabla = 'detalle_combo'; // Tabla objetivo
    const query = 'CALL pa_delete($1, $2, $3)'; // Procedimiento estándar delete
    await pool.query(query, [tabla, columna_id, String(valor_id)]); // Ejecuta delete

    return res.status(200).json({ message: 'Detalle de combo eliminado.' }); // Respuesta ok
  } catch (err) {
    console.error('Error al eliminar detalle_combo:', err.message); // Log error
    return res.status(500).json({ error: true, message: err.message }); // Respuesta error
  }
});

export default router; // Exporta router