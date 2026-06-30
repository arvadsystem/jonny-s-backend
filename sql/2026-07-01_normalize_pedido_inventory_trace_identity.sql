-- Normaliza la identidad de movimientos de inventario de pedido.
-- No ejecutar automaticamente. Migracion idempotente.
--
-- Objetivo:
-- - PEDIDO y FALTANTE_COCINA son equivalentes para unicidad fisica.
-- - Mantener lectura historica de FALTANTE_COCINA sin permitir duplicados nuevos.

DO $$
DECLARE
  v_conflicts bigint := 0;
BEGIN
  SELECT COUNT(*)
    INTO v_conflicts
  FROM (
    SELECT
      id_ref,
      id_detalle_pedido,
      tipo,
      origen_consumo,
      id_insumo,
      COUNT(*) AS total
    FROM public.movimientos_inventario
    WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
      AND tipo = 'SALIDA'
      AND id_ref IS NOT NULL
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IS NOT NULL
      AND id_insumo IS NOT NULL
    GROUP BY id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo
    HAVING COUNT(*) > 1
  ) conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION
      'No se puede normalizar identidad de inventario: existen % conflictos equivalentes de insumo entre PEDIDO/FALTANTE_COCINA.',
      v_conflicts;
  END IF;

  SELECT COUNT(*)
    INTO v_conflicts
  FROM (
    SELECT
      id_ref,
      id_detalle_pedido,
      tipo,
      origen_consumo,
      id_producto,
      COUNT(*) AS total
    FROM public.movimientos_inventario
    WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
      AND tipo = 'SALIDA'
      AND id_ref IS NOT NULL
      AND id_detalle_pedido IS NOT NULL
      AND origen_consumo IS NOT NULL
      AND id_producto IS NOT NULL
    GROUP BY id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto
    HAVING COUNT(*) > 1
  ) conflicts;

  IF v_conflicts > 0 THEN
    RAISE EXCEPTION
      'No se puede normalizar identidad de inventario: existen % conflictos equivalentes de producto entre PEDIDO/FALTANTE_COCINA.',
      v_conflicts;
  END IF;
END $$;

DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_producto;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_inv_linea_salida_insumo
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_insumo IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_inv_linea_salida_producto
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_producto IS NOT NULL;
