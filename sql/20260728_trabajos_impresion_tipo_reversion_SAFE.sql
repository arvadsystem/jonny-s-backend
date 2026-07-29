-- Amplia el CHECK de tipo_documento en trabajos_impresion y en
-- trabajos_impresion_documentos para admitir 'reversion', conservando
-- todos los valores actuales de cada tabla:
--   trabajos_impresion            -> factura, comanda, caja, reversion
--   trabajos_impresion_documentos -> factura, comanda, reversion (nunca
--                                     tuvo 'caja'; no se agrega aqui)
--
-- Validacion ESTRUCTURAL, no por subcadena: cada CHECK que restringe
-- tipo_documento a una lista de valores se valida extrayendo, con
-- regexp_matches sobre pg_get_constraintdef(oid, true), el CONJUNTO EXACTO
-- de literales de texto referenciados (sin duplicados, ordenado), y
-- comparandolo por igualdad de array contra el conjunto esperado completo
-- -- nunca solo "contiene factura Y contiene comanda", que aceptaria
-- valores adicionales no autorizados. Lo mismo para formato_chk/bytes_chk:
-- se valida el conjunto exacto de literales de texto (tipo_documento,
-- formato, flavor) y el conjunto exacto de literales numericos (limites de
-- tamano), en vez de solo buscar subcadenas sueltas.
--
-- Idempotencia real (no solo "el nombre ya existe"): cada bloque
-- inspecciona la DEFINICION vigente de la restriccion relevante, sin
-- importar su nombre. Si la definicion ya es exactamente la esperada, no
-- hace nada. Si el nombre esperado existe pero con una definicion
-- vieja/incompleta/con valores extra, la corrige. tipo_chk, formato_chk y
-- bytes_chk de trabajos_impresion_documentos se procesan de forma
-- INDEPENDIENTE entre si -- nunca hay un RETURN global que salga temprano
-- solo porque uno de los tres ya este correcto.
--
-- trabajos_impresion.tipo_documento originalmente era un CHECK inline SIN
-- NOMBRE (sql/2026-07-16_cola_impresion_agentes_sucursal.sql:30-31), por lo
-- que Postgres le asigno un nombre autogenerado. Esta migracion lo localiza
-- por introspeccion sobre la COLUMNA que restringe (nunca por nombre
-- asumido), y lo reemplaza por uno con nombre explicito y widening
-- correcto, en dos fases para minimizar el tiempo bajo ACCESS EXCLUSIVE:
-- ADD ... NOT VALID (metadata-only) y despues VALIDATE CONSTRAINT (SHARE
-- UPDATE EXCLUSIVE, no bloquea lecturas ni escrituras concurrentes de la
-- cola de impresion).
--
-- No elimina 'caja' de trabajos_impresion ni agrega 'caja' a
-- trabajos_impresion_documentos. No usa CASCADE. No borra filas.

-- ===================== FASE 1: trabajos_impresion =====================
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.trabajos_impresion no existe';
  END IF;
END
$preflight$;

DO $swap_check$
DECLARE
  v_tipo_attnum smallint;
  v_conteo integer;
  v_current_conname text;
  v_definicion text;
  v_literales text[];
  v_definicion_exacta boolean;
BEGIN
  SELECT a.attnum INTO v_tipo_attnum
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trabajos_impresion'::regclass
    AND a.attname = 'tipo_documento'
    AND NOT a.attisdropped;

  IF v_tipo_attnum IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: trabajos_impresion.tipo_documento no existe';
  END IF;

  SELECT COUNT(*) INTO v_conteo
  FROM pg_constraint c
  WHERE c.conrelid = 'public.trabajos_impresion'::regclass
    AND c.contype = 'c'
    AND c.conkey = ARRAY[v_tipo_attnum]::smallint[];

  IF v_conteo = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no existe ningun CHECK sobre trabajos_impresion.tipo_documento; revisar manualmente antes de continuar.';
  END IF;

  IF v_conteo > 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_AMBIGUOUS: existen % restricciones CHECK distintas sobre trabajos_impresion.tipo_documento; no se puede determinar cual reemplazar sin intervencion manual.', v_conteo;
  END IF;

  SELECT c.conname, pg_get_constraintdef(c.oid, true)
  INTO v_current_conname, v_definicion
  FROM pg_constraint c
  WHERE c.conrelid = 'public.trabajos_impresion'::regclass
    AND c.contype = 'c'
    AND c.conkey = ARRAY[v_tipo_attnum]::smallint[];

  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
  INTO v_literales
  FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

  -- Conjunto EXACTO esperado: ni de mas (p.ej. un valor colado por error)
  -- ni de menos (p.ej. reversion faltante).
  v_definicion_exacta := v_literales = ARRAY['caja', 'comanda', 'factura', 'reversion']::text[];

  IF v_current_conname = 'ck_trabajos_impresion_tipo_documento' AND v_definicion_exacta THEN
    RAISE NOTICE 'ck_trabajos_impresion_tipo_documento ya tiene exactamente el conjunto esperado (factura, comanda, caja, reversion); no-op';
    RETURN;
  END IF;

  -- El CHECK sobre tipo_documento existe pero: (a) tiene el nombre
  -- autogenerado original, (b) tiene nuestro nombre explicito con una
  -- definicion vieja/incompleta, o (c) tiene valores adicionales no
  -- autorizados. En todos los casos se reemplaza por la version exacta.
  LOCK TABLE public.trabajos_impresion IN ACCESS EXCLUSIVE MODE NOWAIT;

  EXECUTE format('ALTER TABLE public.trabajos_impresion DROP CONSTRAINT %I', v_current_conname);

  ALTER TABLE public.trabajos_impresion
    ADD CONSTRAINT ck_trabajos_impresion_tipo_documento
    CHECK (tipo_documento IN ('factura', 'comanda', 'caja', 'reversion'))
    NOT VALID;
END
$swap_check$;

COMMIT;
-- ===================== FASE 2: VALIDATE (fuera de ACCESS EXCLUSIVE) =====
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $validate_trabajos_impresion$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'ck_trabajos_impresion_tipo_documento'
      AND NOT convalidated
  ) THEN
    BEGIN
      ALTER TABLE public.trabajos_impresion
        VALIDATE CONSTRAINT ck_trabajos_impresion_tipo_documento;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = SQLSTATE,
        MESSAGE = FORMAT('Fallo VALIDATE CONSTRAINT ck_trabajos_impresion_tipo_documento: %s', SQLERRM);
    END;
  END IF;
END
$validate_trabajos_impresion$;
COMMIT;

-- ============== FASE 3: trabajos_impresion_documentos ==============
-- tipo_chk, formato_chk y bytes_chk se procesan de forma INDEPENDIENTE:
-- cada uno tiene su propio bloque DO que verifica su propio conjunto
-- exacto de literales y lo corrige si hace falta, sin depender de si los
-- otros dos ya estaban correctos.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $ensure_tipo_chk$
DECLARE
  v_definicion text;
  v_literales text[];
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe; se omite tipo_chk (schema v2 opcional)';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_tipo_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no existe trabajos_impresion_documentos_tipo_chk';
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
    AND conname = 'trabajos_impresion_documentos_tipo_chk';

  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
  INTO v_literales
  FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

  -- Conjunto EXACTO: factura, comanda, reversion -- nunca 'caja'.
  IF v_literales = ARRAY['comanda', 'factura', 'reversion']::text[] THEN
    RAISE NOTICE 'trabajos_impresion_documentos_tipo_chk ya tiene exactamente el conjunto esperado (factura, comanda, reversion); no-op';
    RETURN;
  END IF;

  LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE NOWAIT;
  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT trabajos_impresion_documentos_tipo_chk;
  ALTER TABLE public.trabajos_impresion_documentos
    ADD CONSTRAINT trabajos_impresion_documentos_tipo_chk
    CHECK (tipo_documento IN ('factura', 'comanda', 'reversion'))
    NOT VALID;
END
$ensure_tipo_chk$;

DO $ensure_formato_chk$
DECLARE
  v_definicion text;
  v_literales text[];
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe; se omite formato_chk (schema v2 opcional)';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_formato_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no existe trabajos_impresion_documentos_formato_chk';
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
    AND conname = 'trabajos_impresion_documentos_formato_chk';

  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
  INTO v_literales
  FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

  -- Conjunto EXACTO de literales de texto esperado:
  -- {factura, reversion, comanda, pdf, base64, html, plain}. El comprobante
  -- de reversion es PDF/base64, igual que factura (mismo limite de tamano
  -- MAX_CANONICAL_PDF_BYTES=2097152 de services/printJobDocumentService.js).
  IF v_literales = ARRAY['base64', 'comanda', 'factura', 'html', 'pdf', 'plain', 'reversion']::text[] THEN
    RAISE NOTICE 'trabajos_impresion_documentos_formato_chk ya tiene exactamente el conjunto esperado; no-op';
    RETURN;
  END IF;

  LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE NOWAIT;
  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT trabajos_impresion_documentos_formato_chk;
  ALTER TABLE public.trabajos_impresion_documentos
    ADD CONSTRAINT trabajos_impresion_documentos_formato_chk CHECK (
      (tipo_documento = 'factura' AND formato = 'pdf' AND flavor = 'base64')
      OR (tipo_documento = 'reversion' AND formato = 'pdf' AND flavor = 'base64')
      OR (tipo_documento = 'comanda' AND formato = 'html' AND flavor = 'plain')
    ) NOT VALID;
END
$ensure_formato_chk$;

DO $ensure_bytes_chk$
DECLARE
  v_definicion text;
  v_literales text[];
  v_numeros text[];
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe; se omite bytes_chk (schema v2 opcional)';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_bytes_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no existe trabajos_impresion_documentos_bytes_chk';
  END IF;

  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint
  WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
    AND conname = 'trabajos_impresion_documentos_bytes_chk';

  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
  INTO v_literales
  FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

  SELECT array_agg(DISTINCT m[0] ORDER BY m[0])
  INTO v_numeros
  FROM regexp_matches(v_definicion, '\y\d+\y', 'g') AS m;

  -- Conjunto EXACTO: tipos {comanda, factura, reversion}; limites
  -- numericos {0 (de content_bytes>0), 262144 (comanda), 2097152
  -- (factura y reversion, mismo limite)}.
  IF v_literales = ARRAY['comanda', 'factura', 'reversion']::text[]
     AND v_numeros = ARRAY['0', '2097152', '262144']::text[]
  THEN
    RAISE NOTICE 'trabajos_impresion_documentos_bytes_chk ya tiene exactamente los limites esperados (factura/reversion<=2097152, comanda<=262144); no-op';
    RETURN;
  END IF;

  LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE NOWAIT;
  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT trabajos_impresion_documentos_bytes_chk;
  ALTER TABLE public.trabajos_impresion_documentos
    ADD CONSTRAINT trabajos_impresion_documentos_bytes_chk CHECK (
      content_bytes > 0
      AND octet_length(contenido) = content_bytes
      AND (
        (tipo_documento = 'factura' AND content_bytes <= 2097152)
        OR (tipo_documento = 'reversion' AND content_bytes <= 2097152)
        OR (tipo_documento = 'comanda' AND content_bytes <= 262144)
      )
    ) NOT VALID;
END
$ensure_bytes_chk$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $validate_documentos$
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_tipo_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      VALIDATE CONSTRAINT trabajos_impresion_documentos_tipo_chk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_formato_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      VALIDATE CONSTRAINT trabajos_impresion_documentos_formato_chk;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_bytes_chk'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      VALIDATE CONSTRAINT trabajos_impresion_documentos_bytes_chk;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING
    ERRCODE = SQLSTATE,
    MESSAGE = FORMAT('Fallo VALIDATE CONSTRAINT sobre trabajos_impresion_documentos: %s', SQLERRM);
END
$validate_documentos$;
COMMIT;
