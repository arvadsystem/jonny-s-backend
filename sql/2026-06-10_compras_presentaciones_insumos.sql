BEGIN;

-- Microfase 4A: contrato SQL para presentaciones de insumos en ordenes de compra y compras.
-- Solo prepara estructura; no modifica datos ni inventario.

-- ---------------------------------------------------------------------------
-- detalle_orden_compras
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'detalle_orden_compras'
      AND column_name = 'cantidad_orden'
      AND (
        data_type <> 'numeric'
        OR numeric_precision <> 14
        OR numeric_scale <> 4
      )
  ) THEN
    EXECUTE 'ALTER TABLE public.detalle_orden_compras ALTER COLUMN cantidad_orden TYPE numeric(14,4) USING cantidad_orden::numeric(14,4)';
  END IF;
END $$;

ALTER TABLE public.detalle_orden_compras
  ADD COLUMN IF NOT EXISTS id_unidad_base integer NULL,
  ADD COLUMN IF NOT EXISTS id_presentacion_insumo bigint NULL,
  ADD COLUMN IF NOT EXISTS cantidad_presentacion numeric(14,4) NULL,
  ADD COLUMN IF NOT EXISTS id_unidad_presentacion integer NULL,
  ADD COLUMN IF NOT EXISTS factor_conversion_usado numeric(14,6) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_orden_compras_unidad_base' AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT fk_detalle_orden_compras_unidad_base
      FOREIGN KEY (id_unidad_base)
      REFERENCES public.unidades_medida(id_unidad_medida)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_orden_compras_presentacion_insumo' AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT fk_detalle_orden_compras_presentacion_insumo
      FOREIGN KEY (id_presentacion_insumo)
      REFERENCES public.insumo_presentaciones(id_presentacion)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_orden_compras_unidad_presentacion' AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT fk_detalle_orden_compras_unidad_presentacion
      FOREIGN KEY (id_unidad_presentacion)
      REFERENCES public.unidades_medida(id_unidad_medida)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_detalle_orden_compras_presentacion_consistente' AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      DROP CONSTRAINT chk_detalle_orden_compras_presentacion_consistente;
  END IF;

  ALTER TABLE public.detalle_orden_compras
    ADD CONSTRAINT chk_detalle_orden_compras_presentacion_consistente
    CHECK (
      (
        id_presentacion_insumo IS NULL
        AND cantidad_presentacion IS NULL
        AND id_unidad_presentacion IS NULL
        AND factor_conversion_usado IS NULL
        AND (
          id_unidad_base IS NULL
          OR (
            id_insumo IS NOT NULL
            AND id_producto IS NULL
          )
        )
      )
      OR
      (
        id_presentacion_insumo IS NOT NULL
        AND cantidad_presentacion IS NOT NULL
        AND cantidad_presentacion > 0
        AND id_unidad_presentacion IS NOT NULL
        AND factor_conversion_usado IS NOT NULL
        AND factor_conversion_usado > 0
        AND id_insumo IS NOT NULL
        AND id_producto IS NULL
        AND id_unidad_base IS NOT NULL
      )
    )
    NOT VALID;
END $$;

ALTER TABLE public.detalle_orden_compras VALIDATE CONSTRAINT fk_detalle_orden_compras_unidad_base;
ALTER TABLE public.detalle_orden_compras VALIDATE CONSTRAINT fk_detalle_orden_compras_presentacion_insumo;
ALTER TABLE public.detalle_orden_compras VALIDATE CONSTRAINT fk_detalle_orden_compras_unidad_presentacion;
ALTER TABLE public.detalle_orden_compras VALIDATE CONSTRAINT chk_detalle_orden_compras_presentacion_consistente;

CREATE INDEX IF NOT EXISTS idx_detalle_orden_compras_presentacion_insumo
  ON public.detalle_orden_compras (id_presentacion_insumo)
  WHERE id_presentacion_insumo IS NOT NULL;

COMMENT ON COLUMN public.detalle_orden_compras.cantidad_orden IS
  'Cantidad canonica expresada en la unidad base del insumo o cantidad directa del producto.';
COMMENT ON COLUMN public.detalle_orden_compras.id_unidad_base IS
  'Snapshot de la unidad oficial de inventario del insumo. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_orden_compras.id_presentacion_insumo IS
  'Presentacion de insumo seleccionada para la linea. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_orden_compras.cantidad_presentacion IS
  'Cantidad de presentaciones compradas o solicitadas. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_orden_compras.id_unidad_presentacion IS
  'Snapshot de la unidad de la presentacion seleccionada. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_orden_compras.factor_conversion_usado IS
  'Snapshot del factor cantidad_base / cantidad_presentacion utilizado al guardar la linea. Aplica exclusivamente a lineas de insumos.';

-- ---------------------------------------------------------------------------
-- detalle_compras
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'detalle_compras'
      AND column_name = 'cantidad'
      AND (
        data_type <> 'numeric'
        OR numeric_precision <> 14
        OR numeric_scale <> 4
      )
  ) THEN
    EXECUTE 'ALTER TABLE public.detalle_compras ALTER COLUMN cantidad TYPE numeric(14,4) USING cantidad::numeric(14,4)';
  END IF;
END $$;

ALTER TABLE public.detalle_compras
  ADD COLUMN IF NOT EXISTS id_unidad_base integer NULL,
  ADD COLUMN IF NOT EXISTS id_presentacion_insumo bigint NULL,
  ADD COLUMN IF NOT EXISTS cantidad_presentacion numeric(14,4) NULL,
  ADD COLUMN IF NOT EXISTS id_unidad_presentacion integer NULL,
  ADD COLUMN IF NOT EXISTS factor_conversion_usado numeric(14,6) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_compras_unidad_base' AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT fk_detalle_compras_unidad_base
      FOREIGN KEY (id_unidad_base)
      REFERENCES public.unidades_medida(id_unidad_medida)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_compras_presentacion_insumo' AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT fk_detalle_compras_presentacion_insumo
      FOREIGN KEY (id_presentacion_insumo)
      REFERENCES public.insumo_presentaciones(id_presentacion)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_detalle_compras_unidad_presentacion' AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT fk_detalle_compras_unidad_presentacion
      FOREIGN KEY (id_unidad_presentacion)
      REFERENCES public.unidades_medida(id_unidad_medida)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_detalle_compras_presentacion_consistente' AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      DROP CONSTRAINT chk_detalle_compras_presentacion_consistente;
  END IF;

  ALTER TABLE public.detalle_compras
    ADD CONSTRAINT chk_detalle_compras_presentacion_consistente
    CHECK (
      (
        id_presentacion_insumo IS NULL
        AND cantidad_presentacion IS NULL
        AND id_unidad_presentacion IS NULL
        AND factor_conversion_usado IS NULL
        AND (
          id_unidad_base IS NULL
          OR (
            id_insumo IS NOT NULL
            AND id_producto IS NULL
          )
        )
      )
      OR
      (
        id_presentacion_insumo IS NOT NULL
        AND cantidad_presentacion IS NOT NULL
        AND cantidad_presentacion > 0
        AND id_unidad_presentacion IS NOT NULL
        AND factor_conversion_usado IS NOT NULL
        AND factor_conversion_usado > 0
        AND id_insumo IS NOT NULL
        AND id_producto IS NULL
        AND id_unidad_base IS NOT NULL
      )
    )
    NOT VALID;
END $$;

ALTER TABLE public.detalle_compras VALIDATE CONSTRAINT fk_detalle_compras_unidad_base;
ALTER TABLE public.detalle_compras VALIDATE CONSTRAINT fk_detalle_compras_presentacion_insumo;
ALTER TABLE public.detalle_compras VALIDATE CONSTRAINT fk_detalle_compras_unidad_presentacion;
ALTER TABLE public.detalle_compras VALIDATE CONSTRAINT chk_detalle_compras_presentacion_consistente;

CREATE INDEX IF NOT EXISTS idx_detalle_compras_presentacion_insumo
  ON public.detalle_compras (id_presentacion_insumo)
  WHERE id_presentacion_insumo IS NOT NULL;

COMMENT ON COLUMN public.detalle_compras.cantidad IS
  'Cantidad canonica recibida, expresada en la unidad base del insumo o cantidad directa del producto.';
COMMENT ON COLUMN public.detalle_compras.id_unidad_base IS
  'Snapshot de la unidad oficial de inventario del insumo. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_compras.id_presentacion_insumo IS
  'Presentacion de insumo seleccionada para la linea. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_compras.cantidad_presentacion IS
  'Cantidad de presentaciones compradas o solicitadas. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_compras.id_unidad_presentacion IS
  'Snapshot de la unidad de la presentacion seleccionada. Aplica exclusivamente a lineas de insumos.';
COMMENT ON COLUMN public.detalle_compras.factor_conversion_usado IS
  'Snapshot del factor cantidad_base / cantidad_presentacion utilizado al guardar la linea. Aplica exclusivamente a lineas de insumos.';

COMMIT;
