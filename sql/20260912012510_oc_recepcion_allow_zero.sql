BEGIN;

ALTER TABLE public.solicitudes_compra_detalle
  DROP CONSTRAINT IF EXISTS solicitudes_compra_detalle_cantidad_recibida_check,
  DROP CONSTRAINT IF EXISTS solicitudes_compra_detalle_cantidad_base_recibida_check;

ALTER TABLE public.solicitudes_compra_detalle
  ADD CONSTRAINT solicitudes_compra_detalle_cantidad_recibida_check
    CHECK (cantidad_recibida IS NULL OR cantidad_recibida >= 0),
  ADD CONSTRAINT solicitudes_compra_detalle_cantidad_base_recibida_check
    CHECK (cantidad_base_recibida IS NULL OR cantidad_base_recibida >= 0);

COMMIT;
