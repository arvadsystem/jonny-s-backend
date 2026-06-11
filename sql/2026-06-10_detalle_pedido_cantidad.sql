BEGIN;

ALTER TABLE public.detalle_pedido
  ADD COLUMN IF NOT EXISTS cantidad integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'detalle_pedido'
      AND column_name = 'cantidad'
      AND data_type <> 'integer'
  ) THEN
    RAISE EXCEPTION 'public.detalle_pedido.cantidad debe ser integer antes de continuar';
  END IF;
END;
$$;

ALTER TABLE public.detalle_pedido
  ALTER COLUMN cantidad SET DEFAULT 1;

UPDATE public.detalle_pedido
SET cantidad = 1
WHERE cantidad IS NULL;

ALTER TABLE public.detalle_pedido
  ALTER COLUMN cantidad SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.detalle_pedido'::regclass
      AND conname = 'chk_detalle_pedido_cantidad_positiva'
  ) THEN
    ALTER TABLE public.detalle_pedido
      ADD CONSTRAINT chk_detalle_pedido_cantidad_positiva
      CHECK (cantidad > 0)
      NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.detalle_pedido
  VALIDATE CONSTRAINT chk_detalle_pedido_cantidad_positiva;

COMMENT ON COLUMN public.detalle_pedido.cantidad IS
  'Cantidad entera de unidades del producto, receta o combo incluidas en la linea del pedido.';

COMMIT;
