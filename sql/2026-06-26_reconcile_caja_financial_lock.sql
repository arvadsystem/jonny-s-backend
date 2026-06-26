-- Reconcile caja financial lock functions with Jonnys QA.
-- Safe to run repeatedly. Do not execute automatically from the backend.

CREATE OR REPLACE FUNCTION public.fn_ventas_caja_financial_lock_key(p_id_sesion_caja bigint)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT p_id_sesion_caja;
$$;

REVOKE ALL ON FUNCTION public.fn_ventas_caja_financial_lock_key(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ventas_caja_financial_lock_key(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ventas_caja_financial_lock_key(bigint) FROM authenticated;
REVOKE ALL ON FUNCTION public.fn_ventas_caja_financial_lock_key(bigint) FROM service_role;

CREATE OR REPLACE FUNCTION public.fn_ventas_lock_caja_financial_session(
  p_id_sesion_caja bigint,
  p_timeout_ms integer DEFAULT 5000
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_timeout_ms integer;
  v_locked boolean;
BEGIN
  IF p_id_sesion_caja IS NULL OR p_id_sesion_caja <= 0 THEN
    RAISE EXCEPTION 'id_sesion_caja invalido'
      USING ERRCODE = '22023';
  END IF;

  v_timeout_ms := COALESCE(p_timeout_ms, 5000);
  IF v_timeout_ms < 100 OR v_timeout_ms > 60000 THEN
    RAISE EXCEPTION 'timeout financiero invalido'
      USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('lock_timeout', v_timeout_ms::text || 'ms', true);
  v_locked := pg_try_advisory_xact_lock(public.fn_ventas_caja_financial_lock_key(p_id_sesion_caja));

  IF NOT v_locked THEN
    RAISE EXCEPTION 'VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT'
      USING ERRCODE = '55P03';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ventas_lock_caja_financial_session(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ventas_lock_caja_financial_session(bigint, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ventas_lock_caja_financial_session(bigint, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ventas_lock_caja_financial_session(bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ventas_assert_caja_session_write_open(
  p_id_sesion_caja bigint,
  p_id_caja bigint,
  p_id_sucursal bigint,
  p_id_usuario_ejecutor bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_estado_codigo text;
  v_session record;
BEGIN
  IF p_id_sesion_caja IS NULL THEN
    RETURN;
  END IF;

  IF p_id_caja IS NULL OR p_id_sucursal IS NULL OR p_id_usuario_ejecutor IS NULL THEN
    RAISE EXCEPTION 'VENTAS_CAJA_SESSION_CONTEXT_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.fn_ventas_lock_caja_financial_session(p_id_sesion_caja, 5000);

  SELECT
    cs.id_sesion_caja,
    cs.id_caja,
    cs.id_sucursal,
    cs.id_usuario_responsable,
    estado.codigo AS estado_codigo,
    COALESCE(c.estado, true) AS caja_activa,
    EXISTS (
      SELECT 1
      FROM public.cajas_sesiones_participantes csp
      WHERE csp.id_sesion_caja = cs.id_sesion_caja
        AND csp.id_usuario = p_id_usuario_ejecutor
        AND COALESCE(csp.activo, true) = true
    ) AS has_active_participation
  INTO v_session
  FROM public.cajas_sesiones cs
  INNER JOIN public.cat_cajas_sesiones_estados estado
    ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
  INNER JOIN public.cajas c
    ON c.id_caja = cs.id_caja
   AND c.id_sucursal = cs.id_sucursal
  WHERE cs.id_sesion_caja = p_id_sesion_caja
  LIMIT 1
  FOR UPDATE OF cs;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENTAS_CAJA_SESSION_NOT_FOUND'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_session.id_caja IS DISTINCT FROM p_id_caja
    OR v_session.id_sucursal IS DISTINCT FROM p_id_sucursal THEN
    RAISE EXCEPTION 'VENTAS_CAJA_SESSION_SCOPE_MISMATCH'
      USING ERRCODE = 'P0001';
  END IF;

  v_estado_codigo := UPPER(TRIM(COALESCE(v_session.estado_codigo, '')));
  IF v_estado_codigo <> 'ABIERTA' THEN
    RAISE EXCEPTION 'VENTAS_CAJA_SESSION_CLOSED'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_session.caja_activa, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VENTAS_CAJA_NOT_ACTIVE'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_session.id_usuario_responsable IS DISTINCT FROM p_id_usuario_ejecutor
    AND COALESCE(v_session.has_active_participation, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'VENTAS_CAJA_SESSION_PARTICIPATION_REQUIRED'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ventas_assert_caja_session_write_open(bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ventas_assert_caja_session_write_open(bigint, bigint, bigint, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.fn_ventas_assert_caja_session_write_open(bigint, bigint, bigint, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ventas_assert_caja_session_write_open(bigint, bigint, bigint, bigint) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'cajas_sesiones'
      AND column_name = 'id_sesion_caja'
      AND data_type = 'bigint'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'public.cajas_sesiones.id_sesion_caja must be bigint before applying backend caja close lock changes';
  END IF;
END;
$$;

SELECT
  to_regprocedure('public.fn_ventas_caja_financial_lock_key(bigint)') AS lock_key_function,
  to_regprocedure('public.fn_ventas_lock_caja_financial_session(bigint, integer)') AS lock_function,
  to_regprocedure('public.fn_ventas_assert_caja_session_write_open(bigint, bigint, bigint, bigint)') AS guard_function;
