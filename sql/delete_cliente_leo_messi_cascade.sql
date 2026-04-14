-- Elimina en cascada logica al usuario cliente por email:
--   - usuario (usuarios)
--   - cliente (clientes)
--   - persona (personas)
-- y sus tablas relacionadas conocidas.
--
-- Objetivo: lenguaprogra2@gmail.com
-- Uso recomendado: ejecutar en SQL Editor con rol admin, en una ventana dedicada.

DO $$
DECLARE
  v_email_target TEXT := lower('lenguaprogra2@gmail.com');
  v_total_matches INTEGER := 0;
  v_id_usuario INTEGER;
  v_id_cliente INTEGER;
  v_id_persona INTEGER;
  v_id_empleado INTEGER;
  v_deleted_rows INTEGER := 0;
  v_fk_row RECORD;
  v_fk_cliente_row RECORD;
  v_fk_persona_row RECORD;
BEGIN
  -- 1) Resolver usuario por email de identidad
  SELECT COUNT(*)
    INTO v_total_matches
  FROM public.identidades_auth ia
  WHERE lower(ia.email_login) = v_email_target;

  IF v_total_matches = 0 THEN
    RAISE EXCEPTION 'No existe identidades_auth para email=%', v_email_target;
  END IF;

  IF v_total_matches > 1 THEN
    RAISE EXCEPTION 'Email % tiene % identidades_auth. Abortado por seguridad.', v_email_target, v_total_matches;
  END IF;

  SELECT
    u.id_usuario,
    u.id_cliente,
    u.id_empleado,
    c.id_persona
  INTO
    v_id_usuario,
    v_id_cliente,
    v_id_empleado,
    v_id_persona
  FROM public.identidades_auth ia
  INNER JOIN public.usuarios u ON u.id_usuario = ia.id_usuario
  LEFT JOIN public.clientes c ON c.id_cliente = u.id_cliente
  WHERE lower(ia.email_login) = v_email_target
  LIMIT 1;

  IF v_id_usuario IS NULL THEN
    RAISE EXCEPTION 'No se pudo resolver id_usuario para email=%', v_email_target;
  END IF;

  IF v_id_empleado IS NOT NULL THEN
    RAISE EXCEPTION 'El usuario % esta vinculado a empleado (id_empleado=%). Script es solo para cliente.', v_id_usuario, v_id_empleado;
  END IF;

  IF v_id_cliente IS NULL THEN
    RAISE EXCEPTION 'El usuario % no tiene id_cliente. Abortado para evitar eliminar un usuario no-cliente.', v_id_usuario;
  END IF;

  IF v_id_persona IS NULL THEN
    RAISE EXCEPTION 'El cliente % no tiene id_persona. Abortado por seguridad.', v_id_cliente;
  END IF;

  RAISE NOTICE 'Objetivo resuelto -> id_usuario=%, id_cliente=%, id_persona=%', v_id_usuario, v_id_cliente, v_id_persona;

  -- 2) Eliminar dependencias de usuario (si existen)
  IF to_regclass('public.verificacion_cuentas_tokens') IS NOT NULL THEN
    DELETE FROM public.verificacion_cuentas_tokens WHERE id_usuario = v_id_usuario;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'verificacion_cuentas_tokens eliminados: %', v_deleted_rows;
  END IF;

  IF to_regclass('public.sesiones_activas') IS NOT NULL THEN
    DELETE FROM public.sesiones_activas WHERE id_usuario = v_id_usuario;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'sesiones_activas eliminadas: %', v_deleted_rows;
  END IF;

  IF to_regclass('public.roles_usuarios') IS NOT NULL THEN
    DELETE FROM public.roles_usuarios WHERE id_usuario = v_id_usuario;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'roles_usuarios eliminados: %', v_deleted_rows;
  END IF;

  IF to_regclass('public.usuarios_clientes') IS NOT NULL THEN
    DELETE FROM public.usuarios_clientes WHERE id_usuario = v_id_usuario OR id_cliente = v_id_cliente;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'usuarios_clientes eliminados: %', v_deleted_rows;
  END IF;

  IF to_regclass('public.identidades_auth') IS NOT NULL THEN
    DELETE FROM public.identidades_auth WHERE id_usuario = v_id_usuario;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'identidades_auth eliminadas: %', v_deleted_rows;
  END IF;

  -- 2.1) Limpieza defensiva de TODAS las tablas hijas con FK -> usuarios(id_usuario)
  -- Evita fallas como fk_login_usuario en public.logins.
  FOR v_fk_row IN
    SELECT
      ns.nspname AS schema_name,
      cls.relname AS table_name,
      att.attname AS column_name
    FROM pg_constraint con
    INNER JOIN pg_class cls ON cls.oid = con.conrelid
    INNER JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    INNER JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.usuarios'::regclass
      AND array_length(con.conkey, 1) = 1
      AND array_length(con.confkey, 1) = 1
      AND con.confkey[1] = (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'public.usuarios'::regclass
          AND attname = 'id_usuario'
          AND NOT attisdropped
        LIMIT 1
      )
  LOOP
    -- Ya se limpiaron arriba para control explicito; evitamos doble mensaje.
    IF (v_fk_row.schema_name = 'public' AND v_fk_row.table_name IN ('identidades_auth', 'roles_usuarios', 'usuarios_clientes', 'sesiones_activas', 'verificacion_cuentas_tokens')) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DELETE FROM %I.%I WHERE %I = $1',
      v_fk_row.schema_name,
      v_fk_row.table_name,
      v_fk_row.column_name
    )
    USING v_id_usuario;

    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE '%.% (%) eliminados por FK->usuarios: %',
      v_fk_row.schema_name,
      v_fk_row.table_name,
      v_fk_row.column_name,
      v_deleted_rows;
  END LOOP;

  -- 3) Eliminar usuario principal
  DELETE FROM public.usuarios WHERE id_usuario = v_id_usuario;
  GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
  IF v_deleted_rows <> 1 THEN
    RAISE EXCEPTION 'No se elimino el usuario esperado (id_usuario=%). ROW_COUNT=%', v_id_usuario, v_deleted_rows;
  END IF;
  RAISE NOTICE 'usuarios eliminados: %', v_deleted_rows;

  -- 4) Eliminar dependencias de cliente (multisucursal, etc.)
  IF to_regclass('public.clientes_sucursales') IS NOT NULL THEN
    DELETE FROM public.clientes_sucursales WHERE id_cliente = v_id_cliente;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'clientes_sucursales eliminados: %', v_deleted_rows;
  END IF;

  -- 4.1) Limpieza defensiva de TODAS las tablas hijas con FK -> clientes(id_cliente)
  -- Evita fallas como fk_fidelizacion_saldos_cliente.
  FOR v_fk_cliente_row IN
    SELECT
      ns.nspname AS schema_name,
      cls.relname AS table_name,
      att.attname AS column_name
    FROM pg_constraint con
    INNER JOIN pg_class cls ON cls.oid = con.conrelid
    INNER JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    INNER JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.clientes'::regclass
      AND array_length(con.conkey, 1) = 1
      AND array_length(con.confkey, 1) = 1
      AND con.confkey[1] = (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'public.clientes'::regclass
          AND attname = 'id_cliente'
          AND NOT attisdropped
        LIMIT 1
      )
  LOOP
    -- Ya se limpia de forma explicita para mejor trazabilidad.
    IF (v_fk_cliente_row.schema_name = 'public' AND v_fk_cliente_row.table_name IN ('clientes_sucursales', 'usuarios_clientes')) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DELETE FROM %I.%I WHERE %I = $1',
      v_fk_cliente_row.schema_name,
      v_fk_cliente_row.table_name,
      v_fk_cliente_row.column_name
    )
    USING v_id_cliente;

    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE '%.% (%) eliminados por FK->clientes: %',
      v_fk_cliente_row.schema_name,
      v_fk_cliente_row.table_name,
      v_fk_cliente_row.column_name,
      v_deleted_rows;
  END LOOP;

  -- 5) Eliminar cliente
  DELETE FROM public.clientes WHERE id_cliente = v_id_cliente;
  GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
  IF v_deleted_rows <> 1 THEN
    RAISE EXCEPTION 'No se elimino el cliente esperado (id_cliente=%). ROW_COUNT=%', v_id_cliente, v_deleted_rows;
  END IF;
  RAISE NOTICE 'clientes eliminados: %', v_deleted_rows;

  -- 6) Limpiar contactos ligados por id_persona (si la columna existe)
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'correos' AND column_name = 'id_persona'
  ) THEN
    DELETE FROM public.correos WHERE id_persona = v_id_persona;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'correos(id_persona) eliminados: %', v_deleted_rows;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'telefonos' AND column_name = 'id_persona'
  ) THEN
    DELETE FROM public.telefonos WHERE id_persona = v_id_persona;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'telefonos(id_persona) eliminados: %', v_deleted_rows;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'direcciones' AND column_name = 'id_persona'
  ) THEN
    DELETE FROM public.direcciones WHERE id_persona = v_id_persona;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE 'direcciones(id_persona) eliminadas: %', v_deleted_rows;
  END IF;

  -- 6.1) Limpieza defensiva de TODAS las tablas hijas con FK -> personas(id_persona)
  -- (ademas de correos/telefonos/direcciones cuando tengan id_persona)
  FOR v_fk_persona_row IN
    SELECT
      ns.nspname AS schema_name,
      cls.relname AS table_name,
      att.attname AS column_name
    FROM pg_constraint con
    INNER JOIN pg_class cls ON cls.oid = con.conrelid
    INNER JOIN pg_namespace ns ON ns.oid = cls.relnamespace
    INNER JOIN pg_attribute att
      ON att.attrelid = con.conrelid
     AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.personas'::regclass
      AND array_length(con.conkey, 1) = 1
      AND array_length(con.confkey, 1) = 1
      AND con.confkey[1] = (
        SELECT attnum
        FROM pg_attribute
        WHERE attrelid = 'public.personas'::regclass
          AND attname = 'id_persona'
          AND NOT attisdropped
        LIMIT 1
      )
  LOOP
    -- clientes ya se elimina arriba; evitamos doble intento.
    IF (v_fk_persona_row.schema_name = 'public' AND v_fk_persona_row.table_name IN ('clientes')) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'DELETE FROM %I.%I WHERE %I = $1',
      v_fk_persona_row.schema_name,
      v_fk_persona_row.table_name,
      v_fk_persona_row.column_name
    )
    USING v_id_persona;

    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
    RAISE NOTICE '%.% (%) eliminados por FK->personas: %',
      v_fk_persona_row.schema_name,
      v_fk_persona_row.table_name,
      v_fk_persona_row.column_name,
      v_deleted_rows;
  END LOOP;

  -- 7) Eliminar persona
  DELETE FROM public.personas WHERE id_persona = v_id_persona;
  GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;
  IF v_deleted_rows <> 1 THEN
    RAISE EXCEPTION 'No se elimino la persona esperada (id_persona=%). ROW_COUNT=%', v_id_persona, v_deleted_rows;
  END IF;
  RAISE NOTICE 'personas eliminadas: %', v_deleted_rows;

END $$;

-- Verificacion post-ejecucion (opcional):
-- SELECT * FROM public.identidades_auth WHERE lower(email_login) = lower('lenguaprogra2@gmail.com');
-- SELECT * FROM public.usuarios u WHERE u.id_cliente IS NOT NULL AND u.id_usuario IN (
--   SELECT id_usuario FROM public.identidades_auth WHERE lower(email_login) = lower('lenguaprogra2@gmail.com')
-- );
