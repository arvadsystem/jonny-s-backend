BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE _salsas_mapeos_demostrados (
  master_id integer PRIMARY KEY,
  legacy_id integer NOT NULL UNIQUE,
  nombre text NOT NULL
) ON COMMIT DROP;

INSERT INTO _salsas_mapeos_demostrados (master_id, legacy_id, nombre)
VALUES
  (29, 194, 'SALSA MANGO HABANERO'),
  (28, 196, 'SALSA ORIENTAL');

DO $$
DECLARE
  pair record;
  table_name text;
  reference_count bigint;
  reference_tables constant text[] := ARRAY[
    'detalle_compras',
    'detalle_factura_extras',
    'detalle_orden_compras',
    'detalle_pedido_extras',
    'detalle_recetas',
    'insumo_presentaciones',
    'insumos_almacenes',
    'menu_extras',
    'movimientos_inventario',
    'orden_compra_solicitudes_item',
    'pedidos_inventario_alertas',
    'salsas'
  ];
BEGIN
  IF (SELECT COUNT(*) FROM _salsas_mapeos_demostrados) <> 2 THEN
    RAISE EXCEPTION 'Preflight cancelado: se esperaban exactamente dos pares demostrados.';
  END IF;

  PERFORM i.id_insumo
  FROM public.insumos i
  JOIN _salsas_mapeos_demostrados p
    ON i.id_insumo IN (p.master_id, p.legacy_id)
  ORDER BY i.id_insumo
  FOR UPDATE OF i;

  PERFORM m.id_insumo_legacy
  FROM public.insumos_mapeo_maestro m
  JOIN _salsas_mapeos_demostrados p
    ON m.id_insumo_maestro = p.master_id
   AND m.id_insumo_legacy IN (p.master_id, p.legacy_id)
  ORDER BY m.id_insumo_legacy
  FOR UPDATE OF m;

  FOR pair IN SELECT * FROM _salsas_mapeos_demostrados ORDER BY master_id
  LOOP
    IF (
      SELECT COUNT(*)
      FROM public.insumos i
      WHERE i.id_insumo IN (pair.master_id, pair.legacy_id)
        AND UPPER(REGEXP_REPLACE(BTRIM(i.nombre_insumo), '\s+', ' ', 'g')) = pair.nombre
    ) <> 2 THEN
      RAISE EXCEPTION 'Preflight cancelado: el par % -> % no coincide exactamente con %.',
        pair.legacy_id, pair.master_id, pair.nombre;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.insumos i
      WHERE i.id_insumo = pair.master_id AND i.estado IS TRUE
    ) THEN
      RAISE EXCEPTION 'Preflight cancelado: maestro % no esta activo.', pair.master_id;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.insumos i
      WHERE i.estado IS TRUE
        AND i.id_insumo NOT IN (pair.master_id, pair.legacy_id)
        AND UPPER(REGEXP_REPLACE(BTRIM(i.nombre_insumo), '\s+', ' ', 'g')) = pair.nombre
    ) THEN
      RAISE EXCEPTION 'Preflight cancelado: % tiene otro registro activo.', pair.nombre;
    END IF;

    IF (
      SELECT COUNT(*)
      FROM public.insumos_mapeo_maestro m
      WHERE m.id_insumo_maestro = pair.master_id
        AND m.id_insumo_legacy IN (pair.master_id, pair.legacy_id)
    ) <> 2 THEN
      RAISE EXCEPTION 'Preflight cancelado: el maestro % no tiene los dos mapeos esperados.', pair.master_id;
    END IF;

    FOREACH table_name IN ARRAY reference_tables
    LOOP
      EXECUTE format('SELECT COUNT(*) FROM public.%I WHERE id_insumo = $1', table_name)
      INTO reference_count
      USING pair.legacy_id;

      IF reference_count > 0 THEN
        RAISE EXCEPTION 'Preflight cancelado: legacy % tiene % referencias en public.%.',
          pair.legacy_id, reference_count, table_name;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

UPDATE public.insumos_mapeo_maestro mapping
SET
  estado_migracion = 'VALIDADO',
  observacion = CONCAT_WS(
    ' | ',
    NULLIF(BTRIM(mapping.observacion), ''),
    '[SANEAMIENTO_SALSAS_MAPEO_2026_06_20] Equivalencia por nombre exacto y ausencia de referencias legacy. No modifica unidad, conversiones ni stock.'
  ),
  fecha_actualizacion = NOW()
FROM _salsas_mapeos_demostrados pair
WHERE mapping.id_insumo_maestro = pair.master_id
  AND mapping.id_insumo_legacy IN (pair.master_id, pair.legacy_id)
  AND UPPER(TRIM(mapping.estado_migracion)) <> 'VALIDADO';

UPDATE public.insumos legacy
SET estado = FALSE
FROM _salsas_mapeos_demostrados pair
WHERE legacy.id_insumo = pair.legacy_id
  AND legacy.estado IS DISTINCT FROM FALSE;

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.insumos_mapeo_maestro mapping
    JOIN _salsas_mapeos_demostrados pair
      ON mapping.id_insumo_maestro = pair.master_id
     AND mapping.id_insumo_legacy IN (pair.master_id, pair.legacy_id)
    WHERE UPPER(TRIM(mapping.estado_migracion)) = 'VALIDADO'
  ) <> 4 THEN
    RAISE EXCEPTION 'Validacion final fallida: los cuatro mapeos no quedaron VALIDADO.';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.insumos legacy
    JOIN _salsas_mapeos_demostrados pair ON pair.legacy_id = legacy.id_insumo
    WHERE legacy.estado IS FALSE
  ) <> 2 THEN
    RAISE EXCEPTION 'Validacion final fallida: los dos legacy no quedaron inactivos.';
  END IF;
END
$$;

COMMIT;

SELECT
  pair.nombre,
  pair.master_id,
  master.estado AS maestro_activo,
  master.id_unidad_medida AS unidad_base_sin_modificar,
  pair.legacy_id,
  legacy.estado AS legacy_activo,
  mapping.estado_migracion
FROM (VALUES
  (29, 194, 'SALSA MANGO HABANERO'),
  (28, 196, 'SALSA ORIENTAL')
) AS pair(master_id, legacy_id, nombre)
JOIN public.insumos master ON master.id_insumo = pair.master_id
JOIN public.insumos legacy ON legacy.id_insumo = pair.legacy_id
JOIN public.insumos_mapeo_maestro mapping
  ON mapping.id_insumo_maestro = pair.master_id
 AND mapping.id_insumo_legacy = pair.legacy_id
ORDER BY pair.master_id;
