-- Permiso de impresion para el rol cajero.
-- Script aditivo e idempotente. No otorga VENTAS_EXPORTAR ni permisos de administracion.

BEGIN;

INSERT INTO public.permisos (nombre_permiso)
SELECT 'VENTAS_IMPRIMIR'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_IMPRIMIR'
);

WITH target_roles AS (
  SELECT r.id_rol
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
),
target_permissions AS (
  SELECT p.id_permiso
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_IMPRIMIR'
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

-- Verificacion esperada: CAJERO debe tener VENTAS_IMPRIMIR y no debe recibir VENTAS_EXPORTAR por este script.
SELECT
  r.id_rol,
  r.nombre AS rol,
  p.nombre_permiso
FROM public.roles r
JOIN public.roles_permisos rp ON rp.id_rol = r.id_rol
JOIN public.permisos p ON p.id_permiso = rp.id_permiso
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
  AND UPPER(TRIM(p.nombre_permiso)) IN ('VENTAS_IMPRIMIR', 'VENTAS_EXPORTAR')
ORDER BY p.nombre_permiso;
