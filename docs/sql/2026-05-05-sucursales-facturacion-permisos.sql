-- ETAPA 3 Fix - permisos de Facturacion en Sucursales
-- Crea permisos faltantes y asigna solo a SUPER_ADMIN de forma idempotente.

INSERT INTO public.permisos (nombre_permiso)
VALUES
  ('SUCURSALES_FACTURACION_VER'),
  ('SUCURSALES_FACTURACION_EDITAR'),
  ('SUCURSALES_FACTURACION_PREVIEW_VER'),
  ('SUCURSALES_FACTURACION_CAI_VER'),
  ('SUCURSALES_FACTURACION_CAI_GESTIONAR')
ON CONFLICT (nombre_permiso) DO NOTHING;

INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
JOIN public.permisos p
  ON p.nombre_permiso IN (
    'SUCURSALES_FACTURACION_VER',
    'SUCURSALES_FACTURACION_EDITAR',
    'SUCURSALES_FACTURACION_PREVIEW_VER',
    'SUCURSALES_FACTURACION_CAI_VER',
    'SUCURSALES_FACTURACION_CAI_GESTIONAR'
  )
WHERE UPPER(TRIM(r.nombre)) = 'SUPER_ADMIN'
  AND NOT EXISTS (
    SELECT 1
    FROM public.roles_permisos rp
    WHERE rp.id_rol = r.id_rol
      AND rp.id_permiso = p.id_permiso
  );

