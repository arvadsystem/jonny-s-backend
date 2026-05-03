BEGIN;

ALTER TABLE public.facturas
  ADD COLUMN IF NOT EXISTS fecha_operacion DATE;

UPDATE public.facturas
SET fecha_operacion = fecha_hora_facturacion::date
WHERE fecha_operacion IS NULL
  AND fecha_hora_facturacion IS NOT NULL;

DROP INDEX IF EXISTS public.ux_facturas_codigo_venta;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT id_sucursal, fecha_operacion, codigo_venta
      FROM public.facturas
      WHERE codigo_venta IS NOT NULL
        AND fecha_operacion IS NOT NULL
      GROUP BY id_sucursal, fecha_operacion, codigo_venta
      HAVING COUNT(*) > 1
    ) dup
  ) THEN
    RAISE EXCEPTION 'No se puede crear indice unico por sucursal/fecha/codigo_venta: existen duplicados.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_facturas_sucursal_fecha_codigo_venta
  ON public.facturas (id_sucursal, fecha_operacion, codigo_venta)
  WHERE codigo_venta IS NOT NULL
    AND fecha_operacion IS NOT NULL;

COMMIT;
