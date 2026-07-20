-- Rollback seguro: falla cerrado si ya existen cierres teoricos negativos.

BEGIN;

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.cajas_sesiones
    WHERE monto_teorico_cierre < 0
  ) OR EXISTS (
    SELECT 1
    FROM public.cajas_cierres
    WHERE monto_teorico_cierre < 0
  ) THEN
    RAISE EXCEPTION 'Rollback bloqueado: existen montos teoricos negativos que deben conservarse';
  END IF;
END
$rollback$;

DO $rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_sesiones'::regclass
      AND c.conname = 'ck_cajas_sesiones_monto_teorico'
  ) THEN
    ALTER TABLE public.cajas_sesiones
      ADD CONSTRAINT ck_cajas_sesiones_monto_teorico
      CHECK (monto_teorico_cierre >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_cierres'::regclass
      AND c.conname = 'ck_cajas_cierres_monto_teorico'
  ) THEN
    ALTER TABLE public.cajas_cierres
      ADD CONSTRAINT ck_cajas_cierres_monto_teorico
      CHECK (monto_teorico_cierre >= 0) NOT VALID;
  END IF;
END
$rollback$;

ALTER TABLE public.cajas_sesiones
  VALIDATE CONSTRAINT ck_cajas_sesiones_monto_teorico;

ALTER TABLE public.cajas_cierres
  VALIDATE CONSTRAINT ck_cajas_cierres_monto_teorico;

COMMIT;
