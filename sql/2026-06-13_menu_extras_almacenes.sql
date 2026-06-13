BEGIN;

CREATE TABLE IF NOT EXISTS public.menu_extra_almacenes (
  id_extra_almacen SERIAL PRIMARY KEY,
  id_extra INTEGER NOT NULL REFERENCES public.menu_extras(id_extra),
  id_almacen INTEGER NOT NULL REFERENCES public.almacenes(id_almacen),
  estado BOOLEAN NOT NULL DEFAULT true,
  fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT menu_extra_almacenes_unique UNIQUE (id_extra, id_almacen)
);

CREATE INDEX IF NOT EXISTS idx_menu_extra_almacenes_id_extra
  ON public.menu_extra_almacenes (id_extra);

CREATE INDEX IF NOT EXISTS idx_menu_extra_almacenes_id_almacen
  ON public.menu_extra_almacenes (id_almacen);

CREATE INDEX IF NOT EXISTS idx_menu_extra_almacenes_estado_extra_almacen
  ON public.menu_extra_almacenes (estado, id_extra, id_almacen);

COMMIT;

-- Compatibilidad de datos existentes:
-- Este cambio NO asigna extras legacy automaticamente para evitar errores funcionales.
-- Si QA necesita una carga masiva temporal, ejecutar un script separado y revisado.
