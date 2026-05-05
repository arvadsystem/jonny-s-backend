-- Resumen QA: empleados activos no planillables por sucursal y motivo
-- Usa la misma regla funcional del backend:
-- 1) salario_base > 0
-- 2) cargo normalizado en whitelist planillable

WITH base AS (
  SELECT
    e.id_empleado,
    e.id_sucursal,
    COALESCE(s.nombre_sucursal, 'Sin sucursal') AS sucursal_nombre,
    COALESCE(e.salario_base, 0)::numeric(12,2) AS salario_base,
    COALESCE(e.cargo, '')::varchar AS cargo_original,
    regexp_replace(
      translate(upper(trim(COALESCE(e.cargo, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'),
      '\s+',
      ' ',
      'g'
    ) AS cargo_normalizado
  FROM public.empleados e
  LEFT JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  WHERE e.estado = TRUE
),
clasificado AS (
  SELECT
    b.*,
    CASE
      WHEN b.salario_base <= 0 THEN 'SALARIO_BASE_NO_VALIDO'
      WHEN b.cargo_normalizado NOT IN (
        'ADMINISTRADOR',
        'CAJERO',
        'MESERO',
        'SUPERVISOR',
        'GERENTE',
        'AUXILIAR COCINA',
        'AUXILIAR DE COCINA',
        'COCINERO'
      ) THEN 'CARGO_FUERA_DE_WHITELIST'
      ELSE 'PLANILLABLE'
    END AS estado_planillable
  FROM base b
)
SELECT
  c.id_sucursal,
  c.sucursal_nombre,
  c.estado_planillable,
  COUNT(*)::int AS total_empleados
FROM clasificado c
GROUP BY
  c.id_sucursal,
  c.sucursal_nombre,
  c.estado_planillable
ORDER BY
  c.sucursal_nombre,
  c.estado_planillable;

