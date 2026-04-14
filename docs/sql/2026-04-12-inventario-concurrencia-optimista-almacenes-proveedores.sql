BEGIN;

ALTER TABLE public.almacenes
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.almacenes
SET updated_at = COALESCE(updated_at, NOW())
WHERE updated_at IS NULL;

ALTER TABLE public.almacenes
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE public.almacenes
  ALTER COLUMN updated_at SET NOT NULL;

ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE public.proveedores
SET updated_at = COALESCE(updated_at, NOW())
WHERE updated_at IS NULL;

ALTER TABLE public.proveedores
  ALTER COLUMN updated_at SET DEFAULT NOW();

ALTER TABLE public.proveedores
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_inventory_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_almacenes_touch_updated_at ON public.almacenes;
CREATE TRIGGER trg_almacenes_touch_updated_at
BEFORE UPDATE ON public.almacenes
FOR EACH ROW
EXECUTE FUNCTION public.fn_inventory_touch_updated_at();

DROP TRIGGER IF EXISTS trg_proveedores_touch_updated_at ON public.proveedores;
CREATE TRIGGER trg_proveedores_touch_updated_at
BEFORE UPDATE ON public.proveedores
FOR EACH ROW
EXECUTE FUNCTION public.fn_inventory_touch_updated_at();

COMMIT;
