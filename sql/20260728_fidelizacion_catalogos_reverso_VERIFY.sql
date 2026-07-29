-- Verificacion exclusivamente de lectura. Ejecutar SIEMPRE antes del SAFE
-- companero, para confirmar el estado real del entorno (en QA se espera
-- que ambas filas ya existan y por lo tanto el SAFE sea no-op).

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
-- columnas significa "el entorno ya tenia los catalogos, el SAFE es no-op".
SELECT
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_tipos_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO' AND COALESCE(estado, true) = true
  ) AS reverso_activo,
  EXISTS (
    SELECT 1 FROM public.cat_fidelizacion_origenes_movimiento
    WHERE UPPER(TRIM(codigo)) = 'REVERSO_FACTURA' AND COALESCE(estado, true) = true
  ) AS reverso_factura_activo;
