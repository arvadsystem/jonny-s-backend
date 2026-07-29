-- Clasificacion: PRE/POST seguro. Ejecutar SIEMPRE antes del SAFE
-- companero, para confirmar el estado real del entorno (en QA se espera
-- que ambas filas ya existan activas y por lo tanto el SAFE sea no-op en
-- ambos bloques). Las consultas 1-3 asumen que
-- cat_fidelizacion_tipos_movimiento/cat_fidelizacion_origenes_movimiento
-- existen (son catalogos base que la aplicacion ya usa en produccion via
-- services/ventasReversionService.js); la consulta 5 guarda su ausencia
-- explicitamente antes de referenciarlas.

-- 1) Presencia y estado de REVERSO en cat_fidelizacion_tipos_movimiento.
SELECT id_tipo_movimiento, codigo, estado
FROM public.cat_fidelizacion_tipos_movimiento
WHERE UPPER(TRIM(codigo)) = 'REVERSO';

-- 2) Presencia y estado de REVERSO_FACTURA en
-- cat_fidelizacion_origenes_movimiento.
SELECT id_origen_movimiento, codigo, estado
FROM public.cat_fidelizacion_origenes_movimiento
WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';

-- 3) Catalogo completo de ambos, para inspeccion manual (nada mas debe
-- haberse tocado).
SELECT id_tipo_movimiento, codigo, estado
FROM public.cat_fidelizacion_tipos_movimiento
ORDER BY id_tipo_movimiento;

SELECT id_origen_movimiento, codigo, estado
FROM public.cat_fidelizacion_origenes_movimiento
ORDER BY id_origen_movimiento;

-- 4) Resumen booleano directo para el reporte de Fase 1: TRUE en ambas
-- columnas significa "el entorno ya tenia los catalogos activos, el SAFE
-- debe ser no-op en ambos bloques". FALSE puede significar tanto
-- "ausente" como "existe pero inactivo" o "ambiguo" -- usar las consultas
-- 1/2 para distinguir cual caso es antes de correr el SAFE.
SELECT
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO' AND COALESCE(estado, true) = true
  ) AS reverso_activo,
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA' AND COALESCE(estado, true) = true
  ) AS reverso_factura_activo;

-- 5) Guardia de ambiguedad/inactividad explicita, guardada con to_regclass
-- por si alguna de las dos tablas no existiera en un entorno futuro.
DO $diagnostico$
DECLARE
  v_reverso_count integer := 0;
  v_reverso_factura_count integer := 0;
BEGIN
  IF to_regclass('public.cat_fidelizacion_tipos_movimiento') IS NULL THEN
    RAISE NOTICE 'cat_fidelizacion_tipos_movimiento no existe en este entorno';
  ELSE
    SELECT COUNT(*) INTO v_reverso_count
    FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO';
    IF v_reverso_count > 1 THEN
      RAISE NOTICE 'AMBIGUEDAD: % filas REVERSO en cat_fidelizacion_tipos_movimiento; el SAFE abortara.', v_reverso_count;
    ELSIF v_reverso_count = 1 THEN
      RAISE NOTICE 'REVERSO: exactamente 1 fila (revisar consulta 1 para estado activo/inactivo)';
    ELSE
      RAISE NOTICE 'REVERSO: 0 filas; el SAFE insertara una fila activa';
    END IF;
  END IF;

  IF to_regclass('public.cat_fidelizacion_origenes_movimiento') IS NULL THEN
    RAISE NOTICE 'cat_fidelizacion_origenes_movimiento no existe en este entorno';
  ELSE
    SELECT COUNT(*) INTO v_reverso_factura_count
    FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA';
    IF v_reverso_factura_count > 1 THEN
      RAISE NOTICE 'AMBIGUEDAD: % filas REVERSO_FACTURA en cat_fidelizacion_origenes_movimiento; el SAFE abortara.', v_reverso_factura_count;
    ELSIF v_reverso_factura_count = 1 THEN
      RAISE NOTICE 'REVERSO_FACTURA: exactamente 1 fila (revisar consulta 2 para estado activo/inactivo)';
    ELSE
      RAISE NOTICE 'REVERSO_FACTURA: 0 filas; el SAFE insertara una fila activa';
    END IF;
  END IF;
END
$diagnostico$;
