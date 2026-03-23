BEGIN;

-- AM: Estado de flujo real para ordenes de compra.
-- AM: Mantiene compatibilidad con `orden_compras.estado` (boolean legacy).
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS estado_flujo varchar(20);

UPDATE public.orden_compras
SET estado_flujo = CASE WHEN COALESCE(estado, false) = true THEN 'ABASTECIDA' ELSE 'PENDIENTE' END
WHERE estado_flujo IS NULL;

ALTER TABLE public.orden_compras
  ALTER COLUMN estado_flujo SET NOT NULL,
  ALTER COLUMN estado_flujo SET DEFAULT 'PENDIENTE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_orden_compras_estado_flujo'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT chk_orden_compras_estado_flujo
      CHECK (estado_flujo IN ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'EN_COMPRA', 'ABASTECIDA', 'CANCELADA'));
  END IF;
END $$;

-- AM: Trazabilidad de revision y abastecimiento para auditoria operativa.
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS observacion_solicitud text;
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS comentario_revision text;
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS id_usuario_revisor integer;
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS fecha_revision timestamp without time zone;
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS fecha_abastecimiento timestamp without time zone;
ALTER TABLE public.orden_compras ADD COLUMN IF NOT EXISTS id_usuario_abastecedor integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_oc_usuario_revisor'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT fk_oc_usuario_revisor
      FOREIGN KEY (id_usuario_revisor) REFERENCES public.usuarios(id_usuario);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_oc_usuario_abastecedor'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT fk_oc_usuario_abastecedor
      FOREIGN KEY (id_usuario_abastecedor) REFERENCES public.usuarios(id_usuario);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oc_estado_flujo ON public.orden_compras (estado_flujo);
CREATE INDEX IF NOT EXISTS idx_oc_id_usuario ON public.orden_compras (id_usuario);
CREATE INDEX IF NOT EXISTS idx_oc_id_usuario_revisor ON public.orden_compras (id_usuario_revisor);
CREATE INDEX IF NOT EXISTS idx_oc_id_usuario_abastecedor ON public.orden_compras (id_usuario_abastecedor);

-- AM: `detalle_orden_compras` ahora soporta producto o insumo con validacion XOR.
ALTER TABLE public.detalle_orden_compras
  ADD COLUMN IF NOT EXISTS id_producto integer;
-- AM: permite detalle mixto; si el item es producto, id_insumo debe aceptar NULL.
ALTER TABLE public.detalle_orden_compras
  ALTER COLUMN id_insumo DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_doc_prod'
      AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT fk_doc_prod
      FOREIGN KEY (id_producto) REFERENCES public.productos(id_producto);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_doc_item_xor'
      AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT chk_doc_item_xor
      CHECK (((id_insumo IS NOT NULL)::int + (id_producto IS NOT NULL)::int) = 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_doc_cantidad_orden_pos'
      AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT chk_doc_cantidad_orden_pos
      CHECK (cantidad_orden > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_doc_id_producto ON public.detalle_orden_compras (id_producto);
CREATE INDEX IF NOT EXISTS idx_doc_id_orden_compra ON public.detalle_orden_compras (id_orden_compra);
CREATE INDEX IF NOT EXISTS idx_doc_id_insumo ON public.detalle_orden_compras (id_insumo);

-- AM: `detalle_compras` ahora soporta producto o insumo con validacion XOR.
ALTER TABLE public.detalle_compras
  ADD COLUMN IF NOT EXISTS id_producto integer;
-- AM: permite detalle mixto; si la compra es de producto, id_insumo debe aceptar NULL.
ALTER TABLE public.detalle_compras
  ALTER COLUMN id_insumo DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_dc_prod'
      AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT fk_dc_prod
      FOREIGN KEY (id_producto) REFERENCES public.productos(id_producto);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_dc_item_xor'
      AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT chk_dc_item_xor
      CHECK (((id_insumo IS NOT NULL)::int + (id_producto IS NOT NULL)::int) = 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_dc_cantidad_pos'
      AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT chk_dc_cantidad_pos
      CHECK (cantidad > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dc_id_producto ON public.detalle_compras (id_producto);
CREATE INDEX IF NOT EXISTS idx_dc_id_compra ON public.detalle_compras (id_compra);
CREATE INDEX IF NOT EXISTS idx_dc_id_insumo ON public.detalle_compras (id_insumo);

-- AM: Permisos minimos del submodulo de ordenes de compra.
INSERT INTO public.permisos (nombre_permiso)
VALUES
  ('INVENTARIO_ORDENES_COMPRA_VER'),
  ('INVENTARIO_ORDENES_COMPRA_CREAR'),
  ('INVENTARIO_ORDENES_COMPRA_VER_TODAS'),
  ('INVENTARIO_ORDENES_COMPRA_GESTIONAR'),
  ('INVENTARIO_ORDENES_COMPRA_CONVERTIR'),
  ('INVENTARIO_ORDENES_COMPRA_ABASTECER')
ON CONFLICT (nombre_permiso) DO NOTHING;

-- AM: Asignacion inicial completa a super_admin.
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
WHERE lower(trim(r.nombre)) = 'super_admin'
ON CONFLICT DO NOTHING;

-- AM: Asignacion inicial minima a cocina y cajero para crear/ver solicitudes propias.
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso IN (
    'INVENTARIO_ORDENES_COMPRA_VER',
    'INVENTARIO_ORDENES_COMPRA_CREAR'
  )
WHERE lower(trim(r.nombre)) IN ('cocina', 'cajero')
ON CONFLICT DO NOTHING;

COMMIT;
