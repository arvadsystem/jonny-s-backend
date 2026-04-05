BEGIN;

-- AM: historial persistente de evidencias del flujo OC (factura recepcion + deposito/transferencia).
CREATE TABLE IF NOT EXISTS public.orden_compra_evidencias_historial (
  id_historial_evidencia bigserial PRIMARY KEY,
  id_orden_compra integer NOT NULL,
  id_compra integer NULL,
  tipo_evidencia varchar(40) NOT NULL,
  id_archivo integer NOT NULL,
  id_usuario_registro integer NULL,
  origen_etapa varchar(40) NULL,
  fecha_registro timestamp without time zone NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_oc_evid_hist_orden
    FOREIGN KEY (id_orden_compra) REFERENCES public.orden_compras(id_orden_compra) ON DELETE CASCADE,
  CONSTRAINT fk_oc_evid_hist_compra
    FOREIGN KEY (id_compra) REFERENCES public.compras(id_compra) ON DELETE SET NULL,
  CONSTRAINT fk_oc_evid_hist_archivo
    FOREIGN KEY (id_archivo) REFERENCES public.archivos(id_archivo),
  CONSTRAINT fk_oc_evid_hist_usuario
    FOREIGN KEY (id_usuario_registro) REFERENCES public.usuarios(id_usuario),
  CONSTRAINT chk_oc_evid_hist_tipo
    CHECK (tipo_evidencia IN ('FACTURA_RECEPCION', 'DEPOSITO_TRANSFERENCIA'))
);

CREATE INDEX IF NOT EXISTS idx_oc_evid_hist_orden_fecha
  ON public.orden_compra_evidencias_historial (id_orden_compra, fecha_registro DESC);

CREATE INDEX IF NOT EXISTS idx_oc_evid_hist_tipo
  ON public.orden_compra_evidencias_historial (tipo_evidencia);

CREATE UNIQUE INDEX IF NOT EXISTS uq_oc_evid_hist_unica
  ON public.orden_compra_evidencias_historial (
    id_orden_compra,
    tipo_evidencia,
    id_archivo,
    COALESCE(id_compra, 0)
  );

-- AM: trigger para registrar automaticamente factura de recepcion asociada a OC.
CREATE OR REPLACE FUNCTION public.fn_oc_log_factura_recepcion_historial()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id_archivo_factura_recepcion IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.id_archivo_factura_recepcion IS DISTINCT FROM OLD.id_archivo_factura_recepcion THEN
    INSERT INTO public.orden_compra_evidencias_historial (
      id_orden_compra,
      id_compra,
      tipo_evidencia,
      id_archivo,
      id_usuario_registro,
      origen_etapa
    )
    VALUES (
      NEW.id_orden_compra,
      NULL,
      'FACTURA_RECEPCION',
      NEW.id_archivo_factura_recepcion,
      COALESCE(NEW.id_usuario_recepcion, NEW.id_usuario_abastecedor, NEW.id_usuario_revisor, NEW.id_usuario),
      'RECEPCION_SUCURSAL'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oc_log_factura_recepcion_historial ON public.orden_compras;
CREATE TRIGGER trg_oc_log_factura_recepcion_historial
AFTER INSERT OR UPDATE OF id_archivo_factura_recepcion
ON public.orden_compras
FOR EACH ROW
EXECUTE FUNCTION public.fn_oc_log_factura_recepcion_historial();

-- AM: trigger para registrar automaticamente comprobante de deposito/transferencia en compras.
CREATE OR REPLACE FUNCTION public.fn_oc_log_transferencia_historial()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_usuario_registro integer;
BEGIN
  IF NEW.id_archivo_transferencia IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.id_archivo_transferencia IS DISTINCT FROM OLD.id_archivo_transferencia THEN
    SELECT COALESCE(oc.id_usuario_abastecedor, oc.id_usuario_revisor, oc.id_usuario)
    INTO v_usuario_registro
    FROM public.orden_compras oc
    WHERE oc.id_orden_compra = NEW.id_orden_compra
    LIMIT 1;

    INSERT INTO public.orden_compra_evidencias_historial (
      id_orden_compra,
      id_compra,
      tipo_evidencia,
      id_archivo,
      id_usuario_registro,
      origen_etapa
    )
    VALUES (
      NEW.id_orden_compra,
      NEW.id_compra,
      'DEPOSITO_TRANSFERENCIA',
      NEW.id_archivo_transferencia,
      v_usuario_registro,
      'CONVERSION_ADMIN'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oc_log_transferencia_historial ON public.compras;
CREATE TRIGGER trg_oc_log_transferencia_historial
AFTER INSERT OR UPDATE OF id_archivo_transferencia
ON public.compras
FOR EACH ROW
EXECUTE FUNCTION public.fn_oc_log_transferencia_historial();

-- AM: backfill defensivo para OC historicas que ya tienen factura/transferencia asociada.
INSERT INTO public.orden_compra_evidencias_historial (
  id_orden_compra,
  id_compra,
  tipo_evidencia,
  id_archivo,
  id_usuario_registro,
  origen_etapa,
  fecha_registro
)
SELECT
  oc.id_orden_compra,
  NULL::integer AS id_compra,
  'FACTURA_RECEPCION'::varchar(40) AS tipo_evidencia,
  oc.id_archivo_factura_recepcion,
  COALESCE(oc.id_usuario_recepcion, oc.id_usuario_abastecedor, oc.id_usuario_revisor, oc.id_usuario) AS id_usuario_registro,
  'RECEPCION_SUCURSAL'::varchar(40) AS origen_etapa,
  COALESCE(oc.fecha_recepcion_reportada, oc.fecha_revision, oc.fecha_abastecimiento, NOW()) AS fecha_registro
FROM public.orden_compras oc
WHERE oc.id_archivo_factura_recepcion IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO public.orden_compra_evidencias_historial (
  id_orden_compra,
  id_compra,
  tipo_evidencia,
  id_archivo,
  id_usuario_registro,
  origen_etapa,
  fecha_registro
)
SELECT
  c.id_orden_compra,
  c.id_compra,
  'DEPOSITO_TRANSFERENCIA'::varchar(40) AS tipo_evidencia,
  c.id_archivo_transferencia,
  COALESCE(oc.id_usuario_abastecedor, oc.id_usuario_revisor, oc.id_usuario) AS id_usuario_registro,
  'CONVERSION_ADMIN'::varchar(40) AS origen_etapa,
  COALESCE(c.fecha::timestamp, NOW()) AS fecha_registro
FROM public.compras c
LEFT JOIN public.orden_compras oc ON oc.id_orden_compra = c.id_orden_compra
WHERE c.id_archivo_transferencia IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
