DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'planillas'
      AND column_name = 'periodo'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'planillas'
      AND column_name = 'tipo_periodo'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'planillas'
      AND column_name = 'quincena'
  ) THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_planillas_scope_lookup
      ON public.planillas (id_sucursal, periodo, tipo_periodo, quincena, fecha_creacion DESC)';
  ELSE
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_planillas_sucursal_fecha
      ON public.planillas (id_sucursal, fecha_creacion DESC)';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ix_detalle_planilla_planilla_empleado
  ON public.detalle_planilla (id_planilla, id_empleado);

CREATE INDEX IF NOT EXISTS ix_movimiento_planilla_detalle
  ON public.movimiento_planilla (id_detalle_planilla);

CREATE INDEX IF NOT EXISTS ix_adelanto_aplicacion_planilla_adelanto
  ON public.adelanto_aplicacion (id_planilla, id_adelanto_salario);

CREATE INDEX IF NOT EXISTS ix_horas_extras_planilla_empleado_fecha
  ON public.horas_extras (id_planilla, id_empleado, fecha DESC);

CREATE INDEX IF NOT EXISTS ix_adelantos_salario_empleado_fecha_estado
  ON public.adelantos_salario (id_empleado, fecha DESC, estado);
