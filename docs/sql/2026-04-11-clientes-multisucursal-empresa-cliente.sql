-- 2026-04-11
-- Plan Maestro Clientes: id_empresa_cliente + clientes_sucursales + backfill + funciones
-- Ejecutar en este orden: migracion DB -> backend -> frontend

BEGIN;

ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS id_empresa_cliente INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_clientes_id_empresa_cliente'
      AND conrelid = 'public.clientes'::regclass
  ) THEN
    ALTER TABLE public.clientes
      ADD CONSTRAINT fk_clientes_id_empresa_cliente
      FOREIGN KEY (id_empresa_cliente)
      REFERENCES public.empresas(id_empresa)
      ON UPDATE RESTRICT
      ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.clientes_sucursales (
  id_cliente INTEGER NOT NULL REFERENCES public.clientes(id_cliente) ON DELETE CASCADE,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
  estado BOOLEAN NOT NULL DEFAULT TRUE,
  es_principal BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('America/Tegucigalpa', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('America/Tegucigalpa', now()),
  PRIMARY KEY (id_cliente, id_sucursal)
);

CREATE INDEX IF NOT EXISTS idx_clientes_sucursales_id_sucursal
  ON public.clientes_sucursales(id_sucursal);

CREATE INDEX IF NOT EXISTS idx_clientes_sucursales_id_cliente
  ON public.clientes_sucursales(id_cliente);

-- Backfill relacion empresa-cliente desde legado.
UPDATE public.clientes c
SET id_empresa_cliente = c.id_empresa
WHERE c.id_empresa_cliente IS NULL
  AND c.id_persona IS NULL
  AND c.id_empresa IS NOT NULL;

-- Backfill vinculos por sucursal (idempotente).
DO $$
DECLARE
  has_cliente_sucursal BOOLEAN;
  has_persona_sucursal BOOLEAN;
  has_created_by BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clientes'
      AND column_name = 'id_sucursal'
  ) INTO has_cliente_sucursal;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'personas'
      AND column_name = 'id_sucursal'
  ) INTO has_persona_sucursal;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clientes'
      AND column_name = 'created_by'
  ) INTO has_created_by;

  IF has_cliente_sucursal THEN
    EXECUTE $sql$
      INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
      SELECT c.id_cliente, c.id_sucursal, TRUE, TRUE
      FROM public.clientes c
      WHERE c.id_sucursal IS NOT NULL
      ON CONFLICT (id_cliente, id_sucursal) DO UPDATE
      SET estado = TRUE,
          updated_at = timezone('America/Tegucigalpa', now())
    $sql$;
  END IF;

  IF has_persona_sucursal THEN
    EXECUTE $sql$
      INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
      SELECT c.id_cliente, p.id_sucursal, TRUE, FALSE
      FROM public.clientes c
      INNER JOIN public.personas p ON p.id_persona = c.id_persona
      WHERE p.id_sucursal IS NOT NULL
      ON CONFLICT (id_cliente, id_sucursal) DO UPDATE
      SET estado = TRUE,
          updated_at = timezone('America/Tegucigalpa', now())
    $sql$;
  END IF;

  EXECUTE $sql$
    INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
    SELECT c.id_cliente, em.id_sucursal, TRUE, FALSE
    FROM public.clientes c
    INNER JOIN LATERAL (
      SELECT e.id_sucursal
      FROM public.empleados e
      WHERE e.id_persona = c.id_persona
      ORDER BY e.id_empleado DESC
      LIMIT 1
    ) em ON TRUE
    WHERE em.id_sucursal IS NOT NULL
    ON CONFLICT (id_cliente, id_sucursal) DO UPDATE
    SET estado = TRUE,
        updated_at = timezone('America/Tegucigalpa', now())
  $sql$;

  IF has_created_by THEN
    EXECUTE $sql$
      INSERT INTO public.clientes_sucursales (id_cliente, id_sucursal, estado, es_principal)
      SELECT c.id_cliente, em.id_sucursal, TRUE, FALSE
      FROM public.clientes c
      INNER JOIN public.usuarios u ON u.id_usuario = c.created_by
      INNER JOIN public.empleados em ON em.id_empleado = u.id_empleado
      WHERE em.id_sucursal IS NOT NULL
      ON CONFLICT (id_cliente, id_sucursal) DO UPDATE
      SET estado = TRUE,
          updated_at = timezone('America/Tegucigalpa', now())
    $sql$;
  END IF;
END;
$$;

-- Marcar una sucursal principal por cliente (deterministica).
WITH principal AS (
  SELECT DISTINCT ON (cs.id_cliente) cs.id_cliente, cs.id_sucursal
  FROM public.clientes_sucursales cs
  WHERE COALESCE(cs.estado, TRUE) = TRUE
  ORDER BY cs.id_cliente, cs.es_principal DESC, cs.id_sucursal ASC
)
UPDATE public.clientes_sucursales cs
SET es_principal = (cs.id_sucursal = principal.id_sucursal),
    updated_at = timezone('America/Tegucigalpa', now())
FROM principal
WHERE principal.id_cliente = cs.id_cliente;

-- Unicos parciales (si no existen duplicados).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.clientes
    WHERE id_persona IS NOT NULL
    GROUP BY id_persona
    HAVING COUNT(*) > 1
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_id_persona_not_null ON public.clientes(id_persona) WHERE id_persona IS NOT NULL';
  ELSE
    RAISE NOTICE 'Saltando uq_clientes_id_persona_not_null: hay duplicados en id_persona';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.clientes
    WHERE id_empresa_cliente IS NOT NULL
    GROUP BY id_empresa_cliente
    HAVING COUNT(*) > 1
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_id_empresa_cliente_not_null ON public.clientes(id_empresa_cliente) WHERE id_empresa_cliente IS NOT NULL';
  ELSE
    RAISE NOTICE 'Saltando uq_clientes_id_empresa_cliente_not_null: hay duplicados en id_empresa_cliente';
  END IF;
END;
$$;

-- Funciones compatibles con nuevo contrato.
CREATE OR REPLACE FUNCTION public.fn_guardar_cliente(p_datos JSON)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_id_cliente INTEGER;
  v_fecha_ingreso DATE := NULLIF(TRIM(p_datos->>'fecha_ingreso'), '')::DATE;
  v_puntos INTEGER := COALESCE(NULLIF(TRIM(p_datos->>'puntos'), '')::INTEGER, 0);
  v_id_tipo_cliente INTEGER := NULLIF(TRIM(p_datos->>'id_tipo_cliente'), '')::INTEGER;
  v_id_persona INTEGER := NULLIF(TRIM(p_datos->>'id_persona'), '')::INTEGER;
  v_id_empresa_cliente INTEGER := NULLIF(TRIM(p_datos->>'id_empresa_cliente'), '')::INTEGER;
  v_id_empresa_tenant INTEGER := NULLIF(TRIM(p_datos->>'id_empresa'), '')::INTEGER;
  v_estado BOOLEAN := COALESCE(NULLIF(TRIM(p_datos->>'estado'), '')::BOOLEAN, TRUE);
BEGIN
  IF (CASE WHEN v_id_persona IS NULL THEN 0 ELSE 1 END)
     + (CASE WHEN v_id_empresa_cliente IS NULL THEN 0 ELSE 1 END) <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Debe enviar exactamente una relacion: id_persona o id_empresa_cliente';
  END IF;

  INSERT INTO public.clientes (
    fecha_ingreso,
    puntos,
    id_tipo_cliente,
    id_persona,
    id_empresa,
    id_empresa_cliente,
    estado
  )
  VALUES (
    v_fecha_ingreso,
    v_puntos,
    v_id_tipo_cliente,
    v_id_persona,
    v_id_empresa_tenant,
    v_id_empresa_cliente,
    v_estado
  )
  RETURNING id_cliente INTO v_id_cliente;

  RETURN v_id_cliente;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_actualizar_cliente(p_id_cliente INTEGER, p_datos JSON)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_id_cliente INTEGER;
BEGIN
  UPDATE public.clientes c
  SET
    fecha_ingreso = COALESCE(NULLIF(TRIM(p_datos->>'fecha_ingreso'), '')::DATE, c.fecha_ingreso),
    puntos = COALESCE(NULLIF(TRIM(p_datos->>'puntos'), '')::INTEGER, c.puntos),
    id_tipo_cliente = COALESCE(NULLIF(TRIM(p_datos->>'id_tipo_cliente'), '')::INTEGER, c.id_tipo_cliente),
    id_persona = COALESCE(NULLIF(TRIM(p_datos->>'id_persona'), '')::INTEGER, c.id_persona),
    id_empresa = COALESCE(NULLIF(TRIM(p_datos->>'id_empresa'), '')::INTEGER, c.id_empresa),
    id_empresa_cliente = COALESCE(NULLIF(TRIM(p_datos->>'id_empresa_cliente'), '')::INTEGER, c.id_empresa_cliente),
    estado = COALESCE(NULLIF(TRIM(p_datos->>'estado'), '')::BOOLEAN, c.estado)
  WHERE c.id_cliente = p_id_cliente
  RETURNING c.id_cliente INTO v_id_cliente;

  IF v_id_cliente IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '02000', MESSAGE = 'Cliente no encontrado';
  END IF;

  RETURN v_id_cliente;
END;
$$;

COMMIT;

