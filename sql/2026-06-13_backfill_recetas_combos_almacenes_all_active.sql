INSERT INTO public.menu_receta_almacenes (
  id_receta,
  id_almacen,
  estado,
  fecha_creacion,
  fecha_actualizacion
)
SELECT
  r.id_receta,
  a.id_almacen,
  true,
  NOW(),
  NOW()
FROM public.recetas r
INNER JOIN public.almacenes a
  ON COALESCE(a.estado, true) = true
INNER JOIN public.sucursales s
  ON s.id_sucursal = a.id_sucursal
 AND COALESCE(s.estado, true) = true
WHERE COALESCE(r.estado, true) = true
ON CONFLICT (id_receta, id_almacen)
DO UPDATE SET
  estado = true,
  fecha_actualizacion = NOW();

INSERT INTO public.menu_combo_almacenes (
  id_combo,
  id_almacen,
  estado,
  fecha_creacion,
  fecha_actualizacion
)
SELECT
  c.id_combo,
  a.id_almacen,
  true,
  NOW(),
  NOW()
FROM public.combos c
INNER JOIN public.almacenes a
  ON COALESCE(a.estado, true) = true
INNER JOIN public.sucursales s
  ON s.id_sucursal = a.id_sucursal
 AND COALESCE(s.estado, true) = true
WHERE COALESCE(c.estado, true) = true
ON CONFLICT (id_combo, id_almacen)
DO UPDATE SET
  estado = true,
  fecha_actualizacion = NOW();
