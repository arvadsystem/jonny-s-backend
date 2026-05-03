BEGIN;

-- Operativa Honduras para columnas timestamp without time zone.
ALTER TABLE public.facturas
  ALTER COLUMN fecha_hora_facturacion SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa');

ALTER TABLE public.pedidos
  ALTER COLUMN fecha_hora_pedido SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa');

ALTER TABLE public.cajas_movimientos
  ALTER COLUMN fecha_movimiento SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa'),
  ALTER COLUMN fecha_creacion SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa');

ALTER TABLE public.cajas_sesiones
  ALTER COLUMN fecha_apertura SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa'),
  ALTER COLUMN fecha_creacion SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa');

ALTER TABLE public.facturas_reversiones
  ALTER COLUMN creada_en SET DEFAULT (NOW() AT TIME ZONE 'America/Tegucigalpa');

COMMIT;
