BEGIN;

ALTER TABLE public.movimientos_inventario ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.movimientos_inventario FROM PUBLIC;
REVOKE ALL ON TABLE public.movimientos_inventario FROM anon;
REVOKE ALL ON TABLE public.movimientos_inventario FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.movimientos_inventario TO service_role;

DO $$
DECLARE
  seq_name text;
BEGIN
  SELECT pg_get_serial_sequence('public.movimientos_inventario', 'id_movimiento')
    INTO seq_name;

  IF seq_name IS NOT NULL THEN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', seq_name);
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon', seq_name);
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM authenticated', seq_name);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq_name);
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_kardex_detalle
WITH (security_invoker = true) AS
 SELECT m.id_movimiento,
    m.fecha_mov,
    m.tipo,
    m.cantidad,
    m.saldo_antes,
    m.saldo_despues,
    m.saldo_antes IS NULL OR m.saldo_despues IS NULL AS es_legacy,
    m.id_almacen,
    a.nombre AS nombre_almacen,
    a.id_sucursal,
    s.nombre_sucursal,
    m.id_producto,
    p.nombre_producto,
    m.id_insumo,
    i.nombre_insumo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN 'Producto'::text
            ELSE 'Insumo'::text
        END AS item_tipo,
        CASE
            WHEN m.id_producto IS NOT NULL THEN m.id_producto
            ELSE m.id_insumo
        END AS item_id,
        CASE
            WHEN m.id_producto IS NOT NULL THEN p.nombre_producto
            ELSE i.nombre_insumo
        END AS item_nombre,
        CASE
            WHEN m.tipo::text = 'ENTRADA'::text THEN m.cantidad
            WHEN m.tipo::text = 'SALIDA'::text THEN - m.cantidad
            ELSE NULL::numeric
        END AS impacto,
    m.ref_origen,
    m.id_ref,
    m.descripcion,
    m.id_detalle_pedido,
    m.origen_consumo,
    m.id_movimiento_origen,
    m.id_pedido_trazabilidad
   FROM public.movimientos_inventario m
     LEFT JOIN public.almacenes a ON a.id_almacen = m.id_almacen
     LEFT JOIN public.sucursales s ON s.id_sucursal = a.id_sucursal
     LEFT JOIN public.productos p ON p.id_producto = m.id_producto
     LEFT JOIN public.insumos i ON i.id_insumo = m.id_insumo;

REVOKE ALL ON TABLE public.v_kardex_detalle FROM PUBLIC;
REVOKE ALL ON TABLE public.v_kardex_detalle FROM anon;
REVOKE ALL ON TABLE public.v_kardex_detalle FROM authenticated;
GRANT SELECT ON TABLE public.v_kardex_detalle TO service_role;

COMMIT;
