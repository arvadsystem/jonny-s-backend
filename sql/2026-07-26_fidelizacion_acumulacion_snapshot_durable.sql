BEGIN;

-- Snapshot historico de elegibilidad para la reserva durable de acumulacion
-- de puntos de fidelizacion.
--
-- ORDEN EXACTO DE EJECUCION (ninguna de las tres ha sido ejecutada todavia
-- en QA ni en produccion; deben aplicarse en este orden):
--   1) sql/2026-07-25_fidelizacion_acumulacion_habilitada.sql
--        -> agrega fidelizacion_configuracion_sucursal.acumulacion_habilitada
--   2) sql/2026-07-26_fidelizacion_acumulacion_facturas_estado.sql
--        -> crea la tabla fidelizacion_acumulacion_facturas_estado (PK id_factura,
--           CHECK de estados, indice parcial PENDING/RETRYABLE_ERROR)
--   3) sql/2026-07-26_fidelizacion_acumulacion_snapshot_durable.sql  <-- ESTA
--        -> agrega las columnas de snapshot historico a esa misma tabla
-- Esta migracion depende de (2): si (2) no se aplico, el ALTER falla porque la
-- tabla no existe. No hay dependencia con (1) mas alla del orden logico.
--
-- POR QUE: la reserva PENDING ahora se crea DENTRO de la transaccion
-- financiera que confirma el pago (ver
-- modules/fidelizacion/application/reservePaidInvoiceAccumulation.js), antes
-- del COMMIT. Guardar en ese momento el nombre/telefono/elegibilidad
-- convierte la fila en evidencia historica inmutable: si el proceso se
-- reinicia entre el COMMIT financiero y el drenado de la cola en memoria, la
-- reconciliacion posterior decide con estos datos y NUNCA con el perfil
-- actual del cliente (que pudo cambiar despues de la compra).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS permite reaplicarla sin error.
-- No modifica datos historicos ni otorga puntos retroactivos: las filas
-- existentes (si las hubiera) quedan con snapshot NULL, y el codigo trata un
-- snapshot ausente como "sin evidencia confiable".
ALTER TABLE public.fidelizacion_acumulacion_facturas_estado
  -- Contexto de la factura, capturado en la reserva (evita re-resolverlo despues).
  ADD COLUMN IF NOT EXISTS id_pedido integer,
  ADD COLUMN IF NOT EXISTS id_cliente integer,
  ADD COLUMN IF NOT EXISTS id_sucursal integer,
  -- Origen del pedido tal como estaba persistido en pedidos.origen_pedido
  -- ('MENU' | 'CAJA' | NULL). Ver utils/pedidoOrigen.js para la clasificacion
  -- canonica compartida entre Ventas y Fidelizacion.
  ADD COLUMN IF NOT EXISTS origen_pedido varchar(30),
  -- Snapshot del perfil AL MOMENTO DEL PAGO. Para pedidos del menu publico
  -- proviene de pedidos_contacto (nombre_contacto / telefono_normalizado);
  -- para el resto, del perfil maestro vigente en ese instante
  -- (personas.nombre o empresas.nombre_empresa + su telefono asociado).
  ADD COLUMN IF NOT EXISTS nombre_snapshot text,
  ADD COLUMN IF NOT EXISTS telefono_snapshot varchar(20),
  -- Resultado ya evaluado de la regla de elegibilidad en ese momento:
  -- cliente activo + nombre no vacio + telefono valido (normalizePhoneHN).
  -- NULL = reserva sin snapshot (fila legada): sin evidencia confiable.
  ADD COLUMN IF NOT EXISTS perfil_completo_snapshot boolean;

COMMENT ON COLUMN public.fidelizacion_acumulacion_facturas_estado.perfil_completo_snapshot IS
  'Elegibilidad del cliente evaluada AL MOMENTO DEL PAGO. La reconciliacion posterior usa este valor y nunca el perfil actual.';

-- La PK sigue siendo id_factura (definida en la migracion 2): es la garantia
-- de idempotencia -una factura no puede tener dos reservas- y la ultima linea
-- de defensa ante dos callbacks de pago duplicados.
-- El indice parcial para los estados reintentables tambien viene de la
-- migracion 2; se reafirma aqui por si esta migracion se aplica sobre una
-- tabla creada manualmente sin el.
CREATE INDEX IF NOT EXISTS idx_fidelizacion_acum_facturas_estado_retryable
  ON public.fidelizacion_acumulacion_facturas_estado (estado)
  WHERE estado IN ('PENDING', 'RETRYABLE_ERROR');

COMMIT;

-- Verificacion read-only posterior (no ejecutar como parte de esta migracion):
--
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'fidelizacion_acumulacion_facturas_estado'
--   AND column_name IN ('id_pedido','id_cliente','id_sucursal','origen_pedido',
--                       'nombre_snapshot','telefono_snapshot','perfil_completo_snapshot')
-- ORDER BY column_name;
-- Debe devolver las 7 filas, todas is_nullable = YES.
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.fidelizacion_acumulacion_facturas_estado'::regclass;
-- Debe seguir incluyendo la PK sobre id_factura y el CHECK de estados
-- ('PENDING','PROCESSED','SKIPPED_TERMINAL','RETRYABLE_ERROR').
--
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'fidelizacion_acumulacion_facturas_estado';
-- Debe incluir idx_fidelizacion_acum_facturas_estado_retryable.
--
-- SELECT count(*) FILTER (WHERE perfil_completo_snapshot IS NOT NULL) AS con_snapshot,
--        count(*) AS total
-- FROM public.fidelizacion_acumulacion_facturas_estado;
-- Inmediatamente despues de aplicar: con_snapshot = 0 (ninguna fila historica
-- recibe snapshot automaticamente; solo las reservas nuevas lo traen).

-- Rollback explicito (no ejecutar salvo que se decida revertir). Seguro:
-- son columnas nuevas y nullable; eliminarlas no toca ninguna fila de
-- movimientos, saldos ni facturas. Solo se pierde el snapshot de las
-- reservas creadas mientras estuvo desplegado este codigo.
-- BEGIN;
-- ALTER TABLE public.fidelizacion_acumulacion_facturas_estado
--   DROP COLUMN IF EXISTS perfil_completo_snapshot,
--   DROP COLUMN IF EXISTS telefono_snapshot,
--   DROP COLUMN IF EXISTS nombre_snapshot,
--   DROP COLUMN IF EXISTS origen_pedido,
--   DROP COLUMN IF EXISTS id_sucursal,
--   DROP COLUMN IF EXISTS id_cliente,
--   DROP COLUMN IF EXISTS id_pedido;
-- COMMIT;
