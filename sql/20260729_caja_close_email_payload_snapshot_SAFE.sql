-- Fase 6: congela el reporte de cierre usado por correo y PDF.
-- No ejecutar directamente; aplicar mediante el proceso normal de migraciones.
-- NULL conserva compatibilidad con notificaciones historicas, cuyo snapshot no
-- puede reconstruirse de forma inmutable retroactivamente.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.cajas_cierres_notificaciones_email') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cajas_cierres_notificaciones_email no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.cajas_cierres_notificaciones_email
  ADD COLUMN IF NOT EXISTS payload_snapshot JSONB NULL;

DO $validate$
DECLARE
  v_type text;
  v_nullable text;
BEGIN
  SELECT data_type, is_nullable
  INTO v_type, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'cajas_cierres_notificaciones_email'
    AND column_name = 'payload_snapshot';

  IF v_type IS DISTINCT FROM 'jsonb' OR v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: payload_snapshot tipo=% nullable=%; esperado jsonb/YES',
      v_type,
      v_nullable;
  END IF;
END
$validate$;

COMMENT ON COLUMN public.cajas_cierres_notificaciones_email.payload_snapshot IS
  'Snapshot inmutable del reporte de cierre usado por correo HTML y PDF. NULL solo para registros historicos anteriores a Fase 6.';

COMMIT;
