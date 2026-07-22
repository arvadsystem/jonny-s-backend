-- Preflight exclusivamente de lectura. Ejecutar antes de SAFE, en el mismo
-- entorno donde se ejecutara SAFE, lo mas cerca posible en el tiempo.
-- No modifica esquema ni datos. Seguro de ejecutar en produccion.
--
-- El estado observado aqui puede cambiar antes de que SAFE realmente corra
-- (sesiones nuevas, ventas nuevas, otro operador). SAFE vuelve a validar
-- todo, ya con el lock exclusivo tomado, antes de eliminar nada.

-- 1) Existencia de tablas requeridas.
SELECT
  t.tabla,
  to_regclass(t.tabla) IS NOT NULL AS existe
FROM (VALUES
  ('public.cajas_sesiones'),
  ('public.cajas_cierres'),
  ('public.cajas_arqueos'),
  ('public.cajas_cierres_arqueos_metodos'),
  ('public.cajas_cierres_validaciones_metodos'),
  ('public.cat_metodos_pago')
) AS t(tabla);

-- 2) Estado individual de cada uno de los tres CHECK que SAFE eliminaria.
-- Nunca se decide por conteo: cada restriccion se clasifica por separado.
WITH objetivo(tabla, restriccion) AS (
  VALUES
    ('public.cajas_sesiones'::regclass, 'ck_cajas_sesiones_monto_teorico'),
    ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico'),
    ('public.cajas_arqueos'::regclass, 'ck_cajas_arqueos_teorico')
),
estado AS (
  SELECT
    o.tabla,
    o.restriccion,
    c.oid IS NOT NULL AS presente,
    c.convalidated,
    pg_get_constraintdef(c.oid, true) AS definicion
  FROM objetivo o
  LEFT JOIN pg_constraint c
    ON c.conrelid = o.tabla AND c.conname = o.restriccion AND c.contype = 'c'
)
SELECT
  tabla,
  restriccion,
  presente,
  convalidated,
  definicion,
  CASE WHEN presente THEN 'LEGACY' ELSE 'SAFE' END AS estado_restriccion
FROM estado
ORDER BY tabla::text;

-- 3) Estado global de la migracion: LEGACY (las 3 presentes), SAFE (las 3
-- ausentes) o PARCIAL (mezcla). Deriva del detalle anterior, nunca de un
-- COUNT(*) suelto.
WITH objetivo(tabla, restriccion) AS (
  VALUES
    ('public.cajas_sesiones'::regclass, 'ck_cajas_sesiones_monto_teorico'),
    ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico'),
    ('public.cajas_arqueos'::regclass, 'ck_cajas_arqueos_teorico')
),
presentes AS (
  SELECT o.tabla, o.restriccion, (c.oid IS NOT NULL) AS presente
  FROM objetivo o
  LEFT JOIN pg_constraint c
    ON c.conrelid = o.tabla AND c.conname = o.restriccion AND c.contype = 'c'
)
SELECT
  COUNT(*) FILTER (WHERE presente) AS presentes_count,
  COUNT(*) FILTER (WHERE NOT presente) AS ausentes_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE presente) = 3 THEN 'LEGACY'
    WHEN COUNT(*) FILTER (WHERE NOT presente) = 3 THEN 'SAFE'
    ELSE 'PARCIAL'
  END AS estado_migracion
FROM presentes;

-- 4) Validacion estricta de ck_cajas_arqueos_contado: no basta el nombre.
-- Debe proteger EXCLUSIVAMENTE monto_contado con monto_contado >= 0, estar
-- validado, y no proteger ninguna otra columna. Si esto no se cumple, SAFE
-- debe abortar (asi lo hace su propio preflight interno).
WITH objetivo AS (
  SELECT 'public.cajas_arqueos'::regclass AS tabla, 'monto_contado'::text AS columna
),
constraint_row AS (
  SELECT c.*
  FROM pg_constraint c, objetivo o
  WHERE c.conrelid = o.tabla AND c.conname = 'ck_cajas_arqueos_contado' AND c.contype = 'c'
),
columna_attnum AS (
  SELECT a.attnum
  FROM pg_attribute a, objetivo o
  WHERE a.attrelid = o.tabla AND a.attname = o.columna AND NOT a.attisdropped
)
SELECT
  cr.oid IS NOT NULL AS existe,
  cr.convalidated AS validada,
  cr.conkey AS columnas_protegidas_attnum,
  (SELECT array_agg(attnum) FROM columna_attnum) AS attnum_monto_contado,
  cr.conkey = (SELECT array_agg(attnum) FROM columna_attnum) AS protege_exclusivamente_monto_contado,
  pg_get_expr(cr.conbin, cr.conrelid) AS expresion,
  lower(regexp_replace(COALESCE(pg_get_expr(cr.conbin, cr.conrelid), ''), '\s+|[()]|::numeric', '', 'g')) = 'monto_contado>=0' AS expresion_equivalente_no_negativa
FROM objetivo o
LEFT JOIN constraint_row cr ON true;

-- 5) Resto de controles no negativos que deben sobrevivir a SAFE.
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
      AND lower(regexp_replace(pg_get_expr(c.conbin, c.conrelid), '\s+|[()]|::numeric', '', 'g'))
        IN (objetivo.columna || '>=0', objetivo.columna || 'isnullor' || objetivo.columna || '>=0')
  ) AS control_no_negativo_presente_y_validado
FROM controles_requeridos objetivo
ORDER BY objetivo.tabla::text, objetivo.columna;

-- 6) Catalogo de metodos requerido (EFECTIVO/TARJETA/TRANSFERENCIA/OTRO).
WITH requerido(codigo, afecta_efectivo_esperado) AS (
  VALUES ('EFECTIVO', true), ('TARJETA', false), ('TRANSFERENCIA', false), ('OTRO', false)
)
SELECT
  r.codigo,
  mp.id_metodo_pago,
  COALESCE(mp.estado, true) AS activo,
  mp.afecta_efectivo,
  r.afecta_efectivo_esperado,
  (mp.id_metodo_pago IS NOT NULL
    AND COALESCE(mp.estado, true) = true
    AND mp.afecta_efectivo IS NOT DISTINCT FROM r.afecta_efectivo_esperado) AS valido
FROM requerido r
LEFT JOIN public.cat_metodos_pago mp ON UPPER(TRIM(mp.codigo)) = r.codigo
ORDER BY r.codigo;

-- 7) Sesiones de caja abiertas ahora mismo (informativo: puede cambiar).
SELECT COUNT(*) AS sesiones_abiertas
FROM public.cajas_sesiones cs
INNER JOIN public.cat_cajas_sesiones_estados e ON e.id_estado_sesion_caja = cs.id_estado_sesion_caja
WHERE UPPER(TRIM(e.codigo)) = 'ABIERTA';

-- 8) Transacciones abiertas y consultas de mas de 5 segundos ahora mismo
-- (excluyendo esta propia consulta). Informativo: el estado puede cambiar
-- antes de que SAFE realmente se ejecute.
SELECT
  pid,
  state,
  now() - xact_start AS duracion_transaccion,
  now() - query_start AS duracion_consulta,
  wait_event_type,
  wait_event,
  LEFT(query, 120) AS consulta
FROM pg_stat_activity
WHERE pid <> pg_backend_pid()
  AND (
    (state <> 'idle' AND now() - query_start > interval '5 seconds')
    OR (xact_start IS NOT NULL AND now() - xact_start > interval '5 seconds')
  )
ORDER BY duracion_transaccion DESC NULLS LAST;

-- 9) Locks concedidos o en espera sobre las tres tablas objetivo.
SELECT
  l.locktype,
  l.relation::regclass AS tabla,
  l.mode,
  l.granted,
  l.pid,
  now() - a.query_start AS duracion
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation IN (
  'public.cajas_sesiones'::regclass,
  'public.cajas_cierres'::regclass,
  'public.cajas_arqueos'::regclass
)
ORDER BY l.granted, duracion DESC NULLS LAST;

-- 10) Valores teoricos negativos ya existentes. Si estado_migracion = SAFE y
-- hay negativos aqui, un futuro ROLLBACK fallara cerrado (comportamiento
-- esperado: los negativos deben resolverse antes, no descartarse).
SELECT
  (SELECT COUNT(*) FROM public.cajas_sesiones WHERE monto_teorico_cierre < 0) AS sesiones_negativas,
  (SELECT COUNT(*) FROM public.cajas_cierres WHERE monto_teorico_cierre < 0) AS cierres_negativos,
  (SELECT COUNT(*) FROM public.cajas_arqueos WHERE monto_teorico < 0) AS arqueos_negativos;

-- 11) Tamano de las tablas objetivo (para estimar impacto de un table scan;
-- SAFE no escanea filas -- solo DROP CONSTRAINT -- pero informa el contexto).
SELECT
  relname AS tabla,
  pg_size_pretty(pg_total_relation_size(('public.'||relname)::regclass)) AS tamano,
  pg_total_relation_size(('public.'||relname)::regclass) AS bytes
FROM (VALUES ('cajas_sesiones'), ('cajas_cierres'), ('cajas_arqueos')) v(relname)
ORDER BY bytes DESC;

-- 12) Reversiones aplicadas completamente huerfanas. Este resultado es
-- bloqueante para el despliegue: sin una sesion original ni un cobro con
-- id_sesion_caja no existe una atribucion financiera verificable.
SELECT
  fr.id_reversion,
  fr.id_factura_original,
  fr.monto_reversado,
  COALESCE(
    ARRAY_AGG(DISTINCT fc.id_sesion_caja)
      FILTER (WHERE fc.id_sesion_caja IS NOT NULL),
    ARRAY[]::bigint[]
  ) AS sesiones_encontradas,
  COUNT(fc.id_factura_cobro)::bigint AS cantidad_cobros,
  'REVERSION_SIN_SESION_ATRIBUIBLE'::text AS motivo,
  true AS bloqueante_despliegue,
  'BLOQUEANTE'::text AS estado_preflight
FROM public.facturas_reversiones fr
LEFT JOIN public.facturas_cobros fc
  ON fc.id_factura = fr.id_factura_original
WHERE UPPER(TRIM(fr.estado)) = 'APLICADA'
  AND fr.id_sesion_caja_original IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.facturas_cobros fc_atribuible
    WHERE fc_atribuible.id_factura = fr.id_factura_original
      AND fc_atribuible.id_sesion_caja IS NOT NULL
  )
GROUP BY fr.id_reversion, fr.id_factura_original, fr.monto_reversado
ORDER BY fr.id_reversion;
