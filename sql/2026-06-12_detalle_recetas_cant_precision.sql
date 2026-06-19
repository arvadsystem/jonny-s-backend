BEGIN;

-- Amplia la precision para cantidades pequenas de ingredientes en recetas.
-- La conversion conserva los datos existentes y no elimina detalle_recetas_cant_check.
-- El constraint debe continuar exigiendo que cant sea mayor que cero.
ALTER TABLE public.detalle_recetas
  ALTER COLUMN cant TYPE numeric(14,4)
  USING cant::numeric(14,4);

COMMIT;
