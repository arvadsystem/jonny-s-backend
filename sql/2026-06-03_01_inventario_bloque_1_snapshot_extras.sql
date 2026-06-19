-- Bloque 1 inventario - snapshot operativo de extras.
-- Archivo para revision manual. No ejecutar sin validar primero en entorno controlado.
--
-- Objetivo:
-- - Permitir stock negativo cuando cocina inicia preparacion.
-- - Persistir configuracion de inventario de extras al crear el pedido.
-- - Resolver descuentos desde detalle_pedido_extras antes que desde menu_extras.
-- - Diagnosticar usos legacy de movimientos PEDIDO_EXTRA.

ALTER TABLE public.insumos
  DROP CONSTRAINT IF EXISTS chk_insumos_cantidad_no_negativa;

-- FKs revisables como NOT VALID para no bloquear por datos historicos antes de diagnosticar.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_pedido_extras_id_insumo'
      AND conrelid = 'public.detalle_pedido_extras'::regclass
  ) THEN
    ALTER TABLE public.detalle_pedido_extras
      ADD CONSTRAINT fk_detalle_pedido_extras_id_insumo
      FOREIGN KEY (id_insumo)
      REFERENCES public.insumos(id_insumo)
      NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_detalle_pedido_extras_id_unidad_medida'
      AND conrelid = 'public.detalle_pedido_extras'::regclass
  ) THEN
    ALTER TABLE public.detalle_pedido_extras
      ADD CONSTRAINT fk_detalle_pedido_extras_id_unidad_medida
      FOREIGN KEY (id_unidad_medida)
      REFERENCES public.unidades_medida(id_unidad_medida)
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_extras_detalle_activos
ON public.detalle_pedido_extras (id_detalle_pedido, id_extra)
WHERE COALESCE(estado, true) = true;

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_extras_insumo_activos
ON public.detalle_pedido_extras (id_insumo)
WHERE COALESCE(estado, true) = true
  AND id_insumo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_extras_unidad_activos
ON public.detalle_pedido_extras (id_unidad_medida)
WHERE COALESCE(estado, true) = true
  AND id_unidad_medida IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_detalle_pedido_extras_origen_snapshot_gin
ON public.detalle_pedido_extras
USING GIN (origen_snapshot);

-- Indice diagnostico para detectar movimientos legacy de extras fuera del flujo PEDIDO/SALIDA.
CREATE INDEX IF NOT EXISTS idx_mov_inv_legacy_pedido_extra
ON public.movimientos_inventario (id_ref, id_insumo, fecha_movimiento)
WHERE ref_origen = 'PEDIDO_EXTRA'
  AND tipo = 'SALIDA';

-- Diagnostico 1: extras activos sin snapshot completo de inventario.
SELECT
  dpe.id_detalle_pedido_extra,
  dpe.id_detalle_pedido,
  dpe.id_extra,
  dpe.nombre_extra_snapshot,
  dpe.cantidad,
  dpe.id_insumo,
  dpe.cant,
  dpe.id_unidad_medida,
  dpe.origen_snapshot
FROM public.detalle_pedido_extras dpe
WHERE COALESCE(dpe.estado, true) = true
  AND (dpe.id_insumo IS NULL OR dpe.cant IS NULL OR dpe.id_unidad_medida IS NULL)
ORDER BY dpe.id_detalle_pedido_extra DESC
LIMIT 100;

-- Diagnostico 2: movimientos legacy PEDIDO_EXTRA que deben dejar de generarse en el flujo nuevo.
SELECT
  mi.id_ref,
  mi.id_insumo,
  COUNT(*) AS total_movimientos,
  SUM(mi.cantidad) AS cantidad_total
FROM public.movimientos_inventario mi
WHERE mi.ref_origen = 'PEDIDO_EXTRA'
  AND mi.tipo = 'SALIDA'
GROUP BY mi.id_ref, mi.id_insumo
ORDER BY total_movimientos DESC, mi.id_ref DESC
LIMIT 100;
