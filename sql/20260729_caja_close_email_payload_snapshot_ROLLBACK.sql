-- Rollback estructural de Fase 6.
-- Destructivo para snapshots ya persistidos; ejecutar solo con autorizacion.

BEGIN;

ALTER TABLE public.cajas_cierres_notificaciones_email
  DROP COLUMN IF EXISTS payload_snapshot;

COMMIT;
