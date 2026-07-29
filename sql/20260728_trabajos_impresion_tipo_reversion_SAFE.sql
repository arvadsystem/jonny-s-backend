-- Amplia el CHECK de tipo_documento en trabajos_impresion y en
-- trabajos_impresion_documentos para admitir 'reversion', conservando
-- todos los valores actuales de cada tabla:
--   trabajos_impresion            -> factura, comanda, caja, reversion
--   trabajos_impresion_documentos -> factura, comanda, reversion (nunca
--                                     tuvo 'caja'; no se agrega aqui)
--
-- trabajos_impresion.tipo_documento hoy es un CHECK inline SIN NOMBRE
-- (sql/2026-07-16_cola_impresion_agentes_sucursal.sql:30-31), por lo que
-- Postgres le asigno un nombre autogenerado. Esta migracion lo localiza por
-- introspeccion (nunca por nombre asumido), lo reemplaza por uno con
-- nombre explicito y widening, en dos fases para minimizar el tiempo bajo
-- ACCESS EXCLUSIVE: ADD ... NOT VALID (metadata-only) y despues
-- VALIDATE CONSTRAINT (SHARE UPDATE EXCLUSIVE, no bloquea lecturas ni
-- escrituras concurrentes de la cola de impresion).
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
  v_old_conname text;
  v_tipo_attnum smallint;
  v_definicion text;
BEGIN
  -- Ya migrado en una ejecucion anterior: no-op.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'ck_trabajos_impresion_tipo_documento'
  ) THEN
    RAISE NOTICE 'ck_trabajos_impresion_tipo_documento ya existe; no-op';
    RETURN;
  END IF;

  SELECT a.attnum INTO v_tipo_attnum
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trabajos_impresion'::regclass
    AND a.attname = 'tipo_documento'
    AND NOT a.attisdropped;

  IF v_tipo_attnum IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: trabajos_impresion.tipo_documento no existe';
  END IF;

  SELECT c.conname, pg_get_constraintdef(c.oid, true)
  INTO v_old_conname, v_definicion
  FROM pg_constraint c
  WHERE c.conrelid = 'public.trabajos_impresion'::regclass
    AND c.contype = 'c'
    AND c.conkey = ARRAY[v_tipo_attnum]::smallint[]
    AND pg_get_constraintdef(c.oid, true) LIKE '%factura%'
    AND pg_get_constraintdef(c.oid, true) LIKE '%comanda%'
    AND pg_get_constraintdef(c.oid, true) LIKE '%caja%';

  IF v_old_conname IS NULL THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no se encontro el CHECK esperado de tipo_documento (factura/comanda/caja) sobre trabajos_impresion; revisar manualmente antes de continuar.';
  END IF;

  IF v_definicion LIKE '%reversion%' THEN
    RAISE NOTICE 'El CHECK % ya admite reversion; solo se renombra a ck_trabajos_impresion_tipo_documento', v_old_conname;
  END IF;

  LOCK TABLE public.trabajos_impresion IN ACCESS EXCLUSIVE MODE NOWAIT;

  EXECUTE format('ALTER TABLE public.trabajos_impresion DROP CONSTRAINT %I', v_old_conname);

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
-- Constraint ya tiene nombre explicito (sql/20260719_create_print_job_documents.sql),
-- por lo que aqui se usa DROP/ADD directo por nombre conocido, mismo
-- patron NOT VALID + VALIDATE en dos transacciones separadas.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $swap_documentos_tipo$
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe; se omite (schema v2 opcional)';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND c.conname = 'trabajos_impresion_documentos_tipo_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%reversion%'
  ) THEN
    RAISE NOTICE 'trabajos_impresion_documentos_tipo_chk ya admite reversion; no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND c.conname = 'trabajos_impresion_documentos_tipo_chk'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: no existe trabajos_impresion_documentos_tipo_chk';
  END IF;

  LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE NOWAIT;

  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT trabajos_impresion_documentos_tipo_chk;
  ALTER TABLE public.trabajos_impresion_documentos
    ADD CONSTRAINT trabajos_impresion_documentos_tipo_chk
    CHECK (tipo_documento IN ('factura', 'comanda', 'reversion'))
    NOT VALID;

  -- El comprobante de reversion es PDF/base64, igual que factura (mismo
  -- limite de tamano MAX_CANONICAL_PDF_BYTES=2097152 de
  -- services/printJobDocumentService.js). Se amplia formato_chk y
  -- bytes_chk para reflejar exactamente esa regla, sin tocar comanda.
  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT IF EXISTS trabajos_impresion_documentos_formato_chk;
  ALTER TABLE public.trabajos_impresion_documentos
    ADD CONSTRAINT trabajos_impresion_documentos_formato_chk CHECK (
      (tipo_documento = 'factura' AND formato = 'pdf' AND flavor = 'base64')
      OR (tipo_documento = 'reversion' AND formato = 'pdf' AND flavor = 'base64')
      OR (tipo_documento = 'comanda' AND formato = 'html' AND flavor = 'plain')
    ) NOT VALID;

  ALTER TABLE public.trabajos_impresion_documentos
    DROP CONSTRAINT IF EXISTS trabajos_impresion_documentos_bytes_chk;
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
$swap_documentos_tipo$;

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
