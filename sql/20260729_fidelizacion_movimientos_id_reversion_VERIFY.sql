-- Clasificacion: POST-SAFE solamente. Ejecutar unicamente despues del SAFE
-- companero.

-- 1) Columna presente con tipo/nullabilidad esperados.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fidelizacion_movimientos'
  AND column_name = 'id_reversion';

-- 2) FK hacia facturas_reversiones(id_reversion) con ON DELETE RESTRICT/NO ACTION.
SELECT
  con.conname,
  att2.attname AS columna_referenciada,
  cl2.relname AS tabla_referenciada,
  con.confdeltype AS accion_on_delete
FROM pg_constraint con
JOIN pg_class cl2 ON cl2.oid = con.confrelid
JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = ANY(con.confkey)
WHERE con.conrelid = 'public.fidelizacion_movimientos'::regclass
  AND con.conname = 'fk_fidelizacion_movimientos_reversion';

-- 3) UNIQUE sobre id_reversion.
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'public.fidelizacion_movimientos'::regclass
  AND conname = 'uq_fidelizacion_movimientos_reversion';

-- 4) Indice presente.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'fidelizacion_movimientos'
  AND indexname = 'idx_fidelizacion_movimientos_reversion';

-- 5) Ninguna fila historica deberia tener id_reversion poblado inmediatamente
-- despues de aplicar esta migracion (no hay backfill).
SELECT COUNT(*) AS filas_con_id_reversion
FROM public.fidelizacion_movimientos
WHERE id_reversion IS NOT NULL;
