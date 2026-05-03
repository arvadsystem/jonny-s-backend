-- Extras configurables para menu publico.
-- Permite que el catalogo publique extras con costo, por ejemplo "Extra bacon" en hamburguesas.

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

INSERT INTO public.menu_extras (codigo, nombre, precio_adicional, orden, estado)
VALUES ('extra_bacon', 'Extra bacon', 30.00, 10, true)
ON CONFLICT (codigo) DO UPDATE
SET
  nombre = EXCLUDED.nombre,
  precio_adicional = EXCLUDED.precio_adicional,
  orden = EXCLUDED.orden,
  estado = true,
  fecha_actualizacion = NOW();

WITH extra AS (
  SELECT id_extra
  FROM public.menu_extras
  WHERE codigo = 'extra_bacon'
),
hamburguesas AS (
  SELECT r.id_receta
  FROM public.recetas r
  LEFT JOIN public.tipo_departamento td
    ON td.id_tipo_departamento = r.id_tipo_departamento
  WHERE COALESCE(r.estado, true) = true
    AND (
      lower(COALESCE(r.nombre_receta, '')) LIKE '%hamburguesa%'
      OR lower(COALESCE(r.descripcion, '')) LIKE '%hamburguesa%'
      OR lower(COALESCE(td.nombre_departamento, '')) LIKE '%hamburguesa%'
      OR lower(COALESCE(r.nombre_receta, '')) LIKE '%burger%'
      OR lower(COALESCE(r.descripcion, '')) LIKE '%burger%'
      OR lower(COALESCE(td.nombre_departamento, '')) LIKE '%burger%'
    )
)
INSERT INTO public.menu_extra_receta (id_extra, id_receta, orden, estado)
SELECT extra.id_extra, hamburguesas.id_receta, 10, true
FROM extra
CROSS JOIN hamburguesas
ON CONFLICT (id_extra, id_receta) DO UPDATE
SET
  estado = true,
  orden = EXCLUDED.orden,
  fecha_actualizacion = NOW();
