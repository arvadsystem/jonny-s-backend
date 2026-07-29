-- Agrega public.fidelizacion_canjes.id_sesion_caja (BIGINT NULL), FK hacia
-- public.cajas_sesiones(id_sesion_caja), con indice. Prerrequisito de
-- Fase 4 (createPresentialFidelizacionCanje hoy no tiene ningun concepto de
-- sesion de caja; ver services/fidelizacionService.js:1014-1276).
--
-- Nullable por compatibilidad historica: los canjes ya registrados no
-- tienen sesion asociada y no se puede inferir una por fecha (prohibido
-- explicitamente). Esta migracion NO actualiza ninguna fila existente:
-- id_sesion_caja queda NULL para todo canje creado antes de Fase 4.
--
-- ON DELETE RESTRICT (no SET NULL): la columna sigue siendo nullable para
-- canjes historicos, pero una vez que un canje tiene id_sesion_caja
-- asignado, esa sesion de caja no puede eliminarse sin perder trazabilidad
-- -> el borrado debe fallar explicitamente en vez de degradar el dato a
-- NULL silenciosamente.
--
-- Idempotente y auto-verificante: tras ADD COLUMN IF NOT EXISTS, valida
-- que el tipo/nullabilidad reales sean exactamente los esperados (por si
-- la columna ya existia por fuera de esta migracion con una definicion
-- distinta), y si la FK ya existe con el mismo nombre, valida que su
-- definicion (tabla/columna referenciada y accion ON DELETE) coincida con
-- la esperada antes de darla por buena.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.fidelizacion_canjes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.fidelizacion_canjes no existe';
  END IF;
  IF to_regclass('public.cajas_sesiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.cajas_sesiones no existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cajas_sesiones'
      AND column_name = 'id_sesion_caja'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: cajas_sesiones.id_sesion_caja no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.fidelizacion_canjes
  ADD COLUMN IF NOT EXISTS id_sesion_caja BIGINT NULL;

DO $validate_column$
DECLARE
  v_tipo text;
  v_nullable text;
BEGIN
  SELECT data_type, is_nullable INTO v_tipo, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
    AND column_name = 'id_sesion_caja';

  IF v_tipo IS DISTINCT FROM 'bigint' OR v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_canjes.id_sesion_caja existe con tipo=% nullable=% (se esperaba bigint/YES)', v_tipo, v_nullable;
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
    WHERE conrelid = 'public.fidelizacion_canjes'::regclass
      AND conname = 'fk_fidelizacion_canjes_sesion_caja'
  ) THEN
    ALTER TABLE public.fidelizacion_canjes
      ADD CONSTRAINT fk_fidelizacion_canjes_sesion_caja
      FOREIGN KEY (id_sesion_caja)
      REFERENCES public.cajas_sesiones(id_sesion_caja)
      ON DELETE RESTRICT;
  ELSE
    -- La FK ya existe con este nombre (ejecucion previa, o migracion
    -- aplicada por fuera de este archivo): validar que apunte a la tabla
    -- correcta, a la columna correcta y con ON DELETE RESTRICT/NO ACTION,
    -- nunca asumir que un nombre igual implica una definicion igual.
    SELECT c.confrelid, c.confdeltype
    INTO v_confrelid, v_confdeltype
    FROM pg_constraint c
    WHERE c.conrelid = 'public.fidelizacion_canjes'::regclass
      AND c.conname = 'fk_fidelizacion_canjes_sesion_caja';

    SELECT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_attribute a_local ON a_local.attrelid = c.conrelid AND a_local.attname = 'id_sesion_caja'
      JOIN pg_attribute a_ref ON a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_sesion_caja'
      WHERE c.conrelid = 'public.fidelizacion_canjes'::regclass
        AND c.conname = 'fk_fidelizacion_canjes_sesion_caja'
        AND c.conkey = ARRAY[a_local.attnum]::smallint[]
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    ) INTO v_conkey_ok;

    IF v_confrelid IS DISTINCT FROM 'public.cajas_sesiones'::regclass
       OR NOT v_conkey_ok
       OR v_confdeltype NOT IN ('r', 'a')
    THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fk_fidelizacion_canjes_sesion_caja existe pero no referencia cajas_sesiones(id_sesion_caja) con ON DELETE RESTRICT/NO ACTION (confrelid=%, confdeltype=%)', v_confrelid, v_confdeltype;
    END IF;
  END IF;
END
$add_fk$;

CREATE INDEX IF NOT EXISTS idx_fidelizacion_canjes_sesion_caja
  ON public.fidelizacion_canjes (id_sesion_caja);

COMMENT ON COLUMN public.fidelizacion_canjes.id_sesion_caja IS
  'Sesion de caja abierta bajo la cual se registro el canje presencial. NULL en canjes historicos anteriores a Fase 4; nunca inferido por fecha. ON DELETE RESTRICT: preserva trazabilidad una vez asignado.';

COMMIT;
