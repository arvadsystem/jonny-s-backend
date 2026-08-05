-- Internal financial idempotency state must not be reachable through the Data API.
-- The backend connects directly as the table owner and does not rely on public roles.

REVOKE ALL PRIVILEGES
ON TABLE public.ventas_idempotency_keys
FROM anon, authenticated;

ALTER TABLE public.ventas_idempotency_keys
ENABLE ROW LEVEL SECURITY;
