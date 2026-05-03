BEGIN;

ALTER TABLE public.facturas
  ADD COLUMN IF NOT EXISTS codigo_venta VARCHAR(30);

CREATE TABLE IF NOT EXISTS public.facturacion_config_sucursal (
  id_config BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
  prefijo_venta VARCHAR(10) NOT NULL DEFAULT 'VTA',
  prefijo_reversion VARCHAR(10) NOT NULL DEFAULT 'REV',
  longitud_correlativo SMALLINT NOT NULL DEFAULT 5,
  reinicio_diario BOOLEAN NOT NULL DEFAULT true,
  modo_fiscal VARCHAR(20) NOT NULL DEFAULT 'CAI_PREPARADO',
  mostrar_logo_ticket BOOLEAN NOT NULL DEFAULT true,
  ancho_ticket_mm SMALLINT NOT NULL DEFAULT 80,
  activo BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_facturacion_config_sucursal UNIQUE (id_sucursal),
  CONSTRAINT ck_facturacion_config_longitud CHECK (longitud_correlativo BETWEEN 3 AND 10),
  CONSTRAINT ck_facturacion_config_ticket CHECK (ancho_ticket_mm IN (58, 80)),
  CONSTRAINT ck_facturacion_config_modo_fiscal CHECK (modo_fiscal IN ('INTERNO', 'CAI_PREPARADO', 'CAI_ACTIVO'))
);

CREATE TABLE IF NOT EXISTS public.facturacion_correlativos_diarios (
  id_correlativo BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
  fecha_operacion DATE NOT NULL,
  tipo_documento VARCHAR(20) NOT NULL,
  prefijo VARCHAR(10) NOT NULL,
  ultimo_numero INTEGER NOT NULL DEFAULT 0,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_facturacion_correlativo UNIQUE (id_sucursal, fecha_operacion, tipo_documento),
  CONSTRAINT ck_facturacion_correlativo_tipo CHECK (tipo_documento IN ('VENTA', 'REVERSION')),
  CONSTRAINT ck_facturacion_correlativo_numero CHECK (ultimo_numero >= 0)
);

CREATE INDEX IF NOT EXISTS idx_facturacion_correlativos_fecha
  ON public.facturacion_correlativos_diarios (fecha_operacion, id_sucursal, tipo_documento);

CREATE TABLE IF NOT EXISTS public.facturacion_rangos_cai (
  id_rango_cai BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
  cai VARCHAR(64),
  numero_desde BIGINT NOT NULL DEFAULT 0,
  numero_hasta BIGINT NOT NULL DEFAULT 0,
  fecha_limite_emision DATE,
  estado VARCHAR(20) NOT NULL DEFAULT 'BORRADOR',
  creado_por INTEGER NULL REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_facturacion_rangos_estado CHECK (estado IN ('BORRADOR', 'ACTIVO', 'VENCIDO', 'AGOTADO')),
  CONSTRAINT ck_facturacion_rangos_desde CHECK (numero_desde >= 0),
  CONSTRAINT ck_facturacion_rangos_hasta CHECK (numero_hasta >= 0)
);

UPDATE public.facturas
SET codigo_venta = 'VTA-' || LPAD(id_factura::text, 5, '0')
WHERE codigo_venta IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT codigo_venta
      FROM public.facturas
      WHERE codigo_venta IS NOT NULL
      GROUP BY codigo_venta
      HAVING COUNT(*) > 1
    ) dup
  ) THEN
    RAISE EXCEPTION 'No se puede crear indice unico de codigo_venta: existen duplicados.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_facturas_codigo_venta
  ON public.facturas (codigo_venta)
  WHERE codigo_venta IS NOT NULL;

COMMIT;
