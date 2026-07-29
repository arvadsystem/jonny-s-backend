-- Rollback: elimina la FK, el indice y la columna id_sesion_caja de
-- fidelizacion_canjes. Se bloquea de forma segura si existe algun canje con
-- id_sesion_caja ya asignado (dato real de negocio que se perderia).
-- No usa CASCADE. No borra ninguna fila de fidelizacion_canjes.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  v_filas_con_sesion integer;
BEGIN
  IF to_regclass('public.fidelizacion_canjes') IS NULL THEN
    RAISE NOTICE 'fidelizacion_canjes no existe; rollback no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
      AND column_name = 'id_sesion_caja'
  ) THEN
    RAISE NOTICE 'fidelizacion_canjes.id_sesion_caja no existe; rollback no-op';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_filas_con_sesion
  FROM public.fidelizacion_canjes
  WHERE id_sesion_caja IS NOT NULL;

  IF v_filas_con_sesion > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: % canjes ya tienen id_sesion_caja asignado; revertir backend, respaldar y obtener autorizacion explicita antes de eliminar la columna.',
      v_filas_con_sesion;
  END IF;

  ALTER TABLE public.fidelizacion_canjes
    DROP CONSTRAINT IF EXISTS fk_fidelizacion_canjes_sesion_caja;

  DROP INDEX IF EXISTS public.idx_fidelizacion_canjes_sesion_caja;

  ALTER TABLE public.fidelizacion_canjes
    DROP COLUMN IF EXISTS id_sesion_caja;

  RAISE NOTICE 'fidelizacion_canjes.id_sesion_caja eliminada (no habia canjes con sesion asignada)';
END
$rollback$;

COMMIT;
