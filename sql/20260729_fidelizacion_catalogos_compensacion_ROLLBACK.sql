-- Clasificacion: PRE/POST seguro (usa to_regclass antes de referenciar las
-- tablas; nunca ejecuta DELETE). Mismo patron de rollback intencionalmente
-- sin borrado automatico que
-- 20260728_fidelizacion_catalogos_reverso_ROLLBACK.sql, por el mismo
-- motivo: ninguna columna distingue "fila creada por este SAFE" de "fila
-- preexistente".

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_manual_only$
DECLARE
  v_movimientos_compensacion integer := 0;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL
     OR to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE NOTICE 'Catalogos de fidelizacion ausentes; nada que reportar';
    RETURN;
  END IF;

  IF to_regclass('public.fidelizacion_movimientos') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_movimientos_compensacion
    FROM public.fidelizacion_movimientos fm
    INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
      ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
    WHERE UPPER(TRIM(tm.codigo)) = 'COMPENSACION';
  END IF;

  RAISE NOTICE 'ROLLBACK_MANUAL_REQUERIDO: este archivo no borra filas de catalogo. Movimientos existentes que ya usan COMPENSACION: %. Si es 0 y se confirmo que esta migracion creo las filas en este entorno especifico, un operador puede borrarlas manualmente con DELETE dirigido por codigo tras revisar el VERIFY companero. Si es mayor que 0, NO BORRAR: hay compensaciones de puntos reales que dependen de ese catalogo.', v_movimientos_compensacion;
END
$rollback_manual_only$;

COMMIT;
