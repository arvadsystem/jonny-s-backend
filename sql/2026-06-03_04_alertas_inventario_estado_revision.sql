-- Bloque 4: auditoria de revision para alertas persistentes de inventario.
-- No ejecutar automaticamente. Revisar y aplicar manualmente en Supabase.

BEGIN;

ALTER TABLE public.pedidos_inventario_alertas
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS resolved_by INTEGER NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS nota_resolucion TEXT NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_pedidos_inv_alertas_estado'
      AND conrelid = 'public.pedidos_inventario_alertas'::regclass
  ) THEN
    ALTER TABLE public.pedidos_inventario_alertas
      ADD CONSTRAINT ck_pedidos_inv_alertas_estado
      CHECK (estado IN ('PENDIENTE', 'REVISADA', 'RESUELTA', 'DESCARTADA'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_resolved_at
ON public.pedidos_inventario_alertas (resolved_at DESC)
WHERE resolved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_resolved_by
ON public.pedidos_inventario_alertas (resolved_by)
WHERE resolved_by IS NOT NULL;

COMMENT ON COLUMN public.pedidos_inventario_alertas.resolved_at IS
  'Fecha/hora en que administracion o inventario reviso, resolvio o descarto la alerta.';

COMMENT ON COLUMN public.pedidos_inventario_alertas.resolved_by IS
  'Usuario que marco la alerta como revisada, resuelta o descartada.';

COMMENT ON COLUMN public.pedidos_inventario_alertas.nota_resolucion IS
  'Nota operativa de la revision o resolucion de la alerta.';

COMMIT;
