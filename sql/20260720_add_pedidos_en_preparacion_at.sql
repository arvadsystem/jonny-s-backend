BEGIN;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS en_preparacion_at timestamptz;

COMMENT ON COLUMN public.pedidos.en_preparacion_at IS
  'Primera fecha y hora en que Cocina movio el pedido a EN_PREPARACION.';

-- AM: Conserva la antiguedad operativa de pedidos que ya estaban en preparacion.
UPDATE public.pedidos AS p
SET en_preparacion_at = COALESCE(
  p.en_preparacion_at,
  p.visible_en_cocina_at AT TIME ZONE 'America/Tegucigalpa',
  (
    SELECT f.fecha_hora_facturacion AT TIME ZONE 'America/Tegucigalpa'
    FROM public.facturas AS f
    WHERE f.id_pedido = p.id_pedido
      AND f.id_sucursal = p.id_sucursal
    ORDER BY
      f.fecha_operacion DESC NULLS LAST,
      f.fecha_hora_facturacion DESC NULLS LAST,
      f.id_factura DESC
    LIMIT 1
  ),
  p.fecha_hora_pedido AT TIME ZONE 'America/Tegucigalpa',
  NOW()
)
FROM public.estados_pedido AS ep
WHERE ep.id_estado_pedido = p.id_estado_pedido
  AND REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') = 'EN_PREPARACION'
  AND p.en_preparacion_at IS NULL;

COMMIT;
