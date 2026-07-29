-- Clasificacion: POST-SAFE. Solo lectura: SELECT y validaciones que pueden
-- abortar con RAISE EXCEPTION; no contiene DDL ni DML.

-- 1) Fila COMPENSACION y cantidad de coincidencias por codigo normalizado.
SELECT
  codigo,
  nombre,
  descripcion,
  signo_operacion,
  afecta_saldo,
  estado,
  COUNT(*) OVER () AS cantidad_filas_normalizadas
FROM public.cat_fidelizacion_tipos_movimiento
WHERE UPPER(TRIM(codigo)) = 'COMPENSACION'
ORDER BY id_tipo_movimiento;

-- 2) Fila AJUSTE_PENDIENTE y cantidad de coincidencias por codigo normalizado.
SELECT
  codigo,
  nombre,
  descripcion,
  estado,
  COUNT(*) OVER () AS cantidad_filas_normalizadas
FROM public.cat_fidelizacion_origenes_movimiento
WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE'
ORDER BY id_origen_movimiento;

-- 3) Resumen que sigue mostrando 0 cuando una fila falta.
SELECT
  (
    SELECT COUNT(*)
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'COMPENSACION'
  ) AS compensacion_filas_normalizadas,
  (
    SELECT COUNT(*)
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE'
  ) AS ajuste_pendiente_filas_normalizadas;

-- 4) Validacion posterior estricta de unicidad, actividad, campos
-- obligatorios y semantica canonica. Este bloque es exclusivamente de
-- lectura y aborta para impedir que un VERIFY invalido parezca exitoso.
DO $verify_catalogos_compensacion$
DECLARE
  v_count integer;
  v_codigo text;
  v_nombre text;
  v_descripcion text;
  v_signo_operacion smallint;
  v_afecta_saldo boolean;
  v_estado boolean;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL
     OR to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL
  THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: faltan catalogos base de fidelizacion.';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.cat_fidelizacion_tipos_movimiento
  WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas COMPENSACION.', v_count;
  ELSIF v_count = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: falta la fila COMPENSACION.';
  END IF;

  SELECT codigo, nombre, descripcion, signo_operacion, afecta_saldo, estado
  INTO v_codigo, v_nombre, v_descripcion, v_signo_operacion, v_afecta_saldo, v_estado
  FROM public.cat_fidelizacion_tipos_movimiento
  WHERE UPPER(TRIM(codigo)) = 'COMPENSACION';

  IF v_estado IS NOT TRUE THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_INACTIVE: COMPENSACION existe pero esta inactiva.';
  END IF;

  IF NULLIF(TRIM(v_codigo), '') IS NULL
     OR NULLIF(TRIM(v_nombre), '') IS NULL
     OR NULLIF(TRIM(v_descripcion), '') IS NULL
     OR v_codigo IS DISTINCT FROM 'COMPENSACION'
     OR v_nombre IS DISTINCT FROM 'Compensación'
     OR v_descripcion IS DISTINCT FROM 'Aplicación de puntos acumulados a ajustes pendientes de reversión.'
     OR v_signo_operacion IS DISTINCT FROM -1
     OR v_afecta_saldo IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: COMPENSACION no cumple codigo/nombre/descripcion, signo_operacion=-1, afecta_saldo=true y campos obligatorios no vacios.';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.cat_fidelizacion_origenes_movimiento
  WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas AJUSTE_PENDIENTE.', v_count;
  ELSIF v_count = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: falta la fila AJUSTE_PENDIENTE.';
  END IF;

  SELECT codigo, nombre, descripcion, estado
  INTO v_codigo, v_nombre, v_descripcion, v_estado
  FROM public.cat_fidelizacion_origenes_movimiento
  WHERE UPPER(TRIM(codigo)) = 'AJUSTE_PENDIENTE';

  IF v_estado IS NOT TRUE THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_INACTIVE: AJUSTE_PENDIENTE existe pero esta inactivo.';
  END IF;

  IF NULLIF(TRIM(v_codigo), '') IS NULL
     OR NULLIF(TRIM(v_nombre), '') IS NULL
     OR NULLIF(TRIM(v_descripcion), '') IS NULL
     OR v_codigo IS DISTINCT FROM 'AJUSTE_PENDIENTE'
     OR v_nombre IS DISTINCT FROM 'Ajuste pendiente'
     OR v_descripcion IS DISTINCT FROM 'Compensación aplicada a una deuda pendiente originada por reversión.'
  THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: AJUSTE_PENDIENTE no cumple codigo/nombre/descripcion canonicos y campos obligatorios no vacios.';
  END IF;

  RAISE NOTICE 'VERIFY_OK: COMPENSACION y AJUSTE_PENDIENTE son unicos, activos y semanticamente canonicos.';
END
$verify_catalogos_compensacion$;
