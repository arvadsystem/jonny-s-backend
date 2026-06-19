-- Backfill seguro de clientes.id_sucursal usando datos existentes
-- Prioridad de origen:
-- 1) clientes.id_sucursal actual
-- 2) personas.id_sucursal
-- 3) empresas.id_sucursal
-- 4) empleados.id_sucursal (ultimo empleado por persona)
--
-- Ejecutar una sola vez en entornos donde ya existe la columna clientes.id_sucursal.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clientes'
      AND column_name = 'id_sucursal'
  ) THEN
    RAISE NOTICE 'clientes.id_sucursal no existe en este entorno. Se omite backfill.';
    RETURN;
  END IF;

  WITH ultimo_empleado AS (
    SELECT DISTINCT ON (em.id_persona)
      em.id_persona,
      em.id_sucursal
    FROM public.empleados em
    WHERE em.id_persona IS NOT NULL
    ORDER BY em.id_persona, em.id_empleado DESC
  ),
  origen AS (
    SELECT
      c.id_cliente,
      COALESCE(c.id_sucursal, p.id_sucursal, e.id_sucursal, ue.id_sucursal) AS id_sucursal_resuelta
    FROM public.clientes c
    LEFT JOIN public.personas p
      ON p.id_persona = c.id_persona
    LEFT JOIN public.empresas e
      ON e.id_empresa = c.id_empresa
    LEFT JOIN ultimo_empleado ue
      ON ue.id_persona = c.id_persona
  )
  UPDATE public.clientes c
  SET id_sucursal = o.id_sucursal_resuelta
  FROM origen o
  WHERE c.id_cliente = o.id_cliente
    AND o.id_sucursal_resuelta IS NOT NULL
    AND c.id_sucursal IS DISTINCT FROM o.id_sucursal_resuelta;
END
$$;

