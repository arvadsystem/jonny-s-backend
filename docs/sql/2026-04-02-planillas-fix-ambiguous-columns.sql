-- =========================================================
-- PLANILLAS: FIX DE AMBIGUEDAD (42702)
-- Fecha: 2026-04-02
-- Motivo:
--   Varias funciones PL/pgSQL usan RETURNS TABLE y referencias
--   sin alias (ej. id_planilla, id_sucursal, id_detalle_planilla),
--   lo que causa "column reference is ambiguous".
-- =========================================================

CREATE OR REPLACE FUNCTION public.fn_recalcular_planilla_por_sucursal(
  p_id_planilla INTEGER
)
RETURNS TABLE (
  id_planilla INTEGER,
  id_sucursal INTEGER,
  empleados_recalculados INTEGER,
  total_salario_base NUMERIC,
  total_bonos NUMERIC,
  total_deducciones NUMERIC,
  total_neto_pagar NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_id_sucursal INTEGER;
  v_count INTEGER := 0;
BEGIN
  SELECT p.id_sucursal
  INTO v_id_sucursal
  FROM public.planillas p
  WHERE p.id_planilla = p_id_planilla;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La planilla % no existe', p_id_planilla;
  END IF;

  IF v_id_sucursal IS NULL THEN
    RAISE EXCEPTION 'La planilla % no tiene sucursal', p_id_planilla;
  END IF;

  PERFORM public.fn_recalcular_detalle_planilla(dp.id_detalle_planilla)
  FROM public.detalle_planilla dp
  WHERE dp.id_planilla = p_id_planilla;

  SELECT COUNT(*)
  INTO v_count
  FROM public.detalle_planilla dp
  WHERE dp.id_planilla = p_id_planilla;

  RETURN QUERY
  SELECT
    p.id_planilla,
    p.id_sucursal,
    v_count,
    COALESCE(SUM(dp.salario_base), 0),
    COALESCE(SUM(dp.total_bonos), 0),
    COALESCE(SUM(dp.total_deducciones), 0),
    COALESCE(SUM(dp.neto_pagar), 0)
  FROM public.planillas p
  LEFT JOIN public.detalle_planilla dp
    ON dp.id_planilla = p.id_planilla
  WHERE p.id_planilla = p_id_planilla
  GROUP BY p.id_planilla, p.id_sucursal;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_resumen_planilla_por_sucursal(
  p_id_planilla INTEGER
)
RETURNS TABLE (
  id_planilla INTEGER,
  id_sucursal INTEGER,
  nombre_sucursal VARCHAR,
  fecha_creacion TIMESTAMP,
  id_estado_planilla INTEGER,
  estado_planilla VARCHAR,
  total_empleados BIGINT,
  total_salario_base NUMERIC,
  total_bonos NUMERIC,
  total_deducciones NUMERIC,
  total_adelantos_aplicados NUMERIC,
  total_neto_pagar NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.planillas p
    WHERE p.id_planilla = p_id_planilla
  ) THEN
    RAISE EXCEPTION 'La planilla % no existe', p_id_planilla;
  END IF;

  RETURN QUERY
  SELECT
    p.id_planilla,
    p.id_sucursal,
    s.nombre_sucursal::VARCHAR,
    p.fecha_creacion,
    p.id_estado_planilla,
    ep.descripcion::VARCHAR,
    COUNT(dp.id_detalle_planilla),
    COALESCE(SUM(dp.salario_base), 0),
    COALESCE(SUM(dp.total_bonos), 0),
    COALESCE(SUM(dp.total_deducciones), 0),
    COALESCE(
      (
        SELECT SUM(aa.monto_aplicado)
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla = p.id_planilla
      ),
      0
    ),
    COALESCE(SUM(dp.neto_pagar), 0)
  FROM public.planillas p
  LEFT JOIN public.sucursales s
    ON s.id_sucursal = p.id_sucursal
  LEFT JOIN public.estado_planilla ep
    ON ep.id_estado_planilla = p.id_estado_planilla
  LEFT JOIN public.detalle_planilla dp
    ON dp.id_planilla = p.id_planilla
  WHERE p.id_planilla = p_id_planilla
  GROUP BY
    p.id_planilla,
    p.id_sucursal,
    s.nombre_sucursal,
    p.fecha_creacion,
    p.id_estado_planilla,
    ep.descripcion;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_planilla_completa_json(
  p_id_planilla INTEGER
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_result JSON;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.planillas p
    WHERE p.id_planilla = p_id_planilla
  ) THEN
    RAISE EXCEPTION 'No existe la planilla %', p_id_planilla;
  END IF;

  SELECT json_build_object(
    'encabezado',
    (
      SELECT row_to_json(x)
      FROM (
        SELECT
          p.id_planilla,
          p.fecha_creacion,
          p.id_estado_planilla,
          ep.descripcion AS estado_planilla,
          p.id_sucursal,
          s.nombre_sucursal
        FROM public.planillas p
        LEFT JOIN public.estado_planilla ep
          ON ep.id_estado_planilla = p.id_estado_planilla
        LEFT JOIN public.sucursales s
          ON s.id_sucursal = p.id_sucursal
        WHERE p.id_planilla = p_id_planilla
      ) x
    ),
    'resumen',
    (
      SELECT row_to_json(r)
      FROM (
        SELECT *
        FROM public.fn_listar_resumen_planilla_por_sucursal(p_id_planilla)
      ) r
    ),
    'detalle',
    (
      SELECT COALESCE(json_agg(d), '[]'::JSON)
      FROM (
        SELECT *
        FROM public.fn_listar_detalle_planilla(p_id_planilla)
      ) d
    ),
    'adelantos_aplicados',
    (
      SELECT COALESCE(json_agg(a), '[]'::JSON)
      FROM (
        SELECT
          aa.id_adelanto_aplicacion,
          aa.id_planilla,
          aa.id_adelanto_salario,
          aa.monto_aplicado
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla = p_id_planilla
      ) a
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_empleados_activos_por_sucursal(
  p_id_sucursal INTEGER
)
RETURNS TABLE (
  id_empleado INTEGER,
  id_persona INTEGER,
  nombre_completo TEXT,
  dni VARCHAR,
  cargo VARCHAR,
  salario_base NUMERIC,
  telefono VARCHAR,
  correo VARCHAR,
  id_sucursal INTEGER,
  nombre_sucursal VARCHAR,
  estado BOOLEAN
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.sucursales s
    WHERE s.id_sucursal = p_id_sucursal
  ) THEN
    RAISE EXCEPTION 'La sucursal % no existe', p_id_sucursal;
  END IF;

  RETURN QUERY
  SELECT
    e.id_empleado,
    e.id_persona,
    TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')),
    p.dni::VARCHAR,
    e.cargo::VARCHAR,
    e.salario_base,
    t.telefono::VARCHAR,
    c.direccion_correo::VARCHAR,
    e.id_sucursal,
    s.nombre_sucursal::VARCHAR,
    e.estado
  FROM public.empleados e
  JOIN public.personas p
    ON p.id_persona = e.id_persona
  LEFT JOIN public.telefonos t
    ON t.id_telefono = p.id_telefono
  LEFT JOIN public.correos c
    ON c.id_correo = p.id_correo
  JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  WHERE e.estado = TRUE
    AND e.id_sucursal = p_id_sucursal
  ORDER BY nombre_completo;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_adelantos_pendientes_por_sucursal(
  p_id_sucursal INTEGER
)
RETURNS TABLE (
  id_adelanto_salario INTEGER,
  id_empleado INTEGER,
  nombre_completo TEXT,
  cargo VARCHAR,
  id_sucursal INTEGER,
  nombre_sucursal VARCHAR,
  fecha TIMESTAMP,
  monto NUMERIC,
  saldo NUMERIC,
  estado BOOLEAN
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.sucursales s
    WHERE s.id_sucursal = p_id_sucursal
  ) THEN
    RAISE EXCEPTION 'La sucursal % no existe', p_id_sucursal;
  END IF;

  RETURN QUERY
  SELECT
    a.id_adelanto_salario,
    e.id_empleado,
    TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')),
    e.cargo::VARCHAR,
    e.id_sucursal,
    s.nombre_sucursal::VARCHAR,
    a.fecha,
    a.monto,
    a.saldo,
    a.estado
  FROM public.adelantos_salario a
  JOIN public.empleados e
    ON e.id_empleado = a.id_empleado
  JOIN public.personas p
    ON p.id_persona = e.id_persona
  JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  WHERE e.id_sucursal = p_id_sucursal
    AND e.estado = TRUE
    AND a.estado = TRUE
    AND COALESCE(a.saldo, 0) > 0
  ORDER BY a.fecha DESC, nombre_completo;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_movimientos_planilla(
  p_id_detalle_planilla INTEGER
)
RETURNS TABLE (
  id_movimiento_planilla INTEGER,
  id_detalle_planilla INTEGER,
  tipo_movimiento VARCHAR,
  concepto VARCHAR,
  monto NUMERIC,
  observacion VARCHAR,
  fecha_registro TIMESTAMP
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.detalle_planilla dp
    WHERE dp.id_detalle_planilla = p_id_detalle_planilla
  ) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;

  RETURN QUERY
  SELECT
    mp.id_movimiento_planilla,
    mp.id_detalle_planilla,
    mp.tipo_movimiento::VARCHAR,
    mp.concepto::VARCHAR,
    mp.monto,
    mp.observacion::VARCHAR,
    mp.fecha_registro
  FROM public.movimiento_planilla mp
  WHERE mp.id_detalle_planilla = p_id_detalle_planilla
    AND mp.estado = TRUE
  ORDER BY mp.fecha_registro DESC, mp.id_movimiento_planilla DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_movimientos_planilla_detalle(
  p_id_detalle_planilla INTEGER
)
RETURNS TABLE (
  id_movimiento_planilla INTEGER,
  id_detalle_planilla INTEGER,
  id_planilla INTEGER,
  id_empleado INTEGER,
  nombre_completo TEXT,
  nombre_sucursal VARCHAR,
  cargo VARCHAR,
  salario_base NUMERIC,
  neto_pagar NUMERIC,
  tipo_movimiento VARCHAR,
  concepto VARCHAR,
  monto NUMERIC,
  observacion VARCHAR,
  fecha_registro TIMESTAMP
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.detalle_planilla dp
    WHERE dp.id_detalle_planilla = p_id_detalle_planilla
  ) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;

  RETURN QUERY
  SELECT
    mp.id_movimiento_planilla,
    mp.id_detalle_planilla,
    dp.id_planilla,
    e.id_empleado,
    TRIM(COALESCE(p.nombre, '') || ' ' || COALESCE(p.apellido, '')) AS nombre_completo,
    s.nombre_sucursal::VARCHAR,
    e.cargo::VARCHAR,
    dp.salario_base,
    dp.neto_pagar,
    mp.tipo_movimiento::VARCHAR,
    mp.concepto::VARCHAR,
    mp.monto,
    mp.observacion::VARCHAR,
    mp.fecha_registro
  FROM public.movimiento_planilla mp
  JOIN public.detalle_planilla dp
    ON dp.id_detalle_planilla = mp.id_detalle_planilla
  JOIN public.empleados e
    ON e.id_empleado = dp.id_empleado
  JOIN public.personas p
    ON p.id_persona = e.id_persona
  LEFT JOIN public.sucursales s
    ON s.id_sucursal = e.id_sucursal
  WHERE mp.id_detalle_planilla = p_id_detalle_planilla
    AND mp.estado = TRUE
  ORDER BY mp.fecha_registro DESC, mp.id_movimiento_planilla DESC;
END;
$$;
