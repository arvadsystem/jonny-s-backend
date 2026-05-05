-- Diagnostico de empleados que NO califican para planilla
-- Regla backend vigente:
-- 1) salario_base > 0
-- 2) cargo en whitelist:
--    ADMINISTRADOR, CAJERO, MESERO, SUPERVISOR, GERENTE,
--    AUXILIAR COCINA, AUXILIAR DE COCINA, COCINERO

WITH empleados_activos AS (
  SELECT
    e.id_empleado,
    e.id_sucursal,
    COALESCE(s.nombre_sucursal, 'Sin sucursal') AS sucursal_nombre,
    TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS nombre_completo,
    COALESCE(e.salario_base, 0)::numeric(12,2) AS salario_base,
    COALESCE(e.cargo, '')::varchar AS cargo_original,
    regexp_replace(
      translate(upper(trim(COALESCE(e.cargo, ''))), 'ÁÉÍÓÚÜÑ', 'AEIOUUN'),
      '\s+',
      ' ',
      'g'
    ) AS cargo_normalizado
  FROM public.empleados e
  LEFT JOIN public.personas p
    ON p.id_persona = e.id_persona
  LEFT JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  WHERE e.estado = TRUE
)
SELECT
  ea.id_empleado,
  ea.id_sucursal,
  ea.sucursal_nombre,
  ea.nombre_completo,
  ea.salario_base,
  ea.cargo_original AS cargo,
  ea.cargo_normalizado,
  CASE
    WHEN ea.salario_base <= 0 THEN 'SALARIO_BASE_NO_VALIDO'
    WHEN ea.cargo_normalizado NOT IN (
      'ADMINISTRADOR',
      'CAJERO',
      'MESERO',
      'SUPERVISOR',
      'GERENTE',
      'AUXILIAR COCINA',
      'AUXILIAR DE COCINA',
      'COCINERO'
    ) THEN 'CARGO_FUERA_DE_WHITELIST'
    ELSE 'OK'
  END AS motivo_exclusion
FROM empleados_activos ea
WHERE
  ea.salario_base <= 0
  OR ea.cargo_normalizado NOT IN (
    'ADMINISTRADOR',
    'CAJERO',
    'MESERO',
    'SUPERVISOR',
    'GERENTE',
    'AUXILIAR COCINA',
    'AUXILIAR DE COCINA',
    'COCINERO'
  )
ORDER BY ea.sucursal_nombre, ea.nombre_completo, ea.id_empleado;

