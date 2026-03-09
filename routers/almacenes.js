import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// GET: Obtener almacenes
router.get('/almacenes', async (req, res) => {
  try {
    // NEW: extiende el listado legacy con metadatos reales de sucursal y KPIs operativos por almacen.
    // WHY: la nueva UI de Almacenes necesita cards y resumenes sin inventar campos fuera de la BD.
    // IMPACT: conserva `id_almacen`, `id_sucursal` y `nombre`, y solo agrega campos opcionales retrocompatibles.
    const query = `
      WITH inventario_items AS (
        SELECT
          p.id_almacen,
          p.id_producto AS item_id,
          p.cantidad,
          p.stock_minimo,
          p.estado
        FROM public.productos p
        UNION ALL
        SELECT
          i.id_almacen,
          i.id_insumo AS item_id,
          i.cantidad,
          i.stock_minimo,
          i.estado
        FROM public.insumos i
      ),
      movimientos_hoy AS (
        SELECT
          k.id_almacen,
          COUNT(*)::int AS movimientos_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'ENTRADA')::int AS entradas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'SALIDA')::int AS salidas_hoy,
          COUNT(*) FILTER (WHERE k.tipo = 'AJUSTE')::int AS ajustes_hoy
        FROM public.v_kardex_detalle k
        WHERE k.fecha_mov::date = ((now() AT TIME ZONE 'America/Tegucigalpa')::date)
        GROUP BY k.id_almacen
      )
      SELECT
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        s.nombre_sucursal,
        s.estado AS sucursal_estado,
        COUNT(*) FILTER (WHERE ii.item_id IS NOT NULL)::int AS total_items,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
        )::int AS total_items_activos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = false
        )::int AS total_items_inactivos,
        COUNT(*) FILTER (
          WHERE ii.item_id IS NOT NULL
            AND COALESCE(ii.estado, true) = true
            AND ii.cantidad <= COALESCE(ii.stock_minimo, 0)
        )::int AS alertas_stock,
        COALESCE(mh.movimientos_hoy, 0)::int AS movimientos_hoy,
        COALESCE(mh.entradas_hoy, 0)::int AS entradas_hoy,
        COALESCE(mh.salidas_hoy, 0)::int AS salidas_hoy,
        COALESCE(mh.ajustes_hoy, 0)::int AS ajustes_hoy
      FROM public.almacenes a
      LEFT JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      LEFT JOIN inventario_items ii
        ON ii.id_almacen = a.id_almacen
      LEFT JOIN movimientos_hoy mh
        ON mh.id_almacen = a.id_almacen
      GROUP BY
        a.id_almacen,
        a.id_sucursal,
        a.nombre,
        s.nombre_sucursal,
        s.estado,
        mh.movimientos_hoy,
        mh.entradas_hoy,
        mh.salidas_hoy,
        mh.ajustes_hoy
      ORDER BY a.id_almacen ASC
    `;

    const result = await pool.query(query);
    const datos = result.rows || [];
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener almacenes:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// POST: Crear almacén
router.post('/almacenes', async (req, res) => {
  try {
    const tabla = 'almacenes';
    const datos = req.body;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Almacén creado exitosamente.' });
  } catch (err) {
    console.error('Error al crear almacén:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// PUT: Actualizar almacén (1 campo)
router.put('/almacenes', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const tabla = 'almacenes';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valor), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Almacén actualizado correctamente.' });
  } catch (err) {
    console.error('Error al actualizar almacén:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar almacén
router.delete('/almacenes', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    const tabla = 'almacenes';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    res.status(200).json({ message: 'Almacén eliminado.' });
  } catch (err) {
    console.error('Error al eliminar almacén:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
