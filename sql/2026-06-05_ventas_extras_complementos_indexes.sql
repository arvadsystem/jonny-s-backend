-- Indices para acelerar validacion previa a RPC en pedidos pendientes.
-- No ejecutar automaticamente: aplicar en ventana controlada de migraciones.

CREATE INDEX IF NOT EXISTS ix_menu_extra_receta_receta_extra_activos
  ON public.menu_extra_receta (id_receta, id_extra)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_menu_extra_combo_combo_extra_activos
  ON public.menu_extra_combo (id_combo, id_extra)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_menu_extras_id_extra_activos
  ON public.menu_extras (id_extra)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_menu_extras_insumo_activos
  ON public.menu_extras (id_insumo)
  WHERE id_insumo IS NOT NULL
    AND COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_insumos_extra_lookup_activos
  ON public.insumos (id_insumo, id_almacen)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_almacenes_id_sucursal
  ON public.almacenes (id_almacen, id_sucursal);

CREATE INDEX IF NOT EXISTS ix_detalle_combo_combo_receta_activos
  ON public.detalle_combo (id_combo, id_receta)
  WHERE id_receta IS NOT NULL
    AND COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_receta_salsa_receta_salsa_activos
  ON public.receta_salsa (id_receta, id_salsa)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_reglas_salsas_receta_rango_activos
  ON public.reglas_salsas_receta (id_receta, min_unidades, max_unidades, id_regla)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS ix_salsas_activas_orden_nombre
  ON public.salsas (orden, nombre)
  WHERE COALESCE(estado, true) = true;
