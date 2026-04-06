import { toPositiveInt } from './pedidoPayloadValidator.js';

// Servicio de movimientos de inventario para pedidos.
// ---------------------------------------------------
// QUE HACE:
// - Verifica idempotencia por pedido (evitar doble descuento).
// - Inserta movimientos SALIDA para productos/insumos.
//
// TRAZABILIDAD:
// - Se fija ref_origen='PEDIDO' y id_ref=id_pedido para auditar origen del descuento.

export const MOVEMENT_REF = 'PEDIDO';

export const fetchExistingPedidoMovement = async (client, idPedido) => {
  const rs = await client.query(
    `
      SELECT id_movimiento
      FROM public.movimientos_inventario
      WHERE ref_origen = $1
        AND id_ref = $2
      LIMIT 1
    `,
    [MOVEMENT_REF, idPedido]
  );
  return rs.rows[0]?.id_movimiento ? Number(rs.rows[0].id_movimiento) : null;
};

const insertMovimiento = async (client, movement) => {
  await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        ref_origen,
        id_ref,
        descripcion
      )
      VALUES ('SALIDA', $1, $2, $3, $4, $5, $6, $7)
    `,
    [
      Number(movement.cantidad),
      Number(movement.id_almacen),
      movement.id_producto ? Number(movement.id_producto) : null,
      movement.id_insumo ? Number(movement.id_insumo) : null,
      MOVEMENT_REF,
      Number(movement.id_ref),
      String(movement.descripcion || '').trim() || null
    ]
  );
};

export const registrarMovimientosPedido = async ({
  client,
  idPedido,
  actorUserId,
  productoQtyMap,
  insumoQtyMap,
  productosById,
  insumosById
}) => {
  const productoIds = [...productoQtyMap.keys()].sort((a, b) => a - b);
  const insumoIds = [...insumoQtyMap.keys()].sort((a, b) => a - b);

  for (const idProducto of productoIds) {
    const row = productosById.get(idProducto);
    await insertMovimiento(client, {
      cantidad: Number(productoQtyMap.get(idProducto) || 0),
      id_almacen: Number(row.id_almacen),
      id_producto: idProducto,
      id_insumo: null,
      id_ref: idPedido,
      descripcion: `Descuento por pedido #${idPedido} (producto ${idProducto})${toPositiveInt(actorUserId) ? ` - usuario ${actorUserId}` : ''}`
    });
  }

  for (const idInsumo of insumoIds) {
    const row = insumosById.get(idInsumo);
    await insertMovimiento(client, {
      cantidad: Number(insumoQtyMap.get(idInsumo) || 0),
      id_almacen: Number(row.id_almacen),
      id_producto: null,
      id_insumo: idInsumo,
      id_ref: idPedido,
      descripcion: `Descuento por pedido #${idPedido} (insumo ${idInsumo})${toPositiveInt(actorUserId) ? ` - usuario ${actorUserId}` : ''}`
    });
  }
};

