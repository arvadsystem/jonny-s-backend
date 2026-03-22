BEGIN;

-- AM: timestamp de creacion para mostrar fecha y hora reales en detalle/listado de OC.
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS fecha_creacion timestamp without time zone;

-- AM: backfill seguro para ordenes legacy (usa `fecha` cuando exista, y NOW() como ultimo fallback).
UPDATE public.orden_compras
SET fecha_creacion = COALESCE(fecha_creacion, fecha::timestamp, NOW())
WHERE fecha_creacion IS NULL;

ALTER TABLE public.orden_compras
  ALTER COLUMN fecha_creacion SET DEFAULT NOW();

ALTER TABLE public.orden_compras
  ALTER COLUMN fecha_creacion SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orden_compras_fecha_creacion
  ON public.orden_compras (fecha_creacion DESC);

-- AM: permisos minimos para fase 1 (crear/ver/aprobar y visibilidad cross-sucursal en admin).
INSERT INTO public.permisos (nombre_permiso)
VALUES
  ('INVENTARIO_ORDENES_COMPRA_VER'),
  ('INVENTARIO_ORDENES_COMPRA_CREAR'),
  ('INVENTARIO_ORDENES_COMPRA_VER_TODAS'),
  ('INVENTARIO_ORDENES_COMPRA_GESTIONAR'),
  ('INVENTARIO_ORDENES_COMPRA_RECEPCIONAR')
ON CONFLICT (nombre_permiso) DO NOTHING;

-- AM: habilita al rol administrador para operar la fase 1 completa.
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso IN (
    'INVENTARIO_ORDENES_COMPRA_VER',
    'INVENTARIO_ORDENES_COMPRA_CREAR',
    'INVENTARIO_ORDENES_COMPRA_VER_TODAS',
    'INVENTARIO_ORDENES_COMPRA_GESTIONAR',
    'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'
  )
WHERE lower(trim(r.nombre)) IN ('administrador', 'admin')
ON CONFLICT DO NOTHING;

COMMIT;
