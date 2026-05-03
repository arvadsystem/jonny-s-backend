BEGIN;

CREATE TABLE IF NOT EXISTS public.sucursales_horarios (
  id_horario BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL,
  dia_semana SMALLINT NOT NULL,
  hora_inicio TIME,
  hora_final TIME,
  cerrado BOOLEAN NOT NULL DEFAULT false,
  estado BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sucursales_fechas_especiales (
  id_fecha_especial BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL,
  fecha DATE NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  descripcion VARCHAR(200),
  cerrado BOOLEAN NOT NULL DEFAULT true,
  hora_inicio TIME,
  hora_final TIME,
  estado BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_horarios_id_sucursal_fkey'
      AND conrelid = 'public.sucursales_horarios'::regclass
  ) THEN
    ALTER TABLE public.sucursales_horarios
      ADD CONSTRAINT sucursales_horarios_id_sucursal_fkey
      FOREIGN KEY (id_sucursal)
      REFERENCES public.sucursales(id_sucursal)
      ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_fechas_especiales_id_sucursal_fkey'
      AND conrelid = 'public.sucursales_fechas_especiales'::regclass
  ) THEN
    ALTER TABLE public.sucursales_fechas_especiales
      ADD CONSTRAINT sucursales_fechas_especiales_id_sucursal_fkey
      FOREIGN KEY (id_sucursal)
      REFERENCES public.sucursales(id_sucursal)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_horarios_dia_semana_chk'
      AND conrelid = 'public.sucursales_horarios'::regclass
  ) THEN
    ALTER TABLE public.sucursales_horarios
      ADD CONSTRAINT sucursales_horarios_dia_semana_chk
      CHECK (dia_semana BETWEEN 1 AND 7);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_horarios_hora_cierre_chk'
      AND conrelid = 'public.sucursales_horarios'::regclass
  ) THEN
    ALTER TABLE public.sucursales_horarios
      ADD CONSTRAINT sucursales_horarios_hora_cierre_chk
      CHECK (
        (cerrado = true AND hora_inicio IS NULL AND hora_final IS NULL)
        OR
        (cerrado = false AND hora_inicio IS NOT NULL AND hora_final IS NOT NULL AND hora_final > hora_inicio)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_horarios_sucursal_dia_unique'
      AND conrelid = 'public.sucursales_horarios'::regclass
  ) THEN
    ALTER TABLE public.sucursales_horarios
      ADD CONSTRAINT sucursales_horarios_sucursal_dia_unique
      UNIQUE (id_sucursal, dia_semana);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_fechas_especiales_tipo_chk'
      AND conrelid = 'public.sucursales_fechas_especiales'::regclass
  ) THEN
    ALTER TABLE public.sucursales_fechas_especiales
      ADD CONSTRAINT sucursales_fechas_especiales_tipo_chk
      CHECK (tipo IN ('FERIADO', 'CIERRE_ESPECIAL', 'HORARIO_ESPECIAL'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_fechas_especiales_hora_cierre_chk'
      AND conrelid = 'public.sucursales_fechas_especiales'::regclass
  ) THEN
    ALTER TABLE public.sucursales_fechas_especiales
      ADD CONSTRAINT sucursales_fechas_especiales_hora_cierre_chk
      CHECK (
        (cerrado = true AND hora_inicio IS NULL AND hora_final IS NULL)
        OR
        (cerrado = false AND hora_inicio IS NOT NULL AND hora_final IS NOT NULL AND hora_final > hora_inicio)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sucursales_fechas_especiales_sucursal_fecha_unique'
      AND conrelid = 'public.sucursales_fechas_especiales'::regclass
  ) THEN
    ALTER TABLE public.sucursales_fechas_especiales
      ADD CONSTRAINT sucursales_fechas_especiales_sucursal_fecha_unique
      UNIQUE (id_sucursal, fecha);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sucursales_horarios_sucursal
  ON public.sucursales_horarios (id_sucursal);

CREATE INDEX IF NOT EXISTS idx_sucursales_horarios_dia
  ON public.sucursales_horarios (dia_semana);

CREATE INDEX IF NOT EXISTS idx_sucursales_fechas_especiales_sucursal
  ON public.sucursales_fechas_especiales (id_sucursal);

CREATE INDEX IF NOT EXISTS idx_sucursales_fechas_especiales_fecha
  ON public.sucursales_fechas_especiales (fecha);

CREATE INDEX IF NOT EXISTS idx_sucursales_fechas_especiales_tipo
  ON public.sucursales_fechas_especiales (tipo);

CREATE OR REPLACE FUNCTION public.fn_set_actualizado_en()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_sucursales_horarios_set_actualizado_en'
      AND tgrelid = 'public.sucursales_horarios'::regclass
  ) THEN
    CREATE TRIGGER trg_sucursales_horarios_set_actualizado_en
      BEFORE UPDATE ON public.sucursales_horarios
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_actualizado_en();
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_sucursales_fechas_especiales_set_actualizado_en'
      AND tgrelid = 'public.sucursales_fechas_especiales'::regclass
  ) THEN
    CREATE TRIGGER trg_sucursales_fechas_especiales_set_actualizado_en
      BEFORE UPDATE ON public.sucursales_fechas_especiales
      FOR EACH ROW
      EXECUTE FUNCTION public.fn_set_actualizado_en();
  END IF;
END $$;

INSERT INTO public.permisos (id_permiso, nombre_permiso)
SELECT nextval('public.permisos_id_permiso_seq'), 'SUCURSALES_HORARIOS_GESTIONAR'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.permisos
  WHERE nombre_permiso = 'SUCURSALES_HORARIOS_GESTIONAR'
);

COMMIT;
