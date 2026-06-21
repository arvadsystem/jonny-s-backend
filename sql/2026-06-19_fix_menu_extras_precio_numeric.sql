-- Fuerza precio_adicional a NUMERIC(10,2) para extras y corrige residuos de precision.
ALTER TABLE public.menu_extras
  ALTER COLUMN precio_adicional TYPE NUMERIC(10,2)
  USING ROUND(COALESCE(precio_adicional, 0)::numeric, 2);

ALTER TABLE public.menu_extras
  ALTER COLUMN precio_adicional SET DEFAULT 0;
