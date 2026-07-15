-- Transactional outbox para correos de cierre de caja.
-- No ejecutar directamente en produccion sin el proceso normal de migraciones.

CREATE TABLE IF NOT EXISTS public.cajas_cierres_notificaciones_email (
  id_notificacion BIGSERIAL PRIMARY KEY,
  id_cierre_caja BIGINT NOT NULL REFERENCES public.cajas_cierres(id_cierre_caja),
  estado TEXT NOT NULL DEFAULT 'PENDIENTE',
  intentos INTEGER NOT NULL DEFAULT 0,
  proximo_intento TIMESTAMPTZ NULL DEFAULT NOW(),
  bloqueado_hasta TIMESTAMPTZ NULL,
  ultimo_error TEXT NULL,
  email_destino TEXT NULL,
  message_id TEXT NULL,
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_envio TIMESTAMPTZ NULL,
  CONSTRAINT uq_cajas_cierres_notificaciones_email_cierre UNIQUE (id_cierre_caja),
  CONSTRAINT ck_cajas_cierres_notificaciones_email_estado CHECK (
    estado IN ('PENDIENTE', 'PROCESANDO', 'ENVIADO', 'REINTENTO', 'FALLIDO')
  ),
  CONSTRAINT ck_cajas_cierres_notificaciones_email_intentos CHECK (intentos >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_notificaciones_email_pending
  ON public.cajas_cierres_notificaciones_email (estado, proximo_intento, id_notificacion)
  WHERE estado IN ('PENDIENTE', 'REINTENTO');

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_notificaciones_email_locked
  ON public.cajas_cierres_notificaciones_email (estado, bloqueado_hasta, id_notificacion)
  WHERE estado = 'PROCESANDO';
