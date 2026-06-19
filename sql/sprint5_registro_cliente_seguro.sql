-- Sprint 5: Registro cliente + verificacion segura + ajustes clientes

CREATE TABLE IF NOT EXISTS public.verificacion_cuentas_tokens (
  id_token BIGSERIAL PRIMARY KEY,
  id_usuario INTEGER NOT NULL REFERENCES public.usuarios(id_usuario) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL,
  request_ip TEXT NULL,
  user_agent TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verificacion_tokens_usuario
  ON public.verificacion_cuentas_tokens (id_usuario);

CREATE INDEX IF NOT EXISTS idx_verificacion_tokens_exp
  ON public.verificacion_cuentas_tokens (token_expires_at);

-- Fecha automatica para nuevos clientes.
ALTER TABLE IF EXISTS public.clientes
  ALTER COLUMN fecha_ingreso SET DEFAULT CURRENT_DATE;
