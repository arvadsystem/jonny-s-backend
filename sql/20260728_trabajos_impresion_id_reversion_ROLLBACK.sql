-- Rollback: elimina la FK, el indice y la columna id_reversion de
-- trabajos_impresion. Se bloquea de forma segura si existe algun trabajo
-- con id_reversion ya asignado (dato real de negocio que se perderia).
-- No usa CASCADE. No borra ninguna fila de trabajos_impresion.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  v_filas_con_reversion integer;
BEGIN
  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion no existe; rollback no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trabajos_impresion'
      AND column_name = 'id_reversion'
  ) THEN
    RAISE NOTICE 'trabajos_impresion.id_reversion no existe; rollback no-op';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_filas_con_reversion
  FROM public.trabajos_impresion
  WHERE id_reversion IS NOT NULL;

  IF v_filas_con_reversion > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: % trabajos de impresion ya tienen id_reversion asignado; revertir backend, respaldar y obtener autorizacion explicita antes de eliminar la columna.',
      v_filas_con_reversion;
  END IF;

  ALTER TABLE public.trabajos_impresion
    DROP CONSTRAINT IF EXISTS fk_trabajos_impresion_reversion;

  DROP INDEX IF EXISTS public.idx_trabajos_impresion_reversion;

  ALTER TABLE public.trabajos_impresion
    DROP COLUMN IF EXISTS id_reversion;

  RAISE NOTICE 'trabajos_impresion.id_reversion eliminada (no habia trabajos con reversion asignada)';
END
$rollback$;

COMMIT;
