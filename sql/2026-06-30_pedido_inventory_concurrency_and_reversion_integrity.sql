BEGIN;

CREATE INDEX IF NOT EXISTS idx_pedidos_inventory_lock
  ON public.pedidos (id_pedido, id_sucursal);

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_inventory_validation
  ON public.detalle_pedido (id_detalle_pedido, id_pedido)
  WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_extras_inventory_validation
  ON public.detalle_pedido_extras (id_detalle_pedido, id_extra)
  WHERE COALESCE(estado, true) = true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_mov_inv_cantidad_escala_6'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT ck_mov_inv_cantidad_escala_6
      CHECK (cantidad = ROUND(cantidad, 6));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_mov_inv_entrada_origen_cantidad'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT ck_mov_inv_entrada_origen_cantidad
      CHECK (
        tipo <> 'ENTRADA'
        OR id_movimiento_origen IS NULL
        OR cantidad > 0
      );
  END IF;
END $$;

COMMENT ON INDEX public.idx_pedidos_inventory_lock IS
  'Apoya el bloqueo FOR UPDATE de pedidos antes de descontar inventario.';

COMMENT ON INDEX public.idx_detalle_pedido_inventory_validation IS
  'Apoya validacion pedido-detalle-recurso antes de tocar stock.';

COMMENT ON INDEX public.idx_detalle_pedido_extras_inventory_validation IS
  'Apoya validacion de extras y salsas por linea de pedido antes de tocar stock.';

COMMIT;
