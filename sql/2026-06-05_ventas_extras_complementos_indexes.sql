CREATE INDEX IF NOT EXISTS ix_menu_extra_receta_receta_extra_activos
  ON public.menu_extra_receta (id_receta, id_extra)
  WHERE COALESCE(estado, true) = true;
