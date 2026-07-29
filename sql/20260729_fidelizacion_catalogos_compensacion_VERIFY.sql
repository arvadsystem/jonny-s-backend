-- Clasificacion: PRE/POST seguro. Ejecutar SIEMPRE antes del SAFE
-- companero para confirmar el estado real del entorno. Mismo patron que
-- 20260728_fidelizacion_catalogos_reverso_VERIFY.sql.

-- 1) Presencia y estado de COMPENSACION en cat_fidelizacion_tipos_movimiento.
SELECT id_tipo_movimiento, codigo, estado
FROM public.cat_fidelizacion_tipos_movimiento
WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

-- 2) Presencia y estado de AJUSTE_PENDIENTE en
-- cat_fidelizacion_origenes_movimiento.
SELECT id_origen_movimiento, codigo, estado
FROM public.cat_fidelizacion_origenes_movimiento
WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

-- 3) Resumen booleano directo para el reporte de Fase 4.
SELECT
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'COMPENSACION' AND COALESCE(estado, true) = true
  ) AS compensacion_activo,
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE' AND COALESCE(estado, true) = true
  ) AS ajuste_pendiente_activo;

-- 4) Guardia de ambiguedad/inactividad explicita.
DO $diagnostico$
DECLARE
  v_compensacion_count integer := 0;
  v_ajuste_pendiente_count integer := 0;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL THEN
    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento no existe en este entorno';
  ELSE
    SELECT COUNT(*) INTO v_compensacion_count
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';
    IF v_compensacion_count > 1 THEN
      RAISE NOTICE 'AMBIGUEDAD: % filas COMPENSACION en cat_fidelizacion_tipos_movimiento; el SAFE abortara.', v_compensacion_count;
    ELSIF v_compensacion_count = 1 THEN
      RAISE NOTICE 'COMPENSACION: exactamente 1 fila (revisar consulta 1 para estado activo/inactivo)';
    ELSE
      RAISE NOTICE 'COMPENSACION: 0 filas; el SAFE insertara una fila activa';
    END IF;
  END IF;

  IF to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento no existe en este entorno';
  ELSE
    SELECT COUNT(*) INTO v_ajuste_pendiente_count
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';
    IF v_ajuste_pendiente_count > 1 THEN
      RAISE NOTICE 'AMBIGUEDAD: % filas AJUSTE_PENDIENTE en cat_fidelizacion_origenes_movimiento; el SAFE abortara.', v_ajuste_pendiente_count;
    ELSIF v_ajuste_pendiente_count = 1 THEN
      RAISE NOTICE 'AJUSTE_PENDIENTE: exactamente 1 fila (revisar consulta 2 para estado activo/inactivo)';
    ELSE
      RAISE NOTICE 'AJUSTE_PENDIENTE: 0 filas; el SAFE insertara una fila activa';
    END IF;
  END IF;
END
$diagnostico$;
