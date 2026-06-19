-- Microfase 1: indices seguros para administrar presentaciones/conversiones por insumo.
-- No ejecutar automaticamente; aplicar en Supabase tras revisar el estado real de la tabla.

CREATE INDEX IF NOT EXISTS idx_insumo_presentaciones_insumo
ON public.insumo_presentaciones (id_insumo);

CREATE INDEX IF NOT EXISTS idx_insumo_presentaciones_insumo_estado
ON public.insumo_presentaciones (id_insumo, estado);

CREATE INDEX IF NOT EXISTS idx_insumo_presentaciones_insumo_uso_compra
ON public.insumo_presentaciones (id_insumo, uso_compra, estado);

CREATE INDEX IF NOT EXISTS idx_insumo_presentaciones_insumo_uso_receta
ON public.insumo_presentaciones (id_insumo, uso_receta, estado);

CREATE UNIQUE INDEX IF NOT EXISTS ux_insumo_presentaciones_pred_compra_activa
ON public.insumo_presentaciones (id_insumo)
WHERE estado = true
  AND uso_compra = true
  AND es_predeterminada_compra = true;

CREATE UNIQUE INDEX IF NOT EXISTS ux_insumo_presentaciones_pred_receta_activa
ON public.insumo_presentaciones (id_insumo)
WHERE estado = true
  AND uso_receta = true
  AND es_predeterminada_receta = true;
