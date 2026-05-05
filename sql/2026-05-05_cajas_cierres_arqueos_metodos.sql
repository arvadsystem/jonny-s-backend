-- 2026-05-05_cajas_cierres_arqueos_metodos.sql
-- Migracion no destructiva para soportar arqueos segmentados por metodo de pago.

CREATE TABLE IF NOT EXISTS public.cajas_cierres_arqueos_metodos (
  id_arqueo_metodo            BIGSERIAL PRIMARY KEY,
  id_cierre_caja              BIGINT NOT NULL,
  id_sesion_caja              BIGINT NOT NULL,
  id_caja                     INTEGER NOT NULL,
  id_sucursal                 INTEGER NOT NULL,
  id_metodo_pago              INTEGER NOT NULL,
  metodo_pago_codigo          VARCHAR(50) NOT NULL,
  monto_teorico               NUMERIC(12,2) NOT NULL DEFAULT 0,
  monto_declarado             NUMERIC(12,2) NOT NULL DEFAULT 0,
  diferencia                  NUMERIC(12,2) NOT NULL DEFAULT 0,
  cantidad_referencias        INTEGER NULL,
  observacion                 VARCHAR(500) NULL,
  requiere_revision           BOOLEAN NOT NULL DEFAULT FALSE,
  completado_automaticamente  BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_registro              TIMESTAMP NOT NULL DEFAULT NOW(),
  id_usuario_registro         INTEGER NULL,

  CONSTRAINT fk_ccam_cierre
    FOREIGN KEY (id_cierre_caja)
    REFERENCES public.cajas_cierres(id_cierre_caja),

  CONSTRAINT fk_ccam_sesion
    FOREIGN KEY (id_sesion_caja)
    REFERENCES public.cajas_sesiones(id_sesion_caja),

  CONSTRAINT fk_ccam_caja
    FOREIGN KEY (id_caja)
    REFERENCES public.cajas(id_caja),

  CONSTRAINT fk_ccam_sucursal
    FOREIGN KEY (id_sucursal)
    REFERENCES public.sucursales(id_sucursal),

  CONSTRAINT fk_ccam_metodo
    FOREIGN KEY (id_metodo_pago)
    REFERENCES public.cat_metodos_pago(id_metodo_pago),

  CONSTRAINT fk_ccam_usuario
    FOREIGN KEY (id_usuario_registro)
    REFERENCES public.usuarios(id_usuario),

  CONSTRAINT uq_ccam_cierre_metodo
    UNIQUE (id_cierre_caja, id_metodo_pago),

  CONSTRAINT ck_ccam_monto_declarado_non_negative
    CHECK (monto_declarado >= 0),

  CONSTRAINT ck_ccam_cantidad_referencias_non_negative
    CHECK (cantidad_referencias IS NULL OR cantidad_referencias >= 0),

  CONSTRAINT ck_ccam_metodo_codigo_not_blank
    CHECK (length(trim(metodo_pago_codigo)) > 0)
);

CREATE INDEX IF NOT EXISTS ix_ccam_id_cierre_caja
  ON public.cajas_cierres_arqueos_metodos (id_cierre_caja);

CREATE INDEX IF NOT EXISTS ix_ccam_id_sesion_caja
  ON public.cajas_cierres_arqueos_metodos (id_sesion_caja);

CREATE INDEX IF NOT EXISTS ix_ccam_id_caja
  ON public.cajas_cierres_arqueos_metodos (id_caja);

CREATE INDEX IF NOT EXISTS ix_ccam_id_sucursal
  ON public.cajas_cierres_arqueos_metodos (id_sucursal);

CREATE INDEX IF NOT EXISTS ix_ccam_id_metodo_pago
  ON public.cajas_cierres_arqueos_metodos (id_metodo_pago);

CREATE INDEX IF NOT EXISTS ix_ccam_metodo_pago_codigo
  ON public.cajas_cierres_arqueos_metodos (metodo_pago_codigo);

CREATE INDEX IF NOT EXISTS ix_ccam_requiere_revision
  ON public.cajas_cierres_arqueos_metodos (requiere_revision);

CREATE INDEX IF NOT EXISTS ix_ccam_sucursal_fecha_registro
  ON public.cajas_cierres_arqueos_metodos (id_sucursal, fecha_registro);

COMMENT ON TABLE public.cajas_cierres_arqueos_metodos IS
  'Detalle por metodo de pago del arqueo asociado a un cierre de caja.';

COMMENT ON COLUMN public.cajas_cierres_arqueos_metodos.metodo_pago_codigo IS
  'Codigo de metodo de pago en texto (ej. EFECTIVO, TARJETA, TRANSFERENCIA).';

COMMENT ON COLUMN public.cajas_cierres_arqueos_metodos.cantidad_referencias IS
  'Cantidad de vouchers/comprobantes declarados para metodos no efectivos.';

