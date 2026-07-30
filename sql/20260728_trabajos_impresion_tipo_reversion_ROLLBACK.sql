-- Clasificacion: PRE/POST seguro (guarda con to_regclass la tabla opcional
-- trabajos_impresion_documentos; bloquea con ROLLBACK_BLOCKED_NONEMPTY en
-- vez de perder datos 'reversion' ya persistidos).
-- Restaura los CHECK de tipo_documento a su conjunto original
-- (trabajos_impresion: factura/comanda/caja; trabajos_impresion_documentos:
-- factura/comanda, formato/bytes sin reversion), pero SOLO si ningun
-- trabajo real usa hoy tipo_documento='reversion'. Si existen, el rollback
-- se bloquea: reducir el CHECK con datos 'reversion' ya persistidos violaria
-- la restriccion restaurada.
--
-- Nota: el CHECK original de trabajos_impresion era inline y sin nombre
-- (autogenerado por Postgres). El SAFE lo reemplazo por uno con nombre
-- explicito (ck_trabajos_impresion_tipo_documento); este rollback conserva
-- ese nombre explicito y solo revierte el conjunto de valores permitidos.

-- ===================== FASE 1: trabajos_impresion =====================
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_trabajos_impresion$
DECLARE
  v_filas_reversion integer;
BEGIN
  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion no existe; rollback no-op';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'ck_trabajos_impresion_tipo_documento'
  ) THEN
    RAISE NOTICE 'ck_trabajos_impresion_tipo_documento no existe; rollback no-op';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_filas_reversion
  FROM public.trabajos_impresion
  WHERE tipo_documento = 'reversion';

  IF v_filas_reversion > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: % trabajos de impresion con tipo_documento=''reversion'' ya existen; no se puede restringir el CHECK sin perder datos. Revertir backend/agente primero y decidir que hacer con esas filas.',
      v_filas_reversion;
  END IF;

  LOCK TABLE public.trabajos_impresion IN ACCESS EXCLUSIVE MODE NOWAIT;

  ALTER TABLE public.trabajos_impresion
    DROP CONSTRAINT ck_trabajos_impresion_tipo_documento;
  ALTER TABLE public.trabajos_impresion
    ADD CONSTRAINT ck_trabajos_impresion_tipo_documento
    CHECK (tipo_documento IN ('factura', 'comanda', 'caja'))
    NOT VALID;
END
$rollback_trabajos_impresion$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $validate_rollback_trabajos_impresion$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'ck_trabajos_impresion_tipo_documento'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion
      VALIDATE CONSTRAINT ck_trabajos_impresion_tipo_documento;
  END IF;
END
$validate_rollback_trabajos_impresion$;
COMMIT;

-- ============== FASE 2: trabajos_impresion_documentos ==============
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $rollback_documentos$
DECLARE
  v_filas_reversion integer;
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RAISE NOTICE 'trabajos_impresion_documentos no existe; rollback no-op';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_filas_reversion
  FROM public.trabajos_impresion_documentos
  WHERE tipo_documento = 'reversion';

  IF v_filas_reversion > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_NONEMPTY: % documentos con tipo_documento=''reversion'' ya existen en trabajos_impresion_documentos; no se puede restringir el CHECK sin perder datos.',
      v_filas_reversion;
  END IF;

  LOCK TABLE public.trabajos_impresion_documentos IN ACCESS EXCLUSIVE MODE NOWAIT;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_bytes_chk'
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      DROP CONSTRAINT trabajos_impresion_documentos_bytes_chk;
    ALTER TABLE public.trabajos_impresion_documentos
      ADD CONSTRAINT trabajos_impresion_documentos_bytes_chk CHECK (
        content_bytes > 0
        AND octet_length(contenido) = content_bytes
        AND (
          (tipo_documento = 'factura' AND content_bytes <= 2097152)
          OR (tipo_documento = 'comanda' AND content_bytes <= 262144)
        )
      ) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_formato_chk'
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      DROP CONSTRAINT trabajos_impresion_documentos_formato_chk;
    ALTER TABLE public.trabajos_impresion_documentos
      ADD CONSTRAINT trabajos_impresion_documentos_formato_chk CHECK (
        (tipo_documento = 'factura' AND formato = 'pdf' AND flavor = 'base64')
        OR (tipo_documento = 'comanda' AND formato = 'html' AND flavor = 'plain')
      ) NOT VALID;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_tipo_chk'
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos
      DROP CONSTRAINT trabajos_impresion_documentos_tipo_chk;
    ALTER TABLE public.trabajos_impresion_documentos
      ADD CONSTRAINT trabajos_impresion_documentos_tipo_chk
      CHECK (tipo_documento IN ('factura', 'comanda'))
      NOT VALID;
  END IF;
END
$rollback_documentos$;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $validate_rollback_documentos$
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_tipo_chk' AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos VALIDATE CONSTRAINT trabajos_impresion_documentos_tipo_chk;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_formato_chk' AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos VALIDATE CONSTRAINT trabajos_impresion_documentos_formato_chk;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND conname = 'trabajos_impresion_documentos_bytes_chk' AND NOT convalidated
  ) THEN
    ALTER TABLE public.trabajos_impresion_documentos VALIDATE CONSTRAINT trabajos_impresion_documentos_bytes_chk;
  END IF;
END
$validate_rollback_documentos$;
COMMIT;
