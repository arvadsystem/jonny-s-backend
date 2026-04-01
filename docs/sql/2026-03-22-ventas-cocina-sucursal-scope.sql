-- Ventas/Cocina: endurecimiento por sucursal + grants de permisos + base multisucursal sostenible.
-- Fecha: 2026-03-22
-- Nota: script aditivo e idempotente.

BEGIN;

-- 1) Garantizar que exista el permiso COCINA_PEDIDO_INICIAR.
INSERT INTO permisos (nombre_permiso)
SELECT v.nombre_permiso
FROM (VALUES
  ('COCINA_PEDIDO_INICIAR')
) AS v(nombre_permiso)
WHERE NOT EXISTS (
  SELECT 1
  FROM permisos p
  WHERE p.nombre_permiso = v.nombre_permiso
);

-- 2) Grants de cocina para rol cocina y grants relevantes de ventas/cocina para super_admin.
WITH target_roles AS (
  SELECT id_rol, LOWER(TRIM(nombre)) AS role_name
  FROM roles
  WHERE LOWER(TRIM(nombre)) IN ('cocina', 'super_admin')
), target_perms AS (
  SELECT id_permiso, nombre_permiso
  FROM permisos
  WHERE nombre_permiso IN (
    'COCINA_VER',
    'COCINA_ACTUALIZAR_TABLERO',
    'COCINA_BUSCAR',
    'COCINA_DETALLE_VER',
    'COCINA_FILTRAR_SUCURSAL',
    'COCINA_PEDIDO_INICIAR',
    'COCINA_PEDIDO_MARCAR_LISTO',
    'COCINA_PEDIDO_ENTREGAR',
    'VENTAS_VER',
    'VENTAS_DETALLE_VER',
    'VENTAS_CREAR',
    'VENTAS_CARRITO_EDITAR',
    'VENTAS_DESCUENTO_APLICAR',
    'VENTAS_METODO_PAGO_SELECCIONAR'
  )
), role_perm_matrix AS (
  SELECT
    r.id_rol,
    p.id_permiso
  FROM target_roles r
  JOIN target_perms p
    ON (
      (r.role_name = 'cocina' AND p.nombre_permiso = 'COCINA_PEDIDO_INICIAR')
      OR
      (r.role_name = 'super_admin')
    )
)
INSERT INTO roles_permisos (id_rol, id_permiso)
SELECT rpm.id_rol, rpm.id_permiso
FROM role_perm_matrix rpm
WHERE NOT EXISTS (
  SELECT 1
  FROM roles_permisos rp
  WHERE rp.id_rol = rpm.id_rol
    AND rp.id_permiso = rpm.id_permiso
);

-- 3) Base sostenible multisucursal (N:N empleado-sucursal) sin activar runtime aun.
CREATE TABLE IF NOT EXISTS empleados_sucursales (
  id_empleado integer NOT NULL,
  id_sucursal integer NOT NULL,
  es_principal boolean NOT NULL DEFAULT false,
  estado boolean NOT NULL DEFAULT true,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT NOW(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT empleados_sucursales_pk PRIMARY KEY (id_empleado, id_sucursal),
  CONSTRAINT empleados_sucursales_empleado_fk
    FOREIGN KEY (id_empleado) REFERENCES empleados (id_empleado),
  CONSTRAINT empleados_sucursales_sucursal_fk
    FOREIGN KEY (id_sucursal) REFERENCES sucursales (id_sucursal)
);

CREATE INDEX IF NOT EXISTS empleados_sucursales_idx_empleado
  ON empleados_sucursales (id_empleado);

CREATE INDEX IF NOT EXISTS empleados_sucursales_idx_sucursal
  ON empleados_sucursales (id_sucursal);

CREATE UNIQUE INDEX IF NOT EXISTS empleados_sucursales_unq_principal_activa
  ON empleados_sucursales (id_empleado)
  WHERE es_principal = true AND estado = true;

-- Backfill inicial desde empleados.id_sucursal.
INSERT INTO empleados_sucursales (id_empleado, id_sucursal, es_principal, estado)
SELECT
  e.id_empleado,
  e.id_sucursal,
  true,
  true
FROM empleados e
WHERE e.id_sucursal IS NOT NULL
ON CONFLICT (id_empleado, id_sucursal) DO UPDATE
SET
  es_principal = EXCLUDED.es_principal,
  estado = true,
  fecha_actualizacion = NOW();

-- Vista de scope reutilizable para runtime futuro (usuarios -> empleados -> empleados_sucursales).
CREATE OR REPLACE VIEW v_usuarios_sucursales_scope AS
SELECT
  u.id_usuario,
  es.id_sucursal,
  es.es_principal,
  es.estado
FROM usuarios u
INNER JOIN empleados e
  ON e.id_empleado = u.id_empleado
INNER JOIN empleados_sucursales es
  ON es.id_empleado = e.id_empleado
WHERE es.estado = true

UNION

SELECT
  u.id_usuario,
  e.id_sucursal,
  true AS es_principal,
  true AS estado
FROM usuarios u
INNER JOIN empleados e
  ON e.id_empleado = u.id_empleado
WHERE e.id_sucursal IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM empleados_sucursales es
    WHERE es.id_empleado = e.id_empleado
      AND es.id_sucursal = e.id_sucursal
      AND es.estado = true
  );

COMMIT;
