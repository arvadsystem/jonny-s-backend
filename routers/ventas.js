import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const VENTA_DIRECTA_LABEL = 'VENTA DIRECTA';
const ESTADO_PEDIDO_CODES = {
  PENDIENTE: new Set(['pendiente']),
  EN_COCINA: new Set(['en_cocina']),
  EN_PREPARACION: new Set(['en_preparacion']),
  LISTO_PARA_ENTREGA: new Set(['listo_para_entrega']),
  COMPLETADO: new Set([
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
  ])
};

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

const formatVentaNumero = (idVenta) => `VTA-${String(idVenta).padStart(5, '0')}`;

const normalizeClienteNombre = (cliente) => {
  const nombrePersona = [cliente?.nombre, cliente?.apellido].filter(Boolean).join(' ').trim();
  if (nombrePersona) return nombrePersona;
  if (cliente?.nombre_empresa) return cliente.nombre_empresa;
  return 'Consumidor final';
};

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const parseBooleanish = (value) =>
  value === true || value === 'true' || value === 1 || value === '1';

const parseEntityIdentifier = (value, fieldName) => {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 0 ||
    value === '0'
  ) {
    return { ok: true, value: null };
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      message: `${fieldName} debe ser un entero mayor a 0 o null.`
    };
  }

  return { ok: true, value: parsed };
};

const normalizeObservation = (value) => {
  if (value === undefined || value === null) return null;

  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  return normalized.slice(0, 200);
};

const buildKitchenDescriptionSummary = (lines, fallbackValue = null) => {
  const summary = (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.requiere_cocina && line?.observacion)
    .map((line) => `${line.nombre_item}: ${line.observacion}`)
    .join(' | ')
    .slice(0, 250);

  if (summary) return summary;

  const fallback =
    typeof fallbackValue === 'string'
      ? fallbackValue.replace(/\s+/g, ' ').trim().slice(0, 250)
      : '';

  return fallback || null;
};

const inferKitchenItemQuantity = (rawSubtotal, rawUnitPrice) => {
  const subtotal = Number(rawSubtotal || 0);
  const unitPrice = Number(rawUnitPrice || 0);

  if (!Number.isFinite(subtotal) || subtotal <= 0) return 1;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 1;

  const inferred = Math.round(subtotal / unitPrice);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 1;
};

const buildDirectSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    tipo_item: 'PRODUCTO',
    nombre_item: row.nombre_item || row.nombre_producto || 'Producto',
    nombre_producto: row.nombre_producto || row.nombre_item || 'Producto',
    cantidad: Number(row.cantidad ?? 0) || 0,
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    observacion: null
  }));

const buildKitchenSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    nombre_item: row.nombre_item || 'Item de cocina',
    nombre_producto: row.nombre_item || 'Item de cocina',
    cantidad: inferKitchenItemQuantity(row.sub_total, row.precio_unitario),
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    observacion: normalizeObservation(row.observacion)
  }));

const normalizeVentaItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Debe enviar al menos un item en la venta.' };
  }

  const normalized = [];

  for (const item of items) {
    if (!isPlainObject(item)) {
      return { ok: false, message: 'Cada item debe ser un objeto valido.' };
    }

    const productoResult = parseEntityIdentifier(item.id_producto, 'id_producto');
    if (!productoResult.ok) return { ok: false, message: productoResult.message };

    const comboResult = parseEntityIdentifier(item.id_combo, 'id_combo');
    if (!comboResult.ok) return { ok: false, message: comboResult.message };

    const recetaResult = parseEntityIdentifier(item.id_receta, 'id_receta');
    if (!recetaResult.ok) return { ok: false, message: recetaResult.message };

    const cantidad = parsePositiveInt(item.cantidad);
    if (!cantidad) {
      return {
        ok: false,
        message: 'Cada item debe incluir cantidad entera mayor a 0.'
      };
    }

    const presentIds = [
      ['PRODUCTO', productoResult.value],
      ['COMBO', comboResult.value],
      ['RECETA', recetaResult.value]
    ].filter(([, value]) => value !== null);

    if (presentIds.length !== 1) {
      return {
        ok: false,
        message:
          'Cada item debe incluir exactamente uno entre id_producto, id_combo o id_receta.'
      };
    }

    const [kind, entityId] = presentIds[0];
    normalized.push({
      kind,
      cantidad,
      id_producto: kind === 'PRODUCTO' ? entityId : null,
      id_combo: kind === 'COMBO' ? entityId : null,
      id_receta: kind === 'RECETA' ? entityId : null,
      observacion: normalizeObservation(item.observacion)
    });
  }

  return { ok: true, data: normalized };
};

const fetchProductoMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT id_producto, nombre_producto, precio, estado
      FROM productos
      WHERE id_producto = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_producto), row]));
};

const fetchComboMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT id_combo, descripcion, precio, estado
      FROM combos
      WHERE id_combo = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_combo), row]));
};

const fetchRecetaMap = async (client, ids) => {
  if (!ids.length) return new Map();

  const result = await client.query(
    `
      SELECT
        r.id_receta,
        r.nombre_receta,
        r.estado,
        r.id_producto AS id_producto_base,
        p.nombre_producto AS nombre_producto_base,
        p.precio AS precio_producto_base,
        p.estado AS estado_producto_base
      FROM recetas r
      LEFT JOIN productos p ON p.id_producto = r.id_producto
      WHERE r.id_receta = ANY($1::int[])
    `,
    [ids]
  );

  return new Map(result.rows.map((row) => [Number(row.id_receta), row]));
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

const fetchEstadoPedidoRows = async (client) => {
  const result = await client.query(
    'SELECT id_estado_pedido, descripcion FROM estados_pedido ORDER BY id_estado_pedido'
  );
  return result.rows;
};

const resolveEstadoPedidoIdByCode = async (client, code) => {
  const aliases = ESTADO_PEDIDO_CODES[code];
  if (!aliases || aliases.size === 0) return null;

  const rows = await fetchEstadoPedidoRows(client);
  const match = rows.find((row) => aliases.has(normalizeTextKey(row.descripcion)));
  return match?.id_estado_pedido ?? null;
};

const resolveRequestedEstadoPedidoId = async (client, requestedId) => {
  if (!requestedId) return null;

  const result = await client.query(
    'SELECT id_estado_pedido FROM estados_pedido WHERE id_estado_pedido = $1 LIMIT 1',
    [requestedId]
  );

  return result.rowCount > 0 ? requestedId : null;
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

const hydrateVentaLines = async (client, normalizedItems) => {
  const productoIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'PRODUCTO')
        .map((item) => item.id_producto)
    )
  ];
  const comboIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'COMBO')
        .map((item) => item.id_combo)
    )
  ];
  const recetaIds = [
    ...new Set(
      normalizedItems
        .filter((item) => item.kind === 'RECETA')
        .map((item) => item.id_receta)
    )
  ];

  const [productoMap, comboMap, recetaMap] = await Promise.all([
    fetchProductoMap(client, productoIds),
    fetchComboMap(client, comboIds),
    fetchRecetaMap(client, recetaIds)
  ]);

  const lines = [];
  const subTotals = [];

  for (const item of normalizedItems) {
    if (item.kind === 'PRODUCTO') {
      const producto = productoMap.get(item.id_producto);
      if (!producto) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Producto no encontrado: ${item.id_producto}` }
        };
      }

      if (!parseBooleanish(producto.estado)) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Producto inactivo en la venta: ${item.id_producto}` }
        };
      }

      const precioUnitario = roundMoney(producto.precio);
      const subTotal = roundMoney(precioUnitario * item.cantidad);

      lines.push({
        kind: 'PRODUCTO',
        requiere_cocina: false,
        id_producto: item.id_producto,
        id_combo: null,
        id_receta: null,
        nombre_item: producto.nombre_producto,
        cantidad: item.cantidad,
        precio_unitario: precioUnitario,
        sub_total: subTotal,
        observacion: null
      });
      subTotals.push(subTotal);
      continue;
    }

    if (item.kind === 'COMBO') {
      const combo = comboMap.get(item.id_combo);
      if (!combo) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Combo no encontrado: ${item.id_combo}` }
        };
      }

      if (!parseBooleanish(combo.estado)) {
        return {
          ok: false,
          status: 400,
          body: { error: true, message: `Combo inactivo en la venta: ${item.id_combo}` }
        };
      }

      const precioUnitario = roundMoney(combo.precio);
      const subTotal = roundMoney(precioUnitario * item.cantidad);

      lines.push({
        kind: 'COMBO',
        requiere_cocina: true,
        id_producto: null,
        id_combo: item.id_combo,
        id_receta: null,
        nombre_item: combo.descripcion || `Combo #${item.id_combo}`,
        cantidad: item.cantidad,
        precio_unitario: precioUnitario,
        sub_total: subTotal,
        observacion: item.observacion
      });
      subTotals.push(subTotal);
      continue;
    }

    const receta = recetaMap.get(item.id_receta);
    if (!receta) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: `Receta no encontrada: ${item.id_receta}` }
      };
    }

    if (!parseBooleanish(receta.estado)) {
      return {
        ok: false,
        status: 400,
        body: { error: true, message: `Receta inactiva en la venta: ${item.id_receta}` }
      };
    }

    if (!receta.id_producto_base || !receta.nombre_producto_base) {
      return {
        ok: false,
        status: 400,
        body: {
          error: true,
          message: `La receta ${item.id_receta} no tiene un producto base valido.`
        }
      };
    }

    if (!parseBooleanish(receta.estado_producto_base)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: true,
          message: `El producto base de la receta ${item.id_receta} esta inactivo.`
        }
      };
    }

    const precioUnitario = roundMoney(receta.precio_producto_base);
    const subTotal = roundMoney(precioUnitario * item.cantidad);

    lines.push({
      kind: 'RECETA',
      requiere_cocina: true,
      id_producto: null,
      id_combo: null,
      id_receta: item.id_receta,
      nombre_item: receta.nombre_receta || receta.nombre_producto_base,
      cantidad: item.cantidad,
      precio_unitario: precioUnitario,
      sub_total: subTotal,
      observacion: item.observacion
    });
    subTotals.push(subTotal);
  }

  return { ok: true, data: { lines, subTotals } };
};

const buildVentaPayload = async ({ client, body, userId }) => {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'Payload invalido para crear venta.' }
    };
  }

  const normalizedItemsResult = normalizeVentaItems(body.items);
  if (!normalizedItemsResult.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: normalizedItemsResult.message }
    };
  }

  const idCliente = parseOptionalPositiveInt(body.id_cliente);
  const idSucursalRequested = parseOptionalPositiveInt(body.id_sucursal);
  const idEstadoPedidoRequested = parseOptionalPositiveInt(body.id_estado_pedido);
  const descuentoTotal = parseNonNegativeNumber(body.descuento ?? 0);
  const efectivoEntregadoInput = parseNonNegativeNumber(body.efectivo_entregado);
  const metodoPago = String(body.metodo_pago || 'efectivo').trim().toLowerCase();

  if (body.descuento !== undefined && descuentoTotal === null) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'descuento debe ser un numero mayor o igual a 0.' }
    };
  }

  if (body.efectivo_entregado !== undefined && efectivoEntregadoInput === null) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'efectivo_entregado debe ser un numero mayor o igual a 0.'
      }
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
      body: {
        error: true,
        message: 'No se pudo resolver el usuario autenticado para la venta.'
      }
    };
  }

  const idSucursal = await resolveSucursalId(client, idSucursalRequested);
  if (!idSucursal) {
    return {
      ok: false,
      status: 400,
      body: {
        error: true,
        message: 'No se pudo resolver una sucursal activa para la venta.'
      }
    };
  }

  const requestedEstadoPedido = await resolveRequestedEstadoPedidoId(client, idEstadoPedidoRequested);
  if (idEstadoPedidoRequested && !requestedEstadoPedido) {
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

  const hydratedResult = await hydrateVentaLines(client, normalizedItemsResult.data);
  if (!hydratedResult.ok) return hydratedResult;

  const { lines, subTotals } = hydratedResult.data;
  const subtotalBruto = roundMoney(subTotals.reduce((sum, value) => sum + value, 0));

  if (descuentoTotal > subtotalBruto) {
    return {
      ok: false,
      status: 400,
      body: { error: true, message: 'El descuento no puede ser mayor al subtotal.' }
    };
  }

  const descuentosPorLinea = allocateDiscounts(subTotals, descuentoTotal);
  const finalizedLines = lines.map((line, index) => ({
    ...line,
    descuento: descuentosPorLinea[index],
    total_linea: roundMoney(line.sub_total - descuentosPorLinea[index])
  }));

  const subtotal = roundMoney(finalizedLines.reduce((sum, line) => sum + line.total_linea, 0));
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
  const kitchenLines = finalizedLines.filter((line) => line.requiere_cocina);
  const directLines = finalizedLines.filter((line) => !line.requiere_cocina);
  const pedidoSubtotal = roundMoney(
    kitchenLines.reduce((sum, line) => sum + line.total_linea, 0)
  );
  const pedidoIsv = roundMoney(pedidoSubtotal * 0.15);
  const pedidoTotal = roundMoney(pedidoSubtotal + pedidoIsv);

  let idEstadoPedido = null;
  if (kitchenLines.length > 0) {
    idEstadoPedido =
      requestedEstadoPedido || (await resolveEstadoPedidoIdByCode(client, 'EN_COCINA'));

    if (!idEstadoPedido) {
      return {
        ok: false,
        status: 409,
        body: {
          error: true,
          message:
            'No existe el estado EN_COCINA en estados_pedido. Aplica el seed del KDS antes de facturar items de cocina.'
        }
      };
    }
  }

  return {
    ok: true,
    data: {
      metodo_pago: metodoPago,
      descripcion_pedido: buildKitchenDescriptionSummary(
        kitchenLines,
        typeof body.descripcion_pedido === 'string' ? body.descripcion_pedido : null
      ),
      descripcion_envio:
        typeof body.descripcion_envio === 'string' ? body.descripcion_envio.trim() : null,
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
      direct_lines: directLines,
      kitchen_lines: kitchenLines,
      pedido_subtotal: pedidoSubtotal,
      pedido_isv: pedidoIsv,
      pedido_total: pedidoTotal
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

router.get('/ventas/catalogos/combos', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id_combo, descripcion, precio, estado
        FROM combos
        WHERE COALESCE(estado, true) = true
        ORDER BY COALESCE(descripcion, id_combo::text)
      `
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al listar catalogo de combos para ventas:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.get('/ventas/catalogos/recetas', async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          r.id_receta,
          r.nombre_receta,
          r.estado,
          r.id_producto AS id_producto_base,
          p.nombre_producto AS nombre_producto_base,
          p.precio,
          p.estado AS estado_producto_base
        FROM recetas r
        LEFT JOIN productos p ON p.id_producto = r.id_producto
        WHERE COALESCE(r.estado, true) = true
          AND p.id_producto IS NOT NULL
          AND COALESCE(p.estado, true) = true
        ORDER BY COALESCE(r.nombre_receta, p.nombre_producto, r.id_receta::text)
      `
    );

    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error al listar catalogo de recetas para ventas:', err.message);
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
            f.id_factura::text ILIKE $IDX
            OR COALESCE(f.id_pedido::text, '') ILIKE $IDX
            OR COALESCE(ep.descripcion, '${VENTA_DIRECTA_LABEL}') ILIKE $IDX
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
      pushFilter('COALESCE(p.id_sucursal, f.id_sucursal) = $IDX', idSucursal);
    }

    if (idCliente) {
      pushFilter('COALESCE(p.id_cliente, f.id_cliente) = $IDX', idCliente);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const query = `
      SELECT
        f.id_factura,
        f.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion) AS fecha_hora_pedido,
        COALESCE(p.sub_total, df_info.subtotal_neto, 0) AS sub_total,
        COALESCE(p.isv, COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 0) AS isv,
        COALESCE(
          p.total,
          COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
        ) AS total,
        p.id_estado_pedido,
        CASE
          WHEN p.id_pedido IS NULL THEN '${VENTA_DIRECTA_LABEL}'
          ELSE ep.descripcion
        END AS estado_pedido,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        s.nombre_sucursal,
        COALESCE(p.id_cliente, f.id_cliente) AS id_cliente,
        COALESCE(
          NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
          emp.nombre_empresa,
          'Consumidor final'
        ) AS cliente_nombre,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        u.nombre_usuario,
        f.id_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        f.isv_15,
        f.isv_18,
        COALESCE(df_info.total_items, dp_info.total_items, 0) AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total
      FROM facturas f
      LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
      LEFT JOIN clientes c ON c.id_cliente = COALESCE(p.id_cliente, f.id_cliente)
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(df.cantidad, 0))::int AS total_items,
          COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(12,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS total_items
        FROM detalle_pedido dp
        WHERE dp.id_pedido = f.id_pedido
          AND COALESCE(dp.estado, true) = true
      ) dp_info ON true
      ${whereClause}
      ORDER BY f.id_factura DESC
    `;

    const result = await pool.query(query, params);
    const data = result.rows.map((row) => ({
      ...row,
      numero_venta: formatVentaNumero(row.id_factura),
      metodo_pago: 'efectivo'
    }));

    res.status(200).json(data);
  } catch (err) {
    console.error('Error al listar ventas:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.get('/ventas/:id', async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const headerQuery = `
      SELECT
        f.id_factura,
        f.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        COALESCE(p.fecha_hora_pedido, f.fecha_hora_facturacion) AS fecha_hora_pedido,
        COALESCE(p.sub_total, df_info.subtotal_neto, 0) AS sub_total,
        COALESCE(p.isv, COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 0) AS isv,
        COALESCE(
          p.total,
          COALESCE(df_info.subtotal_neto, 0) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0)
        ) AS total,
        p.id_estado_pedido,
        CASE
          WHEN p.id_pedido IS NULL THEN '${VENTA_DIRECTA_LABEL}'
          ELSE ep.descripcion
        END AS estado_pedido,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        s.nombre_sucursal,
        COALESCE(p.id_cliente, f.id_cliente) AS id_cliente,
        COALESCE(
          NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
          emp.nombre_empresa,
          'Consumidor final'
        ) AS cliente_nombre,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        u.nombre_usuario,
        f.id_caja,
        f.efectivo_entregado,
        f.cambio,
        f.fecha_hora_facturacion,
        f.isv_15,
        f.isv_18,
        COALESCE(df_info.total_items, 0) AS total_items,
        COALESCE(df_info.descuento_total, 0) AS descuento_total
      FROM facturas f
      LEFT JOIN pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
      LEFT JOIN sucursales s ON s.id_sucursal = COALESCE(p.id_sucursal, f.id_sucursal)
      LEFT JOIN clientes c ON c.id_cliente = COALESCE(p.id_cliente, f.id_cliente)
      LEFT JOIN personas per ON per.id_persona = c.id_persona
      LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN usuarios u ON u.id_usuario = COALESCE(p.id_usuario, f.id_usuario)
      LEFT JOIN LATERAL (
        SELECT
          SUM(COALESCE(df.cantidad, 0))::int AS total_items,
          COALESCE(SUM(df.total_detalle), 0)::numeric(12,2) AS subtotal_neto,
          COALESCE(SUM(d.monto_descuento), 0)::numeric(12,2) AS descuento_total
        FROM detalle_facturas df
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = f.id_factura
      ) df_info ON true
      WHERE f.id_factura = $1
      LIMIT 1
    `;

    const headerResult = await pool.query(headerQuery, [idFactura]);
    if (headerResult.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Venta no encontrada.' });
    }

    const venta = headerResult.rows[0];

    const directItemsResult = await pool.query(
      `
        SELECT
          df.id_detalle_factura AS id_detalle,
          'PRODUCTO' AS tipo_item,
          df.id_producto,
          NULL::int AS id_combo,
          NULL::int AS id_receta,
          p.nombre_producto AS nombre_item,
          p.nombre_producto,
          COALESCE(df.cantidad, 1) AS cantidad,
          COALESCE(df.precio_unitario, p.precio, 0) AS precio_unitario,
          COALESCE(df.sub_total, 0) AS sub_total,
          COALESCE(df.total_detalle, 0) AS total_linea,
          COALESCE(d.monto_descuento, 0) AS descuento,
          NULL::varchar(200) AS observacion
        FROM detalle_facturas df
        LEFT JOIN productos p ON p.id_producto = df.id_producto
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = $1
          AND df.id_producto IS NOT NULL
        ORDER BY df.id_detalle_factura
      `,
      [venta.id_factura]
    );

    let kitchenItems = [];

    if (venta.id_pedido) {
      const kitchenItemsResult = await pool.query(
        `
          SELECT
            dp.id_detalle_pedido AS id_detalle,
            CASE
              WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
              WHEN dp.id_combo IS NOT NULL THEN 'COMBO'
              WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
              ELSE 'ITEM'
            END AS tipo_item,
            dp.id_producto,
            dp.id_combo,
            dp.id_receta,
            COALESCE(prod.nombre_producto, combo.descripcion, rec.nombre_receta, 'Item de cocina') AS nombre_item,
            COALESCE(prod.nombre_producto, combo.descripcion, rec.nombre_receta, 'Item de cocina') AS nombre_producto,
            COALESCE(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN prod.precio
                WHEN dp.id_combo IS NOT NULL THEN combo.precio
                WHEN dp.id_receta IS NOT NULL THEN prod_rec.precio
                ELSE NULL
              END,
              CASE
                WHEN COALESCE(dp.sub_total_pedido, 0) > 0 THEN COALESCE(dp.sub_total_pedido, 0)
                ELSE COALESCE(dp.total_pedido, 0)
              END,
              0
            ) AS precio_unitario,
            COALESCE(dp.sub_total_pedido, 0) AS sub_total,
            COALESCE(dp.total_pedido, COALESCE(dp.sub_total_pedido, 0)) AS total_linea,
            COALESCE(d.monto_descuento, 0) AS descuento,
            dp.observacion
          FROM detalle_pedido dp
          LEFT JOIN productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN recetas rec ON rec.id_receta = dp.id_receta
          LEFT JOIN productos prod_rec ON prod_rec.id_producto = rec.id_producto
          LEFT JOIN descuentos d ON d.id_descuento = dp.id_descuento
          WHERE dp.id_pedido = $1
            AND COALESCE(dp.estado, true) = true
          ORDER BY dp.id_detalle_pedido
        `,
        [venta.id_pedido]
      );

      kitchenItems = buildKitchenSaleDetailItems(kitchenItemsResult.rows);
    }

    const directItems = buildDirectSaleDetailItems(directItemsResult.rows);
    const items = [...directItems, ...kitchenItems];

    res.status(200).json({
      ...venta,
      numero_venta: formatVentaNumero(venta.id_factura),
      metodo_pago: 'efectivo',
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
    const allLines = [...venta.direct_lines, ...venta.kitchen_lines];

    for (const line of allLines) {
      let idDescuento = null;

      if (line.descuento > 0) {
        const descuentoResult = await client.query(
          'INSERT INTO descuentos (monto_descuento) VALUES ($1) RETURNING id_descuento',
          [line.descuento]
        );
        idDescuento = descuentoResult.rows[0].id_descuento;
      }

      line.id_descuento = idDescuento;
    }

    let idPedido = null;

    if (venta.kitchen_lines.length > 0) {
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
          venta.pedido_subtotal,
          venta.pedido_isv,
          venta.pedido_total,
          venta.id_estado_pedido,
          venta.id_sucursal,
          venta.id_cliente,
          venta.id_usuario
        ]
      );

      idPedido = pedidoResult.rows[0].id_pedido;

      for (const line of venta.kitchen_lines) {
        await client.query(
          `
            INSERT INTO detalle_pedido (
              sub_total_pedido,
              total_pedido,
              id_producto,
              id_pedido,
              id_descuento,
              estado,
              id_combo,
              id_receta,
              observacion
            )
            VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8)
          `,
          [
            line.sub_total,
            line.total_linea,
            line.id_producto,
            idPedido,
            line.id_descuento,
            line.id_combo,
            line.id_receta,
            line.observacion
          ]
        );
      }
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

    for (const line of venta.direct_lines) {
      await client.query(
        `
          INSERT INTO detalle_facturas (
            id_factura,
            id_producto,
            id_descuento,
            cantidad,
            precio_unitario,
            sub_total,
            total_detalle,
            id_pedido
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
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

    for (const line of venta.kitchen_lines) {
      await client.query(
        `
          INSERT INTO detalle_facturas (
            id_factura,
            id_producto,
            id_descuento,
            cantidad,
            precio_unitario,
            sub_total,
            total_detalle,
            id_pedido
          )
          VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)
        `,
        [
          idFactura,
          line.id_descuento,
          line.cantidad,
          line.precio_unitario,
          line.sub_total,
          line.total_linea,
          idPedido
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Venta creada exitosamente.',
      id_factura: idFactura,
      id_pedido: idPedido,
      numero_venta: formatVentaNumero(idFactura),
      total: venta.total,
      venta_directa: idPedido === null
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
