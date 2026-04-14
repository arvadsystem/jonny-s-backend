BEGIN;

ALTER TABLE public.sucursales
  ADD COLUMN IF NOT EXISTS hora_inicio time without time zone,
  ADD COLUMN IF NOT EXISTS hora_final time without time zone,
  ADD COLUMN IF NOT EXISTS id_archivo_imagen integer NULL REFERENCES public.archivos(id_archivo);

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS visible_en_cocina_at timestamp without time zone;

UPDATE public.pedidos
SET visible_en_cocina_at = COALESCE(visible_en_cocina_at, fecha_hora_pedido, NOW())
WHERE visible_en_cocina_at IS NULL;

CREATE TABLE IF NOT EXISTS public.cajas_cierres_auditoria (
  id_cierre_auditoria bigserial PRIMARY KEY,
  id_cierre_caja bigint NOT NULL REFERENCES public.cajas_cierres(id_cierre_caja),
  id_usuario_accion integer NOT NULL REFERENCES public.usuarios(id_usuario),
  accion varchar(30) NOT NULL,
  motivo varchar(500) NOT NULL,
  snapshot_before jsonb NOT NULL,
  snapshot_after jsonb NOT NULL,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cajas_cierres_planilla_movimientos (
  id_cierre_planilla_movimiento bigserial PRIMARY KEY,
  id_cierre_caja bigint NOT NULL UNIQUE REFERENCES public.cajas_cierres(id_cierre_caja),
  id_movimiento_planilla integer NOT NULL REFERENCES public.movimiento_planilla(id_movimiento_planilla),
  id_planilla integer NOT NULL REFERENCES public.planillas(id_planilla),
  activo boolean NOT NULL DEFAULT true,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT NOW(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_auditoria_cierre
  ON public.cajas_cierres_auditoria (id_cierre_caja, fecha_creacion DESC);

CREATE INDEX IF NOT EXISTS idx_cajas_cierres_planilla_movimientos_planilla
  ON public.cajas_cierres_planilla_movimientos (id_planilla, activo);

CREATE OR REPLACE VIEW public.vw_cajas_sesiones_resumen AS
WITH cobros AS (
    SELECT
      fc.id_sesion_caja,
      COALESCE(SUM(CASE WHEN mp.afecta_efectivo IS TRUE THEN fc.monto ELSE 0 END), 0)::numeric(12,2) AS ventas_efectivo,
      COALESCE(SUM(CASE WHEN mp.afecta_efectivo IS FALSE THEN fc.monto ELSE 0 END), 0)::numeric(12,2) AS ventas_no_efectivo
    FROM public.facturas_cobros fc
    INNER JOIN public.cat_metodos_pago mp ON mp.id_metodo_pago = fc.id_metodo_pago
    GROUP BY fc.id_sesion_caja
  ),
  movimientos AS (
    SELECT
      cm.id_sesion_caja,
      COALESCE(SUM(CASE
        WHEN mt.signo = 1 AND UPPER(TRIM(mt.codigo)) <> 'APERTURA' THEN cm.monto
        ELSE 0
      END), 0)::numeric(12,2) AS ingresos_manuales,
      COALESCE(SUM(CASE WHEN mt.signo = -1 THEN cm.monto ELSE 0 END), 0)::numeric(12,2) AS egresos_manuales
    FROM public.cajas_movimientos cm
    INNER JOIN public.cat_cajas_movimientos_tipos mt ON mt.id_tipo_movimiento_caja = cm.id_tipo_movimiento_caja
    GROUP BY cm.id_sesion_caja
  )
SELECT
  cs.id_sesion_caja,
  cs.id_caja,
  cs.id_sucursal,
  cs.id_usuario_responsable,
  cs.id_estado_sesion_caja,
  cs.fecha_apertura,
  cs.fecha_cierre,
  cs.monto_apertura,
  COALESCE(c.ventas_efectivo, 0)::numeric(12,2) AS ventas_efectivo,
  COALESCE(c.ventas_no_efectivo, 0)::numeric(12,2) AS ventas_no_efectivo,
  COALESCE(m.ingresos_manuales, 0)::numeric(12,2) AS ingresos_manuales,
  COALESCE(m.egresos_manuales, 0)::numeric(12,2) AS egresos_manuales,
  (COALESCE(cs.monto_apertura, 0) + COALESCE(c.ventas_efectivo, 0) + COALESCE(m.ingresos_manuales, 0) - COALESCE(m.egresos_manuales, 0))::numeric(12,2) AS efectivo_teorico,
  cs.monto_declarado_cierre,
  cs.diferencia_cierre,
  cs.id_resolucion_cierre_caja
FROM public.cajas_sesiones cs
LEFT JOIN cobros c ON c.id_sesion_caja = cs.id_sesion_caja
LEFT JOIN movimientos m ON m.id_sesion_caja = cs.id_sesion_caja;

UPDATE public.cat_cajas_arqueos_tipos
SET estado = CASE WHEN UPPER(TRIM(codigo)) IN ('CIERRE', 'EXTRAORDINARIO') THEN true ELSE false END,
    fecha_actualizacion = NOW();

COMMIT;
