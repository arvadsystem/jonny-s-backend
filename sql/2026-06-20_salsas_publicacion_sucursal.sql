BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.salsas
    GROUP BY LOWER(BTRIM(nombre))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migracion cancelada: existen nombres de salsa duplicados al normalizar espacios y mayusculas.';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_salsas_nombre_normalizado
  ON public.salsas (LOWER(BTRIM(nombre)));

CREATE TABLE IF NOT EXISTS public.salsa_sucursales (
  id_salsa_sucursal BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_salsa INTEGER NOT NULL REFERENCES public.salsas(id_salsa),
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal),
  publicada BOOLEAN NOT NULL DEFAULT FALSE,
  estado BOOLEAN NOT NULL DEFAULT TRUE,
  id_usuario_creacion INTEGER REFERENCES public.usuarios(id_usuario),
  id_usuario_actualizacion INTEGER REFERENCES public.usuarios(id_usuario),
  fecha_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_salsa_sucursales_salsa_sucursal UNIQUE (id_salsa, id_sucursal)
);

CREATE INDEX IF NOT EXISTS ix_salsa_sucursales_sucursal
  ON public.salsa_sucursales (id_sucursal, estado, publicada);

CREATE INDEX IF NOT EXISTS ix_salsa_sucursales_salsa
  ON public.salsa_sucursales (id_salsa, estado, publicada);

CREATE INDEX IF NOT EXISTS ix_salsa_sucursales_publicadas_activas
  ON public.salsa_sucursales (id_sucursal, id_salsa)
  WHERE estado IS TRUE AND publicada IS TRUE;

ALTER TABLE public.salsa_sucursales ENABLE ROW LEVEL SECURITY;

-- Compatibilidad inicial: publica solamente salsas activas cuyo inventario
-- canonico ya es resoluble y tiene stock suficiente en una unica asignacion.
WITH candidatos AS (
  SELECT
    s.id_salsa,
    su.id_sucursal
  FROM public.salsas s
  CROSS JOIN public.sucursales su
  JOIN public.insumos_mapeo_maestro mm
    ON mm.id_insumo_legacy = s.id_insumo
   AND mm.estado_migracion = 'VALIDADO'
  JOIN public.insumos i
    ON i.id_insumo = mm.id_insumo_maestro
   AND i.estado IS TRUE
  JOIN public.insumos_almacenes ia
    ON ia.id_insumo = i.id_insumo
   AND COALESCE(ia.estado, TRUE) IS TRUE
  JOIN public.almacenes a
    ON a.id_almacen = ia.id_almacen
   AND a.id_sucursal = su.id_sucursal
   AND COALESCE(a.estado, TRUE) IS TRUE
  WHERE COALESCE(s.estado, TRUE) IS TRUE
    AND COALESCE(su.estado, TRUE) IS TRUE
    AND s.id_insumo IS NOT NULL
    AND s.id_unidad_consumo IS NOT NULL
    AND s.cantidad_porcion > 0
    AND (
      s.id_unidad_consumo = i.id_unidad_medida
      OR 1 = (
        SELECT COUNT(*)
        FROM public.insumo_presentaciones ip
        WHERE ip.id_insumo = i.id_insumo
          AND ip.estado IS TRUE
          AND ip.uso_receta IS TRUE
          AND ip.id_unidad_presentacion = s.id_unidad_consumo
          AND ip.id_unidad_base = i.id_unidad_medida
          AND ip.cantidad_presentacion > 0
          AND ip.cantidad_base > 0
      )
    )
  GROUP BY s.id_salsa, su.id_sucursal, s.cantidad_porcion, s.id_unidad_consumo,
           i.id_unidad_medida, ia.cantidad
  HAVING COUNT(*) = 1
     AND ia.cantidad >= CASE
       WHEN s.id_unidad_consumo = i.id_unidad_medida THEN s.cantidad_porcion
       ELSE COALESCE((
         SELECT MIN(
           s.cantidad_porcion / ip.cantidad_presentacion * ip.cantidad_base
         )
         FROM public.insumo_presentaciones ip
         WHERE ip.id_insumo = i.id_insumo
           AND ip.estado IS TRUE
           AND ip.uso_receta IS TRUE
           AND ip.id_unidad_presentacion = s.id_unidad_consumo
           AND ip.id_unidad_base = i.id_unidad_medida
           AND ip.cantidad_presentacion > 0
           AND ip.cantidad_base > 0
       ), ia.cantidad + 1)
     END
)
INSERT INTO public.salsa_sucursales (
  id_salsa,
  id_sucursal,
  publicada,
  estado
)
SELECT id_salsa, id_sucursal, TRUE, TRUE
FROM candidatos
ON CONFLICT (id_salsa, id_sucursal) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.salsa_sucursales
    GROUP BY id_salsa, id_sucursal
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: existen publicaciones duplicadas.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.salsas
    GROUP BY LOWER(BTRIM(nombre))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: persisten nombres normalizados duplicados.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.salsa_sucursales ss
    JOIN public.salsas s ON s.id_salsa = ss.id_salsa
    JOIN public.sucursales su ON su.id_sucursal = ss.id_sucursal
    WHERE ss.publicada IS TRUE
      AND ss.estado IS TRUE
      AND (
        COALESCE(s.estado, TRUE) IS NOT TRUE
        OR COALESCE(su.estado, TRUE) IS NOT TRUE
        OR s.id_insumo IS NULL
        OR s.id_unidad_consumo IS NULL
        OR s.cantidad_porcion <= 0
      )
  ) THEN
    RAISE EXCEPTION 'Validacion final fallida: existe una publicacion activa con configuracion global invalida.';
  END IF;
END
$$;

COMMIT;

SELECT
  ss.id_salsa,
  s.nombre,
  ss.id_sucursal,
  su.nombre AS sucursal,
  ss.publicada,
  ss.estado
FROM public.salsa_sucursales ss
JOIN public.salsas s ON s.id_salsa = ss.id_salsa
JOIN public.sucursales su ON su.id_sucursal = ss.id_sucursal
ORDER BY s.nombre, su.nombre;
