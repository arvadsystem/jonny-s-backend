-- Renumera tipo_departamento a IDs secuenciales 1..10
-- y actualiza todas las referencias id_tipo_departamento en tablas del esquema public.
-- Ejecutar en una sola transaccion.

BEGIN;

CREATE TEMP TABLE tmp_tipo_departamento_map (
  old_id integer PRIMARY KEY,
  new_id integer UNIQUE NOT NULL,
  nombre_final varchar(50) NOT NULL,
  descripcion_final varchar(50) NOT NULL,
  orden_final integer NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_tipo_departamento_map (
  old_id,
  new_id,
  nombre_final,
  descripcion_final,
  orden_final
)
VALUES
  (16, 1, 'Tacos de birria', 'Categoria de recetas de tacos de birria.', 1),
  (17, 2, 'Hot dogs', 'Categoria de recetas de hot dogs.', 2),
  (18, 3, 'Hamburguesas', 'Categoria de recetas de hamburguesas.', 3),
  (19, 4, 'Combos', 'Categoria reservada para combos.', 4),
  (20, 5, 'Alitas y tenders', 'Categoria de recetas de alitas y tenders.', 5),
  (21, 6, 'Jugos naturales', 'Categoria de recetas de jugos naturales.', 6),
  (13, 7, 'Refrescos / Agua', 'Productos de menu tipo refresco y agua.', 7),
  (12, 8, 'Cervezas', 'Productos de menu tipo cerveza.', 8),
  (14, 9, 'Helados Sarita', 'Productos de menu de helados.', 9),
  (15, 10, 'Snacks', 'Productos de menu tipo snacks.', 10);

DO $$
DECLARE
  missing_ids text;
  occupied_ids text;
BEGIN
  SELECT string_agg(m.old_id::text, ', ' ORDER BY m.old_id)
    INTO missing_ids
  FROM tmp_tipo_departamento_map m
  LEFT JOIN public.tipo_departamento td
    ON td.id_tipo_departamento = m.old_id
  WHERE td.id_tipo_departamento IS NULL;

  IF missing_ids IS NOT NULL THEN
    RAISE EXCEPTION 'No existen IDs esperados en tipo_departamento: %', missing_ids;
  END IF;

  SELECT string_agg(td.id_tipo_departamento::text, ', ' ORDER BY td.id_tipo_departamento)
    INTO occupied_ids
  FROM public.tipo_departamento td
  WHERE td.id_tipo_departamento BETWEEN 1 AND 10;

  IF occupied_ids IS NOT NULL THEN
    RAISE EXCEPTION 'Ya existen IDs 1..10 en tipo_departamento (%). Revisa antes de renumerar.', occupied_ids;
  END IF;
END
$$;

-- Evita colision por nombre durante insercion de nuevos IDs.
UPDATE public.tipo_departamento td
SET nombre_departamento = CONCAT(
  LEFT(COALESCE(td.nombre_departamento, 'dep'), 35),
  ' [legacy-',
  td.id_tipo_departamento::text,
  ']'
)
WHERE td.id_tipo_departamento IN (SELECT old_id FROM tmp_tipo_departamento_map);

-- Inserta filas nuevas con IDs secuenciales 1..10.
INSERT INTO public.tipo_departamento (
  id_tipo_departamento,
  nombre_departamento,
  descripcion,
  estado,
  orden_menu
)
SELECT
  m.new_id,
  m.nombre_final,
  m.descripcion_final,
  COALESCE(td.estado, true),
  m.orden_final
FROM tmp_tipo_departamento_map m
INNER JOIN public.tipo_departamento td
  ON td.id_tipo_departamento = m.old_id
ORDER BY m.new_id;

-- Actualiza todas las columnas id_tipo_departamento en tablas public (excepto la tabla maestra).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT
      c.table_schema,
      c.table_name,
      c.column_name
    FROM information_schema.columns c
    INNER JOIN information_schema.tables t
      ON t.table_schema = c.table_schema
     AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'id_tipo_departamento'
      AND c.table_name <> 'tipo_departamento'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format(
      'UPDATE %I.%I t
       SET %I = m.new_id
       FROM tmp_tipo_departamento_map m
       WHERE t.%I = m.old_id;',
      r.table_schema,
      r.table_name,
      r.column_name,
      r.column_name
    );
  END LOOP;
END
$$;

-- Elimina IDs legacy y categoria Salsas (si existe).
DELETE FROM public.tipo_departamento td
USING tmp_tipo_departamento_map m
WHERE td.id_tipo_departamento = m.old_id;

DELETE FROM public.tipo_departamento
WHERE id_tipo_departamento = 11
   OR lower(trim(nombre_departamento)) = 'salsas';

-- Reasegura nombres/orden oficial en los IDs nuevos.
UPDATE public.tipo_departamento td
SET
  nombre_departamento = m.nombre_final,
  descripcion = m.descripcion_final,
  estado = true,
  orden_menu = m.orden_final
FROM tmp_tipo_departamento_map m
WHERE td.id_tipo_departamento = m.new_id;

-- Ajusta check constraint de recetas a los nuevos IDs de productos (7,8,9,10).
ALTER TABLE public.recetas
  DROP CONSTRAINT IF EXISTS recetas_departamento_valido;

ALTER TABLE public.recetas
  ADD CONSTRAINT recetas_departamento_valido CHECK (
    (COALESCE(estado, true) = false)
    OR (id_tipo_departamento <> ALL (ARRAY[7, 8, 9, 10]))
  );

-- Ajusta secuencia del PK.
SELECT setval(
  'public.tipo_departamento_id_tipo_departamento_seq',
  (SELECT COALESCE(MAX(id_tipo_departamento), 1) FROM public.tipo_departamento),
  true
);

COMMIT;

-- Verificacion sugerida:
-- SELECT id_tipo_departamento, nombre_departamento, orden_menu
-- FROM public.tipo_departamento
-- ORDER BY id_tipo_departamento;
