BEGIN;

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS validacion_pago_vence_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS pago_confirmado_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS cancelado_por_timeout_at TIMESTAMP NULL,
  ADD COLUMN IF NOT EXISTS id_usuario_pago_confirmado INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pedidos_id_usuario_pago_confirmado_fkey'
  ) THEN
    ALTER TABLE public.pedidos
      ADD CONSTRAINT pedidos_id_usuario_pago_confirmado_fkey
      FOREIGN KEY (id_usuario_pago_confirmado)
      REFERENCES public.usuarios(id_usuario)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pedidos_validacion_pago_vence_at
  ON public.pedidos (validacion_pago_vence_at);

CREATE INDEX IF NOT EXISTS idx_pedidos_estado_pago
  ON public.pedidos (estado_pago);

CREATE INDEX IF NOT EXISTS idx_pedidos_menu_pendiente_pago
  ON public.pedidos (origen_pedido, id_estado_pedido, estado_pago, validacion_pago_vence_at);

UPDATE public.pedidos
SET
  estado_pago = CASE
    WHEN UPPER(TRIM(COALESCE(estado_pago, ''))) IN ('', 'PENDIENTE') THEN 'PENDIENTE_VALIDACION'
    ELSE estado_pago
  END,
  validacion_pago_vence_at = COALESCE(
    validacion_pago_vence_at,
    fecha_hora_pedido + INTERVAL '10 minutes'
  )
WHERE origen_pedido = 'MENU'
  AND UPPER(TRIM(COALESCE(estado_pago, ''))) NOT IN ('PAGADO_CONFIRMADO', 'CANCELADO_TIMEOUT');

COMMIT;
