-- Clasificacion: PRE/POST seguro. Solo lectura: SELECT y validaciones que
-- pueden abortar con RAISE EXCEPTION; no contiene DDL ni DML.

-- 1) REVERSO con toda su semantica y conteo normalizado.
SELECT
  codigo,
  nombre,
  descripcion,
  signo_operacion,
  afecta_saldo,
  estado,
  COUNT(*) OVER () AS cantidad_filas_normalizadas
FROM public.cat_fidelizacion_tipos_movimiento
WHERE UPPER(TRIM(codigo)) = 'REVERSO'
ORDER BY id_tipo_movimiento;

-- 2) REVERSO_FACTURA con toda su semantica y conteo normalizado.
SELECT
  codigo,
  nombre,
  descripcion,
  estado,
  COUNT(*) OVER () AS cantidad_filas_normalizadas
FROM public.cat_fidelizacion_origenes_movimiento
WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA'
ORDER BY id_origen_movimiento;

-- 3) Resumen que sigue mostrando 0 cuando una fila falta.
SELECT
  (
    SELECT COUNT(*)
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO'
  ) AS reverso_filas_normalizadas,
  (
    SELECT COUNT(*)
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA'
  ) AS reverso_factura_filas_normalizadas;

-- 4) Validacion estricta de unicidad, actividad, campos obligatorios y
-- semantica canonica. En QA debe confirmar que el SAFE seria no-op.
DO $verify_catalogos_reverso$
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
  WHERE UPPER(TRIM(codigo)) = 'REVERSO';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas REVERSO.', v_count;
  ELSIF v_count = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: falta la fila REVERSO.';
  END IF;

  SELECT codigo, nombre, descripcion, signo_operacion, afecta_saldo, estado
  INTO v_codigo, v_nombre, v_descripcion, v_signo_operacion, v_afecta_saldo, v_estado
  FROM public.cat_fidelizacion_tipos_movimiento
  WHERE UPPER(TRIM(codigo)) = 'REVERSO';

  IF v_estado IS NOT TRUE THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_INACTIVE: REVERSO existe pero esta inactivo.';
  END IF;

  IF NULLIF(TRIM(v_codigo), '') IS NULL
     OR NULLIF(TRIM(v_nombre), '') IS NULL
     OR NULLIF(TRIM(v_descripcion), '') IS NULL
     OR v_codigo IS DISTINCT FROM 'REVERSO'
     OR v_nombre IS DISTINCT FROM 'Reverso'
     OR v_descripcion IS DISTINCT FROM U&'Reversi\00F3n de un movimiento previo.'
     OR v_signo_operacion IS DISTINCT FROM 1
     OR v_afecta_saldo IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: REVERSO no cumple codigo/nombre/descripcion, signo_operacion=1, afecta_saldo=true y campos obligatorios no vacios.';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.cat_fidelizacion_origenes_movimiento
  WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_AMBIGUOUS: existen % filas REVERSO_FACTURA.', v_count;
  ELSIF v_count = 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: falta la fila REVERSO_FACTURA.';
  END IF;

  SELECT codigo, nombre, descripcion, estado
  INTO v_codigo, v_nombre, v_descripcion, v_estado
  FROM public.cat_fidelizacion_origenes_movimiento
  WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

  IF v_estado IS NOT TRUE THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_INACTIVE: REVERSO_FACTURA existe pero esta inactivo.';
  END IF;

  IF NULLIF(TRIM(v_codigo), '') IS NULL
     OR NULLIF(TRIM(v_nombre), '') IS NULL
     OR NULLIF(TRIM(v_descripcion), '') IS NULL
     OR v_codigo IS DISTINCT FROM 'REVERSO_FACTURA'
     OR v_nombre IS DISTINCT FROM 'Reverso de factura'
     OR v_descripcion IS DISTINCT FROM U&'Movimiento generado por reversi\00F3n de acumulaci\00F3n por factura.'
  THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_SEMANTICA_INCOMPATIBLE: REVERSO_FACTURA no cumple codigo/nombre/descripcion canonicos y campos obligatorios no vacios.';
  END IF;

  RAISE NOTICE 'VERIFY_OK: REVERSO y REVERSO_FACTURA son unicos, activos y semanticamente canonicos.';
END
$verify_catalogos_reverso$;
