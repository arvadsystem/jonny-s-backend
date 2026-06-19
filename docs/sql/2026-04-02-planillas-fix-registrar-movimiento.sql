-- =========================================================
-- PLANILLAS: FIX REGISTRAR MOVIMIENTO (42702)
-- Fecha: 2026-04-02
-- Error:
--   column reference "id_detalle_planilla" is ambiguous
-- =========================================================

CREATE OR REPLACE FUNCTION public.fn_registrar_movimiento_planilla(
  p_id_detalle_planilla INTEGER,
  p_tipo_movimiento VARCHAR,
  p_concepto VARCHAR,
  p_monto NUMERIC(12,2),
  p_observacion VARCHAR DEFAULT NULL
)
RETURNS TABLE (
  id_movimiento_planilla INTEGER,
  id_detalle_planilla INTEGER,
  tipo_movimiento VARCHAR,
  concepto VARCHAR,
  monto NUMERIC,
  neto_actualizado NUMERIC
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_id_movimiento_planilla INTEGER;
  v_neto_actualizado NUMERIC(12,2);
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.detalle_planilla dp
    WHERE dp.id_detalle_planilla = p_id_detalle_planilla
  ) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;

  IF UPPER(TRIM(p_tipo_movimiento)) NOT IN ('BONO', 'DEDUCCION') THEN
    RAISE EXCEPTION 'Tipo invalido';
  END IF;

  IF p_concepto IS NULL OR TRIM(p_concepto) = '' THEN
    RAISE EXCEPTION 'Concepto obligatorio';
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN
    RAISE EXCEPTION 'Monto invalido';
  END IF;

  INSERT INTO public.movimiento_planilla (
    id_detalle_planilla,
    tipo_movimiento,
    concepto,
    monto,
    observacion
  )
  VALUES (
    p_id_detalle_planilla,
    UPPER(TRIM(p_tipo_movimiento)),
    TRIM(p_concepto),
    p_monto,
    NULLIF(TRIM(p_observacion), '')
  )
  RETURNING public.movimiento_planilla.id_movimiento_planilla
  INTO v_id_movimiento_planilla;

  v_neto_actualizado := public.fn_recalcular_detalle_planilla(p_id_detalle_planilla);

  RETURN QUERY
  SELECT
    v_id_movimiento_planilla,
    p_id_detalle_planilla,
    UPPER(TRIM(p_tipo_movimiento))::VARCHAR,
    TRIM(p_concepto)::VARCHAR,
    p_monto,
    v_neto_actualizado;
END;
$$;
