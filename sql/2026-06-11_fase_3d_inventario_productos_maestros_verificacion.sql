-- Microfase 3D - Verificacion de inventario de productos maestros.
-- SOLO LECTURA. Ejecutar despues de la migracion.
-- No contiene INSERT, UPDATE, DELETE, ALTER, DROP ni CREATE.

-- 1. Funcion y trigger.
SELECT
  'funcion_y_trigger' AS verificacion,
  (
    SELECT COUNT(*)
    FROM pg_proc p
    INNER JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_mov_inv_apply_stock'
  ) AS total_funciones,
  (
    SELECT COUNT(*)
    FROM pg_trigger t
    INNER JOIN pg_class c
      ON c.oid = t.tgrelid
    INNER JOIN pg_namespace n
      ON n.oid = c.relnamespace
    INNER JOIN pg_proc p
      ON p.oid = t.tgfoid
    WHERE n.nspname = 'public'
      AND c.relname = 'movimientos_inventario'
      AND p.proname = 'fn_mov_inv_apply_stock'
      AND NOT t.tgisinternal
  ) AS total_triggers;

-- 2. La funcion instalada debe contener la resolucion local de productos.
SELECT
  'funcion_contiene_logica_3d' AS verificacion,
  POSITION(
    'public.productos_almacenes'
    IN pg_get_functiondef(p.oid)
  ) > 0 AS usa_productos_almacenes,
  POSITION(
    'v_id_producto_original'
    IN pg_get_functiondef(p.oid)
  ) > 0 AS conserva_id_original,
  POSITION(
    'v_producto_tiene_stock_local'
    IN pg_get_functiondef(p.oid)
  ) > 0 AS usa_resolucion_local
FROM pg_proc p
INNER JOIN pg_namespace n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'fn_mov_inv_apply_stock';

-- 3. Despues de la migracion debe devolver 0.
SELECT
  'constraint_cantidad_local_no_negativa' AS verificacion,
  COUNT(*) AS total_constraints_encontradas
FROM pg_constraint c
WHERE c.conrelid = 'public.productos_almacenes'::regclass
  AND c.conname = 'chk_productos_almacenes_cantidad_no_negativa';

-- 4. Informativo: puede ser mayor que 0 si existen faltantes auditados.
SELECT
  'productos_locales_con_saldo_negativo' AS verificacion,
  COUNT(*) AS total
FROM public.productos_almacenes pa
WHERE pa.cantidad < 0;

SELECT
  'detalle_productos_locales_con_saldo_negativo' AS verificacion,
  pa.id_producto,
  pa.id_almacen,
  pa.cantidad,
  pa.stock_minimo,
  pa.estado
FROM public.productos_almacenes pa
WHERE pa.cantidad < 0
ORDER BY pa.id_producto, pa.id_almacen;

-- 5. Debe devolver cero filas.
SELECT
  'duplicados_maestro_almacen' AS verificacion,
  pm.id_producto_maestro,
  pm.id_almacen_origen,
  COUNT(*) AS total_mapeos
FROM public.productos_mapeo_maestro pm
GROUP BY pm.id_producto_maestro, pm.id_almacen_origen
HAVING COUNT(*) > 1
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen;

-- 6. Debe devolver cero filas.
SELECT
  'legacy_consolidado_tambien_maestro' AS verificacion,
  legacy_map.id_producto_legacy
FROM public.productos_mapeo_maestro legacy_map
WHERE legacy_map.id_producto_legacy <> legacy_map.id_producto_maestro
  AND EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro master_map
    WHERE master_map.id_producto_maestro = legacy_map.id_producto_legacy
  )
ORDER BY legacy_map.id_producto_legacy;

-- 7. Conteos de maestros, legacy consolidados y automapeos.
SELECT
  'mapeos_productos' AS verificacion,
  COUNT(*) AS total_mapeos,
  COUNT(DISTINCT pm.id_producto_maestro) AS total_maestros,
  COUNT(*) FILTER (
    WHERE pm.id_producto_legacy <> pm.id_producto_maestro
  ) AS total_legacy_consolidados,
  COUNT(*) FILTER (
    WHERE pm.id_producto_legacy = pm.id_producto_maestro
  ) AS total_automapeos
FROM public.productos_mapeo_maestro pm;

-- 8. Asignaciones directas reales:
-- maestro canonico con fila local, pero sin mapeo especifico para ese almacen.
SELECT
  'asignaciones_directas_reales' AS verificacion,
  pa.id_producto AS id_producto_maestro,
  pa.id_almacen,
  a.id_sucursal,
  pa.cantidad,
  pa.stock_minimo,
  pa.estado
FROM public.productos_almacenes pa
INNER JOIN public.almacenes a
  ON a.id_almacen = pa.id_almacen
WHERE EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro canonical
    WHERE canonical.id_producto_maestro = pa.id_producto
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro specific_map
    WHERE specific_map.id_producto_maestro = pa.id_producto
      AND specific_map.id_almacen_origen = pa.id_almacen
  )
ORDER BY pa.id_producto, pa.id_almacen;

-- 9. Debe devolver cero filas.
SELECT
  'ambiguedades_maestro_sucursal' AS verificacion,
  pa.id_producto AS id_producto_maestro,
  a.id_sucursal,
  COUNT(*) AS total_asignaciones_activas,
  ARRAY_AGG(pa.id_almacen ORDER BY pa.id_almacen) AS almacenes
FROM public.productos_almacenes pa
INNER JOIN public.almacenes a
  ON a.id_almacen = pa.id_almacen
 AND COALESCE(a.estado, true) = true
WHERE COALESCE(pa.estado, true) = true
  AND EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro canonical
    WHERE canonical.id_producto_maestro = pa.id_producto
  )
GROUP BY pa.id_producto, a.id_sucursal
HAVING COUNT(*) > 1
ORDER BY pa.id_producto, a.id_sucursal;

-- 10. Debe devolver cero filas.
SELECT
  'mapeos_sin_fila_local_canonica' AS verificacion,
  pm.id_producto_legacy,
  pm.id_producto_maestro,
  pm.id_almacen_origen
FROM public.productos_mapeo_maestro pm
LEFT JOIN public.productos_almacenes pa
  ON pa.id_producto = pm.id_producto_maestro
 AND pa.id_almacen = pm.id_almacen_origen
WHERE pa.id_producto IS NULL
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen, pm.id_producto_legacy;

-- 11. Mientras exista sincronizacion temporal debe devolver cero filas.
SELECT
  'diferencias_stock_local_vs_legacy' AS verificacion,
  pm.id_producto_legacy,
  pm.id_producto_maestro,
  pm.id_almacen_origen,
  pa.cantidad AS cantidad_local_maestro,
  legacy.cantidad AS cantidad_legacy,
  COALESCE(pa.cantidad, 0) - COALESCE(legacy.cantidad, 0) AS diferencia
FROM public.productos_mapeo_maestro pm
INNER JOIN public.productos_almacenes pa
  ON pa.id_producto = pm.id_producto_maestro
 AND pa.id_almacen = pm.id_almacen_origen
INNER JOIN public.productos legacy
  ON legacy.id_producto = pm.id_producto_legacy
WHERE COALESCE(pa.cantidad, 0) <> COALESCE(legacy.cantidad, 0)
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen, pm.id_producto_legacy;

-- 12. Movimientos que no pueden resolverse como maestro, legacy consolidado
-- ni fallback heredado en el almacen indicado. Debe devolver cero filas.
SELECT
  'movimientos_productos_sin_resolucion' AS verificacion,
  mi.id_movimiento,
  mi.id_producto,
  mi.id_almacen,
  mi.tipo,
  mi.cantidad,
  mi.ref_origen,
  mi.id_ref,
  mi.fecha_mov
FROM public.movimientos_inventario mi
WHERE mi.id_producto IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.productos_almacenes pa
    WHERE pa.id_producto = mi.id_producto
      AND pa.id_almacen = mi.id_almacen
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro pm
    INNER JOIN public.productos_almacenes pa
      ON pa.id_producto = pm.id_producto_maestro
     AND pa.id_almacen = pm.id_almacen_origen
    WHERE pm.id_producto_legacy = mi.id_producto
      AND pm.id_almacen_origen = mi.id_almacen
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.productos legacy
    WHERE legacy.id_producto = mi.id_producto
      AND legacy.id_almacen = mi.id_almacen
  )
ORDER BY mi.fecha_mov DESC, mi.id_movimiento DESC;

-- 13. Movimientos normalizados a un maestro canonico, incluyendo
-- asignaciones directas sin mapeo especifico para el almacen.
SELECT
  'movimientos_normalizados_a_maestros' AS verificacion,
  mi.id_movimiento,
  mi.id_producto AS id_producto_maestro,
  mi.id_almacen,
  a.id_sucursal,
  pm.id_producto_legacy,
  mi.tipo,
  mi.cantidad,
  mi.saldo_antes,
  mi.saldo_despues,
  mi.ref_origen,
  mi.id_ref,
  mi.fecha_mov
FROM public.movimientos_inventario mi
INNER JOIN public.productos_almacenes pa
  ON pa.id_producto = mi.id_producto
 AND pa.id_almacen = mi.id_almacen
INNER JOIN public.almacenes a
  ON a.id_almacen = mi.id_almacen
LEFT JOIN public.productos_mapeo_maestro pm
  ON pm.id_producto_maestro = mi.id_producto
 AND pm.id_almacen_origen = mi.id_almacen
WHERE mi.id_producto IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro canonical
    WHERE canonical.id_producto_maestro = mi.id_producto
  )
ORDER BY mi.fecha_mov DESC, mi.id_movimiento DESC;

-- 14. Movimientos que conservan un ID legacy consolidado.
-- Los movimientos nuevos del flujo maestro no deberian aparecer aqui.
SELECT
  'movimientos_con_id_legacy_consolidado' AS verificacion,
  mi.id_movimiento,
  mi.id_producto AS id_producto_legacy,
  pm.id_producto_maestro,
  mi.id_almacen,
  mi.tipo,
  mi.cantidad,
  mi.ref_origen,
  mi.id_ref,
  mi.fecha_mov
FROM public.movimientos_inventario mi
INNER JOIN public.productos_mapeo_maestro pm
  ON pm.id_producto_legacy = mi.id_producto
 AND pm.id_almacen_origen = mi.id_almacen
 AND pm.id_producto_legacy <> pm.id_producto_maestro
WHERE mi.id_producto IS NOT NULL
ORDER BY mi.fecha_mov DESC, mi.id_movimiento DESC;

-- 15. Conteos generales.
SELECT
  'conteos_control' AS verificacion,
  (SELECT COUNT(*) FROM public.productos_mapeo_maestro) AS total_mapeos,
  (
    SELECT COUNT(DISTINCT id_producto_maestro)
    FROM public.productos_mapeo_maestro
  ) AS total_maestros,
  (
    SELECT COUNT(*)
    FROM public.productos_mapeo_maestro
    WHERE id_producto_legacy <> id_producto_maestro
  ) AS total_legacy_consolidados,
  (
    SELECT COUNT(*)
    FROM public.productos_almacenes pa
    WHERE EXISTS (
      SELECT 1
      FROM public.productos_mapeo_maestro canonical
      WHERE canonical.id_producto_maestro = pa.id_producto
    )
  ) AS total_filas_locales_canonicas,
  (
    SELECT COUNT(*)
    FROM public.productos_almacenes pa
    WHERE EXISTS (
      SELECT 1
      FROM public.productos_mapeo_maestro canonical
      WHERE canonical.id_producto_maestro = pa.id_producto
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.productos_mapeo_maestro specific_map
        WHERE specific_map.id_producto_maestro = pa.id_producto
          AND specific_map.id_almacen_origen = pa.id_almacen
      )
  ) AS total_asignaciones_directas_reales,
  (
    SELECT COUNT(*)
    FROM public.movimientos_inventario
    WHERE id_producto IS NOT NULL
  ) AS total_movimientos_productos;
