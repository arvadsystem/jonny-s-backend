-- Bloque D: configuracion de contenido impreso por sucursal.
-- IMPORTANTE: archivo preparado para aplicar manualmente; no fue ejecutado por Codex.

ALTER TABLE public.facturacion_config_sucursal
  ADD COLUMN IF NOT EXISTS mostrar_datos_fiscales boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_cai_ticket boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_numero_fiscal_ticket boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_codigo_interno_ticket boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS aplicar_impuestos boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_impuestos_ticket boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_importe_exento boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_importe_gravado_15 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_isv_15 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_importe_gravado_18 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_isv_18 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_total_isv boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mostrar_descuento_linea boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_descuento_porcentaje_linea boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_descuento_total boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS imprimir_comprobante_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_venta_original_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_codigo_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_usuario_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_caja_sesion_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_motivo_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_detalle_reversion boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mostrar_total_reversion boolean NOT NULL DEFAULT true;

