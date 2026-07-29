-- Agrega public.fidelizacion_canjes.id_sesion_caja (BIGINT NULL), FK hacia
-- public.cajas_sesiones(id_sesion_caja), con indice. Prerrequisito de
-- Fase 4 (createPresentialFidelizacionCanje hoy no tiene ningun concepto de
-- sesion de caja; ver services/fidelizacionService.js:1014-1276).
--
-- Nullable por compatibilidad historica: los canjes ya registrados no
-- tienen sesion asociada y no se puede inferir una por fecha (prohibido
-- explicitamente). Esta migracion NO actualiza ninguna fila existente:
-- id_sesion_caja queda NULL para todo canje creado antes de Fase 4.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + creacion condicional de FK/indice.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.fidelizacion_canjes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.fidelizacion_canjes no existe';
  END IF;
  IF to_regclass('public.cajas_sesiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cajas_sesiones no existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cajas_sesiones'
      AND column_name = 'id_sesion_caja'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: cajas_sesiones.id_sesion_caja no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.fidelizacion_canjes
  ADD COLUMN IF NOT EXISTS id_sesion_caja BIGINT NULL;

DO $add_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.fidelizacion_canjes'::regclass
      AND conname = 'fk_fidelizacion_canjes_sesion_caja'
  ) THEN
    ALTER TABLE public.fidelizacion_canjes
      ADD CONSTRAINT fk_fidelizacion_canjes_sesion_caja
      FOREIGN KEY (id_sesion_caja)
      REFERENCES public.cajas_sesiones(id_sesion_caja)
      ON DELETE SET NULL;
  END IF;
END
$add_fk$;

CREATE INDEX IF NOT EXISTS idx_fidelizacion_canjes_sesion_caja
  ON public.fidelizacion_canjes (id_sesion_caja);

COMMENT ON COLUMN public.fidelizacion_canjes.id_sesion_caja IS
  'Sesion de caja abierta bajo la cual se registro el canje presencial. NULL en canjes historicos anteriores a Fase 4; nunca inferido por fecha.';

COMMIT;
