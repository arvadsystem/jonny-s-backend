-- Script idempotente para habilitar acceso a Clientes (catalogos de Personas/Empresas)
-- Rol objetivo: cajero
-- Tablas reales del proyecto: roles, permisos, roles_permisos

DO $$
DECLARE
  v_id_rol_cajero INT;
  v_rows_inserted INT := 0;
BEGIN
  SELECT r.id_rol
  INTO v_id_rol_cajero
  FROM roles r
  WHERE LOWER(TRIM(r.nombre)) = 'cajero'
  LIMIT 1;

  IF v_id_rol_cajero IS NULL THEN
    RAISE NOTICE 'No se encontro el rol "cajero". No se aplicaron cambios.';
    RETURN;
  END IF;

  WITH permisos_objetivo AS (
    SELECT p.id_permiso, UPPER(TRIM(p.nombre_permiso)) AS nombre_permiso
    FROM permisos p
    WHERE UPPER(TRIM(p.nombre_permiso)) IN (
      'PERSONAS_LISTADO_VER',
      'EMPRESAS_LISTADO_VER',
      -- Compatibilidad legacy (si existen en esta BD):
      'PERSONAS_VER',
      'EMPRESAS_VER'
    )
  ),
  inserciones AS (
    INSERT INTO roles_permisos (id_permiso, id_rol)
    SELECT po.id_permiso, v_id_rol_cajero
    FROM permisos_objetivo po
    WHERE NOT EXISTS (
      SELECT 1
      FROM roles_permisos rp
      WHERE rp.id_rol = v_id_rol_cajero
        AND rp.id_permiso = po.id_permiso
    )
    RETURNING 1
  )
  SELECT COUNT(*)
  INTO v_rows_inserted
  FROM inserciones;

  RAISE NOTICE 'Permisos asignados al rol cajero: %', v_rows_inserted;
END $$;

-- Verificacion rapida:
SELECT
  r.id_rol,
  r.nombre AS rol,
  p.id_permiso,
  p.nombre_permiso
FROM roles r
JOIN roles_permisos rp ON rp.id_rol = r.id_rol
JOIN permisos p ON p.id_permiso = rp.id_permiso
WHERE LOWER(TRIM(r.nombre)) = 'cajero'
  AND UPPER(TRIM(p.nombre_permiso)) IN (
    'PERSONAS_LISTADO_VER',
    'EMPRESAS_LISTADO_VER',
    'PERSONAS_VER',
    'EMPRESAS_VER'
  )
ORDER BY p.nombre_permiso;
