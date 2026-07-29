-- Agrega public.fidelizacion_movimientos.id_reversion (BIGINT NULL), FK
-- hacia public.facturas_reversiones(id_reversion), con UNIQUE (nullable) e
-- indice. Prerrequisito de Fase 4 (seccion 3.5 del ticket): hoy
-- services/ventasReversionService.js:revertLoyaltyForFactura localiza "el"
-- movimiento REVERSO de una factura buscando por
-- (id_factura, id_tipo_movimiento, id_origen_movimiento) y lo ACTUALIZA
-- (UPDATE) si ya existe uno, en vez de crear un registro independiente por
-- cada reversion -- eso hace imposible saber, a partir de
-- fidelizacion_movimientos, cuantos puntos retiro CADA reversion cuando una
-- factura se reversa en mas de una operacion parcial.
--
-- Con esta columna, Fase 4 crea UN movimiento REVERSO nuevo por cada
-- id_reversion (nunca actualiza uno existente), preservando trazabilidad
-- exacta por operacion. El codigo de aplicacion (Fase 4) SOLO usa este
-- camino cuando la columna existe (verificado via information_schema en
-- runtime); si no existe, conserva el comportamiento anterior (un unico
-- movimiento REVERSO mutable por factura) como equivalente seguro de
-- respaldo, documentado explicitamente en el reporte de Fase 4.
--
-- Nullable por compatibilidad historica: los movimientos ya registrados
-- (incluidas reversiones previas a Fase 4) no tienen id_reversion y no se
-- puede inferir uno retroactivamente sin arriesgar una asociacion
-- incorrecta. Esta migracion NO hace backfill.
--
-- UNIQUE (id_reversion): a lo sumo un movimiento de fidelizacion por
-- reversion (NULLs no colisionan entre si en una restriccion UNIQUE de
-- Postgres, asi que las filas historicas sin id_reversion nunca violan
-- esta restriccion).
--
-- ON DELETE RESTRICT: una vez que un movimiento de fidelizacion queda
-- asociado a una reversion, esa reversion no puede eliminarse sin perder
-- trazabilidad -> el borrado debe fallar explicitamente.
--
-- Idempotente y auto-verificante, mismo patron que
-- 20260728_fidelizacion_canjes_sesion_caja_SAFE.sql: ADD COLUMN IF NOT
-- EXISTS, luego valida tipo/nullabilidad reales, luego agrega o valida la
-- FK por tabla/columna referenciada (nunca solo por nombre), luego agrega o
-- valida la UNIQUE, luego el indice.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.fidelizacion_movimientos') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.fidelizacion_movimientos no existe';
  END IF;
  IF to_regclass('public.facturas_reversiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.fidelizacion_movimientos
  ADD COLUMN IF NOT EXISTS id_reversion BIGINT NULL;

DO $validate_column$
DECLARE
  v_tipo text;
  v_nullable text;
BEGIN
  SELECT data_type, is_nullable INTO v_tipo, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'fidelizacion_movimientos'
    AND column_name = 'id_reversion';

  IF v_tipo IS DISTINCT FROM 'bigint' OR v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_movimientos.id_reversion existe con tipo=% nullable=% (se esperaba bigint/YES)', v_tipo, v_nullable;
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
    WHERE conrelid = 'public.fidelizacion_movimientos'::regclass
      AND conname = 'fk_fidelizacion_movimientos_reversion'
  ) THEN
    ALTER TABLE public.fidelizacion_movimientos
      ADD CONSTRAINT fk_fidelizacion_movimientos_reversion
      FOREIGN KEY (id_reversion)
      REFERENCES public.facturas_reversiones(id_reversion)
      ON DELETE RESTRICT;
  ELSE
    SELECT c.confrelid, c.confdeltype
    INTO v_confrelid, v_confdeltype
    FROM pg_constraint c
    WHERE c.conrelid = 'public.fidelizacion_movimientos'::regclass
      AND c.conname = 'fk_fidelizacion_movimientos_reversion';

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a_local ON a_local.attrelid = c.conrelid AND a_local.attname = 'id_reversion'
      JOIN pg_attribute a_ref ON a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_reversion'
      WHERE c.conrelid = 'public.fidelizacion_movimientos'::regclass
        AND c.conname = 'fk_fidelizacion_movimientos_reversion'
        AND c.conkey = ARRAY[a_local.attnum]::smallint[]
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    ) INTO v_conkey_ok;

    IF v_confrelid IS DISTINCT FROM 'public.facturas_reversiones'::regclass
       OR NOT v_conkey_ok
       OR v_confdeltype NOT IN ('r', 'a')
    THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fk_fidelizacion_movimientos_reversion existe pero no referencia facturas_reversiones(id_reversion) con ON DELETE RESTRICT/NO ACTION (confrelid=%, confdeltype=%)', v_confrelid, v_confdeltype;
    END IF;
  END IF;
END
$add_fk$;

DO $add_unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_reversion'
    WHERE c.conrelid = 'public.fidelizacion_movimientos'::regclass
      AND c.contype = 'u' AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) THEN
    ALTER TABLE public.fidelizacion_movimientos
      ADD CONSTRAINT uq_fidelizacion_movimientos_reversion UNIQUE (id_reversion);
  END IF;
END
$add_unique$;

CREATE INDEX IF NOT EXISTS idx_fidelizacion_movimientos_reversion
  ON public.fidelizacion_movimientos (id_reversion);

COMMENT ON COLUMN public.fidelizacion_movimientos.id_reversion IS
  'Reversion de venta que genero este movimiento REVERSO. NULL en movimientos historicos anteriores a Fase 4 y en movimientos que no son reversos. Un movimiento independiente por reversion (nunca se reutiliza/actualiza uno existente).';

COMMIT;
