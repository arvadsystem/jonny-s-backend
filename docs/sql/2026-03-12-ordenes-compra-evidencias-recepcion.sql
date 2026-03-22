BEGIN;

-- AM: evidencia de transferencia y metadata de descuento global en compras.
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS id_archivo_transferencia integer;
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS referencia_transferencia text;
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS descuento_tipo varchar(15) DEFAULT 'MONTO';
ALTER TABLE public.compras
  ADD COLUMN IF NOT EXISTS descuento_valor numeric(14,2) DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_compras_archivo_transferencia'
      AND conrelid = 'public.compras'::regclass
  ) THEN
    ALTER TABLE public.compras
      ADD CONSTRAINT fk_compras_archivo_transferencia
      FOREIGN KEY (id_archivo_transferencia) REFERENCES public.archivos(id_archivo);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_compras_descuento_tipo'
      AND conrelid = 'public.compras'::regclass
  ) THEN
    ALTER TABLE public.compras
      ADD CONSTRAINT chk_compras_descuento_tipo
      CHECK (UPPER(COALESCE(descuento_tipo, 'MONTO')) IN ('MONTO', 'PORCENTAJE'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_compras_descuento_valor_nonneg'
      AND conrelid = 'public.compras'::regclass
  ) THEN
    ALTER TABLE public.compras
      ADD CONSTRAINT chk_compras_descuento_valor_nonneg
      CHECK (COALESCE(descuento_valor, 0) >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_compras_id_archivo_transferencia ON public.compras(id_archivo_transferencia);

-- AM: evidencia de recepcion para bandeja administrativa previa al abastecimiento oficial.
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS id_archivo_factura_recepcion integer;
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS id_usuario_recepcion integer;
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS fecha_recepcion_reportada timestamp without time zone;
ALTER TABLE public.orden_compras
  ADD COLUMN IF NOT EXISTS observacion_recepcion text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_oc_archivo_factura_recepcion'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT fk_oc_archivo_factura_recepcion
      FOREIGN KEY (id_archivo_factura_recepcion) REFERENCES public.archivos(id_archivo);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_oc_usuario_recepcion'
      AND conrelid = 'public.orden_compras'::regclass
  ) THEN
    ALTER TABLE public.orden_compras
      ADD CONSTRAINT fk_oc_usuario_recepcion
      FOREIGN KEY (id_usuario_recepcion) REFERENCES public.usuarios(id_usuario);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oc_id_archivo_factura_recepcion ON public.orden_compras(id_archivo_factura_recepcion);
CREATE INDEX IF NOT EXISTS idx_oc_id_usuario_recepcion ON public.orden_compras(id_usuario_recepcion);
CREATE INDEX IF NOT EXISTS idx_oc_fecha_recepcion_reportada ON public.orden_compras(fecha_recepcion_reportada);

-- AM: solicitudes de creacion para items no existentes en catalogo (producto/insumo).
CREATE TABLE IF NOT EXISTS public.orden_compra_solicitudes_item (
  id_solicitud_item integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_orden_compra integer NOT NULL,
  tipo_item varchar(20) NOT NULL,
  nombre_sugerido varchar(160) NOT NULL,
  descripcion text,
  cantidad_sugerida integer NOT NULL DEFAULT 1,
  estado varchar(20) NOT NULL DEFAULT 'PENDIENTE',
  id_usuario_creador integer NOT NULL,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT NOW(),
  id_usuario_revisor integer,
  fecha_revision timestamp without time zone,
  comentario_revision text,
  CONSTRAINT fk_ocsi_orden FOREIGN KEY (id_orden_compra) REFERENCES public.orden_compras(id_orden_compra),
  CONSTRAINT fk_ocsi_usuario_creador FOREIGN KEY (id_usuario_creador) REFERENCES public.usuarios(id_usuario),
  CONSTRAINT fk_ocsi_usuario_revisor FOREIGN KEY (id_usuario_revisor) REFERENCES public.usuarios(id_usuario),
  CONSTRAINT chk_ocsi_tipo_item CHECK (tipo_item IN ('producto', 'insumo')),
  CONSTRAINT chk_ocsi_cantidad_pos CHECK (cantidad_sugerida > 0),
  CONSTRAINT chk_ocsi_estado CHECK (estado IN ('PENDIENTE', 'EN_REVISION', 'ATENDIDA', 'RECHAZADA'))
);

CREATE INDEX IF NOT EXISTS idx_ocsi_id_orden_compra ON public.orden_compra_solicitudes_item(id_orden_compra);
CREATE INDEX IF NOT EXISTS idx_ocsi_estado ON public.orden_compra_solicitudes_item(estado);
CREATE INDEX IF NOT EXISTS idx_ocsi_tipo_item ON public.orden_compra_solicitudes_item(tipo_item);

-- AM: permiso para reportar recepcion/factura por cajero/cocina/admin.
INSERT INTO public.permisos (nombre_permiso)
VALUES ('INVENTARIO_ORDENES_COMPRA_RECEPCIONAR')
ON CONFLICT (nombre_permiso) DO NOTHING;

INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso = 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'
WHERE lower(trim(r.nombre)) = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso = 'INVENTARIO_ORDENES_COMPRA_RECEPCIONAR'
WHERE lower(trim(r.nombre)) IN ('cocina', 'cajero')
ON CONFLICT DO NOTHING;

COMMIT;
