-- Seed operativo de tipo_departamento para modulo MENU.
-- Objetivo: mantener IDs estables que hoy usa backend/frontend (12-15 productos, 19 combos)
-- y usar orden_menu visual desde 1 en adelante.
BEGIN;

INSERT INTO public.tipo_departamento (
  id_tipo_departamento,
  nombre_departamento,
  descripcion,
  estado,
  orden_menu
)
VALUES
  (16, 'Tacos de Birria', 'Categoria de recetas de tacos de birria.', true, 1),
  (17, 'Hot dogs', 'Categoria de recetas de hot dogs.', true, 2),
  (18, 'Hamburguesas', 'Categoria de recetas de hamburguesas.', true, 3),
  (19, 'Combos', 'Categoria reservada para combos.', true, 4),
  (20, 'Alitas y tenders', 'Categoria de recetas de alitas y tenders.', true, 5),
  (21, 'Jugos naturales', 'Categoria de recetas de jugos naturales.', true, 6),
  (13, 'Refrescos / Agua', 'Productos de menu tipo refresco y agua.', true, 7),
  (12, 'Cervezas', 'Productos de menu tipo cerveza.', true, 8),
  (14, 'Helados Sarita', 'Productos de menu de helados.', true, 9),
  (15, 'Snacks', 'Productos de menu tipo snacks.', true, 10)
ON CONFLICT (id_tipo_departamento)
DO UPDATE SET
  nombre_departamento = EXCLUDED.nombre_departamento,
  descripcion = EXCLUDED.descripcion,
  estado = EXCLUDED.estado,
  orden_menu = EXCLUDED.orden_menu;

-- Remueve fila legacy de salsas si existe.
DELETE FROM public.tipo_departamento
WHERE id_tipo_departamento = 11;

-- Ajusta la secuencia para evitar colisiones en futuras inserciones sin ID explicito.
SELECT setval(
  'public.tipo_departamento_id_tipo_departamento_seq',
  (SELECT COALESCE(MAX(id_tipo_departamento), 1) FROM public.tipo_departamento),
  true
);

COMMIT;
