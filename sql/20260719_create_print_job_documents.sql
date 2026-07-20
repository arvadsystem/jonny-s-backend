BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

SELECT pg_advisory_xact_lock(
  hashtextextended('jonnys.trabajos_impresion_documentos.v1', 0)
);

DO $preflight$
DECLARE
  v_id_trabajo_attnum smallint;
  v_id_trabajo_type text;
  v_target regclass;
  v_sequence regclass;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_REQUIRES_POSTGRES: current_user=%', current_user;
  END IF;

  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.trabajos_impresion no existe';
  END IF;

  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: % no tiene CREATE sobre schema public', current_user;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS required_role(role_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = required_role.role_name
    )
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: faltan roles Supabase requeridos';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto'
      AND n.nspname = 'extensions'
  ) OR to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: extensions.digest(bytea,text) no esta disponible';
  END IF;

  SELECT a.attnum, format_type(a.atttypid, a.atttypmod)
  INTO v_id_trabajo_attnum, v_id_trabajo_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.trabajos_impresion'::regclass
    AND a.attname = 'id_trabajo'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_id_trabajo_attnum IS NULL OR v_id_trabajo_type <> 'bigint' THEN
    RAISE EXCEPTION
      'PREFLIGHT_FAILED: trabajos_impresion.id_trabajo debe ser bigint; tipo=%',
      COALESCE(v_id_trabajo_type, '<ausente>');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion'::regclass
      AND c.contype = 'p'
      AND c.conkey = ARRAY[v_id_trabajo_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: trabajos_impresion.id_trabajo debe ser la PK';
  END IF;

  v_target := to_regclass('public.trabajos_impresion_documentos');
  IF v_target IS NULL THEN
    RETURN;
  END IF;

  v_sequence := to_regclass('public.trabajos_impresion_documentos_id_documento_seq');
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.oid = v_target
      AND c.relkind = 'r'
      AND c.relowner = 'postgres'::regrole
      AND c.relrowsecurity = true
  ) OR v_sequence IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.oid = v_sequence
      AND c.relkind = 'S'
      AND c.relowner = 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: owner, RLS o secuencia incompatibles';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_attribute a
    WHERE a.attrelid = v_target
      AND a.attnum > 0
      AND NOT a.attisdropped
  ) <> 10 OR EXISTS (
    WITH expected(attnum, attname, data_type, attidentity) AS (
      VALUES
        (1, 'id_documento', 'bigint', 'a'),
        (2, 'id_trabajo', 'bigint', ''),
        (3, 'schema_version', 'smallint', ''),
        (4, 'tipo_documento', 'text', ''),
        (5, 'formato', 'text', ''),
        (6, 'flavor', 'text', ''),
        (7, 'contenido', 'bytea', ''),
        (8, 'content_sha256', 'text', ''),
        (9, 'content_bytes', 'integer', ''),
        (10, 'fecha_creacion', 'timestamp with time zone', '')
    )
    SELECT 1
    FROM expected e
    LEFT JOIN pg_attribute a
      ON a.attrelid = v_target
      AND a.attname = e.attname
      AND a.attnum > 0
      AND NOT a.attisdropped
    WHERE a.attname IS NULL
      OR a.attnum <> e.attnum
      OR format_type(a.atttypid, a.atttypmod) <> e.data_type
      OR a.attnotnull IS NOT TRUE
      OR a.attidentity <> e.attidentity::"char"
      OR a.attgenerated <> ''
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
      AND d.adnum = a.attnum
    WHERE a.attrelid = v_target
      AND a.attname = 'fecha_creacion'
      AND pg_get_expr(d.adbin, d.adrelid) = 'now()'
  ) OR EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = v_target
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname NOT IN ('id_documento', 'fecha_creacion')
      AND a.atthasdef
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: columnas incompatibles';
  END IF;

  IF EXISTS (
    WITH expected(conname, contype) AS (
      VALUES
        ('trabajos_impresion_documentos_pkey', 'p'),
        ('trabajos_impresion_documentos_trabajo_uk', 'u'),
        ('trabajos_impresion_documentos_trabajo_fk', 'f'),
        ('trabajos_impresion_documentos_schema_chk', 'c'),
        ('trabajos_impresion_documentos_tipo_chk', 'c'),
        ('trabajos_impresion_documentos_formato_chk', 'c'),
        ('trabajos_impresion_documentos_hash_formato_chk', 'c'),
        ('trabajos_impresion_documentos_bytes_chk', 'c'),
        ('trabajos_impresion_documentos_hash_contenido_chk', 'c')
    )
    SELECT 1
    FROM expected e
    LEFT JOIN pg_constraint c
      ON c.conrelid = v_target
      AND c.conname = e.conname
      AND c.contype = e.contype::"char"
    WHERE c.oid IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname NOT IN (
        'trabajos_impresion_documentos_pkey',
        'trabajos_impresion_documentos_trabajo_uk',
        'trabajos_impresion_documentos_trabajo_fk',
        'trabajos_impresion_documentos_schema_chk',
        'trabajos_impresion_documentos_tipo_chk',
        'trabajos_impresion_documentos_formato_chk',
        'trabajos_impresion_documentos_hash_formato_chk',
        'trabajos_impresion_documentos_bytes_chk',
        'trabajos_impresion_documentos_hash_contenido_chk'
      )
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: restricciones incompatibles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
      AND a.attname = 'id_documento'
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_pkey'
      AND c.contype = 'p'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
      AND a.attname = 'id_trabajo'
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_trabajo_uk'
      AND c.contype = 'u'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid
      AND a.attname = 'id_trabajo'
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_trabajo_fk'
      AND c.contype = 'f'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.confrelid = 'public.trabajos_impresion'::regclass
      AND c.confkey = ARRAY[v_id_trabajo_attnum]::smallint[]
      AND c.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: PK, UNIQUE o FK incompatibles';
  END IF;

  IF to_regclass(pg_get_serial_sequence(
    'public.trabajos_impresion_documentos',
    'id_documento'
  )) IS DISTINCT FROM v_sequence THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: identity no pertenece a la secuencia esperada';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_schema_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%schema_version = 2%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_tipo_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%factura%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%comanda%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_formato_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%pdf%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%base64%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%html%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%plain%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_hash_formato_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%^[a-f0-9]{64}$%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_bytes_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%octet_length(contenido) = content_bytes%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%2097152%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%262144%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = v_target
      AND c.conname = 'trabajos_impresion_documentos_hash_contenido_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%extensions.digest%'
      AND pg_get_constraintdef(c.oid, true) LIKE '%sha256%'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: checks incompatibles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trabajos_impresion_documentos'
  ) OR NOT has_table_privilege(
    'postgres', 'public.trabajos_impresion_documentos', 'SELECT'
  ) OR NOT has_table_privilege(
    'postgres', 'public.trabajos_impresion_documentos', 'INSERT'
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS denied(role_name)
    WHERE has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'SELECT')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'INSERT')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'UPDATE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'DELETE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'TRUNCATE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'REFERENCES')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'TRIGGER')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'USAGE')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'SELECT')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'UPDATE')
  ) OR EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::char ELSE 'r'::char END, c.relowner))
    ) acl
    WHERE c.oid IN (v_target, v_sequence)
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_EXISTING_TABLE_MISMATCH: seguridad o privilegios incompatibles';
  END IF;

  RAISE NOTICE 'tabla existente compatible; migracion en modo no-op';
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.trabajos_impresion_documentos (
  id_documento bigint GENERATED ALWAYS AS IDENTITY,
  id_trabajo bigint NOT NULL,
  schema_version smallint NOT NULL,
  tipo_documento text NOT NULL,
  formato text NOT NULL,
  flavor text NOT NULL,
  contenido bytea NOT NULL,
  content_sha256 text NOT NULL,
  content_bytes integer NOT NULL,
  fecha_creacion timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trabajos_impresion_documentos_pkey PRIMARY KEY (id_documento),
  CONSTRAINT trabajos_impresion_documentos_trabajo_uk UNIQUE (id_trabajo),
  CONSTRAINT trabajos_impresion_documentos_trabajo_fk
    FOREIGN KEY (id_trabajo)
    REFERENCES public.trabajos_impresion(id_trabajo)
    ON DELETE CASCADE,
  CONSTRAINT trabajos_impresion_documentos_schema_chk CHECK (schema_version = 2),
  CONSTRAINT trabajos_impresion_documentos_tipo_chk
    CHECK (tipo_documento IN ('factura', 'comanda')),
  CONSTRAINT trabajos_impresion_documentos_formato_chk CHECK (
    (tipo_documento = 'factura' AND formato = 'pdf' AND flavor = 'base64')
    OR (tipo_documento = 'comanda' AND formato = 'html' AND flavor = 'plain')
  ),
  CONSTRAINT trabajos_impresion_documentos_hash_formato_chk
    CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT trabajos_impresion_documentos_bytes_chk CHECK (
    content_bytes > 0
    AND octet_length(contenido) = content_bytes
    AND (
      (tipo_documento = 'factura' AND content_bytes <= 2097152)
      OR (tipo_documento = 'comanda' AND content_bytes <= 262144)
    )
  ),
  CONSTRAINT trabajos_impresion_documentos_hash_contenido_chk CHECK (
    content_sha256 = encode(extensions.digest(contenido, 'sha256'), 'hex')
  )
);

ALTER TABLE public.trabajos_impresion_documentos OWNER TO postgres;
ALTER SEQUENCE public.trabajos_impresion_documentos_id_documento_seq OWNER TO postgres;

COMMENT ON TABLE public.trabajos_impresion_documentos IS
  'Contenido canonico inmutable de trabajos de impresion schema v2.';
COMMENT ON COLUMN public.trabajos_impresion_documentos.contenido IS
  'Bytes exactos utilizados para content_sha256 y content_bytes.';
COMMENT ON COLUMN public.trabajos_impresion_documentos.content_sha256 IS
  'SHA-256 hexadecimal en minusculas del contenido binario.';

ALTER TABLE public.trabajos_impresion_documentos ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.trabajos_impresion_documentos
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.trabajos_impresion_documentos_id_documento_seq
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_missing_constraints text;
BEGIN
  IF to_regclass('public.trabajos_impresion_documentos') IS NULL
    OR to_regclass('public.trabajos_impresion_documentos_id_documento_seq') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: tabla o secuencia no creada';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.oid = 'public.trabajos_impresion_documentos'::regclass
      AND c.relowner = 'postgres'::regrole
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: owner o RLS incorrectos';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    WHERE c.oid = 'public.trabajos_impresion_documentos_id_documento_seq'::regclass
      AND c.relowner = 'postgres'::regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_attribute a
    WHERE a.attrelid = 'public.trabajos_impresion_documentos'::regclass
      AND a.attname = 'id_documento'
      AND a.attidentity = 'a'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: identity GENERATED ALWAYS incorrecta';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trabajos_impresion_documentos'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: no deben existir politicas en la tabla';
  END IF;

  IF NOT has_table_privilege('postgres', 'public.trabajos_impresion_documentos', 'SELECT')
    OR NOT has_table_privilege('postgres', 'public.trabajos_impresion_documentos', 'INSERT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: postgres no puede SELECT/INSERT';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS denied(role_name)
    WHERE has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'SELECT')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'INSERT')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'UPDATE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'DELETE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'TRUNCATE')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'REFERENCES')
      OR has_table_privilege(denied.role_name, 'public.trabajos_impresion_documentos', 'TRIGGER')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'USAGE')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'SELECT')
      OR has_sequence_privilege(denied.role_name, 'public.trabajos_impresion_documentos_id_documento_seq', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: quedaron privilegios no autorizados';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(
      COALESCE(c.relacl, acldefault(CASE WHEN c.relkind = 'S' THEN 'S'::char ELSE 'r'::char END, c.relowner))
    ) acl
    WHERE c.oid IN (
      'public.trabajos_impresion_documentos'::regclass,
      'public.trabajos_impresion_documentos_id_documento_seq'::regclass
    )
      AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: PUBLIC conserva privilegios';
  END IF;

  SELECT string_agg(expected.conname, ', ' ORDER BY expected.conname)
  INTO v_missing_constraints
  FROM (VALUES
    ('trabajos_impresion_documentos_pkey'),
    ('trabajos_impresion_documentos_trabajo_uk'),
    ('trabajos_impresion_documentos_trabajo_fk'),
    ('trabajos_impresion_documentos_schema_chk'),
    ('trabajos_impresion_documentos_tipo_chk'),
    ('trabajos_impresion_documentos_formato_chk'),
    ('trabajos_impresion_documentos_hash_formato_chk'),
    ('trabajos_impresion_documentos_bytes_chk'),
    ('trabajos_impresion_documentos_hash_contenido_chk')
  ) AS expected(conname)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND c.conname = expected.conname
  );

  IF v_missing_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: faltan restricciones: %', v_missing_constraints;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'public.trabajos_impresion_documentos'::regclass
      AND c.conname = 'trabajos_impresion_documentos_hash_contenido_chk'
      AND pg_get_constraintdef(c.oid, true) LIKE '%extensions.digest%'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAILED: falta validacion SHA-256 real';
  END IF;
END
$postflight$;

COMMIT;
