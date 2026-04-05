BEGIN;

-- AM: tabla base del submodulo Inventario > Mobiliario (v1) con asignacion obligatoria a empleado.
CREATE TABLE IF NOT EXISTS public.mobiliario (
  id_mobiliario integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre_bien text NOT NULL,
  id_empleado integer NOT NULL,
  fecha_asignacion date NOT NULL,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone NOT NULL DEFAULT NOW(),
  updated_at timestamp without time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_mobiliario_empleado
    FOREIGN KEY (id_empleado) REFERENCES public.empleados(id_empleado)
);

-- AM: indices minimos para busqueda operativa por empleado, estado y fecha de asignacion.
CREATE INDEX IF NOT EXISTS idx_mobiliario_id_empleado
  ON public.mobiliario (id_empleado);

CREATE INDEX IF NOT EXISTS idx_mobiliario_activo
  ON public.mobiliario (activo);

CREATE INDEX IF NOT EXISTS idx_mobiliario_fecha_asignacion
  ON public.mobiliario (fecha_asignacion);

CREATE INDEX IF NOT EXISTS idx_mobiliario_activo_empleado
  ON public.mobiliario (activo, id_empleado);

-- AM: funcion dedicada para refrescar updated_at en cada actualizacion del registro.
CREATE OR REPLACE FUNCTION public.fn_mobiliario_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mobiliario_touch_updated_at ON public.mobiliario;
CREATE TRIGGER trg_mobiliario_touch_updated_at
BEFORE UPDATE ON public.mobiliario
FOR EACH ROW
EXECUTE FUNCTION public.fn_mobiliario_touch_updated_at();

-- AM: permisos del submodulo Mobiliario (v1).
INSERT INTO public.permisos (nombre_permiso)
VALUES
  ('INVENTARIO_MOBILIARIO_VER'),
  ('INVENTARIO_MOBILIARIO_CREAR'),
  ('INVENTARIO_MOBILIARIO_EDITAR'),
  ('INVENTARIO_MOBILIARIO_ESTADO_CAMBIAR')
ON CONFLICT (nombre_permiso) DO NOTHING;

-- AM: seed inicial solo para super_admin segun decision funcional cerrada.
INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
INNER JOIN public.permisos p
  ON p.nombre_permiso IN (
    'INVENTARIO_MOBILIARIO_VER',
    'INVENTARIO_MOBILIARIO_CREAR',
    'INVENTARIO_MOBILIARIO_EDITAR',
    'INVENTARIO_MOBILIARIO_ESTADO_CAMBIAR'
  )
WHERE lower(trim(r.nombre)) IN ('super_admin', 'super admin')
ON CONFLICT DO NOTHING;

COMMIT;
