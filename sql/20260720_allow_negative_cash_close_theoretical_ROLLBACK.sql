-- Rollback seguro: falla cerrado si ya existen cierres teoricos negativos.
-- No ejecutar en produccion sin una revision especifica.
--
-- Dividido en dos fases para minimizar el tiempo bajo ACCESS EXCLUSIVE:
--   Fase 1 (transaccion corta): toma el lock NOWAIT, valida definiciones,
--     verifica ausencia de negativos, y agrega las restricciones faltantes
--     como NOT VALID (metadata-only, sin recorrer la tabla).
--   Fase 2 (fuera de la transaccion de la fase 1): valida cada restriccion
--     con VALIDATE CONSTRAINT bajo SHARE UPDATE EXCLUSIVE, que no bloquea
--     lecturas ni escrituras concurrentes. Si todo se hiciera en una sola
--     transaccion, el ACCESS EXCLUSIVE tomado por el ADD CONSTRAINT se
--     mantendria durante todo el escaneo de VALIDATE CONSTRAINT (los locks
--     de una transaccion no se liberan hasta el COMMIT), anulando el
--     beneficio de usar NOT VALID.

-- ===================== FASE 1 =====================
BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '20s';
SET LOCAL idle_in_transaction_session_timeout = '20s';

LOCK TABLE
  public.cajas_sesiones,
  public.cajas_cierres,
  public.cajas_arqueos
IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $rollback_guard$
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
$rollback_guard$;

DO $rollback_validate$
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

  -- Solo se valida la definicion cuando la restriccion YA existe (pudo no
  -- haber sido eliminada nunca, o ya haber sido restaurada antes). Si no
  -- existe, la fase de ADD mas abajo la crea desde cero.
  IF constraint_found AND (
    constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
    OR normalized_expression <> 'monto_teorico_cierreisnullormonto_teorico_cierre>=0'
  ) THEN
    RAISE EXCEPTION 'ck_cajas_sesiones_monto_teorico existe con una definicion incorrecta';
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
  ) THEN
    RAISE EXCEPTION 'ck_cajas_cierres_monto_teorico existe con una definicion incorrecta';
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
  ) THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_teorico existe con una definicion incorrecta';
  END IF;

  -- Columna protegida monto_contado: nunca se toca. Solo se confirma que
  -- sigue intacta antes de continuar (no se restaura ni se elimina).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_arqueos'::regclass
      AND c.conname = 'ck_cajas_arqueos_contado'
      AND c.contype = 'c'
      AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_contado no existe o no esta validado; abortando por seguridad';
  END IF;
END
$rollback_validate$;

-- Restaura EXCLUSIVAMENTE las restricciones que faltan (estado LEGACY). Si
-- alguna ya existe (rollback repetido, o nunca se elimino), no se toca.
-- NOT VALID: metadata-only, no recorre la tabla todavia (eso ocurre en la
-- fase 2, fuera de este ACCESS EXCLUSIVE).
DO $rollback_add$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
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
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_cierres'::regclass
      AND c.conname = 'ck_cajas_cierres_monto_teorico'
  ) THEN
    ALTER TABLE public.cajas_cierres
      ADD CONSTRAINT ck_cajas_cierres_monto_teorico
      CHECK (monto_teorico_cierre >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.cajas_arqueos'::regclass
      AND c.conname = 'ck_cajas_arqueos_teorico'
  ) THEN
    ALTER TABLE public.cajas_arqueos
      ADD CONSTRAINT ck_cajas_arqueos_teorico
      CHECK (monto_teorico >= 0) NOT VALID;
  END IF;
END
$rollback_add$;

COMMIT;

-- ===================== FASE 2 =====================
-- Statements independientes (fuera de cualquier BEGIN explicito): cada uno
-- corre en su propia transaccion implicita, bajo SHARE UPDATE EXCLUSIVE
-- (VALIDATE CONSTRAINT), sin bloquear ventas ni cierres concurrentes. Cada
-- bloque es un no-op seguro si la restriccion no existe o ya esta validada
-- (por ejemplo, si la fase 1 no pudo tomar el lock y aborto).
DO $validate_sesiones$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cajas_sesiones'::regclass
      AND conname = 'ck_cajas_sesiones_monto_teorico'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.cajas_sesiones VALIDATE CONSTRAINT ck_cajas_sesiones_monto_teorico;
  END IF;
END
$validate_sesiones$;

DO $validate_cierres$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cajas_cierres'::regclass
      AND conname = 'ck_cajas_cierres_monto_teorico'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.cajas_cierres VALIDATE CONSTRAINT ck_cajas_cierres_monto_teorico;
  END IF;
END
$validate_cierres$;

DO $validate_arqueos$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cajas_arqueos'::regclass
      AND conname = 'ck_cajas_arqueos_teorico'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.cajas_arqueos VALIDATE CONSTRAINT ck_cajas_arqueos_teorico;
  END IF;
END
$validate_arqueos$;
