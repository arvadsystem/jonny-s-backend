-- Ajuste de permisos de reversion de ventas.
-- Script idempotente. No otorga VENTAS_REVERSION_CREAR al rol cajero.

BEGIN;

DO $$
DECLARE
  v_id_permiso_reversion integer;
  v_admin_count integer;
  v_super_admin_count integer;
BEGIN
  SELECT MIN(p.id_permiso)
  INTO v_id_permiso_reversion
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR';

  IF v_id_permiso_reversion IS NULL THEN
    RAISE EXCEPTION 'No existe el permiso VENTAS_REVERSION_CREAR. Cree el permiso antes de ajustar roles.';
  END IF;

  SELECT COUNT(*)
  INTO v_admin_count
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('ADMIN', 'ADMINISTRADOR');

  IF v_admin_count = 0 THEN
    RAISE EXCEPTION 'No existe rol ADMIN o ADMINISTRADOR. No se puede confirmar VENTAS_REVERSION_CREAR.';
  END IF;

  SELECT COUNT(*)
  INTO v_super_admin_count
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'SUPER_ADMIN';

  IF v_super_admin_count = 0 THEN
    RAISE EXCEPTION 'No existe rol SUPER_ADMIN. No se puede confirmar VENTAS_REVERSION_CREAR.';
  END IF;

  DELETE FROM public.roles_permisos rp
  USING public.roles r
  WHERE rp.id_rol = r.id_rol
    AND rp.id_permiso = v_id_permiso_reversion
    AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO';

  INSERT INTO public.roles_permisos (id_rol, id_permiso)
  SELECT r.id_rol, v_id_permiso_reversion
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN')
    AND NOT EXISTS (
      SELECT 1
      FROM public.roles_permisos rp
      WHERE rp.id_rol = r.id_rol
        AND rp.id_permiso = v_id_permiso_reversion
    );
END $$;

COMMIT;

-- Verificacion esperada:
-- - CAJERO no debe tener VENTAS_REVERSION_CREAR.
-- - ADMIN, ADMINISTRADOR y SUPER_ADMIN existentes deben tener VENTAS_REVERSION_CREAR.
SELECT
  r.id_rol,
  r.nombre AS rol,
  p.nombre_permiso
FROM public.roles r
LEFT JOIN public.roles_permisos rp
  ON rp.id_rol = r.id_rol
LEFT JOIN public.permisos p
  ON p.id_permiso = rp.id_permiso
 AND UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR'
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('CAJERO', 'ADMIN', 'ADMINISTRADOR', 'SUPER_ADMIN')
ORDER BY r.nombre;
