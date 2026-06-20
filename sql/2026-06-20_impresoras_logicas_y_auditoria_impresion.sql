-- Configuracion de impresoras logicas y auditoria de impresiones.
-- Script idempotente y no destructivo.

CREATE TABLE IF NOT EXISTS public.configuracion_impresoras (
  id_impresora bigserial PRIMARY KEY,
  id_sucursal integer NOT NULL REFERENCES public.sucursales(id_sucursal),
  id_caja integer NULL REFERENCES public.cajas(id_caja),
  tipo_impresora text NOT NULL CHECK (tipo_impresora IN ('FACTURA', 'COCINA')),
  nombre_logico text NOT NULL,
  nombre_impresora_sistema text NULL,
  ancho_mm integer NOT NULL DEFAULT 80 CHECK (ancho_mm IN (58, 80)),
  activa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_configuracion_impresoras_sucursal
  ON public.configuracion_impresoras (id_sucursal);

CREATE INDEX IF NOT EXISTS idx_configuracion_impresoras_caja
  ON public.configuracion_impresoras (id_caja)
  WHERE id_caja IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_configuracion_impresoras_tipo
  ON public.configuracion_impresoras (tipo_impresora, activa);

CREATE UNIQUE INDEX IF NOT EXISTS ux_configuracion_impresora_activa_por_scope
  ON public.configuracion_impresoras (
    id_sucursal,
    COALESCE(id_caja, 0),
    tipo_impresora
  )
  WHERE activa = true;

CREATE TABLE IF NOT EXISTS public.impresiones_pedidos (
  id_impresion bigserial PRIMARY KEY,
  id_pedido integer NULL REFERENCES public.pedidos(id_pedido),
  id_factura integer NULL REFERENCES public.facturas(id_factura),
  tipo_documento text NOT NULL CHECK (tipo_documento IN ('FACTURA', 'COMANDA')),
  estado text NOT NULL CHECK (estado IN ('GENERADA', 'ENVIADA', 'CANCELADA', 'ERROR')),
  id_usuario integer NULL REFERENCES public.usuarios(id_usuario),
  id_sucursal integer NULL REFERENCES public.sucursales(id_sucursal),
  id_impresora bigint NULL REFERENCES public.configuracion_impresoras(id_impresora),
  nombre_impresora_snapshot text NULL,
  ancho_mm integer NOT NULL DEFAULT 80 CHECK (ancho_mm IN (58, 80)),
  fecha_creacion timestamptz NOT NULL DEFAULT now(),
  fecha_impresion timestamptz NULL,
  detalle_error text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_impresiones_pedidos_factura
  ON public.impresiones_pedidos (id_factura, tipo_documento, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_impresiones_pedidos_pedido
  ON public.impresiones_pedidos (id_pedido, tipo_documento, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_impresiones_pedidos_sucursal
  ON public.impresiones_pedidos (id_sucursal, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_impresiones_pedidos_estado
  ON public.impresiones_pedidos (estado, tipo_documento, fecha_creacion DESC);

-- Verificacion sugerida:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('configuracion_impresoras', 'impresiones_pedidos');
