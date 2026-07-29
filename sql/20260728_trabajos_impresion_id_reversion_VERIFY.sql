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
