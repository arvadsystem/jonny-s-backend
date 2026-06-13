CREATE TABLE IF NOT EXISTS public.menu_receta_almacenes (
  id_receta_almacen SERIAL PRIMARY KEY,
  id_receta INTEGER NOT NULL REFERENCES public.recetas(id_receta),
  id_almacen INTEGER NOT NULL REFERENCES public.almacenes(id_almacen),
  estado BOOLEAN NOT NULL DEFAULT true,
  fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_menu_receta_almacenes UNIQUE (id_receta, id_almacen)
);

CREATE TABLE IF NOT EXISTS public.menu_combo_almacenes (
  id_combo_almacen SERIAL PRIMARY KEY,
  id_combo INTEGER NOT NULL REFERENCES public.combos(id_combo),
  id_almacen INTEGER NOT NULL REFERENCES public.almacenes(id_almacen),
  estado BOOLEAN NOT NULL DEFAULT true,
  fecha_creacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_menu_combo_almacenes UNIQUE (id_combo, id_almacen)
);

CREATE INDEX IF NOT EXISTS idx_menu_receta_almacenes_receta
  ON public.menu_receta_almacenes (id_receta);

CREATE INDEX IF NOT EXISTS idx_menu_receta_almacenes_almacen
  ON public.menu_receta_almacenes (id_almacen);

CREATE INDEX IF NOT EXISTS idx_menu_receta_almacenes_estado_receta_almacen
  ON public.menu_receta_almacenes (estado, id_receta, id_almacen);

CREATE INDEX IF NOT EXISTS idx_menu_combo_almacenes_combo
  ON public.menu_combo_almacenes (id_combo);

CREATE INDEX IF NOT EXISTS idx_menu_combo_almacenes_almacen
  ON public.menu_combo_almacenes (id_almacen);

CREATE INDEX IF NOT EXISTS idx_menu_combo_almacenes_estado_combo_almacen
  ON public.menu_combo_almacenes (estado, id_combo, id_almacen);
