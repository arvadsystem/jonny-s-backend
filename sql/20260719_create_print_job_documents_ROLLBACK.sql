BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT pg_advisory_xact_lock(
  hashtextextended('jonnys.trabajos_impresion_documentos.v1', 0)
);

DO $rollback$
DECLARE
  v_table regclass;
  v_has_rows boolean;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ROLLBACK_REQUIRES_POSTGRES: current_user=%', current_user;
  END IF;

  v_table := to_regclass('public.trabajos_impresion_documentos');
  IF v_table IS NULL THEN
    RAISE NOTICE 'tabla ausente; rollback no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.oid = v_table
      AND c.relkind = 'r'
      AND c.relowner = 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_PREFLIGHT_FAILED: owner o tipo de relacion inesperado';
  END IF;

  EXECUTE
    'LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE';
  EXECUTE
    'SELECT EXISTS (SELECT 1 FROM public.trabajos_impresion_documentos LIMIT 1)'
    INTO v_has_rows;

  IF v_has_rows THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: existen documentos persistidos; revertir backend, respaldar y obtener autorizacion explicita';
  END IF;

  EXECUTE 'DROP TABLE public.trabajos_impresion_documentos';
END
$rollback$;

COMMIT;
