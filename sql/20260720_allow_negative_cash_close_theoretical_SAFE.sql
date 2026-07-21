-- Permite cierres con efectivo teorico negativo sin alterar datos historicos.
-- Ejecutar primero en QA y conservar una captura del VERIFY previo/posterior.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $migration$
DECLARE
  constraint_columns smallint[];
  constraint_expression text;
  constraint_found boolean;
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

  SELECT c.conkey, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_columns, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_sesiones'::regclass
    AND c.conname = 'ck_cajas_sesiones_monto_teorico'
    AND c.contype = 'c';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression NOT IN (
      'monto_teorico_cierre>=0',
      'monto_teorico_cierreisnullormonto_teorico_cierre>=0'
    )
  ) THEN
    RAISE EXCEPTION 'ck_cajas_sesiones_monto_teorico no coincide con el CHECK no-negativo esperado';
  END IF;

  target_column := NULL;
  constraint_columns := NULL;
  constraint_expression := NULL;
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

  SELECT c.conkey, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_columns, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_cierres'::regclass
    AND c.conname = 'ck_cajas_cierres_monto_teorico'
    AND c.contype = 'c';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression NOT IN (
      'monto_teorico_cierre>=0',
      'monto_teorico_cierreisnullormonto_teorico_cierre>=0'
    )
  ) THEN
    RAISE EXCEPTION 'ck_cajas_cierres_monto_teorico no coincide con el CHECK no-negativo esperado';
  END IF;

  target_column := NULL;
  constraint_columns := NULL;
  constraint_expression := NULL;
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

  -- Columna protegida: monto_contado (conteo fisico) debe seguir >= 0 y no debe
  -- ser alterada por esta migracion.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_arqueos'::regclass
      AND c.conname = 'ck_cajas_arqueos_contado'
      AND c.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_contado (columna protegida monto_contado) no existe; abortando por seguridad';
  END IF;

  SELECT c.conkey, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_columns, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_arqueos'::regclass
    AND c.conname = 'ck_cajas_arqueos_teorico'
    AND c.contype = 'c';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF constraint_found AND (
    constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression <> 'monto_teorico>=0'
  ) THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_teorico no coincide con el CHECK no-negativo esperado';
  END IF;
END
$migration$;

ALTER TABLE public.cajas_sesiones
  DROP CONSTRAINT IF EXISTS ck_cajas_sesiones_monto_teorico;

ALTER TABLE public.cajas_cierres
  DROP CONSTRAINT IF EXISTS ck_cajas_cierres_monto_teorico;

ALTER TABLE public.cajas_arqueos
  DROP CONSTRAINT IF EXISTS ck_cajas_arqueos_teorico;

COMMIT;
