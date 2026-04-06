ALTER TABLE public.detalle_planilla
ADD COLUMN IF NOT EXISTS total_bonos NUMERIC(12,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS observaciones VARCHAR(255);

ALTER TABLE public.horas_extras
ADD COLUMN IF NOT EXISTS compensada BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS fecha_compensacion TIMESTAMP,
ADD COLUMN IF NOT EXISTS observacion VARCHAR(255);

CREATE TABLE IF NOT EXISTS public.movimiento_planilla (
    id_movimiento_planilla SERIAL PRIMARY KEY,
    id_detalle_planilla INTEGER NOT NULL,
    tipo_movimiento VARCHAR(20) NOT NULL,
    concepto VARCHAR(100) NOT NULL,
    monto NUMERIC(12,2) NOT NULL DEFAULT 0,
    observacion VARCHAR(255),
    fecha_registro TIMESTAMP NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_movimiento_detalle_planilla
        FOREIGN KEY (id_detalle_planilla)
        REFERENCES public.detalle_planilla(id_detalle_planilla)
        ON DELETE CASCADE,

    CONSTRAINT chk_tipo_movimiento
        CHECK (tipo_movimiento IN ('BONO', 'DEDUCCION'))
);

CREATE INDEX IF NOT EXISTS ix_detalle_planilla_id_planilla
ON public.detalle_planilla (id_planilla);

CREATE INDEX IF NOT EXISTS ix_detalle_planilla_id_empleado
ON public.detalle_planilla (id_empleado);

CREATE INDEX IF NOT EXISTS ix_adelantos_salario_id_empleado
ON public.adelantos_salario (id_empleado);

CREATE INDEX IF NOT EXISTS ix_adelanto_aplicacion_id_planilla
ON public.adelanto_aplicacion (id_planilla);

CREATE INDEX IF NOT EXISTS ix_adelanto_aplicacion_id_adelanto_salario
ON public.adelanto_aplicacion (id_adelanto_salario);

CREATE INDEX IF NOT EXISTS ix_horas_extras_id_empleado
ON public.horas_extras (id_empleado);

CREATE INDEX IF NOT EXISTS ix_horas_extras_id_planilla
ON public.horas_extras (id_planilla);

CREATE INDEX IF NOT EXISTS ix_movimiento_planilla_id_detalle_planilla
ON public.movimiento_planilla (id_detalle_planilla);

COMMENT ON COLUMN public.detalle_planilla.total_bonos IS
'Suma total de bonos aplicados al empleado en la planilla';

COMMENT ON COLUMN public.detalle_planilla.observaciones IS
'Observaciones generales del detalle de planilla';

COMMENT ON COLUMN public.horas_extras.compensada IS
'Indica si las horas extra fueron compensadas con tiempo libre';

COMMENT ON COLUMN public.horas_extras.fecha_compensacion IS
'Fecha en que se otorgó el tiempo compensatorio';

COMMENT ON COLUMN public.movimiento_planilla.tipo_movimiento IS
'Tipo de movimiento: BONO o DEDUCCION';

COMMENT ON COLUMN public.movimiento_planilla.concepto IS
'Motivo del bono o deducción';


-- Planillas modulo maestro (ejecutable, idempotente)

INSERT INTO public.estado_planilla (descripcion)
SELECT 'BORRADOR' WHERE NOT EXISTS (SELECT 1 FROM public.estado_planilla WHERE UPPER(TRIM(descripcion))='BORRADOR');
INSERT INTO public.estado_planilla (descripcion)
SELECT 'CALCULADA' WHERE NOT EXISTS (SELECT 1 FROM public.estado_planilla WHERE UPPER(TRIM(descripcion))='CALCULADA');
INSERT INTO public.estado_planilla (descripcion)
SELECT 'PAGADA' WHERE NOT EXISTS (SELECT 1 FROM public.estado_planilla WHERE UPPER(TRIM(descripcion))='PAGADA');
INSERT INTO public.estado_planilla (descripcion)
SELECT 'ANULADA' WHERE NOT EXISTS (SELECT 1 FROM public.estado_planilla WHERE UPPER(TRIM(descripcion))='ANULADA');
INSERT INTO public.estado_planilla (descripcion)
SELECT 'CERRADA' WHERE NOT EXISTS (SELECT 1 FROM public.estado_planilla WHERE UPPER(TRIM(descripcion))='CERRADA');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='planillas') THEN
    ALTER TABLE public.planillas ADD COLUMN IF NOT EXISTS id_sucursal INTEGER;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema='public' AND table_name='planillas' AND constraint_name='fk_planillas_sucursal'
    ) THEN
      ALTER TABLE public.planillas
      ADD CONSTRAINT fk_planillas_sucursal
      FOREIGN KEY (id_sucursal) REFERENCES public.sucursales(id_sucursal);
    END IF;
  ELSE
    RAISE EXCEPTION 'No existe public.planillas';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='detalle_planilla') THEN
    ALTER TABLE public.detalle_planilla
    ADD COLUMN IF NOT EXISTS total_bonos NUMERIC(12,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS observaciones VARCHAR(255);
  ELSE
    RAISE EXCEPTION 'No existe public.detalle_planilla';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='horas_extras') THEN
    ALTER TABLE public.horas_extras
    ADD COLUMN IF NOT EXISTS compensada BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS fecha_compensacion TIMESTAMP,
    ADD COLUMN IF NOT EXISTS observacion VARCHAR(255);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.movimiento_planilla (
  id_movimiento_planilla SERIAL PRIMARY KEY,
  id_detalle_planilla INTEGER NOT NULL REFERENCES public.detalle_planilla(id_detalle_planilla) ON DELETE CASCADE,
  tipo_movimiento VARCHAR(20) NOT NULL CHECK (tipo_movimiento IN ('BONO','DEDUCCION')),
  concepto VARCHAR(100) NOT NULL,
  monto NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacion VARCHAR(255),
  fecha_registro TIMESTAMP NOT NULL DEFAULT NOW(),
  estado BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS ix_planillas_id_sucursal ON public.planillas(id_sucursal);
CREATE INDEX IF NOT EXISTS ix_detalle_planilla_id_planilla ON public.detalle_planilla(id_planilla);
CREATE INDEX IF NOT EXISTS ix_detalle_planilla_id_empleado ON public.detalle_planilla(id_empleado);
CREATE INDEX IF NOT EXISTS ix_adelantos_salario_id_empleado ON public.adelantos_salario(id_empleado);
CREATE INDEX IF NOT EXISTS ix_adelanto_aplicacion_id_planilla ON public.adelanto_aplicacion(id_planilla);
CREATE INDEX IF NOT EXISTS ix_adelanto_aplicacion_id_adelanto_salario ON public.adelanto_aplicacion(id_adelanto_salario);
CREATE INDEX IF NOT EXISTS ix_horas_extras_id_empleado ON public.horas_extras(id_empleado);
CREATE INDEX IF NOT EXISTS ix_horas_extras_id_planilla ON public.horas_extras(id_planilla);
CREATE INDEX IF NOT EXISTS ix_movimiento_planilla_id_detalle_planilla ON public.movimiento_planilla(id_detalle_planilla);
CREATE INDEX IF NOT EXISTS ix_movimiento_planilla_estado ON public.movimiento_planilla(estado);
CREATE UNIQUE INDEX IF NOT EXISTS ux_adelanto_aplicacion_planilla_adelanto ON public.adelanto_aplicacion(id_planilla,id_adelanto_salario);

CREATE TABLE IF NOT EXISTS public.auditoria_planilla (
  id_auditoria_planilla SERIAL PRIMARY KEY,
  fecha_registro TIMESTAMP NOT NULL DEFAULT NOW(),
  accion VARCHAR(50) NOT NULL,
  entidad VARCHAR(50) NOT NULL,
  id_referencia INTEGER,
  descripcion VARCHAR(255),
  usuario_accion VARCHAR(100)
);
CREATE INDEX IF NOT EXISTS ix_auditoria_planilla_fecha ON public.auditoria_planilla(fecha_registro);
CREATE INDEX IF NOT EXISTS ix_auditoria_planilla_entidad ON public.auditoria_planilla(entidad);
CREATE OR REPLACE FUNCTION public.fn_generar_planilla_mensual_por_sucursal(
  p_id_sucursal INTEGER,
  p_fecha_planilla TIMESTAMP DEFAULT NOW(),
  p_id_estado_planilla INTEGER DEFAULT 1,
  p_dias_laborados NUMERIC(5,2) DEFAULT 30,
  p_horas_laboradas NUMERIC(6,2) DEFAULT 240
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_id_planilla INTEGER; v_existe INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sucursales WHERE id_sucursal=p_id_sucursal) THEN
    RAISE EXCEPTION 'La sucursal % no existe', p_id_sucursal;
  END IF;

  SELECT id_planilla INTO v_existe FROM public.planillas
  WHERE date_trunc('month', fecha_creacion)=date_trunc('month', p_fecha_planilla)
    AND id_sucursal=p_id_sucursal
  LIMIT 1;

  IF v_existe IS NOT NULL THEN
    RAISE EXCEPTION 'Ya existe una planilla para % en sucursal %', to_char(p_fecha_planilla,'YYYY-MM'), p_id_sucursal;
  END IF;

  INSERT INTO public.planillas(fecha_creacion,id_estado_planilla,id_sucursal)
  VALUES (p_fecha_planilla,p_id_estado_planilla,p_id_sucursal)
  RETURNING id_planilla INTO v_id_planilla;

  INSERT INTO public.detalle_planilla(
    salario_base,dias_laborados,horas_laboradas,total_deducciones,total_bonos,neto_pagar,id_planilla,id_horas_extra,id_empleado,observaciones
  )
  SELECT e.salario_base,p_dias_laborados,p_horas_laboradas,0,0,e.salario_base,v_id_planilla,NULL,e.id_empleado,'Generada por sucursal'
  FROM public.empleados e
  WHERE e.estado=TRUE AND e.id_sucursal=p_id_sucursal;

  RETURN v_id_planilla;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_recalcular_detalle_planilla(
  p_id_detalle_planilla INTEGER
)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
  v_salario_base NUMERIC(12,2);
  v_total_bonos NUMERIC(12,2):=0;
  v_total_deducciones NUMERIC(12,2):=0;
  v_total_adelantos NUMERIC(12,2):=0;
  v_neto NUMERIC(12,2):=0;
  v_id_planilla INTEGER;
  v_id_empleado INTEGER;
BEGIN
  SELECT salario_base,id_planilla,id_empleado INTO v_salario_base,v_id_planilla,v_id_empleado
  FROM public.detalle_planilla WHERE id_detalle_planilla=p_id_detalle_planilla;

  IF NOT FOUND THEN RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla; END IF;

  SELECT COALESCE(SUM(monto),0) INTO v_total_bonos
  FROM public.movimiento_planilla
  WHERE id_detalle_planilla=p_id_detalle_planilla AND tipo_movimiento='BONO' AND estado=TRUE;

  SELECT COALESCE(SUM(monto),0) INTO v_total_deducciones
  FROM public.movimiento_planilla
  WHERE id_detalle_planilla=p_id_detalle_planilla AND tipo_movimiento='DEDUCCION' AND estado=TRUE;

  SELECT COALESCE(SUM(aa.monto_aplicado),0) INTO v_total_adelantos
  FROM public.adelanto_aplicacion aa
  JOIN public.adelantos_salario a ON a.id_adelanto_salario=aa.id_adelanto_salario
  WHERE aa.id_planilla=v_id_planilla AND a.id_empleado=v_id_empleado;

  v_total_deducciones:=v_total_deducciones+v_total_adelantos;
  v_neto:=v_salario_base+v_total_bonos-v_total_deducciones;

  UPDATE public.detalle_planilla
  SET total_bonos=v_total_bonos,total_deducciones=v_total_deducciones,neto_pagar=v_neto
  WHERE id_detalle_planilla=p_id_detalle_planilla;

  RETURN v_neto;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_recalcular_planilla_por_sucursal(
  p_id_planilla INTEGER
)
RETURNS TABLE(id_planilla INTEGER,id_sucursal INTEGER,empleados_recalculados INTEGER,total_salario_base NUMERIC,total_bonos NUMERIC,total_deducciones NUMERIC,total_neto_pagar NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE v_id_sucursal INTEGER; v_count INTEGER:=0;
BEGIN
  SELECT id_sucursal INTO v_id_sucursal FROM public.planillas WHERE id_planilla=p_id_planilla;
  IF NOT FOUND THEN RAISE EXCEPTION 'La planilla % no existe', p_id_planilla; END IF;
  IF v_id_sucursal IS NULL THEN RAISE EXCEPTION 'La planilla % no tiene sucursal', p_id_planilla; END IF;

  PERFORM public.fn_recalcular_detalle_planilla(dp.id_detalle_planilla)
  FROM public.detalle_planilla dp WHERE dp.id_planilla=p_id_planilla;

  SELECT COUNT(*) INTO v_count FROM public.detalle_planilla WHERE id_planilla=p_id_planilla;

  RETURN QUERY
  SELECT p.id_planilla,p.id_sucursal,v_count,
         COALESCE(SUM(dp.salario_base),0),COALESCE(SUM(dp.total_bonos),0),COALESCE(SUM(dp.total_deducciones),0),COALESCE(SUM(dp.neto_pagar),0)
  FROM public.planillas p
  LEFT JOIN public.detalle_planilla dp ON dp.id_planilla=p.id_planilla
  WHERE p.id_planilla=p_id_planilla
  GROUP BY p.id_planilla,p.id_sucursal;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_planillas_por_sucursal()
RETURNS TABLE(id_planilla INTEGER,fecha_creacion TIMESTAMP,id_estado_planilla INTEGER,estado_planilla VARCHAR,id_sucursal INTEGER,nombre_sucursal VARCHAR,total_empleados BIGINT)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT p.id_planilla,p.fecha_creacion,p.id_estado_planilla,ep.descripcion::VARCHAR,p.id_sucursal,s.nombre_sucursal::VARCHAR,COUNT(dp.id_detalle_planilla)
  FROM public.planillas p
  LEFT JOIN public.estado_planilla ep ON ep.id_estado_planilla=p.id_estado_planilla
  LEFT JOIN public.sucursales s ON s.id_sucursal=p.id_sucursal
  LEFT JOIN public.detalle_planilla dp ON dp.id_planilla=p.id_planilla
  GROUP BY p.id_planilla,p.fecha_creacion,p.id_estado_planilla,ep.descripcion,p.id_sucursal,s.nombre_sucursal
  ORDER BY p.fecha_creacion DESC,p.id_planilla DESC;
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_listar_detalle_planilla(p_id_planilla INTEGER)
RETURNS TABLE(id_detalle_planilla INTEGER,id_planilla INTEGER,id_empleado INTEGER,nombre_completo TEXT,sucursal VARCHAR,cargo VARCHAR,salario_base NUMERIC,total_bonos NUMERIC,total_deducciones NUMERIC,neto_pagar NUMERIC,horas_laboradas NUMERIC,dias_laborados NUMERIC,estado_empleado BOOLEAN)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT dp.id_detalle_planilla,dp.id_planilla,e.id_empleado,
         TRIM(COALESCE(p.nombre,'')||' '||COALESCE(p.apellido,'')),
         s.nombre_sucursal::VARCHAR,e.cargo::VARCHAR,dp.salario_base,
         COALESCE(dp.total_bonos,0),COALESCE(dp.total_deducciones,0),COALESCE(dp.neto_pagar,0),
         dp.horas_laboradas,dp.dias_laborados,e.estado
  FROM public.detalle_planilla dp
  JOIN public.empleados e ON e.id_empleado=dp.id_empleado
  JOIN public.personas p ON p.id_persona=e.id_persona
  LEFT JOIN public.sucursales s ON s.id_sucursal=e.id_sucursal
  WHERE dp.id_planilla=p_id_planilla
  ORDER BY nombre_completo;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_empleados_activos_por_sucursal(p_id_sucursal INTEGER)
RETURNS TABLE(id_empleado INTEGER,id_persona INTEGER,nombre_completo TEXT,dni VARCHAR,cargo VARCHAR,salario_base NUMERIC,telefono VARCHAR,correo VARCHAR,id_sucursal INTEGER,nombre_sucursal VARCHAR,estado BOOLEAN)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sucursales WHERE id_sucursal=p_id_sucursal) THEN
    RAISE EXCEPTION 'La sucursal % no existe', p_id_sucursal;
  END IF;

  RETURN QUERY
  SELECT e.id_empleado,e.id_persona,TRIM(COALESCE(p.nombre,'')||' '||COALESCE(p.apellido,'')),
         p.dni::VARCHAR,e.cargo::VARCHAR,e.salario_base,t.telefono::VARCHAR,c.direccion_correo::VARCHAR,
         e.id_sucursal,s.nombre_sucursal::VARCHAR,e.estado
  FROM public.empleados e
  JOIN public.personas p ON p.id_persona=e.id_persona
  LEFT JOIN public.telefonos t ON t.id_telefono=p.id_telefono
  LEFT JOIN public.correos c ON c.id_correo=p.id_correo
  JOIN public.sucursales s ON s.id_sucursal=e.id_sucursal
  WHERE e.estado=TRUE AND e.id_sucursal=p_id_sucursal
  ORDER BY nombre_completo;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_adelantos_pendientes_por_sucursal(p_id_sucursal INTEGER)
RETURNS TABLE(id_adelanto_salario INTEGER,id_empleado INTEGER,nombre_completo TEXT,cargo VARCHAR,id_sucursal INTEGER,nombre_sucursal VARCHAR,fecha TIMESTAMP,monto NUMERIC,saldo NUMERIC,estado BOOLEAN)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sucursales WHERE id_sucursal=p_id_sucursal) THEN
    RAISE EXCEPTION 'La sucursal % no existe', p_id_sucursal;
  END IF;

  RETURN QUERY
  SELECT a.id_adelanto_salario,e.id_empleado,TRIM(COALESCE(p.nombre,'')||' '||COALESCE(p.apellido,'')),
         e.cargo::VARCHAR,e.id_sucursal,s.nombre_sucursal::VARCHAR,a.fecha,a.monto,a.saldo,a.estado
  FROM public.adelantos_salario a
  JOIN public.empleados e ON e.id_empleado=a.id_empleado
  JOIN public.personas p ON p.id_persona=e.id_persona
  JOIN public.sucursales s ON s.id_sucursal=e.id_sucursal
  WHERE e.id_sucursal=p_id_sucursal AND e.estado=TRUE AND a.estado=TRUE AND COALESCE(a.saldo,0)>0
  ORDER BY a.fecha DESC,nombre_completo;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_adelantos_aplicables_a_planilla(p_id_planilla INTEGER)
RETURNS TABLE(id_adelanto_salario INTEGER,id_empleado INTEGER,nombre_completo TEXT,cargo VARCHAR,monto NUMERIC,saldo NUMERIC,fecha TIMESTAMP)
LANGUAGE plpgsql AS $$
DECLARE v_id_sucursal INTEGER;
BEGIN
  SELECT id_sucursal INTO v_id_sucursal FROM public.planillas WHERE id_planilla=p_id_planilla;
  IF NOT FOUND THEN RAISE EXCEPTION 'La planilla % no existe', p_id_planilla; END IF;

  RETURN QUERY
  SELECT a.id_adelanto_salario,e.id_empleado,TRIM(COALESCE(pe.nombre,'')||' '||COALESCE(pe.apellido,'')),
         e.cargo::VARCHAR,a.monto,a.saldo,a.fecha
  FROM public.adelantos_salario a
  JOIN public.empleados e ON e.id_empleado=a.id_empleado
  JOIN public.personas pe ON pe.id_persona=e.id_persona
  JOIN public.detalle_planilla dp ON dp.id_empleado=e.id_empleado AND dp.id_planilla=p_id_planilla
  WHERE e.id_sucursal=v_id_sucursal AND e.estado=TRUE AND a.estado=TRUE AND COALESCE(a.saldo,0)>0
  ORDER BY a.fecha DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_aplicar_adelanto_a_planilla(
  p_id_adelanto_salario INTEGER,
  p_id_planilla INTEGER,
  p_monto_aplicado NUMERIC(12,2) DEFAULT NULL
)
RETURNS TABLE(id_adelanto_salario INTEGER,id_planilla INTEGER,id_empleado INTEGER,monto_aplicado NUMERIC,saldo_restante NUMERIC,neto_actualizado NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE v_id_empleado INTEGER; v_saldo_actual NUMERIC(12,2); v_estado_adelanto BOOLEAN; v_monto_aplicar NUMERIC(12,2); v_id_detalle_planilla INTEGER; v_neto_actualizado NUMERIC(12,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.planillas WHERE id_planilla=p_id_planilla) THEN
    RAISE EXCEPTION 'No existe la planilla %', p_id_planilla;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.adelantos_salario WHERE id_adelanto_salario=p_id_adelanto_salario) THEN
    RAISE EXCEPTION 'No existe el adelanto_salario %', p_id_adelanto_salario;
  END IF;

  SELECT id_empleado,saldo,estado INTO v_id_empleado,v_saldo_actual,v_estado_adelanto
  FROM public.adelantos_salario WHERE id_adelanto_salario=p_id_adelanto_salario;

  IF v_estado_adelanto IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Adelanto inactivo'; END IF;
  IF COALESCE(v_saldo_actual,0)<=0 THEN RAISE EXCEPTION 'Adelanto sin saldo'; END IF;

  SELECT id_detalle_planilla INTO v_id_detalle_planilla
  FROM public.detalle_planilla WHERE id_planilla=p_id_planilla AND id_empleado=v_id_empleado LIMIT 1;

  IF v_id_detalle_planilla IS NULL THEN RAISE EXCEPTION 'Empleado no pertenece a la planilla'; END IF;

  v_monto_aplicar:=COALESCE(p_monto_aplicado,v_saldo_actual);
  IF v_monto_aplicar IS NULL OR v_monto_aplicar<=0 THEN RAISE EXCEPTION 'Monto invalido'; END IF;
  IF v_monto_aplicar>v_saldo_actual THEN RAISE EXCEPTION 'Monto mayor al saldo'; END IF;

  INSERT INTO public.adelanto_aplicacion(id_planilla,id_adelanto_salario,monto_aplicado)
  VALUES (p_id_planilla,p_id_adelanto_salario,v_monto_aplicar);

  UPDATE public.adelantos_salario
  SET saldo=saldo-v_monto_aplicar,
      estado=CASE WHEN saldo-v_monto_aplicar<=0 THEN FALSE ELSE estado END
  WHERE id_adelanto_salario=p_id_adelanto_salario;

  v_neto_actualizado:=public.fn_recalcular_detalle_planilla(v_id_detalle_planilla);

  RETURN QUERY
  SELECT p_id_adelanto_salario,p_id_planilla,v_id_empleado,v_monto_aplicar,(v_saldo_actual-v_monto_aplicar),v_neto_actualizado;
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_listar_resumen_planilla_por_sucursal(p_id_planilla INTEGER)
RETURNS TABLE(id_planilla INTEGER,id_sucursal INTEGER,nombre_sucursal VARCHAR,fecha_creacion TIMESTAMP,id_estado_planilla INTEGER,estado_planilla VARCHAR,total_empleados BIGINT,total_salario_base NUMERIC,total_bonos NUMERIC,total_deducciones NUMERIC,total_adelantos_aplicados NUMERIC,total_neto_pagar NUMERIC)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.planillas WHERE id_planilla=p_id_planilla) THEN
    RAISE EXCEPTION 'La planilla % no existe', p_id_planilla;
  END IF;

  RETURN QUERY
  SELECT p.id_planilla,p.id_sucursal,s.nombre_sucursal::VARCHAR,p.fecha_creacion,p.id_estado_planilla,ep.descripcion::VARCHAR,
         COUNT(dp.id_detalle_planilla),COALESCE(SUM(dp.salario_base),0),COALESCE(SUM(dp.total_bonos),0),COALESCE(SUM(dp.total_deducciones),0),
         COALESCE((SELECT SUM(aa.monto_aplicado) FROM public.adelanto_aplicacion aa WHERE aa.id_planilla=p.id_planilla),0),
         COALESCE(SUM(dp.neto_pagar),0)
  FROM public.planillas p
  LEFT JOIN public.sucursales s ON s.id_sucursal=p.id_sucursal
  LEFT JOIN public.estado_planilla ep ON ep.id_estado_planilla=p.id_estado_planilla
  LEFT JOIN public.detalle_planilla dp ON dp.id_planilla=p.id_planilla
  WHERE p.id_planilla=p_id_planilla
  GROUP BY p.id_planilla,p.id_sucursal,s.nombre_sucursal,p.fecha_creacion,p.id_estado_planilla,ep.descripcion;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_registrar_movimiento_planilla(
  p_id_detalle_planilla INTEGER,
  p_tipo_movimiento VARCHAR,
  p_concepto VARCHAR,
  p_monto NUMERIC(12,2),
  p_observacion VARCHAR DEFAULT NULL
)
RETURNS TABLE(id_movimiento_planilla INTEGER,id_detalle_planilla INTEGER,tipo_movimiento VARCHAR,concepto VARCHAR,monto NUMERIC,neto_actualizado NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE v_id_movimiento_planilla INTEGER; v_neto_actualizado NUMERIC(12,2);
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.detalle_planilla dp
    WHERE dp.id_detalle_planilla=p_id_detalle_planilla
  ) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;
  IF UPPER(TRIM(p_tipo_movimiento)) NOT IN ('BONO','DEDUCCION') THEN RAISE EXCEPTION 'Tipo invalido'; END IF;
  IF p_concepto IS NULL OR TRIM(p_concepto)='' THEN RAISE EXCEPTION 'Concepto obligatorio'; END IF;
  IF p_monto IS NULL OR p_monto<=0 THEN RAISE EXCEPTION 'Monto invalido'; END IF;

  INSERT INTO public.movimiento_planilla(id_detalle_planilla,tipo_movimiento,concepto,monto,observacion)
  VALUES (p_id_detalle_planilla,UPPER(TRIM(p_tipo_movimiento)),TRIM(p_concepto),p_monto,NULLIF(TRIM(p_observacion),''))
  RETURNING public.movimiento_planilla.id_movimiento_planilla INTO v_id_movimiento_planilla;

  v_neto_actualizado:=public.fn_recalcular_detalle_planilla(p_id_detalle_planilla);
  RETURN QUERY SELECT v_id_movimiento_planilla,p_id_detalle_planilla,UPPER(TRIM(p_tipo_movimiento))::VARCHAR,TRIM(p_concepto)::VARCHAR,p_monto,v_neto_actualizado;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_movimientos_planilla(p_id_detalle_planilla INTEGER)
RETURNS TABLE(id_movimiento_planilla INTEGER,id_detalle_planilla INTEGER,tipo_movimiento VARCHAR,concepto VARCHAR,monto NUMERIC,observacion VARCHAR,fecha_registro TIMESTAMP)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.detalle_planilla WHERE id_detalle_planilla=p_id_detalle_planilla) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;

  RETURN QUERY
  SELECT id_movimiento_planilla,id_detalle_planilla,tipo_movimiento::VARCHAR,concepto::VARCHAR,monto,observacion::VARCHAR,fecha_registro
  FROM public.movimiento_planilla
  WHERE id_detalle_planilla=p_id_detalle_planilla AND estado=TRUE
  ORDER BY fecha_registro DESC,id_movimiento_planilla DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_movimientos_planilla_detalle(p_id_detalle_planilla INTEGER)
RETURNS TABLE(id_movimiento_planilla INTEGER,id_detalle_planilla INTEGER,id_planilla INTEGER,id_empleado INTEGER,nombre_completo TEXT,nombre_sucursal VARCHAR,cargo VARCHAR,salario_base NUMERIC,neto_pagar NUMERIC,tipo_movimiento VARCHAR,concepto VARCHAR,monto NUMERIC,observacion VARCHAR,fecha_registro TIMESTAMP)
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.detalle_planilla WHERE id_detalle_planilla=p_id_detalle_planilla) THEN
    RAISE EXCEPTION 'No existe detalle_planilla %', p_id_detalle_planilla;
  END IF;

  RETURN QUERY
  SELECT mp.id_movimiento_planilla,mp.id_detalle_planilla,dp.id_planilla,e.id_empleado,
         TRIM(COALESCE(p.nombre,'')||' '||COALESCE(p.apellido,'')) AS nombre_completo,
         s.nombre_sucursal::VARCHAR,e.cargo::VARCHAR,dp.salario_base,dp.neto_pagar,
         mp.tipo_movimiento::VARCHAR,mp.concepto::VARCHAR,mp.monto,mp.observacion::VARCHAR,mp.fecha_registro
  FROM public.movimiento_planilla mp
  JOIN public.detalle_planilla dp ON dp.id_detalle_planilla=mp.id_detalle_planilla
  JOIN public.empleados e ON e.id_empleado=dp.id_empleado
  JOIN public.personas p ON p.id_persona=e.id_persona
  LEFT JOIN public.sucursales s ON s.id_sucursal=e.id_sucursal
  WHERE mp.id_detalle_planilla=p_id_detalle_planilla AND mp.estado=TRUE
  ORDER BY mp.fecha_registro DESC,mp.id_movimiento_planilla DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_anular_movimiento_planilla(p_id_movimiento_planilla INTEGER)
RETURNS TABLE(id_movimiento_planilla INTEGER,id_detalle_planilla INTEGER,neto_actualizado NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE v_id_detalle_planilla INTEGER; v_neto_actualizado NUMERIC(12,2);
BEGIN
  SELECT id_detalle_planilla INTO v_id_detalle_planilla
  FROM public.movimiento_planilla
  WHERE id_movimiento_planilla=p_id_movimiento_planilla AND estado=TRUE;

  IF NOT FOUND THEN RAISE EXCEPTION 'No existe movimiento activo %', p_id_movimiento_planilla; END IF;

  UPDATE public.movimiento_planilla SET estado=FALSE WHERE id_movimiento_planilla=p_id_movimiento_planilla;
  v_neto_actualizado:=public.fn_recalcular_detalle_planilla(v_id_detalle_planilla);

  RETURN QUERY SELECT p_id_movimiento_planilla,v_id_detalle_planilla,v_neto_actualizado;
END;
$$;
CREATE OR REPLACE FUNCTION public.fn_actualizar_estado_planilla(
  p_id_planilla INTEGER,
  p_id_estado_planilla INTEGER,
  p_recalcular BOOLEAN DEFAULT TRUE
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.planillas WHERE id_planilla=p_id_planilla) THEN
    RAISE EXCEPTION 'No existe planilla %', p_id_planilla;
  END IF;

  IF p_recalcular THEN
    PERFORM public.fn_recalcular_detalle_planilla(dp.id_detalle_planilla)
    FROM public.detalle_planilla dp WHERE dp.id_planilla=p_id_planilla;
  END IF;

  UPDATE public.planillas
  SET id_estado_planilla=p_id_estado_planilla
  WHERE id_planilla=p_id_planilla;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_registrar_auditoria_planilla(
  p_accion VARCHAR,
  p_entidad VARCHAR,
  p_id_referencia INTEGER,
  p_descripcion VARCHAR,
  p_usuario_accion VARCHAR DEFAULT NULL
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_id_auditoria INTEGER;
BEGIN
  INSERT INTO public.auditoria_planilla(accion,entidad,id_referencia,descripcion,usuario_accion)
  VALUES (UPPER(TRIM(p_accion)),UPPER(TRIM(p_entidad)),p_id_referencia,p_descripcion,NULLIF(TRIM(p_usuario_accion),''))
  RETURNING id_auditoria_planilla INTO v_id_auditoria;
  RETURN v_id_auditoria;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_anular_planilla_completa(
  p_id_planilla INTEGER,
  p_usuario_accion VARCHAR DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_id_estado_anulada INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.planillas WHERE id_planilla=p_id_planilla) THEN
    RAISE EXCEPTION 'No existe la planilla %', p_id_planilla;
  END IF;

  SELECT id_estado_planilla INTO v_id_estado_anulada
  FROM public.estado_planilla
  WHERE UPPER(TRIM(descripcion))='ANULADA'
  LIMIT 1;

  IF v_id_estado_anulada IS NULL THEN
    RAISE EXCEPTION 'No existe estado ANULADA';
  END IF;

  UPDATE public.adelantos_salario a
  SET saldo=a.saldo+x.total_aplicado, estado=TRUE
  FROM (
    SELECT id_adelanto_salario, SUM(monto_aplicado) AS total_aplicado
    FROM public.adelanto_aplicacion
    WHERE id_planilla=p_id_planilla
    GROUP BY id_adelanto_salario
  ) x
  WHERE a.id_adelanto_salario=x.id_adelanto_salario;

  DELETE FROM public.adelanto_aplicacion WHERE id_planilla=p_id_planilla;

  UPDATE public.planillas
  SET id_estado_planilla=v_id_estado_anulada
  WHERE id_planilla=p_id_planilla;

  PERFORM public.fn_registrar_auditoria_planilla('ANULAR','PLANILLA',p_id_planilla,'Planilla anulada y adelantos revertidos',p_usuario_accion);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_planilla_completa_json(p_id_planilla INTEGER)
RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE v_result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.planillas WHERE id_planilla=p_id_planilla) THEN
    RAISE EXCEPTION 'No existe la planilla %', p_id_planilla;
  END IF;

  SELECT json_build_object(
    'encabezado', (
      SELECT row_to_json(x) FROM (
        SELECT p.id_planilla,p.fecha_creacion,p.id_estado_planilla,ep.descripcion AS estado_planilla,p.id_sucursal,s.nombre_sucursal
        FROM public.planillas p
        LEFT JOIN public.estado_planilla ep ON ep.id_estado_planilla=p.id_estado_planilla
        LEFT JOIN public.sucursales s ON s.id_sucursal=p.id_sucursal
        WHERE p.id_planilla=p_id_planilla
      ) x
    ),
    'resumen', (
      SELECT row_to_json(r) FROM (
        SELECT * FROM public.fn_listar_resumen_planilla_por_sucursal(p_id_planilla)
      ) r
    ),
    'detalle', (
      SELECT COALESCE(json_agg(d), '[]'::json)
      FROM (SELECT * FROM public.fn_listar_detalle_planilla(p_id_planilla)) d
    ),
    'adelantos_aplicados', (
      SELECT COALESCE(json_agg(a), '[]'::json)
      FROM (
        SELECT aa.id_adelanto_aplicacion,aa.id_planilla,aa.id_adelanto_salario,aa.monto_aplicado
        FROM public.adelanto_aplicacion aa
        WHERE aa.id_planilla=p_id_planilla
      ) a
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_auditar_movimiento_planilla(
  p_id_movimiento_planilla INTEGER,
  p_accion VARCHAR,
  p_usuario_accion VARCHAR DEFAULT NULL
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_descripcion VARCHAR(255);
BEGIN
  SELECT CONCAT('Movimiento planilla ',tipo_movimiento,' - ',concepto,' - monto: ',monto)
  INTO v_descripcion
  FROM public.movimiento_planilla
  WHERE id_movimiento_planilla=p_id_movimiento_planilla;

  IF v_descripcion IS NULL THEN RAISE EXCEPTION 'No existe movimiento_planilla %', p_id_movimiento_planilla; END IF;

  RETURN public.fn_registrar_auditoria_planilla(p_accion,'MOVIMIENTO_PLANILLA',p_id_movimiento_planilla,v_descripcion,p_usuario_accion);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_auditar_adelanto_aplicado(
  p_id_adelanto_salario INTEGER,
  p_id_planilla INTEGER,
  p_monto NUMERIC,
  p_usuario_accion VARCHAR DEFAULT NULL
)
RETURNS INTEGER LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.fn_registrar_auditoria_planilla(
    'APLICAR','ADELANTO_PLANILLA',p_id_planilla,
    CONCAT('Adelanto aplicado. Adelanto: ',p_id_adelanto_salario,', Planilla: ',p_id_planilla,', Monto aplicado: ',p_monto),
    p_usuario_accion
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_listar_auditoria_planilla(p_entidad VARCHAR DEFAULT NULL)
RETURNS TABLE(id_auditoria_planilla INTEGER,fecha_registro TIMESTAMP,accion VARCHAR,entidad VARCHAR,id_referencia INTEGER,descripcion VARCHAR,usuario_accion VARCHAR)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT id_auditoria_planilla,fecha_registro,accion,entidad,id_referencia,descripcion,usuario_accion
  FROM public.auditoria_planilla
  WHERE p_entidad IS NULL OR UPPER(TRIM(entidad))=UPPER(TRIM(p_entidad))
  ORDER BY fecha_registro DESC,id_auditoria_planilla DESC;
END;
$$;

INSERT INTO permisos (nombre_permiso)
SELECT nombre_permiso FROM (
  VALUES
    ('PLANILLAS_MODULO_VER'),('PLANILLAS_LISTADO_VER'),('PLANILLAS_DETALLE_VER'),
    ('PLANILLAS_GENERAR'),('PLANILLAS_RECALCULAR'),('PLANILLAS_ADELANTOS_APLICAR'),
    ('PLANILLAS_MOVIMIENTO_REGISTRAR'),('PLANILLAS_MOVIMIENTO_ANULAR'),
    ('PLANILLAS_CERRAR'),('PLANILLAS_PAGAR'),('PLANILLAS_ANULAR'),('PLANILLAS_AUDITORIA_VER')
) AS nuevos(nombre_permiso)
WHERE NOT EXISTS (SELECT 1 FROM permisos p WHERE p.nombre_permiso=nuevos.nombre_permiso);

CREATE UNIQUE INDEX IF NOT EXISTS ux_permisos_nombre_permiso ON permisos(nombre_permiso);

-- Verificacion manual (ejecutar aparte):
-- SELECT proname FROM pg_proc WHERE proname ILIKE 'fn_%planilla%' ORDER BY proname;
-- SELECT * FROM fn_listar_planillas_por_sucursal();
-- SELECT fn_generar_planilla_mensual_por_sucursal(1);
