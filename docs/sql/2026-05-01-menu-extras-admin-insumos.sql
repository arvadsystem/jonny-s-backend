-- Submodulo administrativo de extras del menu.
-- Agrega relacion opcional a insumo/unidad para que extras como bacon, doble queso
-- o doble carne puedan tener precio editable y consumo de inventario definido.

CREATE TABLE IF NOT EXISTS public.menu_extras (
  id_extra SERIAL PRIMARY KEY,
  codigo VARCHAR(80) NOT NULL UNIQUE,
  nombre VARCHAR(120) NOT NULL,
  precio_adicional NUMERIC(10,2) NOT NULL DEFAULT 0,
  orden INTEGER NOT NULL DEFAULT 0,
  estado BOOLEAN NOT NULL DEFAULT true,
  fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT menu_extras_precio_adicional_non_negative_chk
    CHECK (precio_adicional >= 0)
);

ALTER TABLE public.menu_extras
  ADD COLUMN IF NOT EXISTS id_insumo INTEGER NULL REFERENCES public.insumos(id_insumo),
  ADD COLUMN IF NOT EXISTS cant NUMERIC(12,4) NULL,
  ADD COLUMN IF NOT EXISTS id_unidad_medida INTEGER NULL REFERENCES public.unidades_medida(id_unidad_medida);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'menu_extras_cant_positive_chk'
  ) THEN
    ALTER TABLE public.menu_extras
      ADD CONSTRAINT menu_extras_cant_positive_chk
      CHECK (cant IS NULL OR cant > 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.menu_extra_receta (
  id_extra_receta SERIAL PRIMARY KEY,
  id_extra INTEGER NOT NULL REFERENCES public.menu_extras(id_extra),
  id_receta INTEGER NOT NULL REFERENCES public.recetas(id_receta),
  orden INTEGER NOT NULL DEFAULT 0,
  estado BOOLEAN NOT NULL DEFAULT true,
  fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT menu_extra_receta_unique_active UNIQUE (id_extra, id_receta)
);

CREATE INDEX IF NOT EXISTS idx_menu_extra_receta_id_receta
  ON public.menu_extra_receta(id_receta)
  WHERE estado = true;

