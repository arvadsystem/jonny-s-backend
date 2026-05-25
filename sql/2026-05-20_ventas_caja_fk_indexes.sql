-- facturas: lecturas por caja, cliente, pedido y usuario.
CREATE INDEX IF NOT EXISTS ix_facturas_id_caja
ON public.facturas (id_caja);

CREATE INDEX IF NOT EXISTS ix_facturas_id_cliente
ON public.facturas (id_cliente);

CREATE INDEX IF NOT EXISTS ix_facturas_id_pedido
ON public.facturas (id_pedido);

CREATE INDEX IF NOT EXISTS ix_facturas_id_usuario
ON public.facturas (id_usuario);

-- detalle_facturas: uniones y filtros de detalle de venta.
CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_factura
ON public.detalle_facturas (id_factura);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_pedido
ON public.detalle_facturas (id_pedido);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_producto
ON public.detalle_facturas (id_producto);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_descuento
ON public.detalle_facturas (id_descuento);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_combo
ON public.detalle_facturas (id_combo);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_id_receta
ON public.detalle_facturas (id_receta);

-- detalle_facturas_origen: trazabilidad por item origen.
CREATE INDEX IF NOT EXISTS ix_detalle_facturas_origen_id_producto
ON public.detalle_facturas_origen (id_producto);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_origen_id_combo
ON public.detalle_facturas_origen (id_combo);

CREATE INDEX IF NOT EXISTS ix_detalle_facturas_origen_id_receta
ON public.detalle_facturas_origen (id_receta);

-- pedidos: consultas de ventas/caja por cliente, estado, sucursal y usuario.
CREATE INDEX IF NOT EXISTS ix_pedidos_id_cliente
ON public.pedidos (id_cliente);

CREATE INDEX IF NOT EXISTS ix_pedidos_id_estado_pedido
ON public.pedidos (id_estado_pedido);

CREATE INDEX IF NOT EXISTS ix_pedidos_id_sucursal
ON public.pedidos (id_sucursal);

CREATE INDEX IF NOT EXISTS ix_pedidos_id_usuario
ON public.pedidos (id_usuario);

CREATE INDEX IF NOT EXISTS ix_pedidos_id_usuario_pago_confirmado
ON public.pedidos (id_usuario_pago_confirmado);

CREATE INDEX IF NOT EXISTS ix_pedidos_sucursal_fecha
ON public.pedidos (id_sucursal, fecha_hora_pedido DESC);

-- detalle_pedido: uniones por combo y receta.
CREATE INDEX IF NOT EXISTS ix_detalle_pedido_id_combo
ON public.detalle_pedido (id_combo);

CREATE INDEX IF NOT EXISTS ix_detalle_pedido_id_receta
ON public.detalle_pedido (id_receta);

-- facturas_cobros: consultas de caja, sucursal y metodos de pago.
CREATE INDEX IF NOT EXISTS ix_facturas_cobros_id_caja
ON public.facturas_cobros (id_caja);

CREATE INDEX IF NOT EXISTS ix_facturas_cobros_id_metodo_pago
ON public.facturas_cobros (id_metodo_pago);

CREATE INDEX IF NOT EXISTS ix_facturas_cobros_id_sucursal
ON public.facturas_cobros (id_sucursal);

CREATE INDEX IF NOT EXISTS ix_facturas_cobros_sesion_metodo
ON public.facturas_cobros (id_sesion_caja, id_metodo_pago);
