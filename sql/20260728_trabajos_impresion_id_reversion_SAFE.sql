-- Agrega public.trabajos_impresion.id_reversion (BIGINT NULL), FK hacia
-- public.facturas_reversiones(id_reversion), con indice. Nullable por
-- compatibilidad historica (todo trabajo de factura/comanda/caja existente
-- no tiene reversion asociada y queda NULL).
--
-- No crea una fila 'REVERSION' en configuracion_impresoras: la reversion
-- usara la impresora logica FACTURA ya configurada (ver Fase 5).
--
-- Sobre "evitar trabajos iniciales duplicados sin impedir reimpresiones":
-- NO se agrega ningun indice/constraint unico especulativo sobre
-- id_reversion. La tabla ya tiene UNIQUE (id_sucursal, idempotency_key,
-- tipo_documento) (sql/2026-07-16_cola_impresion_agentes_sucursal.sql:50),
-- y el contrato de Fase 5 fija las claves de idempotencia como
-- 'reversion:{id_reversion}:inicial' (fija, un solo valor posible por
-- reversion -> el UNIQUE existente ya impide un segundo trabajo inicial) y
-- 'reversion:{id_reversion}:reprint:{uuid}' (unica por reimpresion -> el
-- mismo UNIQUE nunca la bloquea). Anadir un UNIQUE(id_reversion) ademas
-- romparía las reimpresiones legitimas, que comparten id_reversion con el
-- trabajo inicial. Por eso esta migracion no agrega esa restriccion.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF to_regclass('public.trabajos_impresion') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.trabajos_impresion no existe';
  END IF;
  IF to_regclass('public.facturas_reversiones') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: public.facturas_reversiones no existe';
  END IF;
END
$preflight$;

ALTER TABLE public.trabajos_impresion
  ADD COLUMN IF NOT EXISTS id_reversion BIGINT NULL;

DO $add_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trabajos_impresion'::regclass
      AND conname = 'fk_trabajos_impresion_reversion'
  ) THEN
    ALTER TABLE public.trabajos_impresion
      ADD CONSTRAINT fk_trabajos_impresion_reversion
      FOREIGN KEY (id_reversion)
      REFERENCES public.facturas_reversiones(id_reversion)
      ON DELETE SET NULL;
  END IF;
END
$add_fk$;

CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_reversion
  ON public.trabajos_impresion (id_reversion, fecha_creacion DESC);

COMMENT ON COLUMN public.trabajos_impresion.id_reversion IS
  'Reversion de venta especifica que origino este trabajo de impresion (tipo_documento=reversion). NULL para trabajos de factura/comanda/caja.';

COMMIT;
