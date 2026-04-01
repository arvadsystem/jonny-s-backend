-- Permisos para modulo de Planillas (Personas > Mas)
-- Fecha: 2026-03-27

WITH missing_perms AS (
  SELECT nombre_permiso
  FROM (VALUES
    ('PLANILLAS_MODULO_VER'),
    ('PLANILLAS_LISTADO_VER'),
    ('PLANILLAS_DETALLE_VER'),
    ('PLANILLAS_GENERAR'),
    ('PLANILLAS_RECALCULAR'),
    ('PLANILLAS_ADELANTOS_APLICAR'),
    ('PLANILLAS_MOVIMIENTO_REGISTRAR'),
    ('PLANILLAS_MOVIMIENTO_ANULAR'),
    ('PLANILLAS_CERRAR'),
    ('PLANILLAS_PAGAR'),
    ('PLANILLAS_ANULAR'),
    ('PLANILLAS_AUDITORIA_VER')
  ) AS v(nombre_permiso)
  WHERE NOT EXISTS (
    SELECT 1
    FROM permisos p
    WHERE p.nombre_permiso = v.nombre_permiso
  )
), base AS (
  SELECT COALESCE(MAX(id_permiso), 0) AS max_id FROM permisos
), ins AS (
  INSERT INTO permisos (id_permiso, nombre_permiso)
  SELECT
    base.max_id + ROW_NUMBER() OVER (ORDER BY mp.nombre_permiso),
    mp.nombre_permiso
  FROM missing_perms mp
  CROSS JOIN base
  RETURNING id_permiso, nombre_permiso
)
SELECT * FROM ins;

WITH target_roles AS (
  SELECT id_rol
  FROM roles
  WHERE LOWER(TRIM(nombre)) IN ('administrador', 'super_admin')
), target_perms AS (
  SELECT id_permiso
  FROM permisos
  WHERE nombre_permiso IN (
    'PLANILLAS_MODULO_VER',
    'PLANILLAS_LISTADO_VER',
    'PLANILLAS_DETALLE_VER',
    'PLANILLAS_GENERAR',
    'PLANILLAS_RECALCULAR',
    'PLANILLAS_ADELANTOS_APLICAR',
    'PLANILLAS_MOVIMIENTO_REGISTRAR',
    'PLANILLAS_MOVIMIENTO_ANULAR',
    'PLANILLAS_CERRAR',
    'PLANILLAS_PAGAR',
    'PLANILLAS_ANULAR',
    'PLANILLAS_AUDITORIA_VER'
  )
)
INSERT INTO roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM target_roles r
CROSS JOIN target_perms p
WHERE NOT EXISTS (
  SELECT 1
  FROM roles_permisos rp
  WHERE rp.id_rol = r.id_rol
    AND rp.id_permiso = p.id_permiso
);
