-- 2026-05-05_verify_cajas_cierres_arqueos_metodos.sql
-- Verificacion post-migracion (SOLO SELECT).

-- 1) Verificar que la tabla existe
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'cajas_cierres_arqueos_metodos';

-- 2) Verificar columnas y tipos
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cajas_cierres_arqueos_metodos'
ORDER BY ordinal_position;

-- 3) Verificar constraints declaradas sobre la tabla
SELECT
  c.conname AS constraint_name,
  c.contype AS constraint_type,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'cajas_cierres_arqueos_metodos'
ORDER BY c.conname;

-- 4) Verificar FK esperadas
SELECT
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'cajas_cierres_arqueos_metodos'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.constraint_name, kcu.ordinal_position;

-- 5) Verificar indice UNIQUE(id_cierre_caja, id_metodo_pago)
SELECT
  tc.constraint_name,
  tc.constraint_type,
  kcu.column_name,
  kcu.ordinal_position
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'cajas_cierres_arqueos_metodos'
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.constraint_name, kcu.ordinal_position;

-- 6) Verificar indices esperados
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'cajas_cierres_arqueos_metodos'
ORDER BY indexname;

-- 7) Verificar metodos de pago base (EFECTIVO/TARJETA/TRANSFERENCIA)
SELECT id_metodo_pago, nombre, codigo, afecta_efectivo, estado
FROM public.cat_metodos_pago
WHERE UPPER(codigo) IN ('EFECTIVO', 'TARJETA', 'TRANSFERENCIA')
ORDER BY id_metodo_pago;

-- 8) Verificar resolucion PENDIENTE_REVISION
SELECT id_resolucion_cierre_caja, codigo, nombre, requiere_observacion, estado
FROM public.cat_cajas_resoluciones_cierre
WHERE UPPER(codigo) = 'PENDIENTE_REVISION';

-- 9) Verificar duplicados por (id_cierre_caja, id_metodo_pago)
SELECT id_cierre_caja, id_metodo_pago, COUNT(*) AS cantidad
FROM public.cajas_cierres_arqueos_metodos
GROUP BY id_cierre_caja, id_metodo_pago
HAVING COUNT(*) > 1;

-- 10) Verificar cantidad de filas (debe ser 0 si aun no hay inserts)
SELECT COUNT(*) AS total_filas
FROM public.cajas_cierres_arqueos_metodos;

-- 11) Verificacion indirecta de no alteracion historica (conteos base de control)
SELECT 'cajas_cierres' AS tabla, COUNT(*) AS total FROM public.cajas_cierres
UNION ALL
SELECT 'cajas_arqueos' AS tabla, COUNT(*) AS total FROM public.cajas_arqueos
UNION ALL
SELECT 'facturas' AS tabla, COUNT(*) AS total FROM public.facturas
UNION ALL
SELECT 'facturas_cobros' AS tabla, COUNT(*) AS total FROM public.facturas_cobros
UNION ALL
SELECT 'cajas_movimientos' AS tabla, COUNT(*) AS total FROM public.cajas_movimientos;
