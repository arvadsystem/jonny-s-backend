BEGIN;

ALTER TABLE public.solicitudes_compra_detalle
  ADD COLUMN IF NOT EXISTS origen_linea varchar(20);

UPDATE public.solicitudes_compra_detalle
SET origen_linea = 'SUCURSAL'
WHERE origen_linea IS NULL
   OR origen_linea NOT IN ('SUCURSAL', 'ADMINISTRACION', 'CAPTURA_RAPIDA');

UPDATE public.solicitudes_compra_detalle detalle
SET origen_linea = 'CAPTURA_RAPIDA'
WHERE detalle.origen_linea IS DISTINCT FROM 'CAPTURA_RAPIDA'
  AND EXISTS (
    SELECT 1
    FROM public.capturas_compra_rapida captura
    WHERE captura.id_solicitud_compra = detalle.id_solicitud_compra
  );

ALTER TABLE public.solicitudes_compra_detalle
  ALTER COLUMN origen_linea SET DEFAULT 'SUCURSAL',
  ALTER COLUMN origen_linea SET NOT NULL;

ALTER TABLE public.solicitudes_compra_detalle
  DROP CONSTRAINT IF EXISTS solicitudes_compra_detalle_origen_linea_check;

ALTER TABLE public.solicitudes_compra_detalle
  ADD CONSTRAINT solicitudes_compra_detalle_origen_linea_check
  CHECK (origen_linea IN ('SUCURSAL', 'ADMINISTRACION', 'CAPTURA_RAPIDA'));

COMMIT;
