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
--       por columna y restriccion por restriccion.
--   (c) la tabla existe mal o parcialmente formada (creada por fuera de
--       esta migracion, o por una ejecucion previa interrumpida) -> se
--       completan UNICAMENTE las restricciones/indices que faltan por
--       nombre; cualquier columna ausente o cualquier
--       columna/restriccion presente con una definicion distinta a la
--       esperada aborta con PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE en vez
--       de alterar datos o reemplazar silenciosamente algo que ya existe.
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
-- columna y cada restriccion de forma explicita; lo que falte se agrega,
-- lo que exista con una definicion distinta aborta la migracion.

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
-- agregarlas despues. Buscar por columna+tabla-referenciada es correcto
-- en ambos casos.
DO $ensure_fk_cliente$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_cliente'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.confrelid = 'public.clientes'::regclass
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_cliente
      FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente) ON DELETE RESTRICT;
  END IF;
END
$ensure_fk_cliente$;

DO $ensure_fk_factura$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_factura'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.confrelid = 'public.facturas'::regclass
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_factura
      FOREIGN KEY (id_factura) REFERENCES public.facturas(id_factura) ON DELETE RESTRICT;
  END IF;
END
$ensure_fk_factura$;

DO $ensure_fk_reversion$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_reversion'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.confrelid = 'public.facturas_reversiones'::regclass
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_reversion
      FOREIGN KEY (id_reversion) REFERENCES public.facturas_reversiones(id_reversion) ON DELETE RESTRICT;
  END IF;
END
$ensure_fk_reversion$;

DO $ensure_fk_usuario$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'id_usuario_ejecutor'
    WHERE c.conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass
      AND c.contype = 'f' AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.confrelid = 'public.usuarios'::regclass
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT fk_fidelizacion_ajustes_pendientes_usuario
      FOREIGN KEY (id_usuario_ejecutor) REFERENCES public.usuarios(id_usuario) ON DELETE RESTRICT;
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

DO $ensure_checks$
DECLARE
  v_definicion text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_estado'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado
      CHECK (estado IN ('PENDIENTE', 'PARCIALMENTE_RECUPERADO', 'RECUPERADO'));
  ELSE
    SELECT pg_get_constraintdef(oid, true) INTO v_definicion
    FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_estado';
    IF v_definicion NOT LIKE '%PENDIENTE%' OR v_definicion NOT LIKE '%PARCIALMENTE_RECUPERADO%' OR v_definicion NOT LIKE '%RECUPERADO%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_estado existe con una definicion distinta a la esperada: %', v_definicion;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_objetivo_positivo'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_objetivo_positivo CHECK (puntos_objetivo > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo CHECK (puntos_recuperados >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo CHECK (puntos_pendientes >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_suma_exacta'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_suma_exacta
      CHECK (puntos_recuperados + puntos_pendientes = puntos_objetivo);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_estado_coherente'
  ) THEN
    ALTER TABLE public.fidelizacion_ajustes_pendientes
      ADD CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado_coherente
      CHECK (
        (estado = 'PENDIENTE' AND puntos_recuperados = 0 AND puntos_pendientes = puntos_objetivo)
        OR (estado = 'PARCIALMENTE_RECUPERADO' AND puntos_recuperados > 0 AND puntos_pendientes > 0)
        OR (estado = 'RECUPERADO' AND puntos_recuperados = puntos_objetivo AND puntos_pendientes = 0)
      );
  ELSE
    SELECT pg_get_constraintdef(oid, true) INTO v_definicion
    FROM pg_constraint WHERE conrelid = 'public.fidelizacion_ajustes_pendientes'::regclass AND conname = 'ck_fidelizacion_ajustes_pendientes_estado_coherente';
    IF v_definicion NOT LIKE '%PARCIALMENTE_RECUPERADO%' THEN
      RAISE EXCEPTION 'PREFLIGHT_FAILED_ESQUEMA_INCOMPATIBLE: ck_fidelizacion_ajustes_pendientes_estado_coherente existe con una definicion distinta a la esperada: %', v_definicion;
    END IF;
  END IF;
END
$ensure_checks$;

CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_cliente_estado
  ON public.fidelizacion_ajustes_pendientes (id_cliente, estado);

CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_factura
  ON public.fidelizacion_ajustes_pendientes (id_factura);

-- id_reversion ya tiene indice implicito por la restriccion UNIQUE
-- garantizada arriba; no se crea un indice adicional redundante.

COMMENT ON TABLE public.fidelizacion_ajustes_pendientes IS
  'Deuda de puntos de fidelizacion que una reversion no pudo retirar de inmediato por saldo insuficiente; se recupera via compensacion FIFO en acumulaciones futuras (Fase 4).';

COMMIT;
