-- Verificacion exclusivamente de lectura. Segura de ejecutar en cualquier
-- entorno, antes y despues de aplicar el SAFE.

-- 1) Columna presente, nullable, tipo correcto.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'trabajos_impresion'
  AND column_name = 'id_reversion';

-- 2) FK hacia facturas_reversiones presente.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion
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
SELECT
  COUNT(*) AS total_trabajos,
  COUNT(*) FILTER (WHERE id_reversion IS NOT NULL) AS trabajos_con_reversion,
  COUNT(*) FILTER (WHERE id_reversion IS NULL) AS trabajos_sin_reversion
FROM public.trabajos_impresion;

-- 6) El UNIQUE existente que ya cubre la idempotencia de trabajos
-- iniciales de reversion (ver comentario del SAFE).
SELECT conname, pg_get_constraintdef(oid, true) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.trabajos_impresion'::regclass
  AND contype = 'u';
