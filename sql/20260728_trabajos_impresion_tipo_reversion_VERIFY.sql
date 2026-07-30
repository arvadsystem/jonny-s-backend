-- Clasificacion: PRE/POST seguro. trabajos_impresion es una tabla base
-- siempre presente. trabajos_impresion_documentos es OPCIONAL (schema v2;
-- puede no existir en algunos entornos, ver comentario en el SAFE
-- companero) -- todas las consultas que la referencian estan guardadas con
-- to_regclass antes de usar ::regclass sobre ella.

-- 1) CHECK vigente de tipo_documento en trabajos_impresion: debe incluir
-- factura, comanda, caja y reversion. Antes del SAFE mostrara la
-- definicion original (sin reversion); despues, la ampliada.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND contype = 'c'
  AND conkey = ARRAY[(
    SELECT attnum FROM pg_attribute
    WHERE attrelid = 'public.trabajos_impresion'::regclass
      AND attname = 'tipo_documento' AND NOT attisdropped
  )]::smallint[];

-- 2) Ningun trabajo existente quedo en un estado invalido (todos los
-- tipo_documento actuales deben seguir perteneciendo al conjunto vigente).
SELECT tipo_documento, COUNT(*) AS cantidad
FROM public.trabajos_impresion
GROUP BY tipo_documento
ORDER BY tipo_documento;

-- 3) trabajos_impresion_documentos: CHECKs de tipo/formato/bytes, guardado
-- para el caso en que la tabla no exista.
DO $verify_documentos$
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe en este entorno; nada que verificar (schema v2 opcional)';
    RETURN;
  END IF;

  RAISE NOTICE 'trabajos_impresion_documentos existe; ver resultados de las consultas 4-6 a continuacion';
END
$verify_documentos$;

-- 4) CHECKs vigentes en trabajos_impresion_documentos (solo produce filas
-- si la tabla existe; si no existe, ::regclass sobre una constante
-- literal fallaria, por eso se usa to_regclass en un WHERE).
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, convalidated
FROM pg_constraint
WHERE to_regclass('public.trabajos_impresion_documentos') IS NOT NULL
  AND conrelid = to_regclass('public.trabajos_impresion_documentos')
  AND conname IN (
    'trabajos_impresion_documentos_tipo_chk',
    'trabajos_impresion_documentos_formato_chk',
    'trabajos_impresion_documentos_bytes_chk'
  )
ORDER BY conname;

-- 5) Todos los CHECK de tipo_documento en ambas tablas deben quedar
-- validados (convalidated=true); si alguno quedo NOT VALID, la Fase 2/4
-- del SAFE no completo correctamente.
SELECT tabla, conname, convalidated
FROM (
  SELECT
    conrelid::regclass::text AS tabla,
    conname,
    convalidated
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion'::regclass
    AND contype = 'c'

  UNION ALL

  SELECT
    conrelid::regclass::text AS tabla,
    conname,
    convalidated
  FROM pg_constraint
  WHERE to_regclass('public.trabajos_impresion_documentos') IS NOT NULL
    AND conrelid = to_regclass('public.trabajos_impresion_documentos')
    AND contype = 'c'
) AS checks
ORDER BY tabla, conname;

-- 6) Verificacion estricta: las consultas anteriores son evidencia visual;
-- este bloque read-only aborta si los CHECK no son exactamente los
-- canonicos o si alguno no esta validado.
DO $verify_impresion_reversion$
DECLARE
  v_conteo integer;
  v_validada boolean;
  v_expresion text;
  v_normalizada text;
  v_literales text[];
  v_numeros text[];
BEGIN
  SELECT COUNT(*)
  INTO v_conteo
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion'::regclass
    AND conname = 'ck_trabajos_impresion_tipo_documento'
    AND contype = 'c';

  IF v_conteo IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_IMPRESION_REVERSION: se esperaba exactamente un ck_trabajos_impresion_tipo_documento y se encontraron %.',
      v_conteo;
  END IF;

  SELECT convalidated, pg_get_expr(conbin, conrelid, true)
  INTO v_validada, v_expresion
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion'::regclass
    AND conname = 'ck_trabajos_impresion_tipo_documento'
    AND contype = 'c';

  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
  INTO v_literales
  FROM regexp_matches(v_expresion, '''([^'']*)''', 'g') AS m;

  v_normalizada := lower(v_expresion);
  v_normalizada := regexp_replace(
    v_normalizada,
    '::[[:space:]]*(text|character varying)(\([0-9]+\))?(\[\])?',
    '',
    'g'
  );
  v_normalizada := regexp_replace(v_normalizada, '[[:space:]()]', '', 'g');

  IF v_validada IS NOT TRUE
     OR v_literales IS DISTINCT FROM ARRAY['caja', 'comanda', 'factura', 'reversion']::text[]
     OR v_normalizada IS DISTINCT FROM 'tipo_documento=anyarray[''factura'',''comanda'',''caja'',''reversion'']'
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_IMPRESION_REVERSION: CHECK de trabajos_impresion invalido (validada=%, literales=%, expresion_normalizada=%).',
      v_validada,
      v_literales,
      v_normalizada;
  END IF;

  IF to_regclass('public.trabajos_impresion_documentos') IS NOT NULL THEN
    SELECT COUNT(*)
    INTO v_conteo
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_tipo_chk'
      AND contype = 'c';

    IF v_conteo IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: se esperaba exactamente un trabajos_impresion_documentos_tipo_chk y se encontraron %.',
        v_conteo;
    END IF;

    SELECT convalidated, pg_get_expr(conbin, conrelid, true)
    INTO v_validada, v_expresion
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_tipo_chk'
      AND contype = 'c';

    SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_literales
    FROM regexp_matches(v_expresion, '''([^'']*)''', 'g') AS m;

    v_normalizada := lower(v_expresion);
    v_normalizada := regexp_replace(
      v_normalizada,
      '::[[:space:]]*(text|character varying)(\([0-9]+\))?(\[\])?',
      '',
      'g'
    );
    v_normalizada := regexp_replace(v_normalizada, '[[:space:]()]', '', 'g');

    IF v_validada IS NOT TRUE
       OR v_literales IS DISTINCT FROM ARRAY['comanda', 'factura', 'reversion']::text[]
       OR v_normalizada IS DISTINCT FROM 'tipo_documento=anyarray[''factura'',''comanda'',''reversion'']'
    THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: CHECK de tipo documental invalido (validada=%, literales=%, expresion_normalizada=%).',
        v_validada,
        v_literales,
        v_normalizada;
    END IF;

    SELECT COUNT(*)
    INTO v_conteo
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_formato_chk'
      AND contype = 'c';

    IF v_conteo IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: se esperaba exactamente un trabajos_impresion_documentos_formato_chk y se encontraron %.',
        v_conteo;
    END IF;

    SELECT convalidated, pg_get_expr(conbin, conrelid, true)
    INTO v_validada, v_expresion
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_formato_chk'
      AND contype = 'c';

    v_normalizada := lower(v_expresion);
    v_normalizada := regexp_replace(
      v_normalizada,
      '::[[:space:]]*(text|character varying)(\([0-9]+\))?',
      '',
      'g'
    );
    v_normalizada := regexp_replace(v_normalizada, '[[:space:]()]', '', 'g');

    IF v_validada IS NOT TRUE
       OR v_normalizada IS DISTINCT FROM
         'tipo_documento=''factura''andformato=''pdf''andflavor=''base64''ortipo_documento=''reversion''andformato=''pdf''andflavor=''base64''ortipo_documento=''comanda''andformato=''html''andflavor=''plain'''
    THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: CHECK de formato invalido (validada=%, expresion_normalizada=%).',
        v_validada,
        v_normalizada;
    END IF;

    SELECT COUNT(*)
    INTO v_conteo
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_bytes_chk'
      AND contype = 'c';

    IF v_conteo IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: se esperaba exactamente un trabajos_impresion_documentos_bytes_chk y se encontraron %.',
        v_conteo;
    END IF;

    SELECT convalidated, pg_get_expr(conbin, conrelid, true)
    INTO v_validada, v_expresion
    FROM pg_constraint
    WHERE conrelid = to_regclass('public.trabajos_impresion_documentos')
      AND conname = 'trabajos_impresion_documentos_bytes_chk'
      AND contype = 'c';

    SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_numeros
    FROM regexp_matches(v_expresion, '\y(\d+)\y', 'g') AS m;

    v_normalizada := lower(v_expresion);
    v_normalizada := regexp_replace(
      v_normalizada,
      '::[[:space:]]*(text|character varying)(\([0-9]+\))?',
      '',
      'g'
    );
    v_normalizada := regexp_replace(v_normalizada, '[[:space:]()]', '', 'g');

    IF v_validada IS NOT TRUE
       OR v_numeros IS DISTINCT FROM ARRAY['0', '2097152', '262144']::text[]
       OR v_normalizada IS DISTINCT FROM
         'content_bytes>0andoctet_lengthcontenido=content_bytesandtipo_documento=''factura''andcontent_bytes<=2097152ortipo_documento=''reversion''andcontent_bytes<=2097152ortipo_documento=''comanda''andcontent_bytes<=262144'
    THEN
      RAISE EXCEPTION
        'VERIFY_FAILED_IMPRESION_REVERSION: CHECK de bytes invalido (validada=%, numeros=%, expresion_normalizada=%).',
        v_validada,
        v_numeros,
        v_normalizada;
    END IF;
  END IF;

  RAISE NOTICE
    'VERIFY_OK: los CHECK de impresion y documentos de reversion son validos y estan validados.';
END
$verify_impresion_reversion$;
