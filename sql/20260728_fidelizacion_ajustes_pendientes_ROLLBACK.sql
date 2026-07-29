-- Rollback protegido: solo elimina la tabla si existe y esta vacia.
-- No usa CASCADE. No borra datos historicos porque, si la tabla tiene
-- filas, significa que ya se registraron ajustes de puntos reales, y
-- borrarlos silenciosamente dejaria deuda de fidelizacion sin rastro.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  v_table regclass;
  v_has_rows boolean;
BEGIN
  v_table := to_regclass('public.fidelizacion_ajustes_pendientes');
  IF v_table IS NULL THEN
    RAISE NOTICE 'fidelizacion_ajustes_pendientes no existe; rollback no-op';
    RETURN;
  END IF;

  EXECUTE 'LOCK TABLE public.fidelizacion_ajustes_pendientes IN ACCESS EXCLUSIVE MODE';
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.fidelizacion_ajustes_pendientes LIMIT 1)'
    INTO v_has_rows;

  IF v_has_rows THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: existen ajustes pendientes de fidelizacion registrados; revertir backend, respaldar y obtener autorizacion explicita antes de eliminar la tabla.';
  END IF;

  EXECUTE 'DROP TABLE public.fidelizacion_ajustes_pendientes';

  RAISE NOTICE 'fidelizacion_ajustes_pendientes eliminada (estaba vacia)';
END
$rollback$;

COMMIT;
