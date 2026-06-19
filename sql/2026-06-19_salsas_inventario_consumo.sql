-- Agrega configuracion explicita de consumo de inventario para salsas.
-- No ejecutar automaticamente: aplicar como migracion controlada en Supabase.

BEGIN;

ALTER TABLE public.salsas
  ADD COLUMN IF NOT EXISTS id_insumo INTEGER NULL,
  ADD COLUMN IF NOT EXISTS cantidad_porcion NUMERIC(12,4) NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS id_unidad_consumo INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_salsas_id_insumo'
      AND conrelid = 'public.salsas'::regclass
  ) THEN
    ALTER TABLE public.salsas
      ADD CONSTRAINT fk_salsas_id_insumo
      FOREIGN KEY (id_insumo)
      REFERENCES public.insumos(id_insumo);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_salsas_id_unidad_consumo'
      AND conrelid = 'public.salsas'::regclass
  ) THEN
    ALTER TABLE public.salsas
      ADD CONSTRAINT fk_salsas_id_unidad_consumo
      FOREIGN KEY (id_unidad_consumo)
      REFERENCES public.unidades_medida(id_unidad_medida);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_salsas_cantidad_porcion_positive'
      AND conrelid = 'public.salsas'::regclass
  ) THEN
    ALTER TABLE public.salsas
      ADD CONSTRAINT ck_salsas_cantidad_porcion_positive
      CHECK (cantidad_porcion > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_salsas_inventario_config_completa'
      AND conrelid = 'public.salsas'::regclass
  ) THEN
    ALTER TABLE public.salsas
      ADD CONSTRAINT ck_salsas_inventario_config_completa
      CHECK (
        (id_insumo IS NULL AND id_unidad_consumo IS NULL)
        OR (id_insumo IS NOT NULL AND id_unidad_consumo IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salsas_id_insumo
  ON public.salsas (id_insumo)
  WHERE id_insumo IS NOT NULL;

COMMIT;

-- Verificacion sugerida:
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'salsas'
--   AND column_name IN ('id_insumo', 'cantidad_porcion', 'id_unidad_consumo');

