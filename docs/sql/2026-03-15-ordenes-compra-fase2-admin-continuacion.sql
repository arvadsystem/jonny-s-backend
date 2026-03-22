BEGIN;

-- AM: asegura permisos de continuidad de OC en ambientes que aplicaron solo fase 1 minima.
INSERT INTO public.permisos (nombre_permiso)
VALUES
  ('INVENTARIO_ORDENES_COMPRA_VER'),
  ('INVENTARIO_ORDENES_COMPRA_CREAR'),
  ('INVENTARIO_ORDENES_COMPRA_VER_TODAS'),
  ('INVENTARIO_ORDENES_COMPRA_GESTIONAR'),
  ('INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'),
  ('INVENTARIO_ORDENES_COMPRA_CONVERTIR'),
  ('INVENTARIO_ORDENES_COMPRA_ABASTECER')
ON CONFLICT (nombre_permiso) DO NOTHING;

-- AM: habilita al administrador y super_admin para operar la continuacion del flujo (guardar / guardar y abastecer).
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso IN (
    'INVENTARIO_ORDENES_COMPRA_VER',
    'INVENTARIO_ORDENES_COMPRA_CREAR',
    'INVENTARIO_ORDENES_COMPRA_VER_TODAS',
    'INVENTARIO_ORDENES_COMPRA_GESTIONAR',
    'INVENTARIO_ORDENES_COMPRA_CONVERTIR',
    'INVENTARIO_ORDENES_COMPRA_ABASTECER'
  )
WHERE lower(trim(r.nombre)) IN ('administrador', 'admin', 'super_admin')
ON CONFLICT DO NOTHING;

-- AM: el rol administrador no debe registrar recepcion de sucursal; evita solape de etapas.
DELETE FROM public.roles_permisos rp
USING public.roles r, public.permisos p
WHERE rp.id_rol = r.id_rol
  AND rp.id_permiso = p.id_permiso
  AND lower(trim(r.nombre)) IN ('administrador', 'admin')
  AND p.nombre_permiso = 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR';

COMMIT;
