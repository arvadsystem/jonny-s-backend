-- Bloque 2: trazabilidad persistente de advertencias de inventario en cocina.
-- No ejecutar automaticamente. Revisar y aplicar manualmente en Supabase.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pedidos_inventario_alertas (
  id_alerta BIGSERIAL PRIMARY KEY,
  id_pedido INTEGER NOT NULL REFERENCES public.pedidos(id_pedido) ON DELETE CASCADE,
  id_detalle_pedido INTEGER NULL REFERENCES public.detalle_pedido(id_detalle_pedido) ON DELETE SET NULL,
  tipo_alerta TEXT NOT NULL,
  motivo TEXT NOT NULL,
  mensaje TEXT NULL,
  tipo_recurso TEXT NULL,
  id_recurso INTEGER NULL,
  id_producto INTEGER NULL REFERENCES public.productos(id_producto) ON DELETE SET NULL,
  id_insumo INTEGER NULL REFERENCES public.insumos(id_insumo) ON DELETE SET NULL,
  id_receta INTEGER NULL REFERENCES public.recetas(id_receta) ON DELETE SET NULL,
  id_combo INTEGER NULL REFERENCES public.combos(id_combo) ON DELETE SET NULL,
  id_extra INTEGER NULL REFERENCES public.menu_extras(id_extra) ON DELETE SET NULL,
  stock_disponible NUMERIC(14,4) NULL,
  cantidad_requerida NUMERIC(14,4) NULL,
  deficit NUMERIC(14,4) NULL,
  payload JSONB NULL,
  estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INTEGER NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL
);

COMMENT ON TABLE public.pedidos_inventario_alertas IS
  'Advertencias persistentes generadas al iniciar preparacion en cocina sin bloquear por inventario.';

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_pedido
ON public.pedidos_inventario_alertas (id_pedido);

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_estado
ON public.pedidos_inventario_alertas (estado);

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_motivo
ON public.pedidos_inventario_alertas (motivo);

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_created_at
ON public.pedidos_inventario_alertas (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pedidos_inv_alertas_payload_gin
ON public.pedidos_inventario_alertas
USING GIN (payload);

-- Idempotencia operacional: evita duplicar la misma advertencia para el mismo
-- pedido/recurso si el flujo se reintenta o el servicio se invoca dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_inv_alertas_pedido_motivo_recurso
ON public.pedidos_inventario_alertas (
  id_pedido,
  motivo,
  COALESCE(tipo_recurso, ''),
  COALESCE(id_detalle_pedido, 0),
  COALESCE(id_recurso, 0),
  COALESCE(id_producto, 0),
  COALESCE(id_insumo, 0),
  COALESCE(id_receta, 0),
  COALESCE(id_combo, 0),
  COALESCE(id_extra, 0)
);

COMMIT;
