SELECT
  c.column_name,
  c.data_type,
  c.is_nullable
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND c.table_name = 'pedidos'
  AND c.column_name = 'en_preparacion_at';

SELECT COUNT(*)::int AS pedidos_en_preparacion_sin_marca
FROM public.pedidos AS p
INNER JOIN public.estados_pedido AS ep
  ON ep.id_estado_pedido = p.id_estado_pedido
WHERE REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') = 'EN_PREPARACION'
  AND p.en_preparacion_at IS NULL;
