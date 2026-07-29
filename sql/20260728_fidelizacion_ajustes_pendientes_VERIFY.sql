-- Verificacion exclusivamente de lectura. Segura de ejecutar en cualquier
-- entorno, antes y despues de aplicar el SAFE.

-- 1) Tabla y columnas esperadas.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'fidelizacion_ajustes_pendientes'
ORDER BY ordinal_position;

-- 2) Constraints (CHECK, UNIQUE, FK, PK) presentes.
SELECT conname, contype, pg_get_constraintdef(oid, true) AS definicion
FROM pg_constraint
WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
ORDER BY conname;

-- 3) Indices presentes.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'fidelizacion_ajustes_pendientes'
ORDER BY indexname;

-- 4) Debe estar vacia inmediatamente despues de Fase 1 (ningun codigo de
-- aplicacion escribe en esta tabla todavia).
SELECT COUNT(*) AS filas_existentes FROM public.fidelizacion_ajustes_pendientes;

-- 5) Confirmacion de que las FK apuntan a las tablas correctas.
SELECT
  con.conname,
  att2.attname AS columna_local,
  cl2.relname AS tabla_referenciada,
  att.attname AS columna_referenciada
FROM pg_constraint con
JOIN pg_class cl ON cl.oid = con.conrelid
JOIN pg_class cl2 ON cl2.oid = con.confrelid
JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ANY(con.confkey)
JOIN pg_attribute att2 ON att2.attrelid = con.conrelid AND att2.attnum = ANY(con.conkey)
WHERE con.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
  AND con.contype = 'f'
ORDER BY con.conname;
