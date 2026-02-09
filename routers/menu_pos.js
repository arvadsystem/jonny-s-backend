import express from 'express'; // Importa Express para crear rutas
import pool from '../config/db-connection.js'; // Pool de conexión PostgreSQL

const router = express.Router(); // Inicializa router

// =====================================================
// MÓDULO 6 - MENÚ / POS
// HU-65: Listar productos por categoría (tipo_departamento)
// - SOLO LECTURA
// - NO CRUD de productos
// - Usa function_select
// =====================================================

// =====================================================
// GET: Productos por categoría (POS)
// URL: /menu-pos/productos/:id_tipo_departamento
// Ej: /menu-pos/productos/9  -> Tacos de Birria
// =====================================================
router.get('/menu-pos/productos/:id_tipo_departamento', async (req, res) => {
  try {
    // 1) Obtener id del departamento desde la URL
    const { id_tipo_departamento } = req.params;

    const idDep = Number(id_tipo_departamento); // Convertir a número
    if (Number.isNaN(idDep)) {
      return res.status(400).json({
        ok: false,
        message: 'id_tipo_departamento inválido'
      }); // Validación básica
    }

    // 2) Leer TODOS los productos (solo lectura)
    const tabla = 'productos'; // Tabla productos (NO CRUD)
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento';

    const query = 'SELECT function_select($1, $2) as resultado'; // Select estándar del proyecto
    const result = await pool.query(query, [tabla, columnas]);

    const productos = result.rows[0].resultado || []; // Lista completa

    // 3) Filtrar por categoría (tipo_departamento)
    const productosFiltrados = productos.filter(
      (p) => Number(p.id_tipo_departamento) === idDep
    );

    // 4) Ordenar por nombre (para el POS)
    productosFiltrados.sort((a, b) =>
      String(a.nombre_producto || '').localeCompare(
        String(b.nombre_producto || ''),
        'es',
        { sensitivity: 'base' }
      )
    );

    // 5) Respuesta final
    return res.status(200).json({
      ok: true,
      total: productosFiltrados.length,
      data: productosFiltrados
    });
  } catch (err) {
    console.error('Error al listar productos del menú (HU-65):', err.message);
    return res.status(500).json({
      ok: false,
      message: 'Error al listar productos del menú',
      error: err.message
    });
  }
});

export default router; // Exporta router