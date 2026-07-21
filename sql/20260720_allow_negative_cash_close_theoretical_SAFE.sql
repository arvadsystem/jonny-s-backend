-- Permite cierres con efectivo/monto teorico negativo sin alterar datos
-- historicos: elimina EXCLUSIVAMENTE los tres CHECK de no-negatividad sobre
-- monto_teorico_cierre/monto_teorico. No contiene DML. No toca facturas,
-- facturas_detalle, facturas_cobros, pedidos, ventas, inventario ni
-- movimientos historicos.
--
-- Operacion manual y separada del deploy. No ejecutar desde el arranque
-- automatico de la aplicacion. Ejecutar PREFLIGHT antes, en el mismo entorno,
-- y no asumir que el estado (sesiones abiertas, locks, transacciones) se
-- mantendra igual hasta este momento.
--
-- Disenado para fallar rapido en vez de bloquear ventas: si no puede tomar
-- el lock exclusivo de inmediato, aborta sin reintentar y sin eliminar nada.

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '20s';
SET LOCAL idle_in_transaction_session_timeout = '20s';

-- Si otra transaccion sostiene cualquier lock sobre estas tablas (una venta,
-- un cierre, un arqueo en curso), esto falla en <=1s en vez de encolar
-- ventas detras de la migracion. No hay reintento automatico: es
-- intencional, para que un operador decida cuando reintentar.
LOCK TABLE
  public.cajas_sesiones,
  public.cajas_cierres,
  public.cajas_arqueos
IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Preflight estricto, ya con el lock exclusivo tomado: nadie mas puede
-- cambiar estas tablas hasta el COMMIT/ROLLBACK de esta transaccion.
DO $migration$
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

  -- Columna protegida: monto_contado (conteo fisico) debe seguir >= 0 y no
  -- debe ser alterada por esta migracion. No basta con el nombre de la
  -- restriccion: se valida tipo, validacion, columnas exactas y expresion.
  SELECT a.attnum
  INTO target_column
  FROM pg_attribute a
  WHERE a.attrelid = 'public.cajas_arqueos'::regclass
    AND a.attname = 'monto_contado'
    AND NOT a.attisdropped;

  IF target_column IS NULL THEN
    RAISE EXCEPTION 'Falta public.cajas_arqueos.monto_contado';
  END IF;

  SELECT c.contype, c.convalidated, c.conkey, pg_get_expr(c.conbin, c.conrelid)
  INTO constraint_type, constraint_validated, constraint_columns, constraint_expression
  FROM pg_constraint c
  WHERE c.conrelid = 'public.cajas_arqueos'::regclass
    AND c.conname = 'ck_cajas_arqueos_contado';

  constraint_found := FOUND;
  normalized_expression := lower(regexp_replace(
    COALESCE(constraint_expression, ''),
    '\s+|[()]|::numeric',
    '',
    'g'
  ));

  IF NOT constraint_found
     OR constraint_type IS DISTINCT FROM 'c'::"char"
     OR constraint_validated IS NOT TRUE
     OR constraint_columns IS DISTINCT FROM ARRAY[target_column]::smallint[]
     OR normalized_expression <> 'monto_contado>=0'
  THEN
    RAISE EXCEPTION 'ck_cajas_arqueos_contado (columna protegida monto_contado) no existe, no esta validado, protege columnas distintas de monto_contado, o no coincide con monto_contado >= 0; abortando por seguridad';
  END IF;

  target_column := NULL;
  constraint_columns := NULL;
  constraint_expression := NULL;
  constraint_type := NULL;
  constraint_validated := NULL;
  normalized_expression := NULL;

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

-- Elimina EXCLUSIVAMENTE estos tres CHECK. DROP CONSTRAINT IF EXISTS es
-- idempotente: si SAFE ya se ejecuto antes (parcial o completo), esto no
-- falla y no vuelve a intentar nada mas.
ALTER TABLE public.cajas_sesiones
  DROP CONSTRAINT IF EXISTS ck_cajas_sesiones_monto_teorico;

ALTER TABLE public.cajas_cierres
  DROP CONSTRAINT IF EXISTS ck_cajas_cierres_monto_teorico;

ALTER TABLE public.cajas_arqueos
  DROP CONSTRAINT IF EXISTS ck_cajas_arqueos_teorico;

COMMIT;
