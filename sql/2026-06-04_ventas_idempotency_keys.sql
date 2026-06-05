CREATE TABLE IF NOT EXISTS public.ventas_idempotency_keys (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  request_hash text NOT NULL,
  id_usuario integer NULL,
  id_sucursal integer NULL,
  id_pedido integer NULL,
  id_factura integer NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  http_status integer NULL,
  response_body jsonb NULL,
  error_code text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT ck_ventas_idempotency_status
    CHECK (status IN ('IN_PROGRESS', 'SUCCESS', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_ventas_idempotency_usuario_fecha
  ON public.ventas_idempotency_keys (id_usuario, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ventas_idempotency_pedido
  ON public.ventas_idempotency_keys (id_pedido)
  WHERE id_pedido IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_idempotency_factura
  ON public.ventas_idempotency_keys (id_factura)
  WHERE id_factura IS NOT NULL;
