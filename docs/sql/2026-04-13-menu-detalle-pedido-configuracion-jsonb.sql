-- Item 11 (Menu): persistencia estructurada de configuracion por linea de pedido.
-- Objetivo:
-- 1) Guardar extras/salsas/cantidad en formato JSONB trazable.
-- 2) Mantener compatibilidad con observacion legacy.

BEGIN;

ALTER TABLE public.detalle_pedido
  ADD COLUMN IF NOT EXISTS configuracion_menu jsonb;

COMMENT ON COLUMN public.detalle_pedido.configuracion_menu IS
  'Snapshot estructurado de configuracion de linea originada en menu publico (schema_version, cantidad, extras, salsas, etc.).';

ALTER TABLE public.detalle_pedido
  DROP CONSTRAINT IF EXISTS detalle_pedido_configuracion_menu_is_object_chk;

ALTER TABLE public.detalle_pedido
  ADD CONSTRAINT detalle_pedido_configuracion_menu_is_object_chk
  CHECK (
    configuracion_menu IS NULL
    OR jsonb_typeof(configuracion_menu) = 'object'
  );

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_configuracion_menu_gin
  ON public.detalle_pedido
  USING GIN (configuracion_menu)
  WHERE configuracion_menu IS NOT NULL;

COMMIT;
