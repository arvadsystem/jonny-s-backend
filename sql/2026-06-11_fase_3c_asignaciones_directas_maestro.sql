-- Microfase 3C - Asignaciones directas del catálogo maestro.
-- Generada tras validar la estructura real de Supabase.
-- REVISAR Y EJECUTAR MANUALMENTE.
--
-- Objetivos:
-- 1. Permitir asignaciones locales de un maestro sin crear otra fila legacy.
-- 2. Excluir de las vistas las filas locales que pertenecen a copias legacy consolidadas.
-- 3. Preservar exactamente el contrato actual de ambas vistas.
-- 4. Resolver movimientos en este orden:
--      legacy consolidado -> maestro canónico -> fallback heredado.
-- 5. Mantener la sincronización legacy solo cuando exista un mapeo específico
--    para el maestro y el almacén del movimiento.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro pm
    GROUP BY pm.id_producto_maestro, pm.id_almacen_origen
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existen mapeos duplicados para la misma combinacion producto maestro y almacen.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.insumos_mapeo_maestro im
    GROUP BY im.id_insumo_maestro, im.id_almacen_origen
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existen mapeos duplicados para la misma combinacion insumo maestro y almacen.';
  END IF;

  -- Evita que un mismo ID tenga significados incompatibles:
  -- legacy consolidado de un grupo y maestro canónico de otro.
  IF EXISTS (
    SELECT 1
    FROM public.productos_mapeo_maestro legacy_map
    WHERE legacy_map.id_producto_legacy <> legacy_map.id_producto_maestro
      AND EXISTS (
        SELECT 1
        FROM public.productos_mapeo_maestro master_map
        WHERE master_map.id_producto_maestro = legacy_map.id_producto_legacy
      )
  ) THEN
    RAISE EXCEPTION
      'Existe un ID de producto usado simultaneamente como legacy consolidado y maestro canonico.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.insumos_mapeo_maestro legacy_map
    WHERE legacy_map.id_insumo_legacy <> legacy_map.id_insumo_maestro
      AND EXISTS (
        SELECT 1
        FROM public.insumos_mapeo_maestro master_map
        WHERE master_map.id_insumo_maestro = legacy_map.id_insumo_legacy
      )
  ) THEN
    RAISE EXCEPTION
      'Existe un ID de insumo usado simultaneamente como legacy consolidado y maestro canonico.';
  END IF;
END;
$$;

-- Conserva exactamente los nombres, el orden y los tipos del contrato vigente.
CREATE OR REPLACE VIEW public.vw_productos_maestros_almacen AS
SELECT
  COALESCE(pm.id_producto_legacy, pa.id_producto) AS id_producto_legacy,
  pa.id_producto AS id_producto,
  pa.id_producto AS id_producto_maestro,
  pa.id_almacen AS id_almacen,
  a.id_sucursal AS id_sucursal,
  maestro.nombre_producto AS nombre_producto,
  maestro.descripcion_producto AS descripcion_producto,
  maestro.id_categoria_producto AS id_categoria_producto,
  maestro.id_tipo_departamento AS id_tipo_departamento,
  maestro.id_archivo_imagen_principal AS id_archivo_imagen_principal,
  maestro.precio AS precio_legacy,
  maestro.fecha_ingreso_producto AS fecha_ingreso_producto,
  maestro.estado AS estado_global,
  pa.cantidad AS cantidad,
  pa.stock_minimo AS stock_minimo,
  pa.costo_compra AS costo_compra,
  pa.fecha_caducidad AS fecha_caducidad,
  pa.estado AS estado_local,
  pa.fecha_asignacion AS fecha_asignacion,
  pa.fecha_actualizacion AS fecha_actualizacion,
  COALESCE(pm.estado_migracion, 'VALIDADO'::varchar(30))::varchar(30) AS estado_migracion
FROM public.productos_almacenes pa
INNER JOIN public.productos maestro
  ON maestro.id_producto = pa.id_producto
INNER JOIN public.almacenes a
  ON a.id_almacen = pa.id_almacen
LEFT JOIN public.productos_mapeo_maestro pm
  ON pm.id_producto_maestro = pa.id_producto
 AND pm.id_almacen_origen = pa.id_almacen
WHERE EXISTS (
  SELECT 1
  FROM public.productos_mapeo_maestro canonical
  WHERE canonical.id_producto_maestro = pa.id_producto
);

CREATE OR REPLACE VIEW public.vw_insumos_maestros_almacen AS
SELECT
  COALESCE(im.id_insumo_legacy, ia.id_insumo) AS id_insumo_legacy,
  ia.id_insumo AS id_insumo,
  ia.id_insumo AS id_insumo_maestro,
  ia.id_almacen AS id_almacen,
  a.id_sucursal AS id_sucursal,
  maestro.nombre_insumo AS nombre_insumo,
  maestro.descripcion AS descripcion,
  maestro.id_categoria_insumo AS id_categoria_insumo,
  maestro.id_unidad_medida AS id_unidad_medida,
  maestro.id_archivo_imagen_principal AS id_archivo_imagen_principal,
  maestro.fecha_ingreso_insumo AS fecha_ingreso_insumo,
  maestro.estado AS estado_global,
  ia.cantidad AS cantidad,
  ia.stock_minimo AS stock_minimo,
  ia.precio_compra AS precio_compra,
  ia.fecha_caducidad AS fecha_caducidad,
  ia.estado AS estado_local,
  ia.fecha_asignacion AS fecha_asignacion,
  ia.fecha_actualizacion AS fecha_actualizacion,
  COALESCE(im.estado_migracion, 'VALIDADO'::varchar(30))::varchar(30) AS estado_migracion
FROM public.insumos_almacenes ia
INNER JOIN public.insumos maestro
  ON maestro.id_insumo = ia.id_insumo
INNER JOIN public.almacenes a
  ON a.id_almacen = ia.id_almacen
LEFT JOIN public.insumos_mapeo_maestro im
  ON im.id_insumo_maestro = ia.id_insumo
 AND im.id_almacen_origen = ia.id_almacen
WHERE EXISTS (
  SELECT 1
  FROM public.insumos_mapeo_maestro canonical
  WHERE canonical.id_insumo_maestro = ia.id_insumo
);

CREATE OR REPLACE FUNCTION public.fn_mov_inv_apply_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_stock_actual numeric(14,4);
  v_stock_nuevo numeric(14,4);
  v_item_almacen integer;
  v_ref_origen text;
  v_allow_negative boolean := false;

  v_id_insumo_original integer;
  v_id_insumo_maestro integer;
  v_id_insumo_legacy integer;

  v_consolidated_legacy_count integer := 0;
  v_mapping_for_warehouse_count integer := 0;
  v_is_canonical_master boolean := false;
  v_has_insumo_local boolean := false;
BEGIN
  IF (NEW.id_producto IS NULL AND NEW.id_insumo IS NULL)
     OR (NEW.id_producto IS NOT NULL AND NEW.id_insumo IS NOT NULL) THEN
    RAISE EXCEPTION 'Debe especificar SOLO id_producto o SOLO id_insumo';
  END IF;

  IF NEW.tipo NOT IN ('ENTRADA', 'SALIDA', 'AJUSTE') THEN
    RAISE EXCEPTION 'Tipo invalido: %', NEW.tipo;
  END IF;

  IF NEW.cantidad IS NULL OR NEW.cantidad < 0 THEN
    RAISE EXCEPTION 'Cantidad invalida (debe ser >= 0)';
  END IF;

  v_ref_origen := UPPER(TRIM(COALESCE(NEW.ref_origen, '')));

  IF NEW.id_producto IS NOT NULL THEN
    -- Flujo de productos preservado sin cambios funcionales.
    SELECT p.cantidad, p.id_almacen
      INTO v_stock_actual, v_item_almacen
    FROM public.productos p
    WHERE p.id_producto = NEW.id_producto
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % no existe', NEW.id_producto;
    END IF;
  ELSE
    v_id_insumo_original := NEW.id_insumo;

    -- 1. Resolver primero un ID legacy consolidado en el almacén indicado.
    SELECT
      COUNT(*)::integer,
      MIN(mm.id_insumo_maestro)::integer,
      MIN(mm.id_insumo_legacy)::integer
      INTO
        v_consolidated_legacy_count,
        v_id_insumo_maestro,
        v_id_insumo_legacy
    FROM public.insumos_mapeo_maestro mm
    WHERE mm.id_insumo_legacy = v_id_insumo_original
      AND mm.id_almacen_origen = NEW.id_almacen
      AND mm.id_insumo_legacy <> mm.id_insumo_maestro;

    IF v_consolidated_legacy_count > 1 THEN
      RAISE EXCEPTION
        'Insumo legacy % tiene mas de una equivalencia para el almacen %',
        v_id_insumo_original,
        NEW.id_almacen;
    END IF;

    IF v_consolidated_legacy_count = 1 THEN
      v_has_insumo_local := true;
      NEW.id_insumo := v_id_insumo_maestro;

      SELECT ia.cantidad, ia.id_almacen
        INTO v_stock_actual, v_item_almacen
      FROM public.insumos_almacenes ia
      WHERE ia.id_insumo = v_id_insumo_maestro
        AND ia.id_almacen = NEW.id_almacen
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Insumo maestro % no tiene stock local en almacen %',
          v_id_insumo_maestro,
          NEW.id_almacen;
      END IF;

    ELSE
      -- 2. Si no es legacy consolidado, aceptar el ID como maestro únicamente
      --    cuando aparezca como maestro canónico en la tabla de mapeo.
      SELECT EXISTS (
        SELECT 1
        FROM public.insumos_mapeo_maestro canonical
        WHERE canonical.id_insumo_maestro = v_id_insumo_original
      )
      INTO v_is_canonical_master;

      IF v_is_canonical_master THEN
        v_has_insumo_local := true;
        v_id_insumo_maestro := v_id_insumo_original;
        NEW.id_insumo := v_id_insumo_maestro;

        SELECT ia.cantidad, ia.id_almacen
          INTO v_stock_actual, v_item_almacen
        FROM public.insumos_almacenes ia
        WHERE ia.id_insumo = v_id_insumo_maestro
          AND ia.id_almacen = NEW.id_almacen
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Insumo maestro % no tiene stock local en almacen %',
            v_id_insumo_maestro,
            NEW.id_almacen;
        END IF;

        -- La fila legacy para sincronización es opcional. Solo se toma cuando
        -- existe un mapeo específico para este maestro y este almacén.
        SELECT
          COUNT(*)::integer,
          MIN(mm.id_insumo_legacy)::integer
          INTO
            v_mapping_for_warehouse_count,
            v_id_insumo_legacy
        FROM public.insumos_mapeo_maestro mm
        WHERE mm.id_insumo_maestro = v_id_insumo_maestro
          AND mm.id_almacen_origen = NEW.id_almacen;

        IF v_mapping_for_warehouse_count > 1 THEN
          RAISE EXCEPTION
            'Insumo maestro % tiene mas de una equivalencia para el almacen %',
            v_id_insumo_maestro,
            NEW.id_almacen;
        END IF;

        IF v_mapping_for_warehouse_count = 0 THEN
          v_id_insumo_legacy := NULL;
        END IF;

      ELSE
        -- 3. Compatibilidad para registros todavía fuera del catálogo maestro.
        SELECT i.cantidad, i.id_almacen
          INTO v_stock_actual, v_item_almacen
        FROM public.insumos i
        WHERE i.id_insumo = v_id_insumo_original
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Insumo % no existe', v_id_insumo_original;
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_item_almacen IS NULL THEN
    RAISE EXCEPTION 'El item no tiene id_almacen asignado';
  END IF;

  IF v_item_almacen <> NEW.id_almacen THEN
    RAISE EXCEPTION
      'El item pertenece al almacen %, pero el movimiento indica almacen %',
      v_item_almacen,
      NEW.id_almacen;
  END IF;

  IF NEW.tipo = 'AJUSTE' THEN
    IF NEW.cantidad < 0 THEN
      RAISE EXCEPTION 'La existencia final debe ser mayor o igual a 0';
    END IF;
  ELSE
    IF NEW.cantidad <= 0 THEN
      RAISE EXCEPTION 'La cantidad debe ser mayor que 0';
    END IF;
  END IF;

  IF NEW.tipo = 'ENTRADA' THEN
    v_stock_nuevo := v_stock_actual + NEW.cantidad;

  ELSIF NEW.tipo = 'SALIDA' THEN
    v_allow_negative := v_ref_origen = 'FALTANTE_COCINA';

    IF NOT v_allow_negative
       AND v_ref_origen = 'PEDIDO'
       AND NEW.id_ref IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.pedidos p
        INNER JOIN public.estados_pedido ep
          ON ep.id_estado_pedido = p.id_estado_pedido
        WHERE p.id_pedido = NEW.id_ref
          AND REPLACE(
                REPLACE(
                  UPPER(TRIM(COALESCE(ep.descripcion, ''))),
                  ' ',
                  '_'
                ),
                '-',
                '_'
              ) = 'EN_COCINA'
      )
      INTO v_allow_negative;
    END IF;

    IF v_stock_actual < NEW.cantidad AND NOT v_allow_negative THEN
      RAISE EXCEPTION
        'Stock insuficiente. Stock actual %, salida %',
        v_stock_actual,
        NEW.cantidad;
    END IF;

    v_stock_nuevo := v_stock_actual - NEW.cantidad;

  ELSE
    v_stock_nuevo := NEW.cantidad;
  END IF;

  NEW.saldo_antes := v_stock_actual;
  NEW.saldo_despues := v_stock_nuevo;

  IF NEW.id_producto IS NOT NULL THEN
    UPDATE public.productos
       SET cantidad = v_stock_nuevo
     WHERE id_producto = NEW.id_producto;

  ELSIF v_has_insumo_local THEN
    UPDATE public.insumos_almacenes
       SET cantidad = v_stock_nuevo,
           fecha_actualizacion = now()
     WHERE id_insumo = v_id_insumo_maestro
       AND id_almacen = NEW.id_almacen;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'No se pudo actualizar el stock local del insumo maestro % en almacen %',
        v_id_insumo_maestro,
        NEW.id_almacen;
    END IF;

    -- Compatibilidad temporal: solo sincroniza una fila legacy específica
    -- cuando realmente existe para este maestro y almacén.
    IF v_id_insumo_legacy IS NOT NULL THEN
      UPDATE public.insumos
         SET cantidad = v_stock_nuevo
       WHERE id_insumo = v_id_insumo_legacy;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'No se pudo sincronizar la fila legacy % del insumo maestro %',
          v_id_insumo_legacy,
          v_id_insumo_maestro;
      END IF;
    END IF;

  ELSE
    UPDATE public.insumos
       SET cantidad = v_stock_nuevo
     WHERE id_insumo = v_id_insumo_original;
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
