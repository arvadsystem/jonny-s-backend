-- Ajusta defaults operativos de caja/facturacion a la convencion local existente.
-- No ejecutar automaticamente en despliegues sin aprobacion explicita.

BEGIN;

ALTER TABLE public.cajas_sesiones_participantes
  ALTER COLUMN fecha_inicio SET DEFAULT (now() AT TIME ZONE 'America/Tegucigalpa');

ALTER TABLE public.facturas_cobros
  ALTER COLUMN fecha_cobro SET DEFAULT (now() AT TIME ZONE 'America/Tegucigalpa');

COMMIT;

