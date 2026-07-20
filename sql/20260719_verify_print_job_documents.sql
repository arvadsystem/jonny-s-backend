-- Verificacion READ-ONLY posterior a la migracion.

SELECT
  current_user,
  session_user,
  to_regclass('public.trabajos_impresion_documentos') AS tabla,
  to_regclass('public.trabajos_impresion_documentos_id_documento_seq') AS secuencia,
  to_regprocedure('extensions.digest(bytea,text)') AS funcion_digest;

SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  is_identity,
  identity_generation
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trabajos_impresion_documentos'
ORDER BY ordinal_position;

SELECT
  c.conname,
  c.contype,
  pg_get_constraintdef(c.oid, true) AS definicion
FROM pg_constraint c
WHERE c.conrelid = 'public.trabajos_impresion_documentos'::regclass
ORDER BY c.conname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'trabajos_impresion_documentos'
ORDER BY indexname;

SELECT
  pg_get_userbyid(c.relowner) AS owner,
  c.relrowsecurity AS rls_habilitado,
  c.relforcerowsecurity AS rls_forzado
FROM pg_class c
WHERE c.oid = 'public.trabajos_impresion_documentos'::regclass;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'trabajos_impresion_documentos';

SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name = 'trabajos_impresion_documentos'
ORDER BY grantee, privilege_type;

SELECT
  has_table_privilege('postgres', 'public.trabajos_impresion_documentos', 'SELECT') AS postgres_select,
  has_table_privilege('postgres', 'public.trabajos_impresion_documentos', 'INSERT') AS postgres_insert,
  has_table_privilege('service_role', 'public.trabajos_impresion_documentos', 'SELECT') AS service_role_select,
  has_table_privilege('service_role', 'public.trabajos_impresion_documentos', 'INSERT') AS service_role_insert,
  has_table_privilege('anon', 'public.trabajos_impresion_documentos', 'SELECT') AS anon_select,
  has_table_privilege('authenticated', 'public.trabajos_impresion_documentos', 'SELECT') AS authenticated_select,
  has_sequence_privilege('service_role', 'public.trabajos_impresion_documentos_id_documento_seq', 'USAGE') AS service_role_sequence_usage;

SELECT
  count(*)::bigint AS documentos,
  COALESCE(sum(content_bytes), 0)::bigint AS bytes_persistidos,
  count(*) FILTER (
    WHERE content_bytes <> octet_length(contenido)
  )::bigint AS bytes_invalidos,
  count(*) FILTER (
    WHERE content_sha256 <> encode(extensions.digest(contenido, 'sha256'), 'hex')
  )::bigint AS hashes_invalidos
FROM public.trabajos_impresion_documentos;

SELECT
  count(*) FILTER (
    WHERE tid.schema_version <> 2
      OR tid.tipo_documento <> ti.tipo_documento
      OR tid.content_sha256 <> ti.payload->'documento_canonico'->>'content_sha256'
      OR tid.content_bytes <> (ti.payload->'documento_canonico'->>'content_bytes')::integer
  )::bigint AS documentos_incompatibles
FROM public.trabajos_impresion_documentos tid
JOIN public.trabajos_impresion ti ON ti.id_trabajo = tid.id_trabajo;

SELECT count(*)::bigint AS trabajos_v2_sin_documento
FROM public.trabajos_impresion ti
LEFT JOIN public.trabajos_impresion_documentos tid
  ON tid.id_trabajo = ti.id_trabajo
WHERE ti.payload->>'schema_version' = '2'
  AND tid.id_trabajo IS NULL;
