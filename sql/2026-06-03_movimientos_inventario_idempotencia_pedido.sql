-- Fase 3 - Blindaje de idempotencia para descuentos de inventario por pedido.
-- No ejecutar sin revisar primero los diagnosticos.
--
-- Valores reales encontrados en services/inventarioMovimientoService.js:
-- - MOVEMENT_REF = 'PEDIDO'
-- - tipo de salida insertado = 'SALIDA'
--
-- Objetivo:
-- Impedir que un mismo pedido registre dos salidas para el mismo producto o insumo
-- en movimientos de inventario generados por el flujo de descuento de pedido.
-- No afecta reversiones, ajustes manuales ni otros ref_origen.

-- 1) Diagnostico de duplicados existentes por producto.
SELECT
  id_ref,
  ref_origen,
  tipo,
  id_producto,
  COUNT(*) AS total,
  ARRAY_AGG(id_movimiento ORDER BY id_movimiento) AS movimientos
FROM public.movimientos_inventario
WHERE ref_origen = 'PEDIDO'
  AND tipo = 'SALIDA'
  AND id_ref IS NOT NULL
  AND id_producto IS NOT NULL
GROUP BY id_ref, ref_origen, tipo, id_producto
HAVING COUNT(*) > 1
ORDER BY total DESC, id_ref, id_producto;

-- 2) Diagnostico de duplicados existentes por insumo.
SELECT
  id_ref,
  ref_origen,
  tipo,
  id_insumo,
  COUNT(*) AS total,
  ARRAY_AGG(id_movimiento ORDER BY id_movimiento) AS movimientos
FROM public.movimientos_inventario
WHERE ref_origen = 'PEDIDO'
  AND tipo = 'SALIDA'
  AND id_ref IS NOT NULL
  AND id_insumo IS NOT NULL
GROUP BY id_ref, ref_origen, tipo, id_insumo
HAVING COUNT(*) > 1
ORDER BY total DESC, id_ref, id_insumo;

-- 3) Diagnostico opcional: movimientos de pedido sin recurso claro.
-- Debe devolver 0 filas antes de confiar en reportes por recurso.
SELECT
  id_movimiento,
  id_ref,
  ref_origen,
  tipo,
  id_producto,
  id_insumo,
  cantidad,
  descripcion
FROM public.movimientos_inventario
WHERE ref_origen = 'PEDIDO'
  AND tipo = 'SALIDA'
  AND id_ref IS NOT NULL
  AND id_producto IS NULL
  AND id_insumo IS NULL
ORDER BY id_movimiento;

-- 4) Indice unico parcial por producto.
-- Ejecutar solo si el diagnostico de duplicados por producto no devuelve filas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_inv_pedido_salida_producto
ON public.movimientos_inventario (id_ref, ref_origen, tipo, id_producto)
WHERE ref_origen = 'PEDIDO'
  AND tipo = 'SALIDA'
  AND id_ref IS NOT NULL
  AND id_producto IS NOT NULL;

-- 5) Indice unico parcial por insumo.
-- Ejecutar solo si el diagnostico de duplicados por insumo no devuelve filas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mov_inv_pedido_salida_insumo
ON public.movimientos_inventario (id_ref, ref_origen, tipo, id_insumo)
WHERE ref_origen = 'PEDIDO'
  AND tipo = 'SALIDA'
  AND id_ref IS NOT NULL
  AND id_insumo IS NOT NULL;
