-- Permiso de impresion para el rol cajero.
-- Script aditivo e idempotente. No crea permisos ni otorga VENTAS_EXPORTAR.

BEGIN;

DO $$
DECLARE
  v_id_rol_cajero integer;
  v_id_permiso_imprimir integer;
BEGIN
  SELECT MIN(r.id_rol)
  INTO v_id_rol_cajero
  FROM public.roles r
  WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) = 'CAJERO';

  IF v_id_rol_cajero IS NULL THEN
    RAISE EXCEPTION 'No existe el rol CAJERO. No se asigno VENTAS_IMPRIMIR.';
  END IF;

  SELECT MIN(p.id_permiso)
  INTO v_id_permiso_imprimir
  FROM public.permisos p
  WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_IMPRIMIR';

  IF v_id_permiso_imprimir IS NULL THEN
    RAISE EXCEPTION 'No existe el permiso VENTAS_IMPRIMIR. Cree el permiso antes de asignarlo al rol CAJERO.';
  END IF;

  INSERT INTO public.roles_permisos (id_rol, id_permiso)
  SELECT v_id_rol_cajero, v_id_permiso_imprimir
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.roles_permisos rp
    WHERE rp.id_rol = v_id_rol_cajero
      AND rp.id_permiso = v_id_permiso_imprimir
  );
END $$;

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
