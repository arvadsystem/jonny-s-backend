-- 2026-05-18_cajas_cierres_validaciones.sql
-- Auditoria de intentos de revision de diferencias antes del cierre formal de caja.
-- No modifica RLS ni cierra sesiones.

CREATE TABLE IF NOT EXISTS public.cajas_cierres_validaciones (
  id_validacion_cierre   BIGSERIAL PRIMARY KEY,
  id_sesion_caja         BIGINT NOT NULL REFERENCES public.cajas_sesiones(id_sesion_caja),
  id_caja                INTEGER NOT NULL REFERENCES public.cajas(id_caja),
  id_sucursal            INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  id_usuario_valida      INTEGER NOT NULL REFERENCES public.usuarios(id_usuario),
  id_cierre_caja         BIGINT NULL REFERENCES public.cajas_cierres(id_cierre_caja),
  numero_intento         INTEGER NOT NULL,
  origen                 TEXT NOT NULL DEFAULT 'REVISION_DIFERENCIAS',
  total_teorico          NUMERIC(12,2),
  total_declarado        NUMERIC(12,2),
  diferencia_total       NUMERIC(12,2),
  hay_diferencia         BOOLEAN NOT NULL DEFAULT FALSE,
  payload_declarado_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  resultado_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
  observacion_general    TEXT,
  ip_origen              TEXT NULL,
  user_agent             TEXT NULL,
  fecha_validacion       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_creacion         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ck_cajas_cierres_validaciones_numero_intento
    CHECK (numero_intento > 0),

  CONSTRAINT ck_cajas_cierres_validaciones_origen_not_blank
    CHECK (length(trim(origen)) > 0)
);

CREATE TABLE IF NOT EXISTS public.cajas_cierres_validaciones_metodos (
  id_validacion_metodo   BIGSERIAL PRIMARY KEY,
  id_validacion_cierre   BIGINT NOT NULL REFERENCES public.cajas_cierres_validaciones(id_validacion_cierre) ON DELETE CASCADE,
  id_metodo_pago         INTEGER NULL REFERENCES public.cat_metodos_pago(id_metodo_pago),
  metodo_pago_codigo     TEXT NOT NULL,
  monto_teorico          NUMERIC(12,2),
  monto_declarado        NUMERIC(12,2) NOT NULL,
  diferencia             NUMERIC(12,2),
  cantidad_referencias   INTEGER NULL,
  resultado              TEXT NOT NULL,
  requiere_revision      BOOLEAN NOT NULL DEFAULT FALSE,
  observacion            TEXT NULL,
  fecha_creacion         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT ck_ccvm_metodo_codigo_not_blank
    CHECK (length(trim(metodo_pago_codigo)) > 0),

  CONSTRAINT ck_ccvm_monto_declarado_non_negative
    CHECK (monto_declarado >= 0),

  CONSTRAINT ck_ccvm_cantidad_referencias_non_negative
    CHECK (cantidad_referencias IS NULL OR cantidad_referencias >= 0),

  CONSTRAINT ck_ccvm_resultado
    CHECK (resultado IN ('CUADRADO', 'FALTANTE', 'SOBRANTE'))
);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_validaciones_sesion
  ON public.cajas_cierres_validaciones (id_sesion_caja, fecha_validacion DESC);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_validaciones_usuario
  ON public.cajas_cierres_validaciones (id_usuario_valida, fecha_validacion DESC);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_validaciones_cierre
  ON public.cajas_cierres_validaciones (id_cierre_caja);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cajas_cierres_validaciones_intento
  ON public.cajas_cierres_validaciones (id_sesion_caja, numero_intento);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_validaciones_metodos_validacion
  ON public.cajas_cierres_validaciones_metodos (id_validacion_cierre);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_validaciones_metodos_codigo
  ON public.cajas_cierres_validaciones_metodos (metodo_pago_codigo);

COMMENT ON TABLE public.cajas_cierres_validaciones IS
  'Intentos auditables de revision de diferencias previos al cierre formal de caja.';

COMMENT ON TABLE public.cajas_cierres_validaciones_metodos IS
  'Detalle por metodo de pago declarado en cada intento de revision de diferencias.';
