-- Agrega public.trabajos_impresion.id_reversion (BIGINT NULL), FK hacia
-- public.facturas_reversiones(id_reversion), con indice. Nullable por
-- compatibilidad historica (todo trabajo de factura/comanda/caja existente
-- no tiene reversion asociada y queda NULL).
--
-- No crea una fila 'REVERSION' en configuracion_impresoras: la reversion
-- usara la impresora logica FACTURA ya configurada (ver Fase 5).
--
-- ON DELETE RESTRICT (no SET NULL): la columna sigue siendo nullable para
-- trabajos historicos, pero una vez que un trabajo de impresion tiene
-- id_reversion asignado, esa reversion no puede eliminarse sin perder
-- trazabilidad -> el borrado debe fallar explicitamente, nunca degradar el
-- dato a NULL silenciosamente.
--
-- Sobre "evitar trabajos iniciales duplicados sin impedir reimpresiones":
-- NO se agrega ningun indice/constraint unico especulativo sobre
-- id_reversion. La tabla ya tiene UNIQUE (id_sucursal, idempotency_key,
-- tipo_documento) (sql/2026-07-16_cola_impresion_agentes_sucursal.sql:50),
-- y el contrato de Fase 5 fija las claves de idempotencia como
-- 'reversion:{id_reversion}:inicial' (fija, un solo valor posible por
-- reversion -> el UNIQUE existente ya impide un segundo trabajo inicial) y
-- 'reversion:{id_reversion}:reprint:{uuid}' (unica por reimpresion -> el
-- mismo UNIQUE nunca la bloquea). Anadir un UNIQUE(id_reversion) ademas
-- rompería las reimpresiones legitimas, que comparten id_reversion con el
-- trabajo inicial. Por eso esta migracion no agrega esa restriccion.
--
-- Idempotente y auto-verificante: tras ADD COLUMN IF NOT EXISTS, valida
-- que el tipo/nullabilidad reales sean exactamente los esperados, y si la
-- FK ya existe con el mismo nombre, valida que su definicion coincida con
-- la esperada antes de darla por buena.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.trabajos_impresion no existe';
  END IF;
  IF to_regclass('public.facturas_reversiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.trabajos_impresion
  ADD COLUMN IF NOT EXISTS id_reversion BIGINT NULL;

DO $validate_column$
DECLARE
  v_tipo text;
  v_nullable text;
BEGIN
  SELECT data_type, is_nullable INTO v_tipo, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'trabajos_impresion'
    AND column_name = 'id_reversion';

  IF v_tipo IS DISTINCT FROM 'bigint' OR v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: trabajos_impresion.id_reversion existe con tipo=% nullable=% (se esperaba bigint/YES)', v_tipo, v_nullable;
  END IF;
END
$validate_column$;

DO $add_fk$
DECLARE
  v_confrelid regclass;
  v_conkey_ok boolean;
  v_confdeltype "char";
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'fk_trabajos_impresion_reversion'
  ) THEN
    ALTER TABLE public.trabajos_impresion
      ADD CONSTRAINT fk_trabajos_impresion_reversion
      FOREIGN KEY (id_reversion)
      REFERENCES public.facturas_reversiones(id_reversion)
      ON DELETE RESTRICT;
  ELSE
    SELECT c.confrelid, c.confdeltype
    INTO v_confrelid, v_confdeltype
    FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion'::regclass
      AND c.conname = 'fk_trabajos_impresion_reversion';

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a_local ON a_local.attrelid = c.conrelid AND a_local.attname = 'id_reversion'
      JOIN pg_attribute a_ref ON a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_reversion'
      WHERE c.conrelid = 'public.trabajos_impresion'::regclass
        AND c.conname = 'fk_trabajos_impresion_reversion'
        AND c.conkey = ARRAY[a_local.attnum]::smallint[]
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    ) INTO v_conkey_ok;

    IF v_confrelid IS DISTINCT FROM 'public.facturas_reversiones'::regclass
       OR NOT v_conkey_ok
       OR v_confdeltype NOT IN ('r', 'a')
    THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fk_trabajos_impresion_reversion existe pero no referencia facturas_reversiones(id_reversion) con ON DELETE RESTRICT/NO ACTION (confrelid=%, confdeltype=%)', v_confrelid, v_confdeltype;
    END IF;
  END IF;
END
$add_fk$;

CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_reversion
  ON public.trabajos_impresion (id_reversion, fecha_creacion DESC);

COMMENT ON COLUMN public.trabajos_impresion.id_reversion IS
  'Reversion de venta especifica que origino este trabajo de impresion (tipo_documento=reversion). NULL para trabajos de factura/comanda/caja. ON DELETE RESTRICT: preserva trazabilidad una vez asignado.';

COMMIT;
