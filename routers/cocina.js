import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const ESTADO_PEDIDO_CODES = {
  EN_COCINA: new Set(['en_cocina', 'en_cocina_pendiente']),
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

const BOARD_CODES = ['EN_COCINA', 'EN_PREPARACION', 'LISTO_PARA_ENTREGA'];
const COLUMN_BY_CODE = {
  EN_COCINA: 'PENDIENTES',
  EN_PREPARACION: 'EN_PREPARACION',
  LISTO_PARA_ENTREGA: 'LISTOS_PARA_ENTREGA'
};
const TRANSITIONS = {
  EN_COCINA: 'EN_PREPARACION',
  EN_PREPARACION: 'LISTO_PARA_ENTREGA',
  LISTO_PARA_ENTREGA: 'COMPLETADO'
};

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const buildTicketNumber = (idPedido) => `VTA-${String(idPedido).padStart(5, '0')}`;

const inferKitchenItemQuantity = (rawSubtotal, rawUnitPrice) => {
  const subtotal = Number(rawSubtotal || 0);
  const unitPrice = Number(rawUnitPrice || 0);

  if (!Number.isFinite(subtotal) || subtotal <= 0) return 1;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 1;

  const inferred = Math.round(subtotal / unitPrice);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 1;
};

const inferTipoServicio = (descripcionEnvio) => {
  const text = String(descripcionEnvio || '').trim().toLowerCase();
  if (!text) return 'LOCAL';
  if (text.includes('delivery')) return 'DELIVERY';
  if (text.includes('llevar')) return 'PARA_LLEVAR';
  return 'LOCAL';
};

const extractPedidoNotes = (descripcionPedido) =>
  String(descripcionPedido || '')
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);

const resolveItemModifications = ({ pedidoNotes, itemName, totalItems }) => {
  if (!pedidoNotes.length) return [];
  if (totalItems <= 1) return pedidoNotes;

  const itemKey = normalizeTextKey(itemName).replace(/_/g, ' ');
  const itemTokens = itemKey.split(' ').filter((token) => token.length >= 4);

  return pedidoNotes.filter((note) => {
    const noteKey = normalizeTextKey(note).replace(/_/g, ' ');
    if (itemKey && noteKey.includes(itemKey)) return true;
    return itemTokens.some((token) => noteKey.includes(token));
  });
};

const resolveEstadoCode = (descripcion) => {
  const key = normalizeTextKey(descripcion);
  for (const [code, aliases] of Object.entries(ESTADO_PEDIDO_CODES)) {
    if (aliases.has(key)) return code;
  }
  return null;
};

const fetchEstadoCatalog = async (client) => {
  const result = await client.query(
    'SELECT id_estado_pedido, descripcion FROM estados_pedido ORDER BY id_estado_pedido'
  );

  return result.rows.map((row) => ({
    ...row,
    code: resolveEstadoCode(row.descripcion)
  }));
};

const buildEstadoIdMap = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    if (row.code && !map.has(row.code)) {
      map.set(row.code, Number(row.id_estado_pedido));
    }
  });
  return map;
};

const tryCreateReadyNotification = async () => false;

router.get('/cocina/pedidos', async (req, res) => {
  try {
    const client = await pool.connect();

    try {
      const estadoRows = await fetchEstadoCatalog(client);
      const estadoIdMap = buildEstadoIdMap(estadoRows);
      const availableBoardCodes = BOARD_CODES.filter((code) => estadoIdMap.has(code));

      if (availableBoardCodes.length === 0) {
        return res.status(200).json([]);
      }

      const requestedSucursalId =
        req.query.id_sucursal === undefined || req.query.id_sucursal === ''
          ? null
          : parsePositiveInt(req.query.id_sucursal);
      if (req.query.id_sucursal !== undefined && req.query.id_sucursal !== '' && !requestedSucursalId) {
        return res.status(400).json({ error: true, message: 'id_sucursal invalido.' });
      }

      const requestedEstado = req.query.estado
        ? String(req.query.estado).trim().toUpperCase()
        : null;
      if (requestedEstado && !BOARD_CODES.includes(requestedEstado)) {
        return res.status(400).json({ error: true, message: 'estado invalido para el tablero KDS.' });
      }

      const filters = [];
      const params = [];

      const pushParam = (value) => {
        params.push(value);
        return `$${params.length}`;
      };

      const activeEstadoIds = requestedEstado
        ? estadoIdMap.has(requestedEstado)
          ? [estadoIdMap.get(requestedEstado)]
          : []
        : availableBoardCodes.map((code) => estadoIdMap.get(code));

      if (activeEstadoIds.length === 0) {
        return res.status(200).json([]);
      }

      filters.push(`p.id_estado_pedido = ANY(${pushParam(activeEstadoIds)}::int[])`);

      if (requestedSucursalId) {
        filters.push(`p.id_sucursal = ${pushParam(requestedSucursalId)}`);
      }

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q) {
        const qLike = `%${q}%`;
        const qParam = pushParam(qLike);
        filters.push(`
          (
            p.id_pedido::text ILIKE ${qParam}
            OR COALESCE(s.nombre_sucursal, '') ILIKE ${qParam}
            OR COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') ILIKE ${qParam}
            OR COALESCE(prod.nombre_producto, combo.descripcion, rec.nombre_receta, '') ILIKE ${qParam}
          )
        `);
      }

      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

      const result = await client.query(
        `
          SELECT
            p.id_pedido,
            p.id_estado_pedido,
            ep.descripcion AS estado_descripcion,
            p.descripcion_pedido,
            p.descripcion_envio,
            p.fecha_hora_pedido,
            p.total,
            p.sub_total,
            p.isv,
            p.id_sucursal,
            s.nombre_sucursal,
            p.id_cliente,
            COALESCE(
              NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
              emp.nombre_empresa,
              'Consumidor final'
            ) AS cliente_nombre,
            f.fecha_hora_facturacion,
            dp.id_detalle_pedido,
            dp.id_producto,
            dp.id_combo,
            dp.id_receta,
            COALESCE(prod.nombre_producto, combo.descripcion, rec.nombre_receta, 'Item de cocina') AS nombre_item,
            COALESCE(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN prod.precio
                WHEN dp.id_combo IS NOT NULL THEN combo.precio
                WHEN dp.id_receta IS NOT NULL THEN prod_rec.precio
                ELSE NULL
              END,
              NULLIF(COALESCE(dp.sub_total_pedido, 0), 0),
              NULLIF(COALESCE(dp.total_pedido, 0), 0),
              0
            ) AS precio_unitario,
            COALESCE(dp.sub_total_pedido, 0) AS sub_total_item,
            COALESCE(dp.total_pedido, COALESCE(dp.sub_total_pedido, 0)) AS total_linea
          FROM pedidos p
          LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
          LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
          LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
          LEFT JOIN personas per ON per.id_persona = c.id_persona
          LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
          LEFT JOIN facturas f ON f.id_pedido = p.id_pedido
          LEFT JOIN detalle_pedido dp
            ON dp.id_pedido = p.id_pedido
           AND COALESCE(dp.estado, true) = true
          LEFT JOIN productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN combos combo ON combo.id_combo = dp.id_combo
          LEFT JOIN recetas rec ON rec.id_receta = dp.id_receta
          LEFT JOIN productos prod_rec ON prod_rec.id_producto = rec.id_producto
          ${whereClause}
          ORDER BY p.fecha_hora_pedido ASC, dp.id_detalle_pedido ASC
        `,
        params
      );

      const grouped = new Map();

      for (const row of result.rows) {
        if (!grouped.has(row.id_pedido)) {
          const estadoCode = resolveEstadoCode(row.estado_descripcion);
          grouped.set(row.id_pedido, {
            id_pedido: Number(row.id_pedido),
            numero_ticket: buildTicketNumber(row.id_pedido),
            id_sucursal: Number(row.id_sucursal ?? 0) || null,
            nombre_sucursal: row.nombre_sucursal || 'Sucursal no definida',
            id_estado_pedido: Number(row.id_estado_pedido ?? 0) || null,
            estado_codigo: estadoCode,
            columna_kds: COLUMN_BY_CODE[estadoCode] || 'PENDIENTES',
            cliente_nombre: row.cliente_nombre || 'Consumidor final',
            tipo_servicio: inferTipoServicio(row.descripcion_envio),
            descripcion_pedido: row.descripcion_pedido || null,
            descripcion_envio: row.descripcion_envio || null,
            fecha_hora_pedido: row.fecha_hora_pedido,
            fecha_hora_facturacion: row.fecha_hora_facturacion || row.fecha_hora_pedido,
            total: roundMoney(row.total),
            total_items: 0,
            items: []
          });
        }

        const pedido = grouped.get(row.id_pedido);

        if (row.id_detalle_pedido) {
          const cantidad = inferKitchenItemQuantity(row.sub_total_item, row.precio_unitario);
          pedido.items.push({
            id_detalle: Number(row.id_detalle_pedido),
            tipo_item:
              row.id_producto !== null
                ? 'PRODUCTO'
                : row.id_combo !== null
                  ? 'COMBO'
                  : row.id_receta !== null
                    ? 'RECETA'
                    : 'ITEM',
            id_producto: Number(row.id_producto ?? 0) || null,
            id_combo: Number(row.id_combo ?? 0) || null,
            id_receta: Number(row.id_receta ?? 0) || null,
            nombre_item: row.nombre_item || 'Item de cocina',
            cantidad,
            modificaciones: []
          });
          pedido.total_items += cantidad;
        }
      }

      const data = Array.from(grouped.values()).map((pedido) => {
        const pedidoNotes = extractPedidoNotes(pedido.descripcion_pedido);
        const totalItems = pedido.items.length;
        return {
          ...pedido,
          items: pedido.items.map((item) => ({
            ...item,
            modificaciones: resolveItemModifications({
              pedidoNotes,
              itemName: item.nombre_item,
              totalItems
            })
          }))
        };
      });

      res.status(200).json(data);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Error al listar pedidos de cocina:', err.message);
    res.status(500).json({ error: true, message: err.message });
  }
});

router.put('/cocina/pedidos/:id/estado', async (req, res) => {
  const client = await pool.connect();

  try {
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
    }

    const estadoDestino = String(req.body?.estado_destino || '').trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, 'EN_COCINA')) {
      return res.status(500).json({ error: true, message: 'Configuracion de transiciones invalida.' });
    }

    if (!['EN_PREPARACION', 'LISTO_PARA_ENTREGA', 'COMPLETADO'].includes(estadoDestino)) {
      return res.status(400).json({ error: true, message: 'estado_destino invalido.' });
    }

    await client.query('BEGIN');

    const estadoRows = await fetchEstadoCatalog(client);
    const estadoIdMap = buildEstadoIdMap(estadoRows);
    const pedidoResult = await client.query(
      `
        SELECT p.id_pedido, p.id_estado_pedido, ep.descripcion AS estado_descripcion
        FROM pedidos p
        LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
        WHERE p.id_pedido = $1
        FOR UPDATE
      `,
      [idPedido]
    );

    if (pedidoResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
    }

    const pedido = pedidoResult.rows[0];
    const estadoActual = resolveEstadoCode(pedido.estado_descripcion);

    if (!estadoActual || !TRANSITIONS[estadoActual]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'El pedido no esta en un estado valido para operar desde cocina.'
      });
    }

    if (TRANSITIONS[estadoActual] !== estadoDestino) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: `No se permite la transicion ${estadoActual} -> ${estadoDestino}.`
      });
    }

    const idEstadoDestino = estadoIdMap.get(estadoDestino);
    if (!idEstadoDestino) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: `No existe el estado ${estadoDestino} en estados_pedido.`
      });
    }

    await client.query(
      'UPDATE pedidos SET id_estado_pedido = $1 WHERE id_pedido = $2',
      [idEstadoDestino, idPedido]
    );

    const notificacionGenerada =
      estadoDestino === 'LISTO_PARA_ENTREGA'
        ? await tryCreateReadyNotification(client, idPedido)
        : false;

    await client.query('COMMIT');

    res.status(200).json({
      message: 'Estado de pedido actualizado correctamente.',
      id_pedido: idPedido,
      estado_anterior: estadoActual,
      estado_actual: estadoDestino,
      notificacion_generada: Boolean(notificacionGenerada)
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error al actualizar estado de cocina:', err.message);
    res.status(500).json({ error: true, message: err.message });
  } finally {
    client.release();
  }
});

export default router;
