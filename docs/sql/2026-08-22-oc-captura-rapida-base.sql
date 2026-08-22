BEGIN;

CREATE TABLE IF NOT EXISTS public.capturas_compra_rapida (
  id_captura_compra_rapida bigserial PRIMARY KEY,
  id_sucursal integer NOT NULL,
  id_almacen integer NOT NULL,
  id_usuario_registro integer NOT NULL,
  estado varchar(20) NOT NULL DEFAULT 'BORRADOR',
  observacion varchar(1000),
  fecha_creacion timestamp with time zone NOT NULL DEFAULT NOW(),
  fecha_envio timestamp with time zone,
  id_usuario_gestion integer,
  fecha_gestion timestamp with time zone,
  motivo_rechazo varchar(1000),
  id_solicitud_compra integer,
  CONSTRAINT capturas_compra_rapida_sucursal_fk
    FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_almacen_fk
    FOREIGN KEY (id_almacen) REFERENCES public.almacenes(id_almacen)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_usuario_registro_fk
    FOREIGN KEY (id_usuario_registro) REFERENCES public.usuarios(id_usuario)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_usuario_gestion_fk
    FOREIGN KEY (id_usuario_gestion) REFERENCES public.usuarios(id_usuario)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_solicitud_fk
    FOREIGN KEY (id_solicitud_compra) REFERENCES public.solicitudes_compra(id_solicitud_compra)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_estado_ck
    CHECK (estado IN ('BORRADOR', 'PENDIENTE', 'FORMALIZADA', 'RECHAZADA')),
  CONSTRAINT capturas_compra_rapida_consistencia_estado_ck
    CHECK (
      (estado = 'BORRADOR'
        AND fecha_envio IS NULL
        AND id_usuario_gestion IS NULL
        AND fecha_gestion IS NULL
        AND motivo_rechazo IS NULL
        AND id_solicitud_compra IS NULL)
      OR
      (estado = 'PENDIENTE'
        AND fecha_envio IS NOT NULL
        AND id_usuario_gestion IS NULL
        AND fecha_gestion IS NULL
        AND motivo_rechazo IS NULL
        AND id_solicitud_compra IS NULL)
      OR
      (estado = 'FORMALIZADA'
        AND fecha_envio IS NOT NULL
        AND id_usuario_gestion IS NOT NULL
        AND fecha_gestion IS NOT NULL
        AND motivo_rechazo IS NULL
        AND id_solicitud_compra IS NOT NULL)
      OR
      (estado = 'RECHAZADA'
        AND fecha_envio IS NOT NULL
        AND id_usuario_gestion IS NOT NULL
        AND fecha_gestion IS NOT NULL
        AND NULLIF(BTRIM(motivo_rechazo), '') IS NOT NULL
        AND id_solicitud_compra IS NULL)
    ),
  CONSTRAINT capturas_compra_rapida_fecha_envio_ck
    CHECK (fecha_envio IS NULL OR fecha_envio >= fecha_creacion),
  CONSTRAINT capturas_compra_rapida_fecha_gestion_ck
    CHECK (fecha_gestion IS NULL OR (fecha_envio IS NOT NULL AND fecha_gestion >= fecha_envio))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_capturas_compra_rapida_solicitud
  ON public.capturas_compra_rapida (id_solicitud_compra)
  WHERE id_solicitud_compra IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_capturas_compra_rapida_estado_fecha
  ON public.capturas_compra_rapida (estado, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_capturas_compra_rapida_sucursal_estado_fecha
  ON public.capturas_compra_rapida (id_sucursal, estado, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_capturas_compra_rapida_usuario_fecha
  ON public.capturas_compra_rapida (id_usuario_registro, fecha_creacion DESC);

CREATE TABLE IF NOT EXISTS public.capturas_compra_rapida_evidencias (
  id_captura_evidencia bigserial PRIMARY KEY,
  id_captura_compra_rapida bigint NOT NULL,
  id_archivo integer NOT NULL,
  tipo_evidencia varchar(20) NOT NULL DEFAULT 'FACTURA',
  id_usuario_registro integer NOT NULL,
  fecha_registro timestamp with time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT capturas_compra_rapida_evidencias_captura_fk
    FOREIGN KEY (id_captura_compra_rapida)
    REFERENCES public.capturas_compra_rapida(id_captura_compra_rapida)
    ON UPDATE RESTRICT ON DELETE CASCADE,
  CONSTRAINT capturas_compra_rapida_evidencias_archivo_fk
    FOREIGN KEY (id_archivo) REFERENCES public.archivos(id_archivo)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_evidencias_usuario_fk
    FOREIGN KEY (id_usuario_registro) REFERENCES public.usuarios(id_usuario)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT capturas_compra_rapida_evidencias_tipo_ck
    CHECK (tipo_evidencia = 'FACTURA'),
  CONSTRAINT capturas_compra_rapida_evidencias_archivo_uq UNIQUE (id_archivo)
);

CREATE INDEX IF NOT EXISTS idx_capturas_compra_rapida_evidencias_captura_fecha
  ON public.capturas_compra_rapida_evidencias
  (id_captura_compra_rapida, fecha_registro DESC);

WITH requested_perms(nombre_permiso, descripcion) AS (
  VALUES
    ('INVENTARIO_OC_CAPTURA_RAPIDA_CREAR', 'Permite crear y enviar capturas rápidas de compras con factura.'),
    ('INVENTARIO_OC_CAPTURA_RAPIDA_VER', 'Permite consultar capturas rápidas de compras y sus evidencias.'),
    ('INVENTARIO_OC_CAPTURA_RAPIDA_GESTIONAR', 'Permite gestionar, rechazar y formalizar capturas rápidas de compras.')
)
INSERT INTO public.permisos (nombre_permiso, descripcion)
SELECT rp.nombre_permiso, rp.descripcion
FROM requested_perms rp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos p
  WHERE p.nombre_permiso = rp.nombre_permiso
);

WITH role_permissions(nombre_rol, nombre_permiso) AS (
  VALUES
    ('cajero', 'INVENTARIO_OC_CAPTURA_RAPIDA_CREAR'),
    ('cajero', 'INVENTARIO_OC_CAPTURA_RAPIDA_VER'),
    ('cocina', 'INVENTARIO_OC_CAPTURA_RAPIDA_CREAR'),
    ('cocina', 'INVENTARIO_OC_CAPTURA_RAPIDA_VER'),
    ('administrador', 'INVENTARIO_OC_CAPTURA_RAPIDA_VER'),
    ('administrador', 'INVENTARIO_OC_CAPTURA_RAPIDA_GESTIONAR'),
    ('super_admin', 'INVENTARIO_OC_CAPTURA_RAPIDA_VER'),
    ('super_admin', 'INVENTARIO_OC_CAPTURA_RAPIDA_GESTIONAR')
), target_roles AS (
  SELECT r.id_rol,
         REGEXP_REPLACE(LOWER(BTRIM(r.nombre)), '[[:space:]-]+', '_', 'g') AS nombre_rol
  FROM public.roles r
), target_assignments AS (
  SELECT tr.id_rol, p.id_permiso
  FROM role_permissions rp
  INNER JOIN target_roles tr ON tr.nombre_rol = rp.nombre_rol
  INNER JOIN public.permisos p ON p.nombre_permiso = rp.nombre_permiso
)
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT ta.id_rol, ta.id_permiso
FROM target_assignments ta
WHERE NOT EXISTS (
  SELECT 1
  FROM public.roles_permisos existing
  WHERE existing.id_rol = ta.id_rol
    AND existing.id_permiso = ta.id_permiso
);

COMMIT;
