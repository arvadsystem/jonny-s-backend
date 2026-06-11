const CATALOGO_MAESTRO_WRITE_STRUCTURE_SQLSTATES = new Set([
  '42P01',
  '42703',
  '42P10'
]);

export const CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_CODE = 'CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING';
export const CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_MESSAGE =
  'No se pudo completar el alta porque falta una estructura del catalogo maestro.';

const wrapCatalogoMaestroWriteStructureError = (context, cause) => {
  const error = new Error(CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_MESSAGE);
  error.code = CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_CODE;
  error.context = context;
  error.cause = cause;
  return error;
};

const queryCatalogoMaestroWrite = async (client, context, sql, params) => {
  try {
    return await client.query(sql, Array.isArray(params) ? params : []);
  } catch (error) {
    if (CATALOGO_MAESTRO_WRITE_STRUCTURE_SQLSTATES.has(error?.code)) {
      throw wrapCatalogoMaestroWriteStructureError(context, error);
    }
    throw error;
  }
};

export const isCatalogoMaestroWriteStructureMissingError = (error) =>
  error?.code === CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_CODE;

export const buildCatalogoMaestroWriteStructureMissingResponse = () => ({
  error: true,
  code: CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_CODE,
  message: CATALOGO_MAESTRO_WRITE_STRUCTURE_MISSING_MESSAGE
});

export const completeProductoCatalogoMaestroWrite = async ({
  client,
  idProducto,
  idAlmacen,
  stockMinimo,
  costoCompra,
  fechaCaducidad,
  estado
}) => {
  await queryCatalogoMaestroWrite(
    client,
    'productos_almacenes',
    `
      INSERT INTO public.productos_almacenes (
        id_producto,
        id_almacen,
        cantidad,
        stock_minimo,
        costo_compra,
        fecha_caducidad,
        estado,
        fecha_actualizacion
      ) VALUES ($1, $2, 0, $3, $4, $5, $6, now())
      ON CONFLICT (id_producto, id_almacen)
      DO UPDATE SET
        cantidad = EXCLUDED.cantidad,
        stock_minimo = EXCLUDED.stock_minimo,
        costo_compra = EXCLUDED.costo_compra,
        fecha_caducidad = EXCLUDED.fecha_caducidad,
        estado = EXCLUDED.estado,
        fecha_actualizacion = now()
    `,
    [
      idProducto,
      idAlmacen,
      stockMinimo ?? 0,
      costoCompra ?? null,
      fechaCaducidad ?? null,
      estado ?? true
    ]
  );

  await queryCatalogoMaestroWrite(
    client,
    'productos_mapeo_maestro',
    `
      INSERT INTO public.productos_mapeo_maestro (
        id_producto_legacy,
        id_producto_maestro,
        id_almacen_origen,
        estado_migracion,
        observacion
      ) VALUES ($1, $2, $3, 'VALIDADO', 'Alta nativa compatible con catalogo maestro')
    `,
    [idProducto, idProducto, idAlmacen]
  );
};

export const completeInsumoCatalogoMaestroWrite = async ({
  client,
  idInsumo,
  idAlmacen,
  cantidad,
  stockMinimo,
  precioCompra,
  fechaCaducidad
}) => {
  await queryCatalogoMaestroWrite(
    client,
    'insumos_almacenes',
    `
      INSERT INTO public.insumos_almacenes (
        id_insumo,
        id_almacen,
        cantidad,
        stock_minimo,
        precio_compra,
        fecha_caducidad,
        estado,
        fecha_actualizacion
      ) VALUES ($1, $2, $3, $4, $5, $6, true, now())
      ON CONFLICT (id_insumo, id_almacen)
      DO UPDATE SET
        cantidad = EXCLUDED.cantidad,
        stock_minimo = EXCLUDED.stock_minimo,
        precio_compra = EXCLUDED.precio_compra,
        fecha_caducidad = EXCLUDED.fecha_caducidad,
        estado = EXCLUDED.estado,
        fecha_actualizacion = now()
    `,
    [
      idInsumo,
      idAlmacen,
      cantidad,
      stockMinimo,
      precioCompra,
      fechaCaducidad ?? null
    ]
  );

  await queryCatalogoMaestroWrite(
    client,
    'insumos_mapeo_maestro',
    `
      INSERT INTO public.insumos_mapeo_maestro (
        id_insumo_legacy,
        id_insumo_maestro,
        id_almacen_origen,
        estado_migracion,
        observacion
      ) VALUES ($1, $2, $3, 'VALIDADO', 'Alta nativa compatible con catalogo maestro')
    `,
    [idInsumo, idInsumo, idAlmacen]
  );
};
