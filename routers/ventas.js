import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const ESTADOS_COMPLETADOS = new Set([
  'completada',
  'completado',
  'finalizada',
  'finalizado',
  'pagada',
  'pagado',
  'cerrada',
  'cerrado',
  'lista',
  'listo'
]);

const roundMoney = (value) => Number((Number(value || 0)).toFixed(2));

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseOptionalPositiveInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  return parsePositiveInt(value);
};

const parseNonNegativeNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : null;
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const formatVentaNumero = (idPedido) => `VTA-${String(idPedido).padStart(5, '0')}`;

const normalizeClienteNombre = (cliente) => {
  const nombrePersona = [cliente?.nombre, cliente?.apellido].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;
  if (cliente?.nombre_empresa) return cliente.nombre_empresa;
  return 'Consumidor final';
};

const normalizeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debe enviar al menos un item en la venta.' };
  }

  const normalized = [];

  for (const item of items) {
    if (!isPlainObject(item)) {
      return { ok: false, message: 'Cada item debe ser un objeto valido.' };
    }

    const idProducto = parsePositiveInt(item.id_producto);
    const cantidad = parsePositiveInt(item.cantidad);

    if (!idProducto) {
      return { ok: false, message: 'Cada item debe incluir id_producto valido.' };
    }

    if (!cantidad) {
      return { ok: false, message: 'Cada item debe incluir cantidad entera mayor a 0.' };
    }

    normalized.push({
      id_producto: idProducto,
      cantidad
    });
  }

  return { ok: true, data: normalized };
};

const resolveEstadoPedidoId = async (client, requestedId) => {
  if (requestedId) {
    const result = await client.query(
      'SELECT id_estado_pedido FROM estados_pedido WHERE id_estado_pedido = $1 LIMIT 1',
      [requestedId]
    );
    return result.rowCount > 0 ? requestedId : null;
  }

  const result = await client.query(
    `
      SELECT id_estado_pedido, descripcion
      FROM estados_pedido
      ORDER BY
        CASE
          WHEN lower(trim(descripcion)) = ANY($1::text[]) THEN 0
          ELSE 1
        END,
        id_estado_pedido
      LIMIT 1
    `,
    [[...ESTADOS_COMPLETADOS]]
  );

  return result.rows[0]?.id_estado_pedido ?? null;
};

const resolveSucursalId = async (client, requestedId) => {
  if (requestedId) {
    const result = await client.query(
      'SELECT id_sucursal FROM sucursales WHERE id_sucursal = $1 AND COALESCE(estado, true) = true LIMIT 1',
      [requestedId]
    );
    return result.rowCount > 0 ? requestedId : null;
  }

  const result = await client.query(
    'SELECT id_sucursal FROM sucursales WHERE COALESCE(estado, true) = true ORDER BY id_sucursal LIMIT 1'
  );

  return result.rows[0]?.id_sucursal ?? null;
};

const resolveCajaId = async (client, idSucursal, idUsuario) => {
  if (!idSucursal) return null;

  const exactMatch = await client.query(
    `
      SELECT id_caja
      FROM cajas
      WHERE id_sucursal = $1
        AND COALESCE(estado, true) = true
        AND ($2::int IS NULL OR id_usuario = $2)
      ORDER BY id_caja
      LIMIT 1
    `,
    [idSucursal, idUsuario || null]
  );

  if (exactMatch.rowCount > 0) {
    return exactMatch.rows[0].id_caja;
  }

  const bySucursal = await client.query(
    `
      SELECT id_caja
      FROM cajas
      WHERE id_sucursal = $1
        AND COALESCE(estado, true) = true
      ORDER BY id_caja
      LIMIT 1
    `,
    [idSucursal]
  );

  return bySucursal.rows[0]?.id_caja ?? null;
};

const fetchProductosMap = async (client, items) => {
  const ids = [...new Set(items.map((item) => item.id_producto))];

  const result = await client.query(
    `
      SELECT id_producto, nombre_producto, precio, estado
      FROM productos
      WHERE id_producto = ANY($1::int[])
    `,
    [ids]
  );

  const map = new Map(result.rows.map((row) => [Number(row.id_producto), row]));
  return { ids, map };
};

const fetchClienteInfo = async (client, idCliente) => {
  if (!idCliente) return null;

  const result = await client.query(
    `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        e.nombre_empresa
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      WHERE c.id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};

const allocateDiscounts = (lineSubtotals, totalDiscount) => {
  if (!totalDiscount || totalDiscount <= 0) {
    return lineSubtotals.map(() => 0);
  }

  const subtotal = roundMoney(lineSubtotals.reduce((sum, value) => sum + value, 0));
  if (subtotal <= 0) {
    return lineSubtotals.map(() => 0);
  }

  let remaining = roundMoney(totalDiscount);

  return lineSubtotals.map((lineSubtotal, index) => {
    if (index === lineSubtotals.length - 1) {
      return remaining;
    }

    const proportional = roundMoney((lineSubtotal / subtotal) * totalDiscount);
    remaining = roundMoney(remaining - proportional);
    return proportional;
  });
};

const buildVentaPayload = async ({ client, body, userId }) => {
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, body: { error: true, message: 'Payload invalido para crear venta.' } };
  }

  const normalizedItemsResult = normalizeItems(body.items);
  if (!normalizedItemsResult.ok) {
    return { ok: false, status: 400, body: { error: true, message: normalizedItemsResult.message } };
  }

  const idCliente = parseOptionalPositiveInt(body.id_cliente);
  const idSucursalRequested = parseOptionalPositiveInt(body.id_sucursal);
  const idEstadoPedidoRequested = parseOptionalPositiveInt(body.id_estado_pedido);
  const descuentoTotal = parseNonNegativeNumber(body.descuento ?? 0);
  const efectivoEntregadoInput = parseNonNegativeNumber(body.efectivo_entregado);
  const metodoPago = String(body.metodo_pago || 'efectivo').trim().toLowerCase();

  if (body.descuento !== undefined && descuentoTotal === null) {
    return { ok: false, status: 400, body: { error: true, message: 'descuento debe ser un numero mayor o igual a 0.' } };
  }

  if (body.efectivo_entregado !== undefined && efectivoEntregadoInput === null) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'efectivo_entregado debe ser un numero mayor o igual a 0.' }
    };
  }

  if (metodoPago !== 'efectivo') {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'El esquema actual solo soporta ventas en efectivo.'
      }
    };
  }

  if (!userId) {
    return {
      ok: false,
      status: 401,
      body: { error: true, message: 'No se pudo resolver el usuario autenticado para la venta.' }
    };
  }

  const idSucursal = await resolveSucursalId(client, idSucursalRequested);
  if (!idSucursal) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'No se pudo resolver una sucursal activa para la venta.' }
    };
  }

  const idEstadoPedido = await resolveEstadoPedidoId(client, idEstadoPedidoRequested);
  if (idEstadoPedidoRequested && !idEstadoPedido) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'id_estado_pedido no existe.' }
    };
  }

  if (idCliente) {
    const cliente = await fetchClienteInfo(client, idCliente);
    if (!cliente) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: 'id_cliente no existe.' }
      };
    }
  }

  const items = normalizedItemsResult.data;
  const { ids, map } = await fetchProductosMap(client, items);

  const faltantes = ids.filter((idProducto) => !map.has(idProducto));
  if (faltantes.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: `Productos no encontrados: ${faltantes.join(', ')}` }
    };
  }

  const inactiveProducts = ids.filter((idProducto) => {
    const producto = map.get(idProducto);
    return !(producto?.estado === true || producto?.estado === 'true' || producto?.estado === 1 || producto?.estado === '1');
  });

  if (inactiveProducts.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: `Productos inactivos en la venta: ${inactiveProducts.join(', ')}` }
    };
  }

  const lineSubtotals = items.map((item) => {
    const producto = map.get(item.id_producto);
    return roundMoney(Number(producto.precio) * item.cantidad);
  });

  const subtotalBruto = roundMoney(lineSubtotals.reduce((sum, value) => sum + value, 0));
  if (descuentoTotal > subtotalBruto) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' }
    };
  }

  const descuentosPorLinea = allocateDiscounts(lineSubtotals, descuentoTotal);
  const subtotal = roundMoney(subtotalBruto - descuentoTotal);
  const isv = roundMoney(subtotal * 0.15);
  const total = roundMoney(subtotal + isv);
  const efectivoEntregado = efectivoEntregadoInput === null ? total : efectivoEntregadoInput;

  if (efectivoEntregado < total) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'efectivo_entregado no puede ser menor al total.' }
    };
  }

  const idCaja = await resolveCajaId(client, idSucursal, userId);

  return {
    ok: true,
    data: {
      metodo_pago: metodoPago,
      descripcion_pedido: typeof body.descripcion_pedido === 'string' ? body.descripcion_pedido.trim() : null,
      descripcion_envio: typeof body.descripcion_envio === 'string' ? body.descripcion_envio.trim() : null,
      descuento: descuentoTotal,
      subtotal,
      isv,
      total,
      efectivo_entregado: efectivoEntregado,
      cambio: roundMoney(efectivoEntregado - total),
      id_caja: idCaja,
      id_cliente: idCliente,
      id_sucursal: idSucursal,
      id_estado_pedido: idEstadoPedido,
      id_usuario: userId,
      lines: items.map((item, index) => {
        const producto = map.get(item.id_producto);
        const subTotalLinea = lineSubtotals[index];
        const descuentoLinea = descuentosPorLinea[index];
        return {
          id_producto: item.id_producto,
          nombre_producto: producto.nombre_producto,
          cantidad: item.cantidad,
          precio_unitario: roundMoney(producto.precio),
          sub_total: subTotalLinea,
          descuento: descuentoLinea,
          total_linea: roundMoney(subTotalLinea - descuentoLinea)
        };
      })
    }
  };
};

router.get('/ventas/catalogos/clientes', async (req, res) => {
  try {
    const query = `
      SELECT
        c.id_cliente,
        c.estado,
        c.id_tipo_cliente,
        p.nombre,
        p.apellido,
        e.nombre_empresa
      FROM clientes c
      LEFT JOIN personas p ON p.id_persona = c.id_persona
      LEFT JOIN empresas e ON e.id_empresa = c.id_empresa
      WHERE COALESCE(c.estado, true) = true
      ORDER BY
        COALESCE(NULLIF(trim(concat_ws(' ', p.nombre, p.apellido)), ''), e.nombre_empresa, c.id_cliente::text)
    `;

    const result = await pool.query(query);
    const data = result.rows.map((row) => ({
      id_cliente: row.id_cliente,
      id_tipo_cliente: row.id_tipo_cliente,
      estado: row.estado,
      nombre_cliente: normalizeClienteNombre(row),
      es_consumidor_final: false
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar catalogo de clientes para ventas:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.get('/ventas', async (req, res) => {
  try {
    const filters = [];
    const params = [];

    const pushFilter = (fragment, value) => {
      params.push(value);
      filters.push(fragment.replace('$IDX', `$${params.length}`));
    };

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const idEstadoPedido = parseOptionalPositiveInt(req.query.id_estado_pedido);
    const idSucursal = parseOptionalPositiveInt(req.query.id_sucursal);
    const idCliente = parseOptionalPositiveInt(req.query.id_cliente);

    if (q) {
      const qLike = `%${q}%`;
      pushFilter(
        `
          (
            p.id_pedido::text ILIKE $IDX
            OR COALESCE(ep.descripcion, '') ILIKE $IDX
            OR COALESCE(s.nombre_sucursal, '') ILIKE $IDX
            OR COALESCE(u.nombre_usuario, '') ILIKE $IDX
            OR COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') ILIKE $IDX
          )
        `,
        qLike
      );
    }

    if (idEstadoPedido) {
      pushFilter('p.id_estado_pedido = $IDX', idEstadoPedido);
    }

    if (idSucursal) {
      pushFilter('p.id_sucursal = $IDX', idSucursal);
    }

    if (idCliente) {
      pushFilter('p.id_cliente = $IDX', idCliente);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      SELECT
        p.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        p.fecha_hora_pedido,
        p.sub_total,
        p.isv,
        p.total,
        p.id_estado_pedido,
        ep.descripcion AS estado_pedido,
        p.id_sucursal,
        s.nombre_sucursal,
        p.id_cliente,
        COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') AS cliente_nombre,
        p.id_usuario,
        u.nombre_usuario,
        f.id_factura,
        f.id_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        f.isv_15,
        f.isv_18,
        COALESCE(df_info.total_items, dp_info.total_items, 0) AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total
      FROM pedidos p
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = p.id_usuario
      LEFT JOIN facturas f ON f.id_pedido = p.id_pedido
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(df.cantidad, 0))::int AS total_items,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(12,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total_items
        FROM detalle_pedido dp
        WHERE dp.id_pedido = p.id_pedido
          AND COALESCE(dp.estado, true) = true
      ) dp_info ON true
      ${whereClause}
      ORDER BY p.id_pedido DESC
    `;

    const result = await pool.query(query, params);
    const data = result.rows.map((row) => ({
      ...row,
      numero_venta: formatVentaNumero(row.id_pedido),
      metodo_pago: row.id_factura ? 'efectivo' : null
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar ventas:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.get('/ventas/:id', async (req, res) => {
  try {
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const headerQuery = `
      SELECT
        p.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        p.fecha_hora_pedido,
        p.sub_total,
        p.isv,
        p.total,
        p.id_estado_pedido,
        ep.descripcion AS estado_pedido,
        p.id_sucursal,
        s.nombre_sucursal,
        p.id_cliente,
        COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') AS cliente_nombre,
        p.id_usuario,
        u.nombre_usuario,
        f.id_factura,
        f.id_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        f.isv_15,
        f.isv_18
      FROM pedidos p
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = p.id_usuario
      LEFT JOIN facturas f ON f.id_pedido = p.id_pedido
      WHERE p.id_pedido = $1
      LIMIT 1
    `;

    const headerResult = await pool.query(headerQuery, [idPedido]);
    if (headerResult.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Venta no encontrada.' });
    }

    const venta = headerResult.rows[0];

    let items = [];

    if (venta.id_factura) {
      const itemsResult = await pool.query(
        `
          SELECT
            df.id_detalle_factura AS id_detalle,
            df.id_producto,
            p.nombre_producto,
            COALESCE(df.cantidad, 1) AS cantidad,
            COALESCE(df.precio_unitario, p.precio, 0) AS precio_unitario,
            COALESCE(df.sub_total, 0) AS sub_total,
            COALESCE(df.total_detalle, 0) AS total_linea,
            COALESCE(d.monto_descuento, 0) AS descuento
          FROM detalle_facturas df
          LEFT JOIN productos p ON p.id_producto = df.id_producto
          LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
          WHERE df.id_factura = $1
          ORDER BY df.id_detalle_factura
        `,
        [venta.id_factura]
      );

      items = itemsResult.rows;
    }

    if (items.length === 0) {
      const fallbackItems = await pool.query(
        `
          SELECT
            dp.id_detalle_pedido AS id_detalle,
            dp.id_producto,
            p.nombre_producto,
            1 AS cantidad,
            CASE
              WHEN COALESCE(dp.total_pedido, 0) > 0 THEN COALESCE(dp.total_pedido, 0)
              ELSE COALESCE(dp.sub_total_pedido, 0)
            END AS precio_unitario,
            COALESCE(dp.sub_total_pedido, 0) AS sub_total,
            COALESCE(dp.total_pedido, 0) AS total_linea,
            COALESCE(d.monto_descuento, 0) AS descuento
          FROM detalle_pedido dp
          LEFT JOIN productos p ON p.id_producto = dp.id_producto
          LEFT JOIN descuentos d ON d.id_descuento = dp.id_descuento
          WHERE dp.id_pedido = $1
            AND COALESCE(dp.estado, true) = true
          ORDER BY dp.id_detalle_pedido
        `,
        [idPedido]
      );

      items = fallbackItems.rows.map((row) => ({
        ...row,
        precio_unitario: row.sub_total > 0 ? row.sub_total : row.precio_unitario
      }));
    }

    res.status(200).json({
      ...venta,
      numero_venta: formatVentaNumero(venta.id_pedido),
      metodo_pago: venta.id_factura ? 'efectivo' : null,
      items
    });
  } catch (err) {
    console.error('Error al obtener detalle de venta:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.post('/ventas', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userId = req.user?.id_usuario ?? null;
    const prepared = await buildVentaPayload({
      client,
      body: req.body,
      userId
    });

    if (!prepared.ok) {
      await client.query('ROLLBACK');
      return res.status(prepared.status).json(prepared.body);
    }

    const venta = prepared.data;

    const pedidoResult = await client.query(
      `
        INSERT INTO pedidos (
          descripcion_pedido,
          descripcion_envio,
          fecha_hora_pedido,
          sub_total,
          isv,
          total,
          id_estado_pedido,
          id_sucursal,
          id_cliente,
          id_usuario
        )
        VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id_pedido
      `,
      [
        venta.descripcion_pedido,
        venta.descripcion_envio,
        venta.subtotal,
        venta.isv,
        venta.total,
        venta.id_estado_pedido,
        venta.id_sucursal,
        venta.id_cliente,
        venta.id_usuario
      ]
    );

    const idPedido = pedidoResult.rows[0].id_pedido;

    for (const line of venta.lines) {
      let idDescuento = null;

      if (line.descuento > 0) {
        const descuentoResult = await client.query(
          'INSERT INTO descuentos (monto_descuento) VALUES ($1) RETURNING id_descuento',
          [line.descuento]
        );
        idDescuento = descuentoResult.rows[0].id_descuento;
      }

      await client.query(
        `
          INSERT INTO detalle_pedido (
            sub_total_pedido,
            total_pedido,
            id_producto,
            id_pedido,
            id_descuento,
            estado
          )
          VALUES ($1, $2, $3, $4, $5, true)
        `,
        [
          line.sub_total,
          line.total_linea,
          line.id_producto,
          idPedido,
          idDescuento
        ]
      );

      line.id_descuento = idDescuento;
    }

    const facturaResult = await client.query(
      `
        INSERT INTO facturas (
          id_caja,
          id_pedido,
          id_sucursal,
          id_usuario,
          id_cliente,
          efectivo_entregado,
          cambio,
          fecha_hora_facturacion,
          isv_15,
          isv_18
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8, 0)
        RETURNING id_factura
      `,
      [
        venta.id_caja,
        idPedido,
        venta.id_sucursal,
        venta.id_usuario,
        venta.id_cliente,
        venta.efectivo_entregado,
        venta.cambio,
        venta.isv
      ]
    );

    const idFactura = facturaResult.rows[0].id_factura;

    for (const line of venta.lines) {
      await client.query(
        `
          INSERT INTO detalle_facturas (
            id_factura,
            id_producto,
            id_descuento,
            cantidad,
            precio_unitario,
            sub_total,
            total_detalle
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          idFactura,
          line.id_producto,
          line.id_descuento,
          line.cantidad,
          line.precio_unitario,
          line.sub_total,
          line.total_linea
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Venta creada exitosamente.',
      id_pedido: idPedido,
      id_factura: idFactura,
      numero_venta: formatVentaNumero(idPedido),
      total: venta.total
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al crear venta:', err.message);
    res.status(500).json({ error: true, message: err.message });
  } finally {
    client.release();
  }
});

export default router;
