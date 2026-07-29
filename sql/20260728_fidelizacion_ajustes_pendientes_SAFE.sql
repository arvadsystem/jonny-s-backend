-- Crea public.fidelizacion_ajustes_pendientes: registro durable del
-- remanente de puntos que una reversion de venta no pudo retirar de
-- inmediato porque el cliente ya los habia gastado (ver
-- services/ventasReversionService.js:revertLoyaltyForFactura, que hoy topa
-- "puntosAplicables" al saldo disponible y descarta el resto sin dejar
-- rastro). Esta tabla es prerrequisito de Fase 4; en Fase 1 solo se crea el
-- esquema, ningun codigo de aplicacion la usa todavia.
--
-- No confia unicamente en CREATE TABLE IF NOT EXISTS. Converge
-- correctamente en tres escenarios:
--   (a) la tabla no existe -> se crea completa, con todas sus columnas,
--       PK, FK, UNIQUE, CHECK e indices en un unico CREATE TABLE atomico.
--   (b) la tabla existe completa y correcta -> no-op verificado columna
--       por columna, default por default, restriccion por restriccion e
--       indice por indice.
--   (c) la tabla existe mal o parcialmente formada (creada por fuera de
--       esta migracion, o por una ejecucion previa interrumpida) -> se
--       completan UNICAMENTE las restricciones/indices que faltan por
--       nombre; cualquier columna/default/restriccion/indice presente con
--       una definicion distinta a la esperada aborta con
--       PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE en vez de alterar datos o
--       reemplazar silenciosamente algo que ya existe.
--
-- Ningun CHECK se acepta solo porque su nombre coincide con el esperado:
-- siempre se lee pg_get_constraintdef(oid, true) y se valida su contenido
-- real (normalizado, o por conjunto exacto de literales extraidos), nunca
-- comparando texto literal completo (que Postgres puede reformatear con
-- espacios/parentesis/casts distintos entre versiones).
--
-- No hace backfill: no hay ningun ajuste pendiente que reconstruir
-- retroactivamente porque el mecanismo no existia antes de esta migracion.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.clientes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.clientes no existe';
  END IF;
  IF to_regclass('public.facturas') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas no existe';
  END IF;
  IF to_regclass('public.facturas_reversiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones no existe';
  END IF;
  IF to_regclass('public.usuarios') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.usuarios no existe';
  END IF;
END
$preflight$;

-- Caso (a): tabla ausente -> creacion completa y atomica, con la
-- restriccion de coherencia por estado ya incluida desde el origen.
CREATE TABLE IF NOT EXISTS public.fidelizacion_ajustes_pendientes (
  id_ajuste BIGSERIAL PRIMARY KEY,
  id_cliente INTEGER NOT NULL REFERENCES public.clientes(id_cliente) ON DELETE RESTRICT,
  id_factura INTEGER NOT NULL REFERENCES public.facturas(id_factura) ON DELETE RESTRICT,
  id_reversion BIGINT NOT NULL REFERENCES public.facturas_reversiones(id_reversion) ON DELETE RESTRICT,
  puntos_objetivo INTEGER NOT NULL,
  puntos_recuperados INTEGER NOT NULL DEFAULT 0,
  puntos_pendientes INTEGER NOT NULL,
  estado VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
  id_usuario_ejecutor INTEGER NOT NULL REFERENCES public.usuarios(id_usuario) ON DELETE RESTRICT,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado
    CHECK (estado IN ('PENDIENTE', 'PARCIALMENTE_RECUPERADO', 'RECUPERADO')),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_objetivo_positivo
    CHECK (puntos_objetivo > 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo
    CHECK (puntos_recuperados >= 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo
    CHECK (puntos_pendientes >= 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_suma_exacta
    CHECK (puntos_recuperados + puntos_pendientes = puntos_objetivo),
  -- Coherencia obligatoria entre estado y los contadores de puntos:
  --   PENDIENTE               -> recuperados=0, pendientes=objetivo
  --   PARCIALMENTE_RECUPERADO -> recuperados>0, pendientes>0
  --   RECUPERADO              -> recuperados=objetivo, pendientes=0
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado_coherente
    CHECK (
      (estado = 'PENDIENTE' AND puntos_recuperados = 0 AND puntos_pendientes = puntos_objetivo)
      OR (estado = 'PARCIALMENTE_RECUPERADO' AND puntos_recuperados > 0 AND puntos_pendientes > 0)
      OR (estado = 'RECUPERADO' AND puntos_recuperados = puntos_objetivo AND puntos_pendientes = 0)
    ),
  -- Un ajuste pendiente por reversion: si la misma reversion se procesa dos
  -- veces (reintento, doble clic), la segunda insercion debe chocar contra
  -- esta restriccion en vez de duplicar deuda de puntos.
  CONSTRAINT uq_fidelizacion_ajustes_pendientes_reversion UNIQUE (id_reversion)
);

-- A partir de aqui la tabla existe con certeza (recien creada, o
-- preexistente por fuera de esta migracion). Casos (b)/(c): se valida cada
-- columna, cada default, cada restriccion y cada indice de forma
-- explicita; lo que falte se agrega, lo que exista con una definicion
-- distinta aborta la migracion.

DO $validate_columns$
DECLARE
  v_faltantes text;
  v_incompatibles text;
BEGIN
  SELECT string_agg(esperado.columna, ', ' ORDER BY esperado.columna)
  INTO v_faltantes
  FROM (VALUES
    ('id_ajuste'), ('id_cliente'), ('id_factura'), ('id_reversion'),
    ('puntos_objetivo'), ('puntos_recuperados'), ('puntos_pendientes'),
    ('estado'), ('id_usuario_ejecutor'), ('fecha_creacion'), ('fecha_actualizacion')
  ) AS esperado(columna)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'fidelizacion_ajustes_pendientes'
      AND c.column_name = esperado.columna
  );

  IF v_faltantes IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes ya existe pero le faltan columnas: %. No se repara automaticamente; revisar manualmente.', v_faltantes;
  END IF;

  SELECT string_agg(c.column_name, ', ' ORDER BY c.column_name)
  INTO v_incompatibles
  FROM information_schema.columns c
  JOIN (VALUES
    ('id_ajuste', 'bigint', 'NO'),
    ('id_cliente', 'integer', 'NO'),
    ('id_factura', 'integer', 'NO'),
    ('id_reversion', 'bigint', 'NO'),
    ('puntos_objetivo', 'integer', 'NO'),
    ('puntos_recuperados', 'integer', 'NO'),
    ('puntos_pendientes', 'integer', 'NO'),
    ('estado', 'character varying', 'NO'),
    ('id_usuario_ejecutor', 'integer', 'NO'),
    ('fecha_creacion', 'timestamp with time zone', 'NO'),
    ('fecha_actualizacion', 'timestamp with time zone', 'NO')
  ) AS esperado(columna, tipo, nullable)
    ON esperado.columna = c.column_name
  WHERE c.table_schema = 'public'
    AND c.table_name = 'fidelizacion_ajustes_pendientes'
    AND (c.data_type <> esperado.tipo OR c.is_nullable <> esperado.nullable);

  IF v_incompatibles IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes tiene columnas con tipo o nullabilidad distinta a la esperada: %. No se altera automaticamente; revisar manualmente.', v_incompatibles;
  END IF;
END
$validate_columns$;

-- Validacion de DEFAULT reales via pg_get_expr(adbin, adrelid), normalizado
-- quitando casts de tipo (::character varying, ::character varying(30),
-- etc.) que Postgres puede agregar/omitir segun version, en vez de
-- comparar el texto crudo tal cual.
DO $validate_defaults$
DECLARE
  v_id_ajuste_autogenerado boolean;
  v_default_normalizado text;
BEGIN
  -- id_ajuste: acepta IDENTITY (GENERATED ALWAYS/BY DEFAULT AS IDENTITY,
  -- attidentity IN ('a','d')) o un DEFAULT basado en nextval(...) (el
  -- patron que genera BIGSERIAL). Cualquiera de los dos es un "default
  -- autogenerado" valido.
  SELECT
    a.attidentity IN ('a', 'd')
    OR EXISTS (
      SELECT 1 FROM pg_attrdef d
      WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum
        AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
    )
  INTO v_id_ajuste_autogenerado
  FROM pg_attribute a
  WHERE a.attrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND a.attname = 'id_ajuste' AND NOT a.attisdropped;

  IF NOT COALESCE(v_id_ajuste_autogenerado, false) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes.id_ajuste no tiene IDENTITY ni DEFAULT nextval(...) (secuencia autogenerada); revisar manualmente.';
  END IF;

  SELECT trim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::[a-zA-Z_ ]+(\(\d+\))?', '', 'g'))
  INTO v_default_normalizado
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND a.attname = 'puntos_recuperados' AND NOT a.attisdropped;

  IF v_default_normalizado IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes.puntos_recuperados no tiene DEFAULT 0 (default real: %); revisar manualmente.', COALESCE(v_default_normalizado, '<sin default>');
  END IF;

  SELECT trim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::[a-zA-Z_ ]+(\(\d+\))?', '', 'g'))
  INTO v_default_normalizado
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND a.attname = 'estado' AND NOT a.attisdropped;

  IF v_default_normalizado IS DISTINCT FROM '''PENDIENTE''' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes.estado no tiene DEFAULT ''PENDIENTE'' (default real: %); revisar manualmente.', COALESCE(v_default_normalizado, '<sin default>');
  END IF;

  SELECT trim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::[a-zA-Z_ ]+(\(\d+\))?', '', 'g'))
  INTO v_default_normalizado
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND a.attname = 'fecha_creacion' AND NOT a.attisdropped;

  IF lower(COALESCE(v_default_normalizado, '')) IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes.fecha_creacion no tiene DEFAULT now() (default real: %); revisar manualmente.', COALESCE(v_default_normalizado, '<sin default>');
  END IF;

  SELECT trim(regexp_replace(pg_get_expr(d.adbin, d.adrelid), '::[a-zA-Z_ ]+(\(\d+\))?', '', 'g'))
  INTO v_default_normalizado
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND a.attname = 'fecha_actualizacion' AND NOT a.attisdropped;

  IF lower(COALESCE(v_default_normalizado, '')) IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes.fecha_actualizacion no tiene DEFAULT now() (default real: %); revisar manualmente.', COALESCE(v_default_normalizado, '<sin default>');
  END IF;
END
$validate_defaults$;

DO $ensure_pk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_ajuste'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'p'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: fidelizacion_ajustes_pendientes no tiene PRIMARY KEY sobre id_ajuste; revisar manualmente antes de continuar.';
  END IF;
END
$ensure_pk$;

-- Cada bloque "ensure_fk_*" busca la FK por COLUMNA + TABLA REFERENCIADA,
-- nunca por nombre: el CREATE TABLE de arriba declara las FK de forma
-- inline (sin CONSTRAINT explicito), por lo que Postgres les asigna un
-- nombre autogenerado distinto al que este script usaria si tuviera que
-- agregarlas despues. Si ya existe una FK que conecta esa columna con esa
-- tabla referenciada, se valida ademas que la columna referenciada sea la
-- correcta y que confdeltype sea RESTRICT ('r') o NO ACTION ('a'); si es
-- CASCADE/SET NULL/SET DEFAULT, aborta en vez de aceptarla.
DO $ensure_fk_cliente$
DECLARE
  v_conname text;
  v_confkey_ok boolean;
  v_confdeltype "char";
BEGIN
  SELECT c.conname, c.confdeltype,
    EXISTS (
      SELECT 1 FROM pg_attribute a_ref
      WHERE a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_cliente'
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    )
  INTO v_conname, v_confdeltype, v_confkey_ok
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_cliente'
  WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
    AND c.confrelid = 'public.clientes'::regclass;

  IF v_conname IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_cliente
      FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente) ON DELETE RESTRICT;
  ELSIF NOT v_confkey_ok OR v_confdeltype NOT IN ('r', 'a') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: % referencia clientes pero no (id_cliente) con ON DELETE RESTRICT/NO ACTION (confdeltype=%)', v_conname, v_confdeltype;
  END IF;
END
$ensure_fk_cliente$;

DO $ensure_fk_factura$
DECLARE
  v_conname text;
  v_confkey_ok boolean;
  v_confdeltype "char";
BEGIN
  SELECT c.conname, c.confdeltype,
    EXISTS (
      SELECT 1 FROM pg_attribute a_ref
      WHERE a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_factura'
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    )
  INTO v_conname, v_confdeltype, v_confkey_ok
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_factura'
  WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
    AND c.confrelid = 'public.facturas'::regclass;

  IF v_conname IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_factura
      FOREIGN KEY (id_factura) REFERENCES public.facturas(id_factura) ON DELETE RESTRICT;
  ELSIF NOT v_confkey_ok OR v_confdeltype NOT IN ('r', 'a') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: % referencia facturas pero no (id_factura) con ON DELETE RESTRICT/NO ACTION (confdeltype=%)', v_conname, v_confdeltype;
  END IF;
END
$ensure_fk_factura$;

DO $ensure_fk_reversion$
DECLARE
  v_conname text;
  v_confkey_ok boolean;
  v_confdeltype "char";
BEGIN
  SELECT c.conname, c.confdeltype,
    EXISTS (
      SELECT 1 FROM pg_attribute a_ref
      WHERE a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_reversion'
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    )
  INTO v_conname, v_confdeltype, v_confkey_ok
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_reversion'
  WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
    AND c.confrelid = 'public.facturas_reversiones'::regclass;

  IF v_conname IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_reversion
      FOREIGN KEY (id_reversion) REFERENCES public.facturas_reversiones(id_reversion) ON DELETE RESTRICT;
  ELSIF NOT v_confkey_ok OR v_confdeltype NOT IN ('r', 'a') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: % referencia facturas_reversiones pero no (id_reversion) con ON DELETE RESTRICT/NO ACTION (confdeltype=%)', v_conname, v_confdeltype;
  END IF;
END
$ensure_fk_reversion$;

DO $ensure_fk_usuario$
DECLARE
  v_conname text;
  v_confkey_ok boolean;
  v_confdeltype "char";
BEGIN
  SELECT c.conname, c.confdeltype,
    EXISTS (
      SELECT 1 FROM pg_attribute a_ref
      WHERE a_ref.attrelid = c.confrelid AND a_ref.attname = 'id_usuario'
        AND c.confkey = ARRAY[a_ref.attnum]::smallint[]
    )
  INTO v_conname, v_confdeltype, v_confkey_ok
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_usuario_ejecutor'
  WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
    AND c.confrelid = 'public.usuarios'::regclass;

  IF v_conname IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_usuario
      FOREIGN KEY (id_usuario_ejecutor) REFERENCES public.usuarios(id_usuario) ON DELETE RESTRICT;
  ELSIF NOT v_confkey_ok OR v_confdeltype NOT IN ('r', 'a') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: % referencia usuarios pero no (id_usuario) con ON DELETE RESTRICT/NO ACTION (confdeltype=%)', v_conname, v_confdeltype;
  END IF;
END
$ensure_fk_usuario$;

DO $ensure_unique_reversion$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_reversion'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'u' AND c.conkey = ARRAY[a.attnum]::smallint[]
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT uq_fidelizacion_ajustes_pendientes_reversion UNIQUE (id_reversion);
  END IF;
END
$ensure_unique_reversion$;

-- Cada CHECK se valida por su CONTENIDO real (normalizado o por conjunto
-- exacto de literales extraidos de pg_get_constraintdef), nunca solo
-- porque el nombre coincide.
DO $ensure_checks$
DECLARE
  v_definicion text;
  v_normalizada text;
  v_literales text[];
  v_numeros text[];
BEGIN
  -- 1) estado: conjunto exacto de literales de texto = los 3 estados.
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_estado';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado
      CHECK (estado IN ('PENDIENTE', 'PARCIALMENTE_RECUPERADO', 'RECUPERADO'));
  ELSE
    SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_literales
    FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

    IF v_literales IS DISTINCT FROM ARRAY['PARCIALMENTE_RECUPERADO', 'PENDIENTE', 'RECUPERADO']::text[] THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_estado existe pero su conjunto de valores (%) no es exactamente {PENDIENTE, PARCIALMENTE_RECUPERADO, RECUPERADO}.', v_literales;
    END IF;
  END IF;

  -- 2) objetivo_positivo: normalizado exacto "puntos_objetivo>0".
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_objetivo_positivo';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_objetivo_positivo CHECK (puntos_objetivo > 0);
  ELSE
    v_normalizada := lower(regexp_replace(v_definicion, '\s+|[()]', '', 'g'));
    IF v_normalizada NOT LIKE '%puntos_objetivo>0%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_objetivo_positivo existe con una definicion distinta a puntos_objetivo>0: %', v_definicion;
    END IF;
  END IF;

  -- 3) recuperados_no_negativo: normalizado exacto "puntos_recuperados>=0".
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo CHECK (puntos_recuperados >= 0);
  ELSE
    v_normalizada := lower(regexp_replace(v_definicion, '\s+|[()]', '', 'g'));
    IF v_normalizada NOT LIKE '%puntos_recuperados>=0%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo existe con una definicion distinta a puntos_recuperados>=0: %', v_definicion;
    END IF;
  END IF;

  -- 4) pendientes_no_negativo: normalizado exacto "puntos_pendientes>=0".
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo CHECK (puntos_pendientes >= 0);
  ELSE
    v_normalizada := lower(regexp_replace(v_definicion, '\s+|[()]', '', 'g'));
    IF v_normalizada NOT LIKE '%puntos_pendientes>=0%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo existe con una definicion distinta a puntos_pendientes>=0: %', v_definicion;
    END IF;
  END IF;

  -- 5) suma_exacta: normalizado exacto "puntos_recuperados+puntos_pendientes=puntos_objetivo".
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_suma_exacta';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_suma_exacta
      CHECK (puntos_recuperados + puntos_pendientes = puntos_objetivo);
  ELSE
    v_normalizada := lower(regexp_replace(v_definicion, '\s+|[()]', '', 'g'));
    IF v_normalizada NOT LIKE '%puntos_recuperados+puntos_pendientes=puntos_objetivo%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_suma_exacta existe con una definicion distinta a puntos_recuperados+puntos_pendientes=puntos_objetivo: %', v_definicion;
    END IF;
  END IF;

  -- 6) estado_coherente: conjunto exacto de literales de texto = los 3
  -- estados, y conjunto exacto de literales numericos = {0} (los 0 de
  -- puntos_recuperados=0 y puntos_pendientes=0; RECUPERADO/PENDIENTE usan
  -- comparaciones columna=columna sin literal numerico adicional).
  SELECT pg_get_constraintdef(oid, true) INTO v_definicion
  FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
    AND conname = 'ck_fidelizacion_ajustes_pendientes_estado_coherente';

  IF v_definicion IS NULL THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado_coherente
      CHECK (
        (estado = 'PENDIENTE' AND puntos_recuperados = 0 AND puntos_pendientes = puntos_objetivo)
        OR (estado = 'PARCIALMENTE_RECUPERADO' AND puntos_recuperados > 0 AND puntos_pendientes > 0)
        OR (estado = 'RECUPERADO' AND puntos_recuperados = puntos_objetivo AND puntos_pendientes = 0)
      );
  ELSE
    SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_literales
    FROM regexp_matches(v_definicion, '''([^'']*)''', 'g') AS m;

    SELECT array_agg(DISTINCT m[0] ORDER BY m[0])
    INTO v_numeros
    FROM regexp_matches(v_definicion, '\y\d+\y', 'g') AS m;

    IF v_literales IS DISTINCT FROM ARRAY['PARCIALMENTE_RECUPERADO', 'PENDIENTE', 'RECUPERADO']::text[]
       OR v_numeros IS DISTINCT FROM ARRAY['0']::text[]
    THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_estado_coherente existe con una definicion distinta a la esperada (literales=%, numeros=%): %', v_literales, v_numeros, v_definicion;
    END IF;
  END IF;
END
$ensure_checks$;

-- Indices: si ya existen por nombre, se valida que indexen exactamente las
-- columnas esperadas en el orden esperado; si el nombre existe con otra
-- definicion, aborta en vez de dejarlo pasar.
DO $ensure_idx_cliente_estado$
DECLARE
  v_existe boolean;
  v_columnas text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'fidelizacion_ajustes_pendientes'
      AND indexname = 'idx_fidelizacion_ajustes_pendientes_cliente_estado'
  ) INTO v_existe;

  IF NOT v_existe THEN
    CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_cliente_estado
      ON public.fidelizacion_ajustes_pendientes (id_cliente, estado);
  ELSE
    SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO v_columnas
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE ic.relname = 'idx_fidelizacion_ajustes_pendientes_cliente_estado';

    IF v_columnas IS DISTINCT FROM 'id_cliente,estado' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: idx_fidelizacion_ajustes_pendientes_cliente_estado existe pero indexa (%) en vez de (id_cliente, estado).', v_columnas;
    END IF;
  END IF;
END
$ensure_idx_cliente_estado$;

DO $ensure_idx_factura$
DECLARE
  v_existe boolean;
  v_columnas text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'fidelizacion_ajustes_pendientes'
      AND indexname = 'idx_fidelizacion_ajustes_pendientes_factura'
  ) INTO v_existe;

  IF NOT v_existe THEN
    CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_factura
      ON public.fidelizacion_ajustes_pendientes (id_factura);
  ELSE
    SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO v_columnas
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE ic.relname = 'idx_fidelizacion_ajustes_pendientes_factura';

    IF v_columnas IS DISTINCT FROM 'id_factura' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: idx_fidelizacion_ajustes_pendientes_factura existe pero indexa (%) en vez de (id_factura).', v_columnas;
    END IF;
  END IF;
END
$ensure_idx_factura$;

-- id_reversion ya tiene indice implicito por la restriccion UNIQUE
-- garantizada arriba; no se crea un indice adicional redundante.

COMMENT ON TABLE public.fidelizacion_ajustes_pendientes IS
  'Deuda de puntos de fidelizacion que una reversion no pudo retirar de inmediato por saldo insuficiente; se recupera via compensacion FIFO en acumulaciones futuras (Fase 4).';

COMMIT;
