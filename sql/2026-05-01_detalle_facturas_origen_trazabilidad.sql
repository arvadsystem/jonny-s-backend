BEGIN;

ALTER TABLE public.detalle_facturas
  ADD COLUMN IF NOT EXISTS id_detalle_pedido BIGINT NULL,
  ADD COLUMN IF NOT EXISTS tipo_item VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS id_receta BIGINT NULL,
  ADD COLUMN IF NOT EXISTS id_combo BIGINT NULL,
  ADD COLUMN IF NOT EXISTS origen_snapshot JSONB NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_detalle_facturas_tipo_item'
      AND conrelid = 'public.detalle_facturas'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas
      ADD CONSTRAINT ck_detalle_facturas_tipo_item
      CHECK (
        tipo_item IS NULL
        OR tipo_item IN ('PRODUCTO', 'RECETA', 'COMBO', 'MIXTO', 'ITEM')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'detalle_pedido'
      AND column_name = 'id_detalle_pedido'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_facturas_detalle_pedido'
      AND conrelid = 'public.detalle_facturas'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas
      ADD CONSTRAINT fk_detalle_facturas_detalle_pedido
      FOREIGN KEY (id_detalle_pedido)
      REFERENCES public.detalle_pedido(id_detalle_pedido)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'recetas'
      AND column_name = 'id_receta'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_facturas_receta'
      AND conrelid = 'public.detalle_facturas'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas
      ADD CONSTRAINT fk_detalle_facturas_receta
      FOREIGN KEY (id_receta)
      REFERENCES public.recetas(id_receta)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'combos'
      AND column_name = 'id_combo'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_facturas_combo'
      AND conrelid = 'public.detalle_facturas'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas
      ADD CONSTRAINT fk_detalle_facturas_combo
      FOREIGN KEY (id_combo)
      REFERENCES public.combos(id_combo)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_detalle_facturas_id_detalle_pedido
  ON public.detalle_facturas (id_detalle_pedido);

CREATE INDEX IF NOT EXISTS idx_detalle_facturas_tipo_item
  ON public.detalle_facturas (tipo_item);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_facturas_reversiones_detalle_tipo'
      AND conrelid = 'public.facturas_reversiones_detalle'::regclass
  ) THEN
    ALTER TABLE public.facturas_reversiones_detalle
      DROP CONSTRAINT ck_facturas_reversiones_detalle_tipo;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_facturas_reversiones_detalle_tipo'
      AND conrelid = 'public.facturas_reversiones_detalle'::regclass
  ) THEN
    ALTER TABLE public.facturas_reversiones_detalle
      ADD CONSTRAINT ck_facturas_reversiones_detalle_tipo
      CHECK (tipo_item IN ('PRODUCTO', 'RECETA', 'COMBO', 'MIXTO', 'ITEM'));
  END IF;
END $$;

COMMIT;
