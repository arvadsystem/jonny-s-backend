BEGIN;

DROP VIEW IF EXISTS public.v_kardex_detalle;

DO $$
DECLARE
  v_max_abs numeric;
BEGIN
  SELECT COALESCE(MAX(ABS(cantidad)), 0)
    INTO v_max_abs
  FROM public.movimientos_inventario;

  IF v_max_abs >= 1000000000000 THEN
    RAISE EXCEPTION 'movimientos_inventario.cantidad contiene valores que exceden numeric(18,6): %', v_max_abs;
  END IF;
END $$;

ALTER TABLE public.movimientos_inventario
  ALTER COLUMN cantidad TYPE numeric(18,6)
  USING cantidad::numeric(18,6);

ALTER TABLE public.movimientos_inventario
  ADD COLUMN IF NOT EXISTS id_detalle_pedido integer NULL;

ALTER TABLE public.movimientos_inventario
  ADD COLUMN IF NOT EXISTS origen_consumo varchar(30) NULL;

ALTER TABLE public.movimientos_inventario
  ADD COLUMN IF NOT EXISTS id_movimiento_origen integer NULL;

ALTER TABLE public.movimientos_inventario
  ADD COLUMN IF NOT EXISTS id_pedido_trazabilidad integer NULL;

UPDATE public.movimientos_inventario
SET origen_consumo = UPPER(TRIM(origen_consumo))
WHERE origen_consumo IS NOT NULL
  AND origen_consumo <> UPPER(TRIM(origen_consumo));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_mov_inv_detalle_pedido'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      DROP CONSTRAINT fk_mov_inv_detalle_pedido;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_mov_inv_pedido_detalle'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      DROP CONSTRAINT fk_mov_inv_pedido_detalle;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ux_detalle_pedido_pedido_detalle'
      AND conrelid = 'public.detalle_pedido'::regclass
  ) THEN
    ALTER TABLE public.detalle_pedido
      ADD CONSTRAINT ux_detalle_pedido_pedido_detalle
      UNIQUE (id_pedido, id_detalle_pedido);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_mov_inv_pedido_detalle'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT fk_mov_inv_pedido_detalle
      FOREIGN KEY (id_pedido_trazabilidad, id_detalle_pedido)
      REFERENCES public.detalle_pedido(id_pedido, id_detalle_pedido)
      ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_mov_inv_movimiento_origen'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT fk_mov_inv_movimiento_origen
      FOREIGN KEY (id_movimiento_origen)
      REFERENCES public.movimientos_inventario(id_movimiento)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_mov_inv_origen_consumo'
      AND conrelid = 'public.movimientos_inventario'::regclass
  ) THEN
    ALTER TABLE public.movimientos_inventario
      ADD CONSTRAINT ck_mov_inv_origen_consumo
      CHECK (
        origen_consumo IS NULL
        OR origen_consumo IN ('PRODUCTO', 'RECETA', 'EXTRA', 'SALSA')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.movimientos_inventario.id_detalle_pedido IS
  'Linea de detalle_pedido que origino el consumo de inventario. NULL conserva movimientos legacy sin trazabilidad por linea.';

COMMENT ON COLUMN public.movimientos_inventario.origen_consumo IS
  'Tipo normalizado de consumo dentro de la linea: PRODUCTO, RECETA, EXTRA o SALSA.';

COMMENT ON COLUMN public.movimientos_inventario.id_movimiento_origen IS
  'Movimiento SALIDA original que origina una ENTRADA de reversion. NULL para salidas y movimientos legacy.';

COMMENT ON COLUMN public.movimientos_inventario.id_pedido_trazabilidad IS
  'Pedido usado por FK compuesta de movimientos trazados. El backend lo escribe explicitamente y el trigger lo conserva como defensa.';

DROP INDEX IF EXISTS public.ux_mov_inv_pedido_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_pedido_salida_producto;
DROP INDEX IF EXISTS public.ux_mov_inv_pedido_linea_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_pedido_linea_salida_producto;
DROP INDEX IF EXISTS public.ux_mov_inv_pedido_legacy_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_pedido_legacy_salida_producto;
DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_insumo;
DROP INDEX IF EXISTS public.ux_mov_inv_linea_salida_producto;
DROP INDEX IF EXISTS public.ux_mov_inv_reversion_origen;
DROP INDEX IF EXISTS public.idx_mov_inv_pedido_linea;
DROP INDEX IF EXISTS public.idx_mov_inv_reversion_origen;

CREATE UNIQUE INDEX ux_mov_inv_linea_salida_insumo
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_insumo)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_insumo IS NOT NULL;

CREATE UNIQUE INDEX ux_mov_inv_linea_salida_producto
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, origen_consumo, id_producto)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL
    AND origen_consumo IS NOT NULL
    AND id_producto IS NOT NULL;

CREATE UNIQUE INDEX ux_mov_inv_pedido_legacy_salida_insumo
  ON public.movimientos_inventario (id_ref, ref_origen, tipo, id_insumo)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NULL
    AND id_insumo IS NOT NULL;

CREATE UNIQUE INDEX ux_mov_inv_pedido_legacy_salida_producto
  ON public.movimientos_inventario (id_ref, ref_origen, tipo, id_producto)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND tipo = 'SALIDA'
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NULL
    AND id_producto IS NOT NULL;

CREATE UNIQUE INDEX ux_mov_inv_reversion_origen
  ON public.movimientos_inventario (ref_origen, id_ref, id_movimiento_origen)
  WHERE ref_origen = 'REVERSION_VENTA_INVENTARIO'
    AND id_ref IS NOT NULL
    AND id_movimiento_origen IS NOT NULL;

CREATE INDEX idx_mov_inv_pedido_linea
  ON public.movimientos_inventario (id_ref, id_detalle_pedido, tipo, id_movimiento)
  WHERE ref_origen IN ('PEDIDO', 'FALTANTE_COCINA')
    AND id_ref IS NOT NULL
    AND id_detalle_pedido IS NOT NULL;

CREATE INDEX idx_mov_inv_reversion_origen
  ON public.movimientos_inventario (id_movimiento_origen, ref_origen, tipo)
  WHERE id_movimiento_origen IS NOT NULL;

CREATE VIEW public.v_kardex_detalle AS
 SELECT m.id_movimiento,
    m.fecha_mov,
    m.tipo,
    m.cantidad,
    m.saldo_antes,
    m.saldo_despues,
    m.saldo_antes IS NULL OR m.saldo_despues IS NULL AS es_legacy,
    m.id_almacen,
    a.nombre AS nombre_almacen,
    a.id_sucursal,
    s.nombre_sucursal,
    m.id_producto,
    p.nombre_producto,
    m.id_insumo,
    i.nombre_insumo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN 'Producto'::text
            ELSE 'Insumo'::text
        END AS item_tipo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN m.id_producto
            ELSE m.id_insumo
        END AS item_id,
        CASE
            WHEN m.id_producto IS NOT NULL THEN p.nombre_producto
            ELSE i.nombre_insumo
        END AS item_nombre,
        CASE
            WHEN m.tipo::text = 'ENTRADA'::text THEN m.cantidad
            WHEN m.tipo::text = 'SALIDA'::text THEN - m.cantidad
            ELSE NULL::numeric
        END AS impacto,
    m.ref_origen,
    m.id_ref,
    m.descripcion
   FROM public.movimientos_inventario m
     LEFT JOIN public.almacenes a ON a.id_almacen = m.id_almacen
     LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
     LEFT JOIN public.productos p ON p.id_producto = m.id_producto
     LEFT JOIN public.insumos i ON i.id_insumo = m.id_insumo;

GRANT ALL ON TABLE public.v_kardex_detalle TO anon;
GRANT ALL ON TABLE public.v_kardex_detalle TO authenticated;
GRANT ALL ON TABLE public.v_kardex_detalle TO service_role;

COMMIT;
