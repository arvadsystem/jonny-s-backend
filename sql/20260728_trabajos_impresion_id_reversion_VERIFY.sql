-- Clasificacion: PRE/POST seguro. trabajos_impresion y
-- configuracion_impresoras son tablas base preexistentes (siempre
-- presentes). La consulta que referencia id_reversion directamente esta
-- guardada en un bloque DO que verifica su existencia antes.

-- 1) Columna presente, nullable, tipo correcto.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'trabajos_impresion'
  AND column_name = 'id_reversion';

-- 2) FK hacia facturas_reversiones presente, con ON DELETE RESTRICT/NO ACTION.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion, confdeltype
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND conname = 'fk_trabajos_impresion_reversion';

-- 3) Indice presente.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'trabajos_impresion'
  AND indexname = 'idx_trabajos_impresion_reversion';

-- 4) Confirmar que NO se creo ninguna fila 'REVERSION' en
-- configuracion_impresoras (debe ser siempre 0).
SELECT COUNT(*) AS filas_impresora_reversion
FROM public.configuracion_impresoras
WHERE UPPER(TRIM(tipo_impresora)) = 'REVERSION';

-- 5) Evidencia de regresion cero: ningun trabajo existente fue modificado.
-- Guardado con verificacion de columna: antes del SAFE, reporta "columna
-- ausente" en vez de fallar.
DO $conteo_guardado$
DECLARE
  v_columna_existe boolean;
  v_total bigint;
  v_con_reversion bigint;
  v_sin_reversion bigint;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'trabajos_impresion'
      AND column_name = 'id_reversion'
  ) INTO v_columna_existe;

  IF NOT v_columna_existe THEN
    RAISE NOTICE 'trabajos_impresion.id_reversion aun no existe (VERIFY ejecutado antes del SAFE)';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*), COUNT(*) FILTER (WHERE id_reversion IS NOT NULL), COUNT(*) FILTER (WHERE id_reversion IS NULL) FROM public.trabajos_impresion'
    INTO v_total, v_con_reversion, v_sin_reversion;

  RAISE NOTICE 'trabajos_impresion: total=%, con_reversion=%, sin_reversion=%', v_total, v_con_reversion, v_sin_reversion;
END
$conteo_guardado$;

-- 6) El UNIQUE existente que ya cubre la idempotencia de trabajos
-- iniciales de reversion (ver comentario del SAFE).
SELECT conname, pg_get_constraintdef(oid, true) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND contype = 'u';

-- 7) Verificacion estricta read-only: aborta si la columna, FK, indice o
-- conteos historicos no corresponden exactamente al estado esperado para
-- reanudar Fase 8B.
DO $verify_trabajos_impresion_id_reversion$
DECLARE
  v_conteo integer;
  v_tipo text;
  v_nullable text;
  v_indexdef text;
  v_total bigint;
  v_con_reversion bigint;
  v_trabajos_reversion bigint;
  v_impresoras_reversion bigint;
BEGIN
  SELECT COUNT(*), max(data_type), max(is_nullable)
  INTO v_conteo, v_tipo, v_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'trabajos_impresion'
    AND column_name = 'id_reversion';

  IF v_conteo IS DISTINCT FROM 1
     OR v_tipo IS DISTINCT FROM 'bigint'
     OR v_nullable IS DISTINCT FROM 'YES'
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_TRABAJOS_ID_REVERSION: columna invalida (conteo=%, tipo=%, nullable=%).',
      v_conteo,
      v_tipo,
      v_nullable;
  END IF;

  SELECT COUNT(*)
  INTO v_conteo
  FROM pg_constraint c
  JOIN pg_attribute a_local
    ON a_local.attrelid = c.conrelid
   AND a_local.attname = 'id_reversion'
  JOIN pg_attribute a_ref
    ON a_ref.attrelid = c.confrelid
   AND a_ref.attname = 'id_reversion'
  WHERE c.conrelid = 'public.trabajos_impresion'::regclass
    AND c.conname = 'fk_trabajos_impresion_reversion'
    AND c.contype = 'f'
    AND c.conkey = ARRAY[a_local.attnum]::smallint[]
    AND c.confrelid = 'public.facturas_reversiones'::regclass
    AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    AND c.confdeltype IN ('a', 'r')
    AND c.convalidated;

  IF v_conteo IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_TRABAJOS_ID_REVERSION: FK fk_trabajos_impresion_reversion ausente, invalida o no validada.';
  END IF;

  SELECT COUNT(*), max(pg_get_indexdef(i.indexrelid, 0, true))
  INTO v_conteo, v_indexdef
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  WHERE i.indrelid = 'public.trabajos_impresion'::regclass
    AND ic.relname = 'idx_trabajos_impresion_reversion'
    AND i.indisvalid
    AND i.indisready;

  v_indexdef := lower(regexp_replace(COALESCE(v_indexdef, ''), '\s+', '', 'g'));

  IF v_conteo IS DISTINCT FROM 1
     OR v_indexdef !~ 'usingbtree\(id_reversion,fecha_creaciondesc\)$'
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_TRABAJOS_ID_REVERSION: indice idx_trabajos_impresion_reversion ausente o incompatible (conteo=%, definicion=%).',
      v_conteo,
      v_indexdef;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE id_reversion IS NOT NULL),
    COUNT(*) FILTER (WHERE tipo_documento = 'reversion')
  INTO v_total, v_con_reversion, v_trabajos_reversion
  FROM public.trabajos_impresion;

  SELECT COUNT(*)
  INTO v_impresoras_reversion
  FROM public.configuracion_impresoras
  WHERE UPPER(TRIM(tipo_impresora)) = 'REVERSION';

  IF v_total IS DISTINCT FROM 201
     OR v_con_reversion IS DISTINCT FROM 0
     OR v_trabajos_reversion IS DISTINCT FROM 0
     OR v_impresoras_reversion IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION
      'VERIFY_FAILED_TRABAJOS_ID_REVERSION: conteos inesperados (total=%, con_id_reversion=%, tipo_reversion=%, impresoras_reversion=%).',
      v_total,
      v_con_reversion,
      v_trabajos_reversion,
      v_impresoras_reversion;
  END IF;

  RAISE NOTICE
    'VERIFY_OK: trabajos_impresion.id_reversion, su FK, indice y conteos historicos son correctos.';
END
$verify_trabajos_impresion_id_reversion$;
