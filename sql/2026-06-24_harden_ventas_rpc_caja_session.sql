-- Harden caja session writes used by registrar_venta_pos_v1/v2 and legacy writers.
-- Safe to review/apply through the normal migration flow. Do not run manually in production.

CREATE OR REPLACE FUNCTION public.fn_ventas_assert_caja_session_write_open(
  p_id_sesion_caja bigint,
  p_id_caja bigint,
  p_id_sucursal bigint,
  p_id_usuario_ejecutor bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  PERFORM pg_advisory_xact_lock(8152028, p_id_sesion_caja::integer);

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

CREATE OR REPLACE FUNCTION public.fn_ventas_facturas_assert_caja_session_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.id_sesion_caja IS NOT DISTINCT FROM OLD.id_sesion_caja
    AND NEW.id_caja IS NOT DISTINCT FROM OLD.id_caja
    AND NEW.id_sucursal IS NOT DISTINCT FROM OLD.id_sucursal
    AND NEW.id_usuario IS NOT DISTINCT FROM OLD.id_usuario THEN
    RETURN NEW;
  END IF;

  PERFORM public.fn_ventas_assert_caja_session_write_open(
    NEW.id_sesion_caja::bigint,
    NEW.id_caja::bigint,
    NEW.id_sucursal::bigint,
    NEW.id_usuario::bigint
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_ventas_facturas_cobros_assert_caja_session_open()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.id_sesion_caja IS NOT DISTINCT FROM OLD.id_sesion_caja
    AND NEW.id_caja IS NOT DISTINCT FROM OLD.id_caja
    AND NEW.id_sucursal IS NOT DISTINCT FROM OLD.id_sucursal
    AND NEW.id_usuario_ejecutor IS NOT DISTINCT FROM OLD.id_usuario_ejecutor THEN
    RETURN NEW;
  END IF;

  PERFORM public.fn_ventas_assert_caja_session_write_open(
    NEW.id_sesion_caja::bigint,
    NEW.id_caja::bigint,
    NEW.id_sucursal::bigint,
    NEW.id_usuario_ejecutor::bigint
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ventas_facturas_assert_caja_session_open ON public.facturas;
CREATE TRIGGER trg_ventas_facturas_assert_caja_session_open
BEFORE INSERT OR UPDATE OF id_sesion_caja, id_caja, id_sucursal, id_usuario
ON public.facturas
FOR EACH ROW
EXECUTE FUNCTION public.fn_ventas_facturas_assert_caja_session_open();

DROP TRIGGER IF EXISTS trg_ventas_facturas_cobros_assert_caja_session_open ON public.facturas_cobros;
CREATE TRIGGER trg_ventas_facturas_cobros_assert_caja_session_open
BEFORE INSERT OR UPDATE OF id_sesion_caja, id_caja, id_sucursal, id_usuario_ejecutor
ON public.facturas_cobros
FOR EACH ROW
EXECUTE FUNCTION public.fn_ventas_facturas_cobros_assert_caja_session_open();

DO $$
BEGIN
  IF to_regprocedure('public.registrar_venta_pos_v1(jsonb,jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb) FROM PUBLIC;
    IF to_regrole('authenticated') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb) TO authenticated;
    END IF;
    IF to_regrole('service_role') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v1(jsonb, jsonb) TO service_role;
    END IF;
  END IF;

  IF to_regprocedure('public.registrar_venta_pos_v2(jsonb,jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.registrar_venta_pos_v2(jsonb, jsonb) FROM PUBLIC;
    IF to_regrole('authenticated') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v2(jsonb, jsonb) TO authenticated;
    END IF;
    IF to_regrole('service_role') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.registrar_venta_pos_v2(jsonb, jsonb) TO service_role;
    END IF;
  END IF;
END $$;
