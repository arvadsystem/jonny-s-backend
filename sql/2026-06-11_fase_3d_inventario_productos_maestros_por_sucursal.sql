-- Microfase 3D - Inventario de productos maestros por sucursal.
-- Generado despues de validar el esquema y los datos reales de Supabase.
-- REVISAR Y EJECUTAR MANUALMENTE.
--
-- Objetivos:
-- 1. Resolver productos en el orden:
--      legacy consolidado -> maestro canonico -> fallback heredado.
-- 2. Descontar el stock maestro desde public.productos_almacenes.
-- 3. Normalizar movimientos al ID maestro.
-- 4. Mantener sincronizada la fila legacy solo cuando exista un mapeo
--    especifico para el maestro y el almacen.
-- 5. Preservar sin cambios funcionales el bloque 3C de insumos.

BEGIN;

-- Controles preventivos. La migracion se cancela si el modelo contiene
-- ambiguedades que obligarian a seleccionar un mapeo arbitrariamente.
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
    FROM public.productos_mapeo_maestro pm
    LEFT JOIN public.productos_almacenes pa
      ON pa.id_producto = pm.id_producto_maestro
     AND pa.id_almacen = pm.id_almacen_origen
    WHERE pa.id_producto IS NULL
  ) THEN
    RAISE EXCEPTION
      'Existen mapeos de productos sin una fila local canonica en productos_almacenes.';
  END IF;
END;
$$;

-- El flujo operativo ya permite saldos negativos auditados para cocina.
-- Esta restriccion impediria persistirlos en el stock local del producto.
ALTER TABLE public.productos_almacenes
  DROP CONSTRAINT IF EXISTS chk_productos_almacenes_cantidad_no_negativa;

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

  -- Resolucion de productos.
  v_id_producto_original integer;
  v_id_producto_maestro integer;
  v_id_producto_legacy integer;
  v_producto_legacy_count integer := 0;
  v_producto_mapping_almacen_count integer := 0;
  v_producto_es_maestro_canonico boolean := false;
  v_producto_tiene_stock_local boolean := false;

  -- Resolucion de insumos 3C, preservada.
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
    v_id_producto_original := NEW.id_producto;

    -- 1. Resolver primero un ID legacy consolidado para el almacen indicado.
    SELECT
      COUNT(*)::integer,
      MIN(pm.id_producto_maestro)::integer,
      MIN(pm.id_producto_legacy)::integer
      INTO
        v_producto_legacy_count,
        v_id_producto_maestro,
        v_id_producto_legacy
    FROM public.productos_mapeo_maestro pm
    WHERE pm.id_producto_legacy = v_id_producto_original
      AND pm.id_almacen_origen = NEW.id_almacen
      AND pm.id_producto_legacy <> pm.id_producto_maestro;

    IF v_producto_legacy_count > 1 THEN
      RAISE EXCEPTION
        'Producto legacy % tiene mas de una equivalencia para el almacen %',
        v_id_producto_original,
        NEW.id_almacen;
    END IF;

    IF v_producto_legacy_count = 1 THEN
      v_producto_tiene_stock_local := true;
      NEW.id_producto := v_id_producto_maestro;

      SELECT pa.cantidad, pa.id_almacen
        INTO v_stock_actual, v_item_almacen
      FROM public.productos_almacenes pa
      WHERE pa.id_producto = v_id_producto_maestro
        AND pa.id_almacen = NEW.id_almacen
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'Producto maestro % no tiene stock local en almacen %',
          v_id_producto_maestro,
          NEW.id_almacen;
      END IF;

    ELSE
      -- 2. Aceptar el ID como maestro solo si aparece como maestro canonico.
      SELECT EXISTS (
        SELECT 1
        FROM public.productos_mapeo_maestro canonical
        WHERE canonical.id_producto_maestro = v_id_producto_original
      )
      INTO v_producto_es_maestro_canonico;

      IF v_producto_es_maestro_canonico THEN
        v_producto_tiene_stock_local := true;
        v_id_producto_maestro := v_id_producto_original;
        NEW.id_producto := v_id_producto_maestro;

        SELECT pa.cantidad, pa.id_almacen
          INTO v_stock_actual, v_item_almacen
        FROM public.productos_almacenes pa
        WHERE pa.id_producto = v_id_producto_maestro
          AND pa.id_almacen = NEW.id_almacen
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Producto maestro % no tiene stock local en almacen %',
            v_id_producto_maestro,
            NEW.id_almacen;
        END IF;

        -- La sincronizacion legacy es opcional para asignaciones directas.
        SELECT
          COUNT(*)::integer,
          MIN(pm.id_producto_legacy)::integer
          INTO
            v_producto_mapping_almacen_count,
            v_id_producto_legacy
        FROM public.productos_mapeo_maestro pm
        WHERE pm.id_producto_maestro = v_id_producto_maestro
          AND pm.id_almacen_origen = NEW.id_almacen;

        IF v_producto_mapping_almacen_count > 1 THEN
          RAISE EXCEPTION
            'Producto maestro % tiene mas de una equivalencia para el almacen %',
            v_id_producto_maestro,
            NEW.id_almacen;
        END IF;

        IF v_producto_mapping_almacen_count = 0 THEN
          v_id_producto_legacy := NULL;
        END IF;

      ELSE
        -- 3. Fallback para productos heredados todavia no mapeados.
        SELECT p.cantidad, p.id_almacen
          INTO v_stock_actual, v_item_almacen
        FROM public.productos p
        WHERE p.id_producto = v_id_producto_original
        FOR UPDATE;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Producto % no existe', v_id_producto_original;
        END IF;
      END IF;
    END IF;

  ELSE
    -- Bloque de insumos de la Microfase 3C preservado.
    v_id_insumo_original := NEW.id_insumo;

    -- 1. Resolver primero un ID legacy consolidado en el almacen indicado.
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
      -- 2. Si no es legacy consolidado, aceptar el ID como maestro unicamente
      --    cuando aparezca como maestro canonico en la tabla de mapeo.
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

        -- La fila legacy para sincronizacion es opcional.
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
        -- 3. Compatibilidad para registros fuera del catalogo maestro.
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
    IF v_producto_tiene_stock_local THEN
      UPDATE public.productos_almacenes
         SET cantidad = v_stock_nuevo,
             fecha_actualizacion = now()
       WHERE id_producto = v_id_producto_maestro
         AND id_almacen = NEW.id_almacen;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'No se pudo actualizar el stock local del producto maestro % en almacen %',
          v_id_producto_maestro,
          NEW.id_almacen;
      END IF;

      IF v_id_producto_legacy IS NOT NULL THEN
        UPDATE public.productos
           SET cantidad = v_stock_nuevo
         WHERE id_producto = v_id_producto_legacy;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'No se pudo sincronizar la fila legacy % del producto maestro %',
            v_id_producto_legacy,
            v_id_producto_maestro;
        END IF;
      END IF;

    ELSE
      UPDATE public.productos
         SET cantidad = v_stock_nuevo
       WHERE id_producto = v_id_producto_original;
    END IF;

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
