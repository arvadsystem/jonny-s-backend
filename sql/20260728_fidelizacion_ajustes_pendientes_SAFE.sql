-- Crea public.fidelizacion_ajustes_pendientes: registro durable del
-- remanente de puntos que una reversion de venta no pudo retirar de
-- inmediato porque el cliente ya los habia gastado (ver
-- services/ventasReversionService.js:revertLoyaltyForFactura, que hoy topa
-- "puntosAplicables" al saldo disponible y descarta el resto sin dejar
-- rastro). Esta tabla es prerrequisito de Fase 4; en Fase 1 solo se crea el
-- esquema, ningun codigo de aplicacion la usa todavia.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS). No hace backfill: no hay
-- ningun ajuste pendiente que reconstruir retroactivamente porque el
-- mecanismo no existia antes de esta migracion.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.clientes') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.clientes no existe';
  END IF;
  IF to_regclass('public.facturas') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas no existe';
  END IF;
  IF to_regclass('public.facturas_reversiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones no existe';
  END IF;
  IF to_regclass('public.usuarios') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.usuarios no existe';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.fidelizacion_ajustes_pendientes (
  id_ajuste BIGSERIAL PRIMARY KEY,
  id_cliente INTEGER NOT NULL REFERENCES public.clientes(id_cliente) ON DELETE RESTRICT,
  id_factura INTEGER NOT NULL REFERENCES public.facturas(id_factura) ON DELETE RESTRICT,
  id_reversion BIGINT NOT NULL REFERENCES public.facturas_reversiones(id_reversion) ON DELETE RESTRICT,
  puntos_objetivo INTEGER NOT NULL,
  puntos_recuperados INTEGER NOT NULL DEFAULT 0,
  puntos_pendientes INTEGER NOT NULL,
  estado VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
  id_usuario_ejecutor INTEGER NOT NULL REFERENCES public.usuarios(id_usuario) ON DELETE RESTRICT,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_estado
    CHECK (estado IN ('PENDIENTE', 'PARCIALMENTE_RECUPERADO', 'RECUPERADO')),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_objetivo_positivo
    CHECK (puntos_objetivo > 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_recuperados_no_negativo
    CHECK (puntos_recuperados >= 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_pendientes_no_negativo
    CHECK (puntos_pendientes >= 0),
  CONSTRAINT ck_fidelizacion_ajustes_pendientes_suma_exacta
    CHECK (puntos_recuperados + puntos_pendientes = puntos_objetivo),
  -- Un ajuste pendiente por reversion: si la misma reversion se procesa dos
  -- veces (reintento, doble clic), la segunda insercion debe chocar contra
  -- esta restriccion en vez de duplicar deuda de puntos.
  CONSTRAINT uq_fidelizacion_ajustes_pendientes_reversion UNIQUE (id_reversion)
);

CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_cliente_estado
  ON public.fidelizacion_ajustes_pendientes (id_cliente, estado);

CREATE INDEX IF NOT EXISTS idx_fidelizacion_ajustes_pendientes_factura
  ON public.fidelizacion_ajustes_pendientes (id_factura);

-- id_reversion ya tiene indice implicito por la restriccion UNIQUE anterior;
-- no se crea un indice adicional redundante.

COMMENT ON TABLE public.fidelizacion_ajustes_pendientes IS
  'Deuda de puntos de fidelizacion que una reversion no pudo retirar de inmediato por saldo insuficiente; se recupera via compensacion FIFO en acumulaciones futuras (Fase 4).';

COMMIT;
