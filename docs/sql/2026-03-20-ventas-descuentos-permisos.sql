-- Permisos para administracion de descuentos_catalogos en modulo Ventas
-- Fecha: 2026-03-20

WITH missing_perms AS (
  SELECT nombre_permiso
  FROM (VALUES
    ('VENTAS_DESCUENTOS_CATALOGO_VER'),
    ('VENTAS_DESCUENTOS_CATALOGO_CREAR'),
    ('VENTAS_DESCUENTOS_CATALOGO_EDITAR'),
    ('VENTAS_DESCUENTOS_CATALOGO_ESTADO_CAMBIAR')
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
    'VENTAS_DESCUENTOS_CATALOGO_VER',
    'VENTAS_DESCUENTOS_CATALOGO_CREAR',
    'VENTAS_DESCUENTOS_CATALOGO_EDITAR',
    'VENTAS_DESCUENTOS_CATALOGO_ESTADO_CAMBIAR'
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
