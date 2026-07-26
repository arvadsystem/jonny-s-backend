BEGIN;

-- Tabla de estado de procesamiento por factura para la acumulacion de
-- puntos de fidelizacion (bloqueante: acumulacion retroactiva despues de
-- completar el perfil del cliente).
--
-- No existe en el modelo actual un snapshot inmutable del nombre/telefono
-- del cliente al momento de la compra (se reviso facturas, pedidos y las
-- tablas de fidelizacion existentes: no hay columnas ni tabla con esa
-- fotografia historica). Esta tabla es el sustituto: registra, por
-- id_factura, el resultado DEFINITIVO de la primera vez que se determino su
-- elegibilidad, para que una reconciliacion posterior nunca vuelva a evaluar
-- el perfil ACTUAL del cliente sobre una factura ya resuelta.
--
-- Regla de negocio que hace cumplir (junto con el codigo de
-- modules/fidelizacion): completar el perfil permite acumular en COMPRAS
-- FUTURAS; nunca recupera automaticamente una factura antigua que ya quedo
-- terminal por perfil incompleto.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS evita error si ya se aplico.
CREATE TABLE IF NOT EXISTS public.fidelizacion_acumulacion_facturas_estado (
  id_factura integer PRIMARY KEY,
  estado varchar(20) NOT NULL DEFAULT 'PENDING'
    CONSTRAINT fidelizacion_acum_facturas_estado_valido
    CHECK (estado IN ('PENDING', 'PROCESSED', 'SKIPPED_TERMINAL', 'RETRYABLE_ERROR')),
  -- Motivo de negocio cuando estado = SKIPPED_TERMINAL (p.ej.
  -- CLIENT_PROFILE_INCOMPLETE, ACCUMULATION_DISABLED,
  -- ACCUMULATION_RULE_NOT_CONFIGURED, POINTS_ROUND_DOWN_TO_ZERO,
  -- LEGACY_ELIGIBILITY_UNVERIFIABLE); NULL para PENDING/PROCESSED.
  motivo varchar(60),
  -- true si la factura llego a generar puntos; false si quedo terminal sin
  -- puntos; NULL mientras sigue pendiente o en reintento.
  elegibilidad_determinada boolean,
  -- Fecha de pago/facturacion de la factura (la misma referencia historica
  -- que ya usa getActiveFidelizacionConfig para la config vigente).
  fecha_referencia timestamptz,
  fecha_creacion timestamptz NOT NULL DEFAULT NOW(),
  fecha_actualizacion timestamptz NOT NULL DEFAULT NOW(),
  intentos integer NOT NULL DEFAULT 0,
  ultimo_error text
);

COMMENT ON TABLE public.fidelizacion_acumulacion_facturas_estado IS
  'Estado de procesamiento por factura de la acumulacion de puntos de fidelizacion. PK id_factura garantiza idempotencia; ver modules/fidelizacion/infrastructure/fidelizacionRepository.js.';

-- Indice para la consulta de reconciliacion (modules/fidelizacion/workers/reconcileMissingPoints.js):
-- solo debe reintentar PENDING/RETRYABLE_ERROR, nunca estados terminales.
CREATE INDEX IF NOT EXISTS idx_fidelizacion_acum_facturas_estado_retryable
  ON public.fidelizacion_acumulacion_facturas_estado (estado)
  WHERE estado IN ('PENDING', 'RETRYABLE_ERROR');

COMMIT;

-- Verificacion read-only posterior (no ejecutar como parte de esta migracion):
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'fidelizacion_acumulacion_facturas_estado'
-- ORDER BY ordinal_position;
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.fidelizacion_acumulacion_facturas_estado'::regclass;
-- Debe incluir la PK sobre id_factura y el CHECK de estado.
--
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'fidelizacion_acumulacion_facturas_estado';
-- Debe incluir idx_fidelizacion_acum_facturas_estado_retryable (parcial, PENDING/RETRYABLE_ERROR).
--
-- SELECT count(*) AS filas_iniciales
-- FROM public.fidelizacion_acumulacion_facturas_estado;
-- Debe devolver 0 inmediatamente despues de aplicar esta migracion (tabla nueva, sin datos).

-- Rollback explicito (no ejecutar salvo que se decida revertir; seguro
-- porque es una tabla nueva que nadie usa hasta que este codigo se
-- despliegue -- no hay perdida de datos historicos al eliminarla):
-- BEGIN;
-- DROP INDEX IF EXISTS public.idx_fidelizacion_acum_facturas_estado_retryable;
-- DROP TABLE IF EXISTS public.fidelizacion_acumulacion_facturas_estado;
-- COMMIT;
