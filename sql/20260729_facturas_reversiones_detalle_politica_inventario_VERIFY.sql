-- POST-SAFE read-only. No realiza DDL ni DML.

DO $verify$
DECLARE
  v_missing integer;
  v_invalid integer;
BEGIN
  IF to_regclass('public.facturas_reversiones_detalle') IS NULL THEN
    RAISE EXCEPTION 'VERIFY_FAILED: public.facturas_reversiones_detalle no existe';
  END IF;

  SELECT 3 - COUNT(*) INTO v_missing
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'facturas_reversiones_detalle'
    AND column_name IN (
      'motivo_no_devolucion',
      'preparacion_iniciada',
      'tipo_politica_inventario'
    );

  SELECT COUNT(*) INTO v_invalid
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'facturas_reversiones_detalle'
    AND column_name IN (
      'motivo_no_devolucion',
      'preparacion_iniciada',
      'tipo_politica_inventario'
    )
    AND (
      is_nullable IS DISTINCT FROM 'YES'
      OR (column_name = 'preparacion_iniciada' AND data_type IS DISTINCT FROM 'boolean')
      OR (column_name <> 'preparacion_iniciada' AND data_type IS DISTINCT FROM 'character varying')
    );

  IF v_missing <> 0 OR v_invalid <> 0 THEN
    RAISE EXCEPTION 'VERIFY_FAILED: faltantes=% invalidas=%', v_missing, v_invalid;
  END IF;

  RAISE NOTICE 'VERIFY_OK: la política de inventario por línea puede persistirse sin backfill histórico';
END
$verify$;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'facturas_reversiones_detalle'
  AND column_name IN (
    'motivo_no_devolucion',
    'preparacion_iniciada',
    'tipo_politica_inventario'
  )
ORDER BY column_name;
