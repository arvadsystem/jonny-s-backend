BEGIN;

ALTER TABLE public.solicitudes_compra_detalle
DROP CONSTRAINT IF EXISTS chk_solicitudes_compra_detalle_cantidades;

ALTER TABLE public.solicitudes_compra_detalle
ADD CONSTRAINT chk_solicitudes_compra_detalle_cantidades
CHECK (
  cantidad_solicitada > 0::numeric
  AND cantidad_base_solicitada > 0::numeric
  AND (cantidad_aprobada IS NULL OR cantidad_aprobada > 0::numeric)
  AND (cantidad_base_aprobada IS NULL OR cantidad_base_aprobada > 0::numeric)
  AND (cantidad_recibida IS NULL OR cantidad_recibida >= 0::numeric)
  AND (cantidad_base_recibida IS NULL OR cantidad_base_recibida >= 0::numeric)
);

COMMIT;
