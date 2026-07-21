-- Verificacion exclusivamente de lectura, antes y despues del SAFE.

SELECT
  c.conrelid::regclass AS tabla,
  c.conname AS restriccion,
  c.convalidated AS validada,
  pg_get_constraintdef(c.oid, true) AS definicion
FROM pg_constraint c
WHERE c.conrelid IN (
    'public.cajas_sesiones'::regclass,
    'public.cajas_cierres'::regclass,
    'public.cajas_cierres_arqueos_metodos'::regclass,
    'public.cajas_cierres_validaciones_metodos'::regclass
  )
  AND c.contype = 'c'
ORDER BY c.conrelid::regclass::text, c.conname;

WITH columnas_que_permiten_negativos(tabla, columna) AS (
  VALUES
    ('public.cajas_sesiones'::regclass, 'monto_teorico_cierre'::text),
    ('public.cajas_cierres'::regclass, 'monto_teorico_cierre'::text),
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

SELECT
  3000.00::numeric(14,2) AS monto_apertura,
  0.00::numeric(14,2) AS ventas_efectivo,
  0.00::numeric(14,2) AS ingresos_manuales,
  16763.00::numeric(14,2) AS egresos_manuales,
  (
    3000.00::numeric(14,2)
    + 0.00::numeric(14,2)
    + 0.00::numeric(14,2)
    - 16763.00::numeric(14,2)
  )::numeric(14,2) AS efectivo_teorico_esperado;

SELECT cm.*
FROM public.cajas_movimientos cm
WHERE cm.id_movimiento_caja = 17;
