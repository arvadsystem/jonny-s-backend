-- Cola de impresion aislada por sucursal y agentes locales revocables.
-- No ejecutar automaticamente. Aplicar primero en QA y validar al final de este archivo.

BEGIN;

CREATE TABLE IF NOT EXISTS public.agentes_impresion (
  id_agente UUID PRIMARY KEY,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  nombre VARCHAR(120) NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'activo'
    CHECK (estado IN ('activo', 'revocado', 'inactivo')),
  token_hash CHAR(64) NOT NULL,
  token_ultimos_4 CHAR(4) NOT NULL,
  ultimo_heartbeat_at TIMESTAMPTZ NULL,
  version VARCHAR(40) NULL,
  fecha_revocacion TIMESTAMPTZ NULL,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id_sucursal, nombre)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agentes_impresion_token_hash
  ON public.agentes_impresion (token_hash);
CREATE INDEX IF NOT EXISTS idx_agentes_impresion_sucursal_estado
  ON public.agentes_impresion (id_sucursal, estado);

CREATE TABLE IF NOT EXISTS public.trabajos_impresion (
  id_trabajo BIGSERIAL PRIMARY KEY,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  tipo_documento VARCHAR(30) NOT NULL
    CHECK (tipo_documento IN ('factura', 'comanda', 'caja')),
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'asignado', 'imprimiendo', 'confirmacion_pendiente', 'impreso', 'fallido', 'cancelado')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key VARCHAR(160) NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0 CHECK (intentos >= 0),
  max_intentos INTEGER NOT NULL DEFAULT 5 CHECK (max_intentos BETWEEN 1 AND 20),
  disponible_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_at TIMESTAMPTZ NULL,
  lease_expires_at TIMESTAMPTZ NULL,
  finalizado_at TIMESTAMPTZ NULL,
  id_agente_tomado UUID NULL REFERENCES public.agentes_impresion(id_agente),
  id_factura INTEGER NULL REFERENCES public.facturas(id_factura),
  id_pedido INTEGER NULL REFERENCES public.pedidos(id_pedido),
  id_usuario_solicitante INTEGER NULL REFERENCES public.usuarios(id_usuario),
  es_reimpresion BOOLEAN NOT NULL DEFAULT false,
  error_sanitizado VARCHAR(1000) NULL,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id_sucursal, idempotency_key, tipo_documento)
);

CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_claim
  ON public.trabajos_impresion (id_sucursal, estado, disponible_at, fecha_creacion)
  WHERE estado IN ('pendiente', 'asignado', 'imprimiendo');
CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_lease
  ON public.trabajos_impresion (lease_expires_at)
  WHERE estado IN ('asignado', 'imprimiendo');
CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_factura
  ON public.trabajos_impresion (id_factura, fecha_creacion DESC);

CREATE TABLE IF NOT EXISTS public.trabajos_impresion_eventos (
  id_evento BIGSERIAL PRIMARY KEY,
  id_trabajo BIGINT NOT NULL REFERENCES public.trabajos_impresion(id_trabajo) ON DELETE CASCADE,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  id_agente UUID NULL REFERENCES public.agentes_impresion(id_agente),
  id_usuario INTEGER NULL REFERENCES public.usuarios(id_usuario),
  evento VARCHAR(40) NOT NULL,
  estado_anterior VARCHAR(30) NULL,
  estado_nuevo VARCHAR(30) NULL,
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detalle) = 'object'),
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trabajos_impresion_eventos_trabajo
  ON public.trabajos_impresion_eventos (id_trabajo, fecha_creacion DESC);

CREATE TABLE IF NOT EXISTS public.firmas_qz_agente_solicitudes (
  id_firma BIGSERIAL PRIMARY KEY,
  id_trabajo BIGINT NOT NULL REFERENCES public.trabajos_impresion(id_trabajo) ON DELETE CASCADE,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  id_agente UUID NOT NULL REFERENCES public.agentes_impresion(id_agente),
  llamada VARCHAR(40) NOT NULL CHECK (llamada IN ('printers.find', 'print')),
  request_hash CHAR(64) NOT NULL,
  request_timestamp BIGINT NOT NULL,
  printer_name VARCHAR(160) NULL,
  signature TEXT NOT NULL,
  expira_at TIMESTAMPTZ NOT NULL,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id_agente, id_trabajo, llamada, request_hash)
);

CREATE INDEX IF NOT EXISTS idx_firmas_qz_agente_trabajo
  ON public.firmas_qz_agente_solicitudes (id_trabajo, fecha_creacion DESC);
CREATE INDEX IF NOT EXISTS idx_firmas_qz_agente_expira
  ON public.firmas_qz_agente_solicitudes (expira_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_firmas_qz_agente_print_trabajo
  ON public.firmas_qz_agente_solicitudes (id_agente, id_trabajo, llamada)
  WHERE llamada = 'print';

ALTER TABLE public.agentes_impresion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trabajos_impresion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trabajos_impresion_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firmas_qz_agente_solicitudes ENABLE ROW LEVEL SECURITY;

-- El backend usa conexion PostgreSQL directa mediante DB_USER. El propietario conserva
-- privilegios nativos; no se conceden permisos a roles de Supabase Data API.
REVOKE ALL ON TABLE public.agentes_impresion FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.trabajos_impresion FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.trabajos_impresion_eventos FROM anon, authenticated, service_role;
REVOKE ALL ON TABLE public.firmas_qz_agente_solicitudes FROM anon, authenticated, service_role;

REVOKE ALL ON SEQUENCE public.trabajos_impresion_id_trabajo_seq FROM anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.trabajos_impresion_eventos_id_evento_seq FROM anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.firmas_qz_agente_solicitudes_id_firma_seq FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reclamar_trabajos_impresion(
  p_id_agente UUID,
  p_limite INTEGER DEFAULT 1,
  p_lease_segundos INTEGER DEFAULT 90
)
RETURNS SETOF public.trabajos_impresion
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id_sucursal INTEGER;
BEGIN
  SELECT id_sucursal INTO v_id_sucursal
  FROM public.agentes_impresion
  WHERE id_agente = p_id_agente AND estado = 'activo'
  FOR UPDATE;

  IF v_id_sucursal IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'AGENTE_IMPRESION_NO_AUTORIZADO';
  END IF;

  -- El bloqueo del agente serializa claims concurrentes del mismo proceso/credencial.
  -- Si ya conserva un lease activo, no se toma un segundo trabajo.
  IF EXISTS (
    SELECT 1
    FROM public.trabajos_impresion t
    WHERE t.id_agente_tomado = p_id_agente
      AND t.estado IN ('asignado', 'imprimiendo')
      AND t.lease_expires_at > now()
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidatos AS (
    SELECT t.id_trabajo
    FROM public.trabajos_impresion t
    WHERE t.id_sucursal = v_id_sucursal
      AND t.intentos < t.max_intentos
      AND t.disponible_at <= now()
      AND (
        t.estado = 'pendiente'
        OR (t.estado IN ('asignado', 'imprimiendo') AND t.lease_expires_at < now())
      )
    ORDER BY t.fecha_creacion, t.id_trabajo
    FOR UPDATE SKIP LOCKED
    -- Primera version: nunca tomar un segundo lease mientras el agente procesa otro trabajo.
    LIMIT 1
  )
  UPDATE public.trabajos_impresion t
  SET estado = 'asignado',
      id_agente_tomado = p_id_agente,
      intentos = t.intentos + 1,
      lease_at = now(),
      lease_expires_at = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_segundos, 90), 30), 600)),
      error_sanitizado = NULL,
      fecha_actualizacion = now()
  FROM candidatos c
  WHERE t.id_trabajo = c.id_trabajo
  RETURNING t.*;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reclamar_trabajos_impresion(UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

-- Verificacion QA:
-- 1) Tablas y RLS (las cuatro deben mostrar rowsecurity=true):
-- SELECT c.relname, c.relrowsecurity
-- FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
-- WHERE n.nspname='public' AND c.relname IN
-- ('agentes_impresion','trabajos_impresion','trabajos_impresion_eventos','firmas_qz_agente_solicitudes');
--
-- 2) ACL: anon/authenticated no deben tener privilegios; tampoco service_role porque
-- el backend usa conexion PostgreSQL directa:
-- SELECT table_name, grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema='public'
--   AND table_name IN ('agentes_impresion','trabajos_impresion','trabajos_impresion_eventos','firmas_qz_agente_solicitudes')
--   AND grantee IN ('anon','authenticated','service_role');
-- SELECT tablename,policyname,roles FROM pg_policies
-- WHERE schemaname='public' AND tablename IN
-- ('agentes_impresion','trabajos_impresion','trabajos_impresion_eventos','firmas_qz_agente_solicitudes');
--
-- 3) Secuencias sin USAGE para Data API (todos deben ser false):
-- SELECT has_sequence_privilege('anon','public.trabajos_impresion_id_trabajo_seq','USAGE') AS anon_jobs,
--        has_sequence_privilege('authenticated','public.trabajos_impresion_eventos_id_evento_seq','USAGE') AS authenticated_events,
--        has_sequence_privilege('service_role','public.firmas_qz_agente_solicitudes_id_firma_seq','USAGE') AS service_signatures;
--
-- 4) Funcion sin EXECUTE publico/Data API (todos deben ser false):
-- SELECT has_function_privilege('PUBLIC','public.reclamar_trabajos_impresion(uuid,integer,integer)','EXECUTE') AS public_execute,
--        has_function_privilege('anon','public.reclamar_trabajos_impresion(uuid,integer,integer)','EXECUTE') AS anon_execute,
--        has_function_privilege('authenticated','public.reclamar_trabajos_impresion(uuid,integer,integer)','EXECUTE') AS authenticated_execute;
--
-- 5) Hash QZ, constraints e indices:
-- SELECT data_type, character_maximum_length
-- FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='firmas_qz_agente_solicitudes' AND column_name='request_hash';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid IN ('public.trabajos_impresion'::regclass,'public.firmas_qz_agente_solicitudes'::regclass);
-- SELECT tablename,indexname,indexdef FROM pg_indexes
-- WHERE schemaname='public' AND tablename IN ('trabajos_impresion','firmas_qz_agente_solicitudes');
