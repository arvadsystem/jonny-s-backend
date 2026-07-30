-- Persiste la decisión de inventario calculada al ejecutar cada reversión.
-- Las columnas son nullable para conservar filas históricas sin inferir datos.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.facturas_reversiones_detalle') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones_detalle no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.facturas_reversiones_detalle
  ADD COLUMN IF NOT EXISTS motivo_no_devolucion varchar NULL,
  ADD COLUMN IF NOT EXISTS preparacion_iniciada boolean NULL,
  ADD COLUMN IF NOT EXISTS tipo_politica_inventario varchar NULL;

DO $validate$
DECLARE
  v_invalid integer;
BEGIN
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

  IF v_invalid <> 0 OR (
    SELECT COUNT(*)
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'facturas_reversiones_detalle'
      AND column_name IN (
        'motivo_no_devolucion',
        'preparacion_iniciada',
        'tipo_politica_inventario'
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: columnas de política de inventario inválidas';
  END IF;
END
$validate$;

COMMIT;
