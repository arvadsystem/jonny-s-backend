BEGIN;

CREATE TABLE IF NOT EXISTS public.facturas_reversiones (
  id_reversion BIGSERIAL PRIMARY KEY,
  codigo_reversion VARCHAR(30) NOT NULL,
  id_factura_original INTEGER NOT NULL REFERENCES public.facturas(id_factura) ON DELETE RESTRICT,
  id_sucursal INTEGER NOT NULL REFERENCES public.sucursales(id_sucursal) ON DELETE RESTRICT,
  id_caja_original INTEGER NULL REFERENCES public.cajas(id_caja) ON DELETE SET NULL,
  id_sesion_caja_original BIGINT NULL REFERENCES public.cajas_sesiones(id_sesion_caja) ON DELETE SET NULL,
  id_caja_actual INTEGER NOT NULL REFERENCES public.cajas(id_caja) ON DELETE RESTRICT,
  id_sesion_caja_actual BIGINT NOT NULL REFERENCES public.cajas_sesiones(id_sesion_caja) ON DELETE RESTRICT,
  tipo_reversion VARCHAR(20) NOT NULL,
  motivo VARCHAR(50) NOT NULL,
  observacion VARCHAR(300),
  monto_reversado NUMERIC(12,2) NOT NULL DEFAULT 0,
  estado VARCHAR(30) NOT NULL DEFAULT 'REGISTRADA',
  creada_por INTEGER NOT NULL REFERENCES public.usuarios(id_usuario) ON DELETE RESTRICT,
  creada_en TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  fecha_operacion DATE NOT NULL,
  ip_origen VARCHAR(80) NOT NULL,
  dispositivo VARCHAR(80),
  user_agent VARCHAR(500),
  correo_notificado BOOLEAN NOT NULL DEFAULT false,
  notificado_en TIMESTAMP WITHOUT TIME ZONE,
  error_notificacion VARCHAR(500),
  CONSTRAINT ck_facturas_reversiones_tipo CHECK (tipo_reversion IN ('TOTAL', 'PARCIAL')),
  CONSTRAINT ck_facturas_reversiones_motivo CHECK (motivo IN ('ERROR_DIGITACION','CLIENTE_CANCELO','PRODUCTO_NO_DISPONIBLE','DEVOLUCION','COBRO_INCORRECTO','OTRO')),
  CONSTRAINT ck_facturas_reversiones_monto CHECK (monto_reversado >= 0)
);

DROP INDEX IF EXISTS public.ux_facturas_reversiones_codigo;

CREATE UNIQUE INDEX IF NOT EXISTS ux_facturas_reversiones_sucursal_fecha_codigo
  ON public.facturas_reversiones (id_sucursal, fecha_operacion, codigo_reversion);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_factura
  ON public.facturas_reversiones (id_factura_original);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_creada_en
  ON public.facturas_reversiones (creada_en DESC);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_sucursal
  ON public.facturas_reversiones (id_sucursal, creada_en DESC);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_sesion_actual
  ON public.facturas_reversiones (id_sesion_caja_actual, creada_en DESC);

CREATE TABLE IF NOT EXISTS public.facturas_reversiones_detalle (
  id_reversion_detalle BIGSERIAL PRIMARY KEY,
  id_reversion BIGINT NOT NULL REFERENCES public.facturas_reversiones(id_reversion) ON DELETE CASCADE,
  id_detalle_factura INTEGER NOT NULL REFERENCES public.detalle_facturas(id_detalle_factura) ON DELETE RESTRICT,
  tipo_item VARCHAR(20) NOT NULL,
  id_producto INTEGER NULL REFERENCES public.productos(id_producto) ON DELETE SET NULL,
  id_receta INTEGER NULL REFERENCES public.recetas(id_receta) ON DELETE SET NULL,
  id_combo INTEGER NULL REFERENCES public.combos(id_combo) ON DELETE SET NULL,
  cantidad_revertida NUMERIC(10,4) NOT NULL,
  precio_unitario_original NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal_revertido NUMERIC(12,2) NOT NULL DEFAULT 0,
  descuento_revertido NUMERIC(12,2) NOT NULL DEFAULT 0,
  isv_15_revertido NUMERIC(12,2) NOT NULL DEFAULT 0,
  isv_18_revertido NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_revertido NUMERIC(12,2) NOT NULL DEFAULT 0,
  devuelve_inventario BOOLEAN NOT NULL DEFAULT false,
  creado_en TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_facturas_reversiones_detalle_tipo CHECK (tipo_item IN ('PRODUCTO', 'RECETA', 'COMBO', 'ITEM')),
  CONSTRAINT ck_facturas_reversiones_detalle_cantidad CHECK (cantidad_revertida > 0),
  CONSTRAINT ck_facturas_reversiones_detalle_total CHECK (total_revertido >= 0)
);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_detalle_reversion
  ON public.facturas_reversiones_detalle (id_reversion);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_detalle_factura
  ON public.facturas_reversiones_detalle (id_detalle_factura);

CREATE TABLE IF NOT EXISTS public.facturas_reversiones_intentos (
  id_intento BIGSERIAL PRIMARY KEY,
  id_factura INTEGER,
  id_usuario INTEGER,
  id_sucursal INTEGER,
  motivo VARCHAR(50),
  error_code VARCHAR(100) NOT NULL,
  error_message_publico VARCHAR(300) NOT NULL,
  ip_origen VARCHAR(80),
  user_agent VARCHAR(500),
  dispositivo VARCHAR(80),
  creado_en TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_intentos_factura
  ON public.facturas_reversiones_intentos (id_factura, creado_en DESC);

CREATE INDEX IF NOT EXISTS idx_facturas_reversiones_intentos_usuario
  ON public.facturas_reversiones_intentos (id_usuario, creado_en DESC);

INSERT INTO public.permisos (nombre_permiso)
SELECT 'VENTAS_REVERSION_CREAR'
WHERE NOT EXISTS (
  SELECT 1 FROM public.permisos WHERE UPPER(TRIM(nombre_permiso)) = 'VENTAS_REVERSION_CREAR'
);

INSERT INTO public.roles_permisos (id_rol, id_permiso)
SELECT r.id_rol, p.id_permiso
FROM public.roles r
CROSS JOIN public.permisos p
WHERE UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\s-]+', '_', 'g')) IN ('CAJERO', 'ADMINISTRADOR', 'ADMIN', 'SUPER_ADMIN')
  AND UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR'
  AND NOT EXISTS (
    SELECT 1 FROM public.roles_permisos rp WHERE rp.id_rol = r.id_rol AND rp.id_permiso = p.id_permiso
  );

INSERT INTO public.cat_cajas_movimientos_tipos (
  codigo,
  nombre,
  descripcion,
  signo,
  afecta_efectivo,
  estado,
  fecha_creacion,
  fecha_actualizacion
)
SELECT
  'REVERSION',
  'ReversiÃ³n de venta',
  'Movimiento de caja por reversiÃ³n de venta',
  -1,
  true,
  true,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM public.cat_cajas_movimientos_tipos WHERE UPPER(TRIM(codigo)) IN ('REVERSION', 'REVERSO', 'REVERSIÃ“N')
);

COMMIT;

