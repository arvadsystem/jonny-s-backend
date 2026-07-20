BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT pg_advisory_xact_lock(
  hashtextextended('jonnys.trabajos_impresion_documentos.v1', 0)
);

DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ROLLBACK_REQUIRES_POSTGRES: current_user=%', current_user;
  END IF;

  IF to_regclass('public.trabajos_impresion_documentos') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      WHERE c.oid = to_regclass('public.trabajos_impresion_documentos')
        AND c.relowner = 'postgres'::regrole
    ) THEN
      RAISE EXCEPTION 'ROLLBACK_PREFLIGHT_FAILED: owner inesperado';
    END IF;
  END IF;
END
$preflight$;

DROP TABLE IF EXISTS public.trabajos_impresion_documentos;

COMMIT;
