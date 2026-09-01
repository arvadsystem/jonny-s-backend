BEGIN;

ALTER TABLE public.solicitudes_compra_detalle
  ALTER COLUMN factor_conversion_snapshot TYPE numeric(30,18)
  USING factor_conversion_snapshot::numeric(30,18);

COMMIT;
