BEGIN;

-- El snapshot de contacto existe incluso para consumidor final sin datos.
ALTER TABLE public.pedidos_contacto
  ALTER COLUMN nombre_contacto DROP NOT NULL;

-- En DELIVERY los datos de recepcion son opcionales. El costo nulo significa
-- que el cajero no lo informo; el total del pedido lo trata como cero.
ALTER TABLE public.pedidos_delivery
  ALTER COLUMN costo_envio DROP NOT NULL,
  ALTER COLUMN nombre_receptor DROP NOT NULL,
  ALTER COLUMN telefono_receptor DROP NOT NULL,
  ALTER COLUMN direccion_entrega DROP NOT NULL,
  ALTER COLUMN referencia_entrega DROP NOT NULL;

COMMIT;

-- Verificacion read-only posterior:
-- SELECT table_name, column_name, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name IN ('pedidos_contacto', 'pedidos_delivery')
--   AND column_name IN (
--     'nombre_contacto', 'costo_envio', 'nombre_receptor',
--     'telefono_receptor', 'direccion_entrega', 'referencia_entrega'
--   )
-- ORDER BY table_name, ordinal_position;
