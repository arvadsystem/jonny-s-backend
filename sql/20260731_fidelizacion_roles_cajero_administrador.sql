-- Acceso de Fidelizacion por rol.
--
-- CAJERO:
--   - consulta panel, clientes, movimientos y canjes;
--   - puede registrar canjes presenciales;
--   - no puede consultar ni modificar la configuracion de reglas/productos.
--
-- ADMIN / ADMINISTRADOR:
--   - conserva las capacidades operativas del cajero;
--   - puede consultar y modificar reglas y productos canjeables.
--
-- No se concede FIDELIZACION_VER_MULTISUCURSAL. El alcance de sucursal
-- continua resolviendose con las reglas existentes del backend.

BEGIN;

INSERT INTO public.permisos (nombre_permiso)
SELECT requested.nombre_permiso
FROM (VALUES
  ('FIDELIZACION_VER_PANEL'),
  ('FIDELIZACION_VER_CLIENTES'),
  ('FIDELIZACION_VER_MOVIMIENTOS'),
  ('FIDELIZACION_CANJEAR_PRESENCIAL'),
  ('FIDELIZACION_VER_CANJES'),
  ('FIDELIZACION_CONFIGURAR_REGLAS'),
  ('FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES')
) AS requested(nombre_permiso)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos existing
  WHERE UPPER(TRIM(existing.nombre_permiso)) = requested.nombre_permiso
);

DO $$
DECLARE
  v_cajero_count integer;
  v_admin_count integer;
BEGIN
  SELECT COUNT(*)
  INTO v_cajero_count
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO';

  IF v_cajero_count = 0 THEN
    RAISE EXCEPTION 'No existe el rol CAJERO. No se aplicaron permisos de Fidelizacion.';
  END IF;

  SELECT COUNT(*)
  INTO v_admin_count
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('ADMIN', 'ADMINISTRADOR');

  IF v_admin_count = 0 THEN
    RAISE EXCEPTION 'No existe el rol ADMIN o ADMINISTRADOR. No se aplicaron permisos de Fidelizacion.';
  END IF;
END $$;

WITH target_roles AS (
  SELECT r.id_rol
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
),
target_permissions AS (
  SELECT MIN(p.id_permiso) AS id_permiso
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) IN (
    'FIDELIZACION_VER_PANEL',
    'FIDELIZACION_VER_CLIENTES',
    'FIDELIZACION_VER_MOVIMIENTOS',
    'FIDELIZACION_CANJEAR_PRESENCIAL',
    'FIDELIZACION_VER_CANJES'
  )
  GROUP BY UPPER(TRIM(p.nombre_permiso))
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

-- Defensa en profundidad: el rol operativo nunca conserva permisos para
-- consultar o guardar la configuracion administrativa.
DELETE FROM public.roles_permisos rp
USING public.roles r, public.permisos p
WHERE rp.id_rol = r.id_rol
  AND rp.id_permiso = p.id_permiso
  AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO'
  AND UPPER(TRIM(p.nombre_permiso)) IN (
    'FIDELIZACION_CONFIGURAR_REGLAS',
    'FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES'
  );

WITH target_roles AS (
  SELECT r.id_rol
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('ADMIN', 'ADMINISTRADOR')
),
target_permissions AS (
  SELECT MIN(p.id_permiso) AS id_permiso
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) IN (
    'FIDELIZACION_VER_PANEL',
    'FIDELIZACION_VER_CLIENTES',
    'FIDELIZACION_VER_MOVIMIENTOS',
    'FIDELIZACION_CANJEAR_PRESENCIAL',
    'FIDELIZACION_VER_CANJES',
    'FIDELIZACION_CONFIGURAR_REGLAS',
    'FIDELIZACION_GESTIONAR_PRODUCTOS_CANJEABLES'
  )
  GROUP BY UPPER(TRIM(p.nombre_permiso))
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

-- Verificacion esperada:
--   CAJERO: cinco permisos operativos y ninguno administrativo.
--   ADMIN/ADMINISTRADOR: cinco permisos operativos y dos administrativos.
SELECT
  r.id_rol,
  r.nombre AS rol,
  p.nombre_permiso
FROM public.roles r
JOIN public.roles_permisos rp ON rp.id_rol = r.id_rol
JOIN public.permisos p ON p.id_permiso = rp.id_permiso
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN (
  'CAJERO',
  'ADMIN',
  'ADMINISTRADOR'
)
  AND UPPER(TRIM(p.nombre_permiso)) LIKE 'FIDELIZACION_%'
ORDER BY r.nombre, p.nombre_permiso;
