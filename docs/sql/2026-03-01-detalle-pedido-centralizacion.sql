-- Migracion aditiva para completar la centralizacion de detalle_pedido.
-- No se aplica automaticamente desde la app.

ALTER TABLE detalle_pedido
ADD COLUMN IF NOT EXISTS cantidad integer NULL;

ALTER TABLE detalle_pedido
ADD COLUMN IF NOT EXISTS precio_unitario numeric(12,2) NULL;

ALTER TABLE detalle_pedido
ADD COLUMN IF NOT EXISTS sub_total numeric(12,2) NULL;

UPDATE detalle_pedido dp
SET precio_unitario = source.precio_unitario
FROM (
  SELECT
    dp_inner.id_detalle_pedido,
    COALESCE(
      CASE
        WHEN dp_inner.id_producto IS NOT NULL THEN prod.precio
        WHEN dp_inner.id_combo IS NOT NULL THEN combo.precio
        WHEN dp_inner.id_receta IS NOT NULL THEN prod_rec.precio
        ELSE NULL
      END,
      dp_inner.precio_unitario
    )::numeric(12,2) AS precio_unitario
  FROM detalle_pedido dp_inner
  LEFT JOIN productos prod ON prod.id_producto = dp_inner.id_producto
  LEFT JOIN combos combo ON combo.id_combo = dp_inner.id_combo
  LEFT JOIN recetas rec ON rec.id_receta = dp_inner.id_receta
  LEFT JOIN productos prod_rec ON prod_rec.id_producto = rec.id_producto
) AS source
WHERE source.id_detalle_pedido = dp.id_detalle_pedido
  AND source.precio_unitario IS NOT NULL
  AND (
    dp.precio_unitario IS NULL
    OR dp.precio_unitario <> source.precio_unitario
  );

UPDATE detalle_pedido
SET cantidad = CASE
  WHEN COALESCE(precio_unitario, 0) > 0
    THEN GREATEST(1, ROUND(COALESCE(sub_total_pedido, 0) / precio_unitario)::int)
  ELSE 1
END
WHERE cantidad IS NULL;

UPDATE detalle_pedido
SET sub_total = COALESCE(sub_total_pedido, 0)::numeric(12,2)
WHERE sub_total IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'detalle_pedido_unica_entidad_chk'
  ) THEN
    ALTER TABLE detalle_pedido
    ADD CONSTRAINT detalle_pedido_unica_entidad_chk
    CHECK (num_nonnulls(id_producto, id_combo, id_receta) = 1)
    NOT VALID;
  END IF;
END $$;
