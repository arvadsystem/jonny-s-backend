BEGIN;

-- AM: cada detalle de OC puede apuntar a un almacen destino especifico (1 o 2 sucursales desde UI).
ALTER TABLE public.detalle_orden_compras
  ADD COLUMN IF NOT EXISTS id_almacen_destino integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_doc_almacen_destino'
      AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT fk_doc_almacen_destino
      FOREIGN KEY (id_almacen_destino) REFERENCES public.almacenes(id_almacen);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_doc_almacen_destino_pos'
      AND conrelid = 'public.detalle_orden_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_orden_compras
      ADD CONSTRAINT chk_doc_almacen_destino_pos
      CHECK (id_almacen_destino IS NULL OR id_almacen_destino > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_doc_id_almacen_destino
  ON public.detalle_orden_compras (id_almacen_destino);

-- AM: backfill seguro para historicos (usa almacen actual del item cuando no exista destino explicito).
UPDATE public.detalle_orden_compras doc
SET id_almacen_destino = COALESCE(
  (
    SELECT p.id_almacen
    FROM public.productos p
    WHERE p.id_producto = doc.id_producto
    LIMIT 1
  ),
  (
    SELECT i.id_almacen
    FROM public.insumos i
    WHERE i.id_insumo = doc.id_insumo
    LIMIT 1
  )
)
WHERE doc.id_almacen_destino IS NULL;

-- AM: detalle de compra replica almacen destino para abastecimiento exacto por sucursal.
ALTER TABLE public.detalle_compras
  ADD COLUMN IF NOT EXISTS id_almacen_destino integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_dc_almacen_destino'
      AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT fk_dc_almacen_destino
      FOREIGN KEY (id_almacen_destino) REFERENCES public.almacenes(id_almacen);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_dc_almacen_destino_pos'
      AND conrelid = 'public.detalle_compras'::regclass
  ) THEN
    ALTER TABLE public.detalle_compras
      ADD CONSTRAINT chk_dc_almacen_destino_pos
      CHECK (id_almacen_destino IS NULL OR id_almacen_destino > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dc_id_almacen_destino
  ON public.detalle_compras (id_almacen_destino);

-- AM: backfill historico de detalle_compra usando detalle OC cuando existe.
UPDATE public.detalle_compras dc
SET id_almacen_destino = COALESCE(
  (
    SELECT doc.id_almacen_destino
    FROM public.compras c
    INNER JOIN public.detalle_orden_compras doc
      ON doc.id_orden_compra = c.id_orden_compra
    WHERE c.id_compra = dc.id_compra
      AND (
        (doc.id_producto IS NOT NULL AND doc.id_producto = dc.id_producto)
        OR (doc.id_insumo IS NOT NULL AND doc.id_insumo = dc.id_insumo)
      )
    ORDER BY doc.id_detalle_orden ASC
    LIMIT 1
  ),
  (
    SELECT p.id_almacen
    FROM public.productos p
    WHERE p.id_producto = dc.id_producto
    LIMIT 1
  ),
  (
    SELECT i.id_almacen
    FROM public.insumos i
    WHERE i.id_insumo = dc.id_insumo
    LIMIT 1
  )
)
WHERE dc.id_almacen_destino IS NULL;

COMMIT;
