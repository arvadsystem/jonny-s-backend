-- Verificacion exclusivamente de lectura. Segura de ejecutar en cualquier
-- entorno, antes y despues de aplicar el SAFE.

-- 1) Columna presente, nullable, tipo correcto.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fidelizacion_canjes'
  AND column_name = 'id_sesion_caja';

-- 2) FK hacia cajas_sesiones presente.
SELECT conname, pg_get_constraintdef(oid, true) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.fidelizacion_canjes'::regclass
  AND conname = 'fk_fidelizacion_canjes_sesion_caja';

-- 3) Indice presente.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'fidelizacion_canjes'
  AND indexname = 'idx_fidelizacion_canjes_sesion_caja';

-- 4) Evidencia de regresion cero: ningun canje existente fue modificado.
-- Ejecutar antes y despues del SAFE y comparar manualmente: deben ser
-- identicos (la migracion no hace backfill ni UPDATE).
SELECT
  COUNT(*) AS total_canjes,
  COUNT(*) FILTER (WHERE id_sesion_caja IS NOT NULL) AS canjes_con_sesion,
  COUNT(*) FILTER (WHERE id_sesion_caja IS NULL) AS canjes_sin_sesion
FROM public.fidelizacion_canjes;
