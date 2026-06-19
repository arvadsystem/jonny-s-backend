BEGIN;

CREATE TABLE IF NOT EXISTS public.detalle_facturas_origen (
  id_origen SERIAL PRIMARY KEY,
  id_detalle_factura INTEGER NOT NULL UNIQUE,
  id_detalle_pedido INTEGER NULL,
  tipo_item VARCHAR(20) NOT NULL,
  id_producto INTEGER NULL,
  id_receta INTEGER NULL,
  id_combo INTEGER NULL,
  origen_snapshot JSONB NULL,
  creado_en TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_facturas_origen_detalle_factura'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT fk_detalle_facturas_origen_detalle_factura
      FOREIGN KEY (id_detalle_factura)
      REFERENCES public.detalle_facturas(id_detalle_factura)
      ON DELETE CASCADE;
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
    WHERE conname = 'fk_detalle_facturas_origen_detalle_pedido'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT fk_detalle_facturas_origen_detalle_pedido
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
      AND table_name = 'productos'
      AND column_name = 'id_producto'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_facturas_origen_producto'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT fk_detalle_facturas_origen_producto
      FOREIGN KEY (id_producto)
      REFERENCES public.productos(id_producto)
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
    WHERE conname = 'fk_detalle_facturas_origen_receta'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT fk_detalle_facturas_origen_receta
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
    WHERE conname = 'fk_detalle_facturas_origen_combo'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT fk_detalle_facturas_origen_combo
      FOREIGN KEY (id_combo)
      REFERENCES public.combos(id_combo)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_detalle_facturas_origen_tipo_item'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT ck_detalle_facturas_origen_tipo_item
      CHECK (tipo_item IN ('PRODUCTO', 'RECETA', 'COMBO', 'ITEM'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_detalle_facturas_origen_consistencia'
      AND conrelid = 'public.detalle_facturas_origen'::regclass
  ) THEN
    ALTER TABLE public.detalle_facturas_origen
      ADD CONSTRAINT ck_detalle_facturas_origen_consistencia
      CHECK (
        (tipo_item = 'PRODUCTO' AND id_producto IS NOT NULL)
        OR (tipo_item = 'RECETA' AND id_receta IS NOT NULL)
        OR (tipo_item = 'COMBO' AND id_combo IS NOT NULL)
        OR (tipo_item = 'ITEM')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_detalle_facturas_origen_tipo_item
  ON public.detalle_facturas_origen (tipo_item);

CREATE INDEX IF NOT EXISTS idx_detalle_facturas_origen_detalle_pedido
  ON public.detalle_facturas_origen (id_detalle_pedido);

INSERT INTO public.detalle_facturas_origen (
  id_detalle_factura,
  id_detalle_pedido,
  tipo_item,
  id_producto,
  id_receta,
  id_combo,
  origen_snapshot
)
SELECT
  df.id_detalle_factura,
  CASE
    WHEN df.id_detalle_pedido IS NOT NULL THEN df.id_detalle_pedido::integer
    ELSE NULL
  END AS id_detalle_pedido,
  CASE
    WHEN UPPER(TRIM(COALESCE(df.tipo_item, ''))) IN ('PRODUCTO', 'RECETA', 'COMBO', 'ITEM')
      THEN UPPER(TRIM(df.tipo_item))
    WHEN df.id_producto IS NOT NULL THEN 'PRODUCTO'
    ELSE 'ITEM'
  END AS tipo_item,
  df.id_producto,
  CASE
    WHEN df.id_receta IS NOT NULL THEN df.id_receta::integer
    ELSE NULL
  END AS id_receta,
  CASE
    WHEN df.id_combo IS NOT NULL THEN df.id_combo::integer
    ELSE NULL
  END AS id_combo,
  df.origen_snapshot
FROM public.detalle_facturas df
WHERE (
  df.tipo_item IS NOT NULL
  OR df.id_detalle_pedido IS NOT NULL
  OR df.id_receta IS NOT NULL
  OR df.id_combo IS NOT NULL
  OR df.origen_snapshot IS NOT NULL
)
ON CONFLICT (id_detalle_factura) DO NOTHING;

COMMIT;
