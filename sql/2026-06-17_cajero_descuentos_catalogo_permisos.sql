-- Permisos para que el rol cajero vea y aplique descuentos preconfigurados.
-- Script aditivo e idempotente. No otorga permisos de crear, editar ni cambiar estado.

BEGIN;

INSERT INTO public.permisos (nombre_permiso)
SELECT v.nombre_permiso
FROM (VALUES
  ('VENTAS_DESCUENTOS_CATALOGO_VER'),
  ('VENTAS_DESCUENTO_APLICAR')
) AS v(nombre_permiso)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = UPPER(TRIM(v.nombre_permiso))
);

WITH target_roles AS (
  SELECT r.id_rol
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
),
target_permissions AS (
  SELECT p.id_permiso
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) IN (
    'VENTAS_DESCUENTOS_CATALOGO_VER',
    'VENTAS_DESCUENTO_APLICAR'
  )
)
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM target_roles r
CROSS JOIN target_permissions p
WHERE NOT EXISTS (
  SELECT 1
  FROM public.roles_permisos rp
  WHERE rp.id_rol = r.id_rol
    AND rp.id_permiso = p.id_permiso
);

COMMIT;

-- Verificacion esperada: CAJERO debe tener solo los permisos de lectura/aplicacion listados aqui.
SELECT
  r.id_rol,
  r.nombre AS rol,
  p.nombre_permiso
FROM public.roles r
JOIN public.roles_permisos rp ON rp.id_rol = r.id_rol
JOIN public.permisos p ON p.id_permiso = rp.id_permiso
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
  AND UPPER(TRIM(p.nombre_permiso)) IN (
    'VENTAS_DESCUENTOS_CATALOGO_VER',
    'VENTAS_DESCUENTO_APLICAR',
    'VENTAS_DESCUENTOS_CATALOGO_CREAR',
    'VENTAS_DESCUENTOS_CATALOGO_EDITAR',
    'VENTAS_DESCUENTOS_CATALOGO_ESTADO_CAMBIAR'
  )
ORDER BY p.nombre_permiso;
