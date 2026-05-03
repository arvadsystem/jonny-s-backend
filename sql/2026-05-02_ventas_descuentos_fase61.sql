BEGIN;

ALTER TABLE public.descuentos_catalogos
  ADD COLUMN IF NOT EXISTS alcance VARCHAR(30) NOT NULL DEFAULT 'FACTURA_COMPLETA',
  ADD COLUMN IF NOT EXISTS id_producto INTEGER NULL,
  ADD COLUMN IF NOT EXISTS id_receta INTEGER NULL,
  ADD COLUMN IF NOT EXISTS id_combo INTEGER NULL,
  ADD COLUMN IF NOT EXISTS id_sucursal INTEGER NULL,
  ADD COLUMN IF NOT EXISTS fecha_inicio TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS fecha_fin TIMESTAMP NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_descuentos_catalogos_alcance'
  ) THEN
    ALTER TABLE public.descuentos_catalogos
      ADD CONSTRAINT chk_descuentos_catalogos_alcance
      CHECK (alcance IN ('FACTURA_COMPLETA', 'PRODUCTO', 'RECETA', 'COMBO'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_descuentos_catalogos_alcance_target'
  ) THEN
    ALTER TABLE public.descuentos_catalogos
      ADD CONSTRAINT chk_descuentos_catalogos_alcance_target
      CHECK (
        (alcance = 'FACTURA_COMPLETA' AND id_producto IS NULL AND id_receta IS NULL AND id_combo IS NULL)
        OR (alcance = 'PRODUCTO' AND id_producto IS NOT NULL AND id_receta IS NULL AND id_combo IS NULL)
        OR (alcance = 'RECETA' AND id_receta IS NOT NULL AND id_producto IS NULL AND id_combo IS NULL)
        OR (alcance = 'COMBO' AND id_combo IS NOT NULL AND id_producto IS NULL AND id_receta IS NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_descuentos_catalogos_vigencia'
  ) THEN
    ALTER TABLE public.descuentos_catalogos
      ADD CONSTRAINT chk_descuentos_catalogos_vigencia
      CHECK (fecha_fin IS NULL OR fecha_inicio IS NULL OR fecha_fin >= fecha_inicio);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_descuentos_catalogos_valor_no_negativo'
  ) THEN
    ALTER TABLE public.descuentos_catalogos
      ADD CONSTRAINT chk_descuentos_catalogos_valor_no_negativo
      CHECK (COALESCE(valor_descuento, 0) >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_descuentos_catalogos_alcance_estado
  ON public.descuentos_catalogos (alcance, estado);

CREATE INDEX IF NOT EXISTS idx_descuentos_catalogos_sucursal_estado
  ON public.descuentos_catalogos (id_sucursal, estado);

CREATE INDEX IF NOT EXISTS idx_descuentos_catalogos_vigencia
  ON public.descuentos_catalogos (fecha_inicio, fecha_fin);

ALTER TABLE public.descuentos_catalogos
  DROP CONSTRAINT IF EXISTS descuentos_catalogos_id_producto_fkey;
ALTER TABLE public.descuentos_catalogos
  ADD CONSTRAINT descuentos_catalogos_id_producto_fkey
  FOREIGN KEY (id_producto) REFERENCES public.productos(id_producto) ON DELETE RESTRICT;

ALTER TABLE public.descuentos_catalogos
  DROP CONSTRAINT IF EXISTS descuentos_catalogos_id_receta_fkey;
ALTER TABLE public.descuentos_catalogos
  ADD CONSTRAINT descuentos_catalogos_id_receta_fkey
  FOREIGN KEY (id_receta) REFERENCES public.recetas(id_receta) ON DELETE RESTRICT;

ALTER TABLE public.descuentos_catalogos
  DROP CONSTRAINT IF EXISTS descuentos_catalogos_id_combo_fkey;
ALTER TABLE public.descuentos_catalogos
  ADD CONSTRAINT descuentos_catalogos_id_combo_fkey
  FOREIGN KEY (id_combo) REFERENCES public.combos(id_combo) ON DELETE RESTRICT;

ALTER TABLE public.descuentos_catalogos
  DROP CONSTRAINT IF EXISTS descuentos_catalogos_id_sucursal_fkey;
ALTER TABLE public.descuentos_catalogos
  ADD CONSTRAINT descuentos_catalogos_id_sucursal_fkey
  FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT;

COMMIT;
