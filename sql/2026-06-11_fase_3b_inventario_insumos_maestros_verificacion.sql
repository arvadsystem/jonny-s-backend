-- Microfase 3B - Verificacion de inventario de insumos maestros por sucursal.
-- Archivo solo lectura. No ejecutar automaticamente desde Codex.

SELECT
  'funcion_existente' AS verificacion,
  COUNT(*) AS total
FROM pg_proc p
INNER JOIN pg_namespace n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'fn_mov_inv_apply_stock';

SELECT
  'trigger_existente' AS verificacion,
  COUNT(*) AS total
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
  AND NOT t.tgisinternal;

SELECT
  'restriccion_no_negativa_ausente' AS verificacion,
  COUNT(*) AS total_presente
FROM pg_constraint c
WHERE c.conrelid = 'public.insumos_almacenes'::regclass
  AND c.conname = 'chk_insumos_almacenes_cantidad_no_negativa';

SELECT
  'saldos_locales_negativos' AS verificacion,
  ia.id_insumo,
  ia.id_almacen,
  ia.cantidad
FROM public.insumos_almacenes ia
WHERE COALESCE(ia.cantidad, 0) < 0
ORDER BY ia.id_insumo, ia.id_almacen;

SELECT
  'ambiguedades_maestro_almacen' AS verificacion,
  mm.id_insumo_maestro,
  mm.id_almacen_origen,
  COUNT(*) AS total_mapeos,
  ARRAY_AGG(mm.id_insumo_legacy ORDER BY mm.id_insumo_legacy) AS insumos_legacy
FROM public.insumos_mapeo_maestro mm
GROUP BY mm.id_insumo_maestro, mm.id_almacen_origen
HAVING COUNT(*) > 1
ORDER BY mm.id_insumo_maestro, mm.id_almacen_origen;

SELECT
  'ambiguedades_maestro_sucursal' AS verificacion,
  a.id_sucursal,
  mm.id_insumo_maestro,
  COUNT(*) AS total_asignaciones_activas,
  ARRAY_AGG(mm.id_almacen_origen ORDER BY mm.id_almacen_origen) AS almacenes
FROM public.insumos_mapeo_maestro mm
INNER JOIN public.almacenes a
  ON a.id_almacen = mm.id_almacen_origen
 AND COALESCE(a.estado, true) = true
INNER JOIN public.insumos_almacenes ia
  ON ia.id_insumo = mm.id_insumo_maestro
 AND ia.id_almacen = mm.id_almacen_origen
 AND COALESCE(ia.estado, true) = true
GROUP BY a.id_sucursal, mm.id_insumo_maestro
HAVING COUNT(*) > 1
ORDER BY a.id_sucursal, mm.id_insumo_maestro;

SELECT
  'mapeos_sin_stock_local' AS verificacion,
  mm.id_insumo_maestro,
  mm.id_insumo_legacy,
  mm.id_almacen_origen
FROM public.insumos_mapeo_maestro mm
LEFT JOIN public.insumos_almacenes ia
  ON ia.id_insumo = mm.id_insumo_maestro
 AND ia.id_almacen = mm.id_almacen_origen
WHERE ia.id_insumo IS NULL
ORDER BY mm.id_insumo_maestro, mm.id_almacen_origen, mm.id_insumo_legacy;

SELECT
  'diferencias_stock_local_vs_legacy' AS verificacion,
  mm.id_insumo_maestro,
  mm.id_insumo_legacy,
  mm.id_almacen_origen,
  ia.cantidad AS cantidad_local,
  i.cantidad AS cantidad_legacy,
  ia.cantidad - i.cantidad AS diferencia
FROM public.insumos_mapeo_maestro mm
INNER JOIN public.insumos_almacenes ia
  ON ia.id_insumo = mm.id_insumo_maestro
 AND ia.id_almacen = mm.id_almacen_origen
INNER JOIN public.insumos i
  ON i.id_insumo = mm.id_insumo_legacy
WHERE COALESCE(ia.cantidad, 0) <> COALESCE(i.cantidad, 0)
ORDER BY mm.id_insumo_maestro, mm.id_almacen_origen, mm.id_insumo_legacy;

SELECT
  'movimientos_sin_asignacion' AS verificacion,
  mi.id_movimiento,
  mi.id_insumo,
  mi.id_almacen,
  mi.tipo,
  mi.ref_origen,
  mi.id_ref,
  mi.fecha_mov
FROM public.movimientos_inventario mi
WHERE mi.id_insumo IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.insumos_mapeo_maestro mm
    WHERE mm.id_almacen_origen = mi.id_almacen
      AND (
        mm.id_insumo_maestro = mi.id_insumo
        OR mm.id_insumo_legacy = mi.id_insumo
      )
  )
ORDER BY mi.fecha_mov DESC, mi.id_movimiento DESC;

SELECT
  'conteos_control' AS verificacion,
  (SELECT COUNT(*) FROM public.insumos_mapeo_maestro) AS total_mapeos,
  (SELECT COUNT(*) FROM public.insumos_almacenes) AS total_insumos_almacenes,
  (SELECT COUNT(*) FROM public.movimientos_inventario WHERE id_insumo IS NOT NULL) AS total_movimientos_insumos,
  (
    SELECT COUNT(*)
    FROM public.insumos_mapeo_maestro mm
    INNER JOIN public.almacenes a
      ON a.id_almacen = mm.id_almacen_origen
     AND COALESCE(a.estado, true) = true
    INNER JOIN public.insumos_almacenes ia
      ON ia.id_insumo = mm.id_insumo_maestro
     AND ia.id_almacen = mm.id_almacen_origen
     AND COALESCE(ia.estado, true) = true
  ) AS total_asignaciones_activas,
  (
    SELECT COUNT(*)
    FROM public.insumos_almacenes ia
    WHERE COALESCE(ia.cantidad, 0) < 0
  ) AS total_saldos_locales_negativos;
