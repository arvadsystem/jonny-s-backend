export const persistVentaPedidoSnapshotRows = async ({
  client,
  pedidoId,
  venta,
  contactoSnapshot,
  skipExisting = false
}) => {
  const contextoValuesSql = skipExisting
    ? `SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (
         SELECT 1
         FROM public.pedidos_contexto
         WHERE id_pedido = $1
       )`
    : 'VALUES ($1, $2, $3, $4, $5, $6)';

  await client.query(
    `
      INSERT INTO public.pedidos_contexto (
        id_pedido,
        id_canal_pedido,
        id_modalidad_entrega,
        id_usuario_toma,
        id_sesion_caja_origen,
        observacion_contexto
      )
      ${contextoValuesSql}
    `,
    [
      pedidoId,
      venta.contexto.id_canal_pedido,
      venta.contexto.id_modalidad_entrega,
      venta.id_usuario,
      venta.id_sesion_caja,
      venta.contexto.observacion_contexto
    ]
  );

  const contactoValuesSql = skipExisting
    ? `SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE NOT EXISTS (
         SELECT 1
         FROM public.pedidos_contacto
         WHERE id_pedido = $1
       )`
    : 'VALUES ($1, $2, $3, $4, $5, $6, $7)';

  await client.query(
    `
      INSERT INTO public.pedidos_contacto (
        id_pedido,
        nombre_contacto,
        telefono_contacto,
        telefono_normalizado,
        dni,
        rtn,
        correo
      )
      ${contactoValuesSql}
    `,
    [
      pedidoId,
      contactoSnapshot.nombre_contacto,
      contactoSnapshot.telefono_contacto,
      contactoSnapshot.telefono_normalizado,
      contactoSnapshot.dni,
      contactoSnapshot.rtn,
      contactoSnapshot.correo
    ]
  );
};
