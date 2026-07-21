-- Rollback seguro: falla cerrado si ya existen cierres teoricos negativos.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.cajas_sesiones
    WHERE monto_teorico_cierre < 0
  ) OR EXISTS (
    SELECT 1
    FROM public.cajas_cierres
    WHERE monto_teorico_cierre < 0
  ) OR EXISTS (
    SELECT 1
    FROM public.cajas_arqueos
    WHERE monto_teorico < 0
  ) THEN
    RAISE EXCEPTION 'Rollback bloqueado: existen montos teoricos negativos que deben conservarse';
  END IF;
END
$rollback$;

DO $rollback$
DECLARE
  constraint_columns smallint[];
  constraint_expression text;
  constraint_found boolean;
  constraint_type "char";
  constraint_validated boolean;
  normalized_expression text;
  target_column smallint;
BEGIN
  IF to_regclass('public.cajas_sesiones') IS NULL
     OR to_regclass('public.cajas_cierres') IS NULL THEN
    RAISE EXCEPTION 'Faltan tablas requeridas de cajas';
  END IF;

  SELECT a.attnum
  INTO target_column
  FROM pg_attribute a
  WHERE a.attrelid = 'public.cajas_sesiones'::regclass
    AND a.attname = 'monto_teorico_cierre'
    AND NOT a.attisdropped;

  IF target_column IS NULL THEN
    RAISE EXCEPTION 'Falta public.cajas_sesiones.monto_teorico_cierre';
  END IF;

  SELECT c.contype, c.conkey, c.convalidated, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_type, constraint_columns, constraint_validated, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_sesiones'::regclass
    AND c.conname = 'ck_cajas_sesiones_monto_teorico';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression <> 'monto_teorico_cierreisnullormonto_teorico_cierre>=0'
    OR constraint_validated IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'ck_cajas_sesiones_monto_teorico existe con una definicion incorrecta o no validada';
  END IF;

  target_column := NULL;
  constraint_columns := NULL;
  constraint_expression := NULL;
  constraint_type := NULL;
  constraint_validated := NULL;
  normalized_expression := NULL;

  SELECT a.attnum
  INTO target_column
  FROM pg_attribute a
  WHERE a.attrelid = 'public.cajas_cierres'::regclass
    AND a.attname = 'monto_teorico_cierre'
    AND NOT a.attisdropped;

  IF target_column IS NULL THEN
    RAISE EXCEPTION 'Falta public.cajas_cierres.monto_teorico_cierre';
  END IF;

  SELECT c.contype, c.conkey, c.convalidated, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_type, constraint_columns, constraint_validated, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_cierres'::regclass
    AND c.conname = 'ck_cajas_cierres_monto_teorico';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression <> 'monto_teorico_cierre>=0'
    OR constraint_validated IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'ck_cajas_cierres_monto_teorico existe con una definicion incorrecta o no validada';
  END IF;

  target_column := NULL;
  constraint_columns := NULL;
  constraint_expression := NULL;
  constraint_type := NULL;
  constraint_validated := NULL;
  normalized_expression := NULL;

  IF to_regclass('public.cajas_arqueos') IS NULL THEN
    RAISE EXCEPTION 'Falta la tabla requerida public.cajas_arqueos';
  END IF;

  SELECT a.attnum
  INTO target_column
  FROM pg_attribute a
  WHERE a.attrelid = 'public.cajas_arqueos'::regclass
    AND a.attname = 'monto_teorico'
    AND NOT a.attisdropped;

  IF target_column IS NULL THEN
    RAISE EXCEPTION 'Falta public.cajas_arqueos.monto_teorico';
  END IF;

  SELECT c.contype, c.conkey, c.convalidated, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_type, constraint_columns, constraint_validated, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_arqueos'::regclass
    AND c.conname = 'ck_cajas_arqueos_teorico';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression <> 'monto_teorico>=0'
    OR constraint_validated IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_teorico existe con una definicion incorrecta o no validada';
  END IF;
END
$rollback$;

DO $rollback$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_sesiones'::regclass
      AND c.conname = 'ck_cajas_sesiones_monto_teorico'
  ) THEN
    ALTER TABLE public.cajas_sesiones
      ADD CONSTRAINT ck_cajas_sesiones_monto_teorico
      CHECK (
        monto_teorico_cierre IS NULL
        OR monto_teorico_cierre >= 0
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_cierres'::regclass
      AND c.conname = 'ck_cajas_cierres_monto_teorico'
  ) THEN
    ALTER TABLE public.cajas_cierres
      ADD CONSTRAINT ck_cajas_cierres_monto_teorico
      CHECK (monto_teorico_cierre >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_arqueos'::regclass
      AND c.conname = 'ck_cajas_arqueos_teorico'
  ) THEN
    ALTER TABLE public.cajas_arqueos
      ADD CONSTRAINT ck_cajas_arqueos_teorico
      CHECK (monto_teorico >= 0) NOT VALID;
  END IF;
END
$rollback$;

ALTER TABLE public.cajas_sesiones
  VALIDATE CONSTRAINT ck_cajas_sesiones_monto_teorico;

ALTER TABLE public.cajas_cierres
  VALIDATE CONSTRAINT ck_cajas_cierres_monto_teorico;

ALTER TABLE public.cajas_arqueos
  VALIDATE CONSTRAINT ck_cajas_arqueos_teorico;

COMMIT;
