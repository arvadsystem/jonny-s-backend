-- Clasificacion: PRE/POST seguro (guardado con to_regclass/information_schema;
-- no falla si la columna nunca existio).
-- Rollback protegido: solo elimina la columna (con su FK/UNIQUE/indice) si
-- ninguna fila la tiene poblada. Si ya hay movimientos de fidelizacion
-- asociados a una reversion, eliminar la columna borraria esa trazabilidad
-- silenciosamente -> se aborta en vez de hacerlo.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback$
DECLARE
  v_columna_existe boolean;
  v_filas_pobladas integer;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fidelizacion_movimientos'
      AND column_name = 'id_reversion'
  ) INTO v_columna_existe;

  IF NOT v_columna_existe THEN
    RAISE NOTICE 'fidelizacion_movimientos.id_reversion no existe; rollback no-op';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM public.fidelizacion_movimientos WHERE id_reversion IS NOT NULL'
    INTO v_filas_pobladas;

  IF v_filas_pobladas > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: existen % movimientos de fidelizacion con id_reversion poblado; revertir backend, respaldar y obtener autorizacion explicita antes de eliminar la columna.',
      v_filas_pobladas;
  END IF;

  ALTER TABLE public.fidelizacion_movimientos DROP COLUMN id_reversion;

  RAISE NOTICE 'fidelizacion_movimientos.id_reversion eliminada (ninguna fila la tenia poblada)';
END
$rollback$;

COMMIT;
