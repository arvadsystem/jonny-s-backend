-- =========================================================
-- PLANILLAS: FIX ANULAR MOVIMIENTO (42702)
-- Fecha: 2026-04-04
-- Error corregido:
--   column reference "id_detalle_planilla" is ambiguous
--   en fn_anular_movimiento_planilla
-- =========================================================

CREATE OR REPLACE FUNCTION public.fn_anular_movimiento_planilla(
    p_id_movimiento_planilla INTEGER
)
RETURNS TABLE (
    id_movimiento_planilla INTEGER,
    id_detalle_planilla INTEGER,
    neto_actualizado NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_id_detalle_planilla INTEGER;
    v_neto_actualizado NUMERIC(12,2);
BEGIN
    SELECT mp.id_detalle_planilla
    INTO v_id_detalle_planilla
    FROM public.movimiento_planilla mp
    WHERE mp.id_movimiento_planilla = p_id_movimiento_planilla
      AND mp.estado = TRUE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe un movimiento activo con id %', p_id_movimiento_planilla;
    END IF;

    UPDATE public.movimiento_planilla mp
    SET estado = FALSE
    WHERE mp.id_movimiento_planilla = p_id_movimiento_planilla;

    v_neto_actualizado := public.fn_recalcular_detalle_planilla(v_id_detalle_planilla);

    RETURN QUERY
    SELECT
        p_id_movimiento_planilla,
        v_id_detalle_planilla,
        v_neto_actualizado;
END;
$$;
