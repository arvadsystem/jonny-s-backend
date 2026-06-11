-- Microfase 3C - Verificación de asignaciones directas del catálogo maestro.
-- SOLO LECTURA. Ejecutar después de la migración.
-- No contiene INSERT, UPDATE, DELETE, ALTER, DROP ni CREATE.

SELECT
  'vistas_existentes' AS verificacion,
  COUNT(*) FILTER (
    WHERE c.relname = 'vw_productos_maestros_almacen'
  ) AS vista_productos,
  COUNT(*) FILTER (
    WHERE c.relname = 'vw_insumos_maestros_almacen'
  ) AS vista_insumos
FROM pg_class c
INNER JOIN pg_namespace n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.relname IN (
    'vw_productos_maestros_almacen',
    'vw_insumos_maestros_almacen'
  );

-- Contrato exacto de columnas de la vista de productos.
SELECT
  'contrato_vista_productos' AS verificacion,
  ordinal_position,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'vw_productos_maestros_almacen'
ORDER BY ordinal_position;

-- Contrato exacto de columnas de la vista de insumos.
SELECT
  'contrato_vista_insumos' AS verificacion,
  ordinal_position,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'vw_insumos_maestros_almacen'
ORDER BY ordinal_position;

-- Compara únicamente filas locales cuyo ID es un maestro canónico.
SELECT
  'productos_canonicos_locales_vs_vista' AS verificacion,
  (
    SELECT COUNT(*)
    FROM public.productos_almacenes pa
    WHERE EXISTS (
      SELECT 1
      FROM public.productos_mapeo_maestro canonical
      WHERE canonical.id_producto_maestro = pa.id_producto
    )
  ) AS total_local_canonico,
  (
    SELECT COUNT(*)
    FROM public.vw_productos_maestros_almacen
  ) AS total_vista;

SELECT
  'insumos_canonicos_locales_vs_vista' AS verificacion,
  (
    SELECT COUNT(*)
    FROM public.insumos_almacenes ia
    WHERE EXISTS (
      SELECT 1
      FROM public.insumos_mapeo_maestro canonical
      WHERE canonical.id_insumo_maestro = ia.id_insumo
    )
  ) AS total_local_canonico,
  (
    SELECT COUNT(*)
    FROM public.vw_insumos_maestros_almacen
  ) AS total_vista;

-- Asignaciones realmente directas:
-- ID maestro canónico con fila local, pero sin mapeo específico para el almacén.
SELECT
  'asignaciones_directas_reales' AS verificacion,
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
  ) AS productos_directos,
  (
    SELECT COUNT(*)
    FROM public.insumos_almacenes ia
    WHERE EXISTS (
      SELECT 1
      FROM public.insumos_mapeo_maestro canonical
      WHERE canonical.id_insumo_maestro = ia.id_insumo
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.insumos_mapeo_maestro specific_map
        WHERE specific_map.id_insumo_maestro = ia.id_insumo
          AND specific_map.id_almacen_origen = ia.id_almacen
      )
  ) AS insumos_directos;

-- Copias legacy consolidadas almacenadas localmente.
-- Deben quedar excluidas de las vistas maestras.
SELECT
  'filas_locales_legacy_consolidadas' AS verificacion,
  (
    SELECT COUNT(*)
    FROM public.productos_almacenes pa
    INNER JOIN public.productos_mapeo_maestro pm
      ON pm.id_producto_legacy = pa.id_producto
     AND pm.id_almacen_origen = pa.id_almacen
    WHERE pm.id_producto_legacy <> pm.id_producto_maestro
  ) AS productos_legacy_consolidados,
  (
    SELECT COUNT(*)
    FROM public.insumos_almacenes ia
    INNER JOIN public.insumos_mapeo_maestro im
      ON im.id_insumo_legacy = ia.id_insumo
     AND im.id_almacen_origen = ia.id_almacen
    WHERE im.id_insumo_legacy <> im.id_insumo_maestro
  ) AS insumos_legacy_consolidados;

-- Las vistas no deben contener IDs que no sean maestros canónicos.
SELECT
  'vista_productos_no_canonicos' AS verificacion,
  COUNT(*) AS total
FROM public.vw_productos_maestros_almacen v
WHERE NOT EXISTS (
  SELECT 1
  FROM public.productos_mapeo_maestro canonical
  WHERE canonical.id_producto_maestro = v.id_producto_maestro
);

SELECT
  'vista_insumos_no_canonicos' AS verificacion,
  COUNT(*) AS total
FROM public.vw_insumos_maestros_almacen v
WHERE NOT EXISTS (
  SELECT 1
  FROM public.insumos_mapeo_maestro canonical
  WHERE canonical.id_insumo_maestro = v.id_insumo_maestro
);

-- Deben devolver cero filas.
SELECT
  'duplicados_producto_maestro_almacen_mapeo' AS verificacion,
  pm.id_producto_maestro,
  pm.id_almacen_origen,
  COUNT(*) AS total_mapeos
FROM public.productos_mapeo_maestro pm
GROUP BY pm.id_producto_maestro, pm.id_almacen_origen
HAVING COUNT(*) > 1
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen;

SELECT
  'duplicados_insumo_maestro_almacen_mapeo' AS verificacion,
  im.id_insumo_maestro,
  im.id_almacen_origen,
  COUNT(*) AS total_mapeos
FROM public.insumos_mapeo_maestro im
GROUP BY im.id_insumo_maestro, im.id_almacen_origen
HAVING COUNT(*) > 1
ORDER BY im.id_insumo_maestro, im.id_almacen_origen;

-- Deben devolver cero filas para que la prioridad legacy -> maestro sea inequívoca.
SELECT
  'producto_legacy_tambien_maestro' AS verificacion,
  legacy_map.id_producto_legacy
FROM public.productos_mapeo_maestro legacy_map
WHERE legacy_map.id_producto_legacy <> legacy_map.id_producto_maestro
  AND EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro master_map
    WHERE master_map.id_producto_maestro = legacy_map.id_producto_legacy
  )
ORDER BY legacy_map.id_producto_legacy;

SELECT
  'insumo_legacy_tambien_maestro' AS verificacion,
  legacy_map.id_insumo_legacy
FROM public.insumos_mapeo_maestro legacy_map
WHERE legacy_map.id_insumo_legacy <> legacy_map.id_insumo_maestro
  AND EXISTS (
    SELECT 1
    FROM public.insumos_mapeo_maestro master_map
    WHERE master_map.id_insumo_maestro = legacy_map.id_insumo_legacy
  )
ORDER BY legacy_map.id_insumo_legacy;

-- Ambigüedad operativa por sucursal. Deben devolver cero filas.
SELECT
  'ambiguedades_producto_maestro_sucursal' AS verificacion,
  a.id_sucursal,
  pa.id_producto AS id_producto_maestro,
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
GROUP BY a.id_sucursal, pa.id_producto
HAVING COUNT(*) > 1
ORDER BY a.id_sucursal, pa.id_producto;

SELECT
  'ambiguedades_insumo_maestro_sucursal' AS verificacion,
  a.id_sucursal,
  ia.id_insumo AS id_insumo_maestro,
  COUNT(*) AS total_asignaciones_activas,
  ARRAY_AGG(ia.id_almacen ORDER BY ia.id_almacen) AS almacenes
FROM public.insumos_almacenes ia
INNER JOIN public.almacenes a
  ON a.id_almacen = ia.id_almacen
 AND COALESCE(a.estado, true) = true
WHERE COALESCE(ia.estado, true) = true
  AND EXISTS (
    SELECT 1
    FROM public.insumos_mapeo_maestro canonical
    WHERE canonical.id_insumo_maestro = ia.id_insumo
  )
GROUP BY a.id_sucursal, ia.id_insumo
HAVING COUNT(*) > 1
ORDER BY a.id_sucursal, ia.id_insumo;

-- Mapeos que no encuentran la fila local canónica correspondiente.
SELECT
  'mapeos_producto_sin_fila_local_canonica' AS verificacion,
  pm.id_producto_maestro,
  pm.id_producto_legacy,
  pm.id_almacen_origen
FROM public.productos_mapeo_maestro pm
LEFT JOIN public.productos_almacenes pa
  ON pa.id_producto = pm.id_producto_maestro
 AND pa.id_almacen = pm.id_almacen_origen
WHERE pa.id_producto IS NULL
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen, pm.id_producto_legacy;

SELECT
  'mapeos_insumo_sin_fila_local_canonica' AS verificacion,
  im.id_insumo_maestro,
  im.id_insumo_legacy,
  im.id_almacen_origen
FROM public.insumos_mapeo_maestro im
LEFT JOIN public.insumos_almacenes ia
  ON ia.id_insumo = im.id_insumo_maestro
 AND ia.id_almacen = im.id_almacen_origen
WHERE ia.id_insumo IS NULL
ORDER BY im.id_insumo_maestro, im.id_almacen_origen, im.id_insumo_legacy;

-- Diferencias de stock cuando existe una fila legacy específica.
SELECT
  'diferencias_stock_producto_local_vs_legacy' AS verificacion,
  pm.id_producto_maestro,
  pm.id_producto_legacy,
  pm.id_almacen_origen,
  pa.cantidad AS cantidad_local,
  p.cantidad AS cantidad_legacy,
  COALESCE(pa.cantidad, 0) - COALESCE(p.cantidad, 0) AS diferencia
FROM public.productos_mapeo_maestro pm
INNER JOIN public.productos_almacenes pa
  ON pa.id_producto = pm.id_producto_maestro
 AND pa.id_almacen = pm.id_almacen_origen
INNER JOIN public.productos p
  ON p.id_producto = pm.id_producto_legacy
WHERE COALESCE(pa.cantidad, 0) <> COALESCE(p.cantidad, 0)
ORDER BY pm.id_producto_maestro, pm.id_almacen_origen, pm.id_producto_legacy;

SELECT
  'diferencias_stock_insumo_local_vs_legacy' AS verificacion,
  im.id_insumo_maestro,
  im.id_insumo_legacy,
  im.id_almacen_origen,
  ia.cantidad AS cantidad_local,
  i.cantidad AS cantidad_legacy,
  COALESCE(ia.cantidad, 0) - COALESCE(i.cantidad, 0) AS diferencia
FROM public.insumos_mapeo_maestro im
INNER JOIN public.insumos_almacenes ia
  ON ia.id_insumo = im.id_insumo_maestro
 AND ia.id_almacen = im.id_almacen_origen
INNER JOIN public.insumos i
  ON i.id_insumo = im.id_insumo_legacy
WHERE COALESCE(ia.cantidad, 0) <> COALESCE(i.cantidad, 0)
ORDER BY im.id_insumo_maestro, im.id_almacen_origen, im.id_insumo_legacy;

SELECT
  'funcion_y_trigger_instalados' AS verificacion,
  (
    SELECT COUNT(*)
    FROM pg_proc p
    INNER JOIN pg_namespace n
      ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'fn_mov_inv_apply_stock'
  ) AS funcion_existente,
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
  ) AS trigger_existente;

SELECT
  'conteos_control' AS verificacion,
  (
    SELECT COUNT(*)
    FROM public.productos_almacenes pa
    WHERE EXISTS (
      SELECT 1
      FROM public.productos_mapeo_maestro canonical
      WHERE canonical.id_producto_maestro = pa.id_producto
    )
  ) AS productos_locales_canonicos,
  (
    SELECT COUNT(*)
    FROM public.vw_productos_maestros_almacen
  ) AS vista_productos,
  (
    SELECT COUNT(*)
    FROM public.insumos_almacenes ia
    WHERE EXISTS (
      SELECT 1
      FROM public.insumos_mapeo_maestro canonical
      WHERE canonical.id_insumo_maestro = ia.id_insumo
    )
  ) AS insumos_locales_canonicos,
  (
    SELECT COUNT(*)
    FROM public.vw_insumos_maestros_almacen
  ) AS vista_insumos,
  (
    SELECT COUNT(*)
    FROM public.productos_mapeo_maestro
  ) AS total_mapeos_productos,
  (
    SELECT COUNT(*)
    FROM public.insumos_mapeo_maestro
  ) AS total_mapeos_insumos;
