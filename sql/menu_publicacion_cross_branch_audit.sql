-- Auditoria de publicaciones cruzadas en detalle_menu.
-- No destructivo. Solo SELECT.

WITH active_menu AS (
  SELECT
    s.id_sucursal,
    s.nombre_sucursal,
    mv.id_menu,
    m.nombre_menu,
    mv.id_menu_vigente,
    mv.fecha_inicio
  FROM sucursales s
  JOIN LATERAL (
    SELECT mvv.id_menu_vigente, mvv.id_menu, mvv.fecha_inicio
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
  JOIN menu m
    ON m.id_menu = mv.id_menu
)
SELECT
  am.id_sucursal,
  am.nombre_sucursal,
  am.id_menu,
  am.nombre_menu,
  COUNT(dm.id_detalle_menu) AS total_publicaciones_activas,
  COUNT(dm.id_detalle_menu) FILTER (
    WHERE dm.id_producto IS NULL OR ap.id_sucursal = am.id_sucursal
  ) AS total_branch_match,
  COUNT(dm.id_detalle_menu) FILTER (
    WHERE dm.id_producto IS NOT NULL AND ap.id_sucursal <> am.id_sucursal
  ) AS total_cross_branch
FROM active_menu am
LEFT JOIN detalle_menu dm
  ON dm.id_menu = am.id_menu
 AND COALESCE(dm.estado, true) = true
LEFT JOIN productos p
  ON p.id_producto = dm.id_producto
LEFT JOIN almacenes ap
  ON ap.id_almacen = p.id_almacen
GROUP BY am.id_sucursal, am.nombre_sucursal, am.id_menu, am.nombre_menu
ORDER BY am.id_sucursal;

WITH active_menu AS (
  SELECT
    s.id_sucursal,
    s.nombre_sucursal,
    mv.id_menu,
    m.nombre_menu
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
  JOIN menu m
    ON m.id_menu = mv.id_menu
)
SELECT
  am.id_sucursal,
  am.nombre_sucursal,
  am.id_menu,
  am.nombre_menu,
  dm.id_detalle_menu,
  dm.id_producto,
  p.nombre_producto,
  ap.id_sucursal AS id_sucursal_producto
FROM active_menu am
JOIN detalle_menu dm
  ON dm.id_menu = am.id_menu
 AND COALESCE(dm.estado, true) = true
JOIN productos p
  ON p.id_producto = dm.id_producto
JOIN almacenes ap
  ON ap.id_almacen = p.id_almacen
WHERE ap.id_sucursal <> am.id_sucursal
ORDER BY am.id_sucursal, dm.id_detalle_menu;

