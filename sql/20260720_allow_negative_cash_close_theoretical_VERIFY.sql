-- Verificacion exclusivamente de lectura, antes y despues del SAFE.
-- Segura de ejecutar en produccion (solo SELECT, ningun DDL/DML).

-- 1) Listado completo de CHECK sobre las tablas involucradas: sirve para
-- confirmar por inspeccion que no aparecio un CHECK equivalente con nombre
-- distinto a los tres que SAFE elimina.
SELECT
  c.conrelid::regclass AS tabla,
  c.conname AS restriccion,
  c.convalidated AS validada,
  pg_get_constraintdef(c.oid, true) AS definicion
FROM pg_constraint c
WHERE c.conrelid IN (
    'public.cajas_sesiones'::regclass,
    'public.cajas_cierres'::regclass,
    'public.cajas_arqueos'::regclass,
    'public.cajas_cierres_arqueos_metodos'::regclass,
    'public.cajas_cierres_validaciones_metodos'::regclass
  )
  AND c.contype = 'c'
ORDER BY c.conrelid::regclass::text, c.conname;

-- 2) Ausencia explicita de los tres CHECK que SAFE debe haber eliminado.
-- ausente=true es el estado esperado despues de SAFE.
SELECT
  objetivo.tabla,
  objetivo.restriccion,
  NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = objetivo.tabla AND c.conname = objetivo.restriccion AND c.contype = 'c'
  ) AS ausente
FROM (VALUES
  ('public.cajas_sesiones'::regclass, 'ck_cajas_sesiones_monto_teorico'),
  ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico'),
  ('public.cajas_arqueos'::regclass, 'ck_cajas_arqueos_teorico')
) AS objetivo(tabla, restriccion);

-- 3) checks_equivalentes_no_negativos / permite_valores_negativos: confirma,
-- por COLUMNA (no por nombre de restriccion), que cada columna que debe
-- seguir siendo no-negativa todavia tiene un CHECK equivalente valido.
WITH columnas_que_permiten_negativos(tabla, columna) AS (
  VALUES
    ('public.cajas_sesiones'::regclass, 'monto_teorico_cierre'::text),
    ('public.cajas_cierres'::regclass, 'monto_teorico_cierre'::text),
    ('public.cajas_arqueos'::regclass, 'monto_teorico'::text),
    ('public.cajas_cierres_arqueos_metodos'::regclass, 'monto_teorico'::text),
    ('public.cajas_cierres_validaciones_metodos'::regclass, 'monto_teorico'::text)
),
checks_columna AS (
  SELECT
    objetivo.tabla,
    objetivo.columna,
    c.conname,
    c.convalidated,
    pg_get_expr(c.conbin, c.conrelid) AS expresion,
    lower(regexp_replace(
      pg_get_expr(c.conbin, c.conrelid),
      '\s+|[()]|::numeric',
      '',
      'g'
    )) AS expresion_normalizada
  FROM columnas_que_permiten_negativos objetivo
  INNER JOIN pg_attribute a
    ON a.attrelid = objetivo.tabla
   AND a.attname = objetivo.columna
   AND NOT a.attisdropped
  LEFT JOIN pg_constraint c
    ON c.conrelid = objetivo.tabla
   AND c.contype = 'c'
   AND c.conkey @> ARRAY[a.attnum]::smallint[]
),
resultado AS (
  SELECT
    objetivo.tabla,
    objetivo.columna,
    COUNT(check_columna.conname) FILTER (
      WHERE check_columna.expresion_normalizada IN (
        objetivo.columna || '>=0',
        objetivo.columna || 'isnullor' || objetivo.columna || '>=0'
      )
    ) AS checks_equivalentes_no_negativos,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'nombre', check_columna.conname,
          'validada', check_columna.convalidated,
          'expresion', check_columna.expresion
        )
        ORDER BY check_columna.conname
      ) FILTER (WHERE check_columna.conname IS NOT NULL),
      '[]'::jsonb
    ) AS checks_sobre_columna
  FROM columnas_que_permiten_negativos objetivo
  LEFT JOIN checks_columna check_columna
    ON check_columna.tabla = objetivo.tabla
   AND check_columna.columna = objetivo.columna
  GROUP BY objetivo.tabla, objetivo.columna
)
SELECT
  tabla,
  columna,
  checks_equivalentes_no_negativos,
  checks_equivalentes_no_negativos = 0 AS permite_valores_negativos,
  checks_sobre_columna
FROM resultado
ORDER BY tabla::text, columna;

-- 4) control_no_negativo_presente_y_validado: el resto de columnas de dinero
-- y referencias que NUNCA deben perder su CHECK no-negativo por este cambio.
WITH controles_requeridos(tabla, columna) AS (
  VALUES
    ('public.cajas_sesiones'::regclass, 'monto_apertura'::text),
    ('public.cajas_sesiones'::regclass, 'monto_declarado_cierre'::text),
    ('public.cajas_cierres'::regclass, 'monto_apertura'::text),
    ('public.cajas_cierres'::regclass, 'monto_declarado_cierre'::text),
    ('public.cajas_cierres'::regclass, 'monto_ventas_efectivo'::text),
    ('public.cajas_cierres'::regclass, 'monto_ventas_no_efectivo'::text),
    ('public.cajas_cierres'::regclass, 'monto_ingresos_manuales'::text),
    ('public.cajas_cierres'::regclass, 'monto_egresos_manuales'::text),
    ('public.cajas_arqueos'::regclass, 'monto_contado'::text),
    ('public.cajas_cierres_arqueos_metodos'::regclass, 'monto_declarado'::text),
    ('public.cajas_cierres_validaciones_metodos'::regclass, 'monto_declarado'::text)
)
SELECT
  objetivo.tabla,
  objetivo.columna,
  EXISTS (
    SELECT 1
    FROM pg_attribute a
    INNER JOIN pg_constraint c
      ON c.conrelid = a.attrelid
     AND c.contype = 'c'
     AND c.convalidated
     AND c.conkey @> ARRAY[a.attnum]::smallint[]
    WHERE a.attrelid = objetivo.tabla
      AND a.attname = objetivo.columna
      AND NOT a.attisdropped
      AND lower(regexp_replace(
        pg_get_expr(c.conbin, c.conrelid),
        '\s+|[()]|::numeric',
        '',
        'g'
      )) IN (
        objetivo.columna || '>=0',
        objetivo.columna || 'isnullor' || objetivo.columna || '>=0'
      )
  ) AS control_no_negativo_presente_y_validado
FROM controles_requeridos objetivo
ORDER BY objetivo.tabla::text, objetivo.columna;

-- 5) ck_cajas_arqueos_contado debe seguir intacto: exacto, validado, y
-- protegiendo unicamente monto_contado.
SELECT
  c.oid IS NOT NULL AS existe,
  c.convalidated AS validada,
  c.conkey = (
    SELECT array_agg(a.attnum)
    FROM pg_attribute a
    WHERE a.attrelid = 'public.cajas_arqueos'::regclass
      AND a.attname = 'monto_contado'
      AND NOT a.attisdropped
  ) AS protege_exclusivamente_monto_contado,
  lower(regexp_replace(COALESCE(pg_get_expr(c.conbin, c.conrelid), ''), '\s+|[()]|::numeric', '', 'g')) = 'monto_contado>=0' AS expresion_no_negativa_exacta
FROM pg_constraint c
WHERE c.conrelid = 'public.cajas_arqueos'::regclass
  AND c.conname = 'ck_cajas_arqueos_contado'
  AND c.contype = 'c';

-- 6) Catalogo completo requerido (EFECTIVO/TARJETA/TRANSFERENCIA/OTRO) y
-- validez de OTRO como bucket de "otros no efectivo".
WITH requerido(codigo, afecta_efectivo_esperado) AS (
  VALUES ('EFECTIVO', true), ('TARJETA', false), ('TRANSFERENCIA', false), ('OTRO', false)
)
SELECT
  r.codigo,
  mp.id_metodo_pago,
  COALESCE(mp.estado, true) AS activo,
  mp.afecta_efectivo,
  (mp.id_metodo_pago IS NOT NULL
    AND COALESCE(mp.estado, true) = true
    AND mp.afecta_efectivo IS NOT DISTINCT FROM r.afecta_efectivo_esperado) AS valido
FROM requerido r
LEFT JOIN public.cat_metodos_pago mp ON UPPER(TRIM(mp.codigo)) = r.codigo
ORDER BY r.codigo;

-- 7) Evidencia de regresion cero: conteos y sumas que NO deben cambiar por
-- esta migracion (ninguna fila de ventas/cobros/facturas se toca). Ejecutar
-- antes y despues de SAFE y comparar manualmente los dos resultados.
SELECT
  (SELECT COUNT(*) FROM public.facturas) AS cantidad_facturas,
  (SELECT COALESCE(SUM(total_detalle), 0) FROM public.detalle_facturas) AS suma_facturas,
  (SELECT COUNT(*) FROM public.facturas_cobros) AS cantidad_cobros,
  (SELECT COALESCE(SUM(monto), 0) FROM public.facturas_cobros) AS suma_cobros,
  (SELECT COUNT(*) FROM public.pedidos) AS cantidad_pedidos,
  (SELECT COUNT(*) FROM public.cajas_movimientos) AS cantidad_movimientos,
  (SELECT COUNT(*) FROM public.cajas_cierres) AS cantidad_cierres,
  (SELECT COUNT(*) FROM public.cajas_sesiones cs
     INNER JOIN public.cat_cajas_sesiones_estados e ON e.id_estado_sesion_caja = cs.id_estado_sesion_caja
     WHERE UPPER(TRIM(e.codigo)) = 'ABIERTA') AS sesiones_abiertas;
