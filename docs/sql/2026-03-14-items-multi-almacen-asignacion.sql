BEGIN;

-- AM: tabla pivote para asignar un producto general a uno o mas almacenes sin duplicar filas de `productos`.
CREATE TABLE IF NOT EXISTS public.productos_almacenes (
  id_producto integer NOT NULL,
  id_almacen integer NOT NULL,
  fecha_asignacion timestamp without time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id_producto, id_almacen),
  CONSTRAINT fk_productos_almacenes_producto
    FOREIGN KEY (id_producto) REFERENCES public.productos(id_producto) ON DELETE CASCADE,
  CONSTRAINT fk_productos_almacenes_almacen
    FOREIGN KEY (id_almacen) REFERENCES public.almacenes(id_almacen) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_productos_almacenes_id_almacen
  ON public.productos_almacenes(id_almacen);

-- AM: tabla pivote para asignar un insumo general a uno o mas almacenes sin duplicar filas de `insumos`.
CREATE TABLE IF NOT EXISTS public.insumos_almacenes (
  id_insumo integer NOT NULL,
  id_almacen integer NOT NULL,
  fecha_asignacion timestamp without time zone NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id_insumo, id_almacen),
  CONSTRAINT fk_insumos_almacenes_insumo
    FOREIGN KEY (id_insumo) REFERENCES public.insumos(id_insumo) ON DELETE CASCADE,
  CONSTRAINT fk_insumos_almacenes_almacen
    FOREIGN KEY (id_almacen) REFERENCES public.almacenes(id_almacen) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_insumos_almacenes_id_almacen
  ON public.insumos_almacenes(id_almacen);

-- AM: backfill de asignaciones iniciales usando el almacen primario actual del item.
INSERT INTO public.productos_almacenes (id_producto, id_almacen)
SELECT p.id_producto, p.id_almacen
FROM public.productos p
WHERE p.id_almacen IS NOT NULL
ON CONFLICT (id_producto, id_almacen) DO NOTHING;

INSERT INTO public.insumos_almacenes (id_insumo, id_almacen)
SELECT i.id_insumo, i.id_almacen
FROM public.insumos i
WHERE i.id_almacen IS NOT NULL
ON CONFLICT (id_insumo, id_almacen) DO NOTHING;

COMMIT;
