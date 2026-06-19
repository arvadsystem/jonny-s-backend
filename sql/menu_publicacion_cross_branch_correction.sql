-- Correccion propuesta para publicaciones cruzadas historicas.
-- NO ejecutar sin respaldo y validacion previa.
-- Objetivo:
-- 1) desactivar filas de detalle_menu con productos de otra sucursal
--    dentro del menu vigente activo de cada sucursal;
-- 2) sembrar productos elegibles faltantes de la sucursal en su menu activo.

BEGIN;

WITH active_menu AS (
  SELECT
    s.id_sucursal,
    mv.id_menu
  FROM sucursales s
  JOIN LATERAL (
    SELECT mvv.id_menu
    FROM menu_vigente mvv
    JOIN menu m2
      ON m2.id_menu = mvv.id_menu
    WHERE mvv.id_sucursal = s.id_sucursal
      AND COALESCE(mvv.estado, true) = true
      AND COALESCE(m2.estado, true) = true
      AND COALESCE(mvv.fecha_inicio, NOW()) <= NOW()
    ORDER BY mvv.fecha_inicio DESC, mvv.id_menu_vigente DESC
    LIMIT 1
  ) mv ON true
),
cross_rows AS (
  SELECT dm.id_detalle_menu
  FROM active_menu am
  JOIN detalle_menu dm
    ON dm.id_menu = am.id_menu
   AND COALESCE(dm.estado, true) = true
  JOIN productos p
    ON p.id_producto = dm.id_producto
  JOIN almacenes ap
    ON ap.id_almacen = p.id_almacen
  WHERE ap.id_sucursal <> am.id_sucursal
)
UPDATE detalle_menu dm
SET
  estado = false,
  visible = false
WHERE dm.id_detalle_menu IN (SELECT id_detalle_menu FROM cross_rows);

WITH aliases AS (
  SELECT UNNEST(ARRAY[
    'cervezas',
    'cerveza',
    'refrescos/agua',
    'refrescos / agua',
    'gaseosas y refrescos',
    'gaseosas/refrescos',
    'aguas, isotónicos y energéticas',
    'aguas, isotonicos y energeticas',
    'helados sarita',
    'snacks',
    'snack'
  ]::text[]) AS alias
),
active_menu AS (
  SELECT
    s.id_sucursal,
    mv.id_menu
  FROM sucursales s
  JOIN LATERAL (
    SELECT mvv.id_menu
    FROM menu_vigente mvv
    JOIN menu m2
      ON m2.id_menu = mvv.id_menu
    WHERE mvv.id_sucursal = s.id_sucursal
      AND COALESCE(mvv.estado, true) = true
      AND COALESCE(m2.estado, true) = true
      AND COALESCE(mvv.fecha_inicio, NOW()) <= NOW()
    ORDER BY mvv.fecha_inicio DESC, mvv.id_menu_vigente DESC
    LIMIT 1
  ) mv ON true
),
eligible_products AS (
  SELECT
    am.id_sucursal,
    am.id_menu,
    p.id_producto
  FROM active_menu am
  JOIN almacenes ap
    ON ap.id_sucursal = am.id_sucursal
  JOIN productos p
    ON p.id_almacen = ap.id_almacen
   AND COALESCE(p.estado, true) = true
  LEFT JOIN categorias_productos cp
    ON cp.id_categoria_producto = p.id_categoria_producto
  WHERE COALESCE(cp.estado, true) = true
    AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(cp.nombre_categoria, '')), '\s*/\s*', '/', 'g')) IN (
      SELECT alias FROM aliases
    )
),
missing_products AS (
  SELECT ep.id_sucursal, ep.id_menu, ep.id_producto
  FROM eligible_products ep
  LEFT JOIN detalle_menu dm
    ON dm.id_menu = ep.id_menu
   AND dm.id_producto = ep.id_producto
   AND COALESCE(dm.estado, true) = true
  WHERE dm.id_detalle_menu IS NULL
),
next_order AS (
  SELECT
    am.id_menu,
    COALESCE(MAX(dm.orden), 0) AS max_orden
  FROM active_menu am
  LEFT JOIN detalle_menu dm
    ON dm.id_menu = am.id_menu
   AND COALESCE(dm.estado, true) = true
  GROUP BY am.id_menu
)
INSERT INTO detalle_menu (
  id_menu,
  estado,
  id_producto,
  visible,
  precio_publico,
  orden
)
SELECT
  mp.id_menu,
  true,
  mp.id_producto,
  true,
  NULL,
  no.max_orden + ROW_NUMBER() OVER (PARTITION BY mp.id_menu ORDER BY mp.id_producto)
FROM missing_products mp
JOIN next_order no
  ON no.id_menu = mp.id_menu
ON CONFLICT DO NOTHING;

COMMIT;
