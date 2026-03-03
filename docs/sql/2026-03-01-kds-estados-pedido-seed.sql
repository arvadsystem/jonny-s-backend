-- Seed idempotente para habilitar el flujo KDS sin romper historicos.
-- No se aplica automaticamente desde la app.

INSERT INTO estados_pedido (descripcion)
SELECT estado.descripcion
FROM (
  VALUES
    ('PENDIENTE'),
    ('EN_COCINA'),
    ('EN_PREPARACION'),
    ('LISTO_PARA_ENTREGA'),
    ('COMPLETADO')
) AS estado(descripcion)
WHERE NOT EXISTS (
  SELECT 1
  FROM estados_pedido ep
  WHERE upper(trim(ep.descripcion)) = upper(trim(estado.descripcion))
);

WITH estado_completado AS (
  SELECT id_estado_pedido
  FROM estados_pedido
  WHERE upper(trim(descripcion)) = 'COMPLETADO'
  ORDER BY id_estado_pedido
  LIMIT 1
),
estado_pendiente AS (
  SELECT id_estado_pedido
  FROM estados_pedido
  WHERE upper(trim(descripcion)) = 'PENDIENTE'
  ORDER BY id_estado_pedido
  LIMIT 1
)
UPDATE pedidos p
SET id_estado_pedido = ec.id_estado_pedido
FROM estado_completado ec
WHERE p.id_estado_pedido IS NULL
  AND EXISTS (
    SELECT 1
    FROM facturas f
    WHERE f.id_pedido = p.id_pedido
  );

WITH estado_pendiente AS (
  SELECT id_estado_pedido
  FROM estados_pedido
  WHERE upper(trim(descripcion)) = 'PENDIENTE'
  ORDER BY id_estado_pedido
  LIMIT 1
)
UPDATE pedidos p
SET id_estado_pedido = ep.id_estado_pedido
FROM estado_pendiente ep
WHERE p.id_estado_pedido IS NULL;
