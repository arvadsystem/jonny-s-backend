-- =========================================================
-- PLANILLAS: FIX APLICAR ADELANTO (42702)
-- Fecha: 2026-04-04
-- Error corregido:
--   column reference ambiguo dentro de fn_aplicar_adelanto_a_planilla
--   en entornos con version desalineada de la funcion.
-- =========================================================

CREATE OR REPLACE FUNCTION public.fn_aplicar_adelanto_a_planilla(
    p_id_adelanto_salario INTEGER,
    p_id_planilla INTEGER,
    p_monto_aplicado NUMERIC(12,2) DEFAULT NULL
)
RETURNS TABLE (
    id_adelanto_salario INTEGER,
    id_planilla INTEGER,
    id_empleado INTEGER,
    monto_aplicado NUMERIC,
    saldo_restante NUMERIC,
    neto_actualizado NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_id_empleado INTEGER;
    v_saldo_actual NUMERIC(12,2);
    v_estado_adelanto BOOLEAN;
    v_monto_aplicar NUMERIC(12,2);
    v_id_detalle_planilla INTEGER;
    v_neto_actualizado NUMERIC(12,2);
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.planillas pl
        WHERE pl.id_planilla = p_id_planilla
    ) THEN
        RAISE EXCEPTION 'No existe la planilla %', p_id_planilla;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.adelantos_salario ad
        WHERE ad.id_adelanto_salario = p_id_adelanto_salario
    ) THEN
        RAISE EXCEPTION 'No existe el adelanto_salario %', p_id_adelanto_salario;
    END IF;

    SELECT
        ad.id_empleado,
        ad.saldo,
        ad.estado
    INTO
        v_id_empleado,
        v_saldo_actual,
        v_estado_adelanto
    FROM public.adelantos_salario ad
    WHERE ad.id_adelanto_salario = p_id_adelanto_salario;

    IF v_estado_adelanto IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'El adelanto % está inactivo o ya fue liquidado', p_id_adelanto_salario;
    END IF;

    IF COALESCE(v_saldo_actual, 0) <= 0 THEN
        RAISE EXCEPTION 'El adelanto % no tiene saldo disponible', p_id_adelanto_salario;
    END IF;

    SELECT dp.id_detalle_planilla
    INTO v_id_detalle_planilla
    FROM public.detalle_planilla dp
    WHERE dp.id_planilla = p_id_planilla
      AND dp.id_empleado = v_id_empleado
    LIMIT 1;

    IF v_id_detalle_planilla IS NULL THEN
        RAISE EXCEPTION
        'El empleado % asociado al adelanto % no pertenece a la planilla %',
        v_id_empleado, p_id_adelanto_salario, p_id_planilla;
    END IF;

    v_monto_aplicar := COALESCE(p_monto_aplicado, v_saldo_actual);

    IF v_monto_aplicar IS NULL OR v_monto_aplicar <= 0 THEN
        RAISE EXCEPTION 'El monto a aplicar debe ser mayor que 0';
    END IF;

    IF v_monto_aplicar > v_saldo_actual THEN
        RAISE EXCEPTION
        'No puedes aplicar % porque el saldo disponible del adelanto es %',
        v_monto_aplicar, v_saldo_actual;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla = p_id_planilla
          AND aa.id_adelanto_salario = p_id_adelanto_salario
    ) THEN
        RAISE EXCEPTION
        'El adelanto % ya fue aplicado a la planilla %',
        p_id_adelanto_salario, p_id_planilla;
    END IF;

    INSERT INTO public.adelanto_aplicacion (
        id_planilla,
        id_adelanto_salario,
        monto_aplicado
    )
    VALUES (
        p_id_planilla,
        p_id_adelanto_salario,
        v_monto_aplicar
    );

    UPDATE public.adelantos_salario ad
    SET
        saldo = ad.saldo - v_monto_aplicar,
        estado = CASE
                    WHEN (ad.saldo - v_monto_aplicar) <= 0 THEN FALSE
                    ELSE ad.estado
                 END
    WHERE ad.id_adelanto_salario = p_id_adelanto_salario;

    v_neto_actualizado := public.fn_recalcular_detalle_planilla(v_id_detalle_planilla);

    RETURN QUERY
    SELECT
        p_id_adelanto_salario::INTEGER,
        p_id_planilla::INTEGER,
        v_id_empleado::INTEGER,
        v_monto_aplicar::NUMERIC,
        (v_saldo_actual - v_monto_aplicar)::NUMERIC,
        v_neto_actualizado::NUMERIC;
END;
$$;


