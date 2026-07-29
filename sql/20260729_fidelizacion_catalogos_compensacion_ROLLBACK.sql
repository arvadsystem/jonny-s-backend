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
  v_movimientos_ajuste_pendiente integer := 0;
  v_movimientos_reverso integer := 0;
  v_movimientos_reverso_factura integer := 0;
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

    SELECT COUNT(*) INTO v_movimientos_ajuste_pendiente
    FROM public.fidelizacion_movimientos fm
    INNER JOIN public.cat_fidelizacion_origenes_movimiento om
      ON om.id_origen_movimiento = fm.id_origen_movimiento
    WHERE UPPER(TRIM(om.codigo)) = 'AJUSTE_PENDIENTE';

    SELECT COUNT(*) INTO v_movimientos_reverso
    FROM public.fidelizacion_movimientos fm
    INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
      ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
    WHERE UPPER(TRIM(tm.codigo)) = 'REVERSO';

    SELECT COUNT(*) INTO v_movimientos_reverso_factura
    FROM public.fidelizacion_movimientos fm
    INNER JOIN public.cat_fidelizacion_origenes_movimiento om
      ON om.id_origen_movimiento = fm.id_origen_movimiento
    WHERE UPPER(TRIM(om.codigo)) = 'REVERSO_FACTURA';
  END IF;

  RAISE NOTICE 'ROLLBACK_MANUAL_REQUERIDO: este archivo no borra filas de catalogo. Movimientos que usan COMPENSACION: %. Movimientos que usan AJUSTE_PENDIENTE: %. Movimientos que usan REVERSO: %. Movimientos que usan REVERSO_FACTURA: %. Si cualquiera es mayor que 0, NO BORRAR la fila asociada: existen movimientos reales que dependen de esos catalogos. Aunque un conteo sea 0, aun se requiere confirmar mediante el log del SAFE que la fila fue creada por esta migracion antes de considerar un DELETE manual dirigido.',
    v_movimientos_compensacion,
    v_movimientos_ajuste_pendiente,
    v_movimientos_reverso,
    v_movimientos_reverso_factura;
END
$rollback_manual_only$;

COMMIT;
