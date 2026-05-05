import crypto from 'crypto';
import express from 'express';
import pool from '../config/db-connection.js';
import {
  checkPermission,
  requestHasAnyPermission
} from '../middleware/checkPermission.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';
import { enviarCorreo } from '../utils/emailService.js';
import { validarYDescontarPedido } from '../services/inventarioPedidoService.js';

const router = express.Router();

// ══════════════════════════════════════════════════════════════════════
// Constantes del módulo
// ══════════════════════════════════════════════════════════════════════

const ESTADO_PEDIDO_CODES = {
  EN_COCINA: new Set(['en_cocina', 'en_cocina_pendiente']),
  EN_PREPARACION: new Set(['en_preparacion']),
  LISTO_PARA_ENTREGA: new Set(['listo_para_entrega']),
  NO_ENTREGADO: new Set(['no_entregado']),
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

// Transiciones normales del flujo de cocina
const TRANSITIONS = {
  EN_COCINA: 'EN_PREPARACION',
  EN_PREPARACION: 'LISTO_PARA_ENTREGA',
  LISTO_PARA_ENTREGA: 'COMPLETADO'
};

// Desde LISTO_PARA_ENTREGA también se puede marcar como NO_ENTREGADO
const EXTRA_TRANSITIONS = {
  EN_COCINA: ['LISTO_PARA_ENTREGA'],
  LISTO_PARA_ENTREGA: ['COMPLETADO', 'NO_ENTREGADO']
};

const COCINA_VIEW_PERMISSIONS = ['COCINA_VER'];
const COCINA_TRANSITION_PERMISSION_BY_STATE = Object.freeze({
  EN_COCINA: 'COCINA_PEDIDO_INICIAR',
  EN_PREPARACION: 'COCINA_PEDIDO_MARCAR_LISTO',
  LISTO_PARA_ENTREGA: 'COCINA_PEDIDO_ENTREGAR'
});

// Tiempo máximo en minutos antes de considerar un pedido como "próximo a expirar"
const EXPIRY_WARN_MINUTES = parseInt(process.env.COCINA_EXPIRY_WARN_MINUTES || '45', 10);
const INVENTARIO_CONFIG_WARNING_CODE = 'CONFIGURACION_INVENTARIO_INCOMPLETA';
const INVENTARIO_CONFIG_WARNING_MESSAGE = 'Pedido marcado como listo. Se notifico a administracion por configuracion incompleta de inventario.';
const schemaColumnCache = new Map();

// ══════════════════════════════════════════════════════════════════════
// Helpers internos
// ══════════════════════════════════════════════════════════════════════

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

const hasColumn = async (client, tableName, columnName) => {
  const key = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  const exists = result.rowCount > 0;
  schemaColumnCache.set(key, exists);
  return exists;
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

const buildPedidoConsumoPayload = async (client, idPedido, idSucursal) => {
  const detailsResult = await client.query(
    `
      SELECT
        dp.id_producto,
        dp.id_combo,
        dp.id_receta,
        COALESCE(dp.sub_total_pedido, 0) AS sub_total_item,
        COALESCE(
          CASE
            WHEN dp.id_producto IS NOT NULL THEN prod.precio
            WHEN dp.id_combo IS NOT NULL THEN combo.precio
            WHEN dp.id_receta IS NOT NULL THEN rec.precio
            ELSE NULL
          END,
          NULLIF(COALESCE(dp.sub_total_pedido, 0), 0),
          NULLIF(COALESCE(dp.total_pedido, 0), 0),
          0
        ) AS precio_unitario
      FROM public.detalle_pedido dp
      LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
      LEFT JOIN public.combos combo ON combo.id_combo = dp.id_combo
      LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
      WHERE dp.id_pedido = $1
        AND COALESCE(dp.estado, true) = true
      ORDER BY dp.id_detalle_pedido
    `,
    [idPedido]
  );

  if (detailsResult.rowCount === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_SIN_DETALLE',
        message: 'No se pudo descontar inventario porque el pedido no tiene detalle valido.'
      }
    };
  }

  const items = detailsResult.rows
    .map((row) => {
      const idProducto = parsePositiveInt(row.id_producto);
      const idCombo = parsePositiveInt(row.id_combo);
      const idReceta = parsePositiveInt(row.id_receta);
      const quantity = inferKitchenItemQuantity(row.sub_total_item, row.precio_unitario);

      if (idProducto) return { tipo_item: 'PRODUCTO', id_item: idProducto, cantidad: quantity };
      if (idCombo) return { tipo_item: 'COMBO', id_item: idCombo, cantidad: quantity };
      if (idReceta) return { tipo_item: 'RECETA', id_item: idReceta, cantidad: quantity };
      return null;
    })
    .filter(Boolean);

  if (!items.length) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_SIN_ITEMS_VALIDOS',
        message: 'No se pudo descontar inventario porque el pedido no tiene items validos para consumo.'
      }
    };
  }

  return {
    ok: true,
    payload: {
      id_sucursal: idSucursal,
      id_pedido: idPedido,
      items
    }
  };
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

const splitObservationSegments = (value) => {
  const source = String(value || '').trim();
  if (!source) return [];
  const separator = source.includes('|') ? '|' : ',';
  return source
    .split(separator)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const extractConfigMenuModifications = (configuracionMenu, itemTipo) => {
  const source = configuracionMenu && typeof configuracionMenu === 'object'
    ? configuracionMenu
    : null;
  const complementos = Array.isArray(source?.complementos) ? source.complementos : [];
  if (!complementos.length) return [];

  return complementos
    .map((entry) => String(entry?.nombre || '').trim())
    .filter(Boolean)
    .map((nombre) => {
      if (String(itemTipo || '').toUpperCase() === 'COMBO') return `Salsa alitas: ${nombre}`;
      return `Salsa: ${nombre}`;
    });
};

const stripItemPrefix = (note, itemName) => {
  const source = String(note || '').trim();
  if (!source) return '';
  const colonIndex = source.indexOf(':');
  if (colonIndex === -1) return source;
  const prefix = source.slice(0, colonIndex).trim();
  const itemKey = normalizeTextKey(itemName).replace(/_/g, ' ');
  const prefixKey = normalizeTextKey(prefix).replace(/_/g, ' ');
  if (itemKey && prefixKey && (prefixKey.includes(itemKey) || itemKey.includes(prefixKey))) {
    return source.slice(colonIndex + 1).trim();
  }
  return source;
};

const resolveItemModifications = ({ pedidoNotes, itemName, totalItems }) => {
  if (!pedidoNotes.length) return [];
  if (totalItems <= 1) {
    return pedidoNotes.flatMap((note) => splitObservationSegments(stripItemPrefix(note, itemName)));
  }
  const itemKey = normalizeTextKey(itemName).replace(/_/g, ' ');
  const itemTokens = itemKey.split(' ').filter((token) => token.length >= 4);
  return pedidoNotes
    .filter((note) => {
      const noteKey = normalizeTextKey(note).replace(/_/g, ' ');
      if (itemKey && noteKey.includes(itemKey)) return true;
      return itemTokens.some((token) => noteKey.includes(token));
    })
    .flatMap((note) => splitObservationSegments(stripItemPrefix(note, itemName)));
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

const buildEstadoCodeByIdMap = (rows) => {
  const map = new Map();
  rows.forEach((row) => {
    const id = Number(row.id_estado_pedido ?? 0);
    if (id > 0 && row.code && !map.has(id)) {
      map.set(id, row.code);
    }
  });
  return map;
};

const normalizeWarningFault = (fault) => ({
  tipo_recurso: String(fault?.tipo_recurso || '').trim().toLowerCase() || 'desconocido',
  id_recurso: Number(fault?.id_recurso ?? 0) || null,
  nombre: String(fault?.nombre || '').trim() || null,
  motivo: String(fault?.motivo || '').trim().toUpperCase() || 'CONFIGURACION_DESCONOCIDA'
});

const buildInventoryIncidentPayload = ({
  idPedido,
  idSucursal,
  idUsuarioCocina,
  numeroTicket,
  faltantes
}) => {
  const normalizedFaults = (Array.isArray(faltantes) ? faltantes : []).map(normalizeWarningFault);
  return {
    idPedido,
    codigoVenta: numeroTicket || buildTicketNumber(idPedido),
    idSucursal: Number(idSucursal ?? 0) || null,
    idUsuarioCocina: Number(idUsuarioCocina ?? 0) || null,
    tipoIncidencia: INVENTARIO_CONFIG_WARNING_CODE,
    mensaje: 'Configuración incompleta detectada al marcar pedido como listo en cocina.',
    detalle: {
      warning_code: INVENTARIO_CONFIG_WARNING_CODE,
      total_faltantes: normalizedFaults.length,
      faltantes: normalizedFaults
    }
  };
};

const insertCocinaIncident = async (client, payload) => {
  await client.query(
    `
      INSERT INTO public.incidencias_cocina (
        id_pedido,
        codigo_venta,
        id_sucursal,
        id_usuario_cocina,
        tipo_incidencia,
        severidad,
        origen,
        detalle,
        mensaje,
        estado
      )
      VALUES ($1, $2, $3, $4, $5, 'ADVERTENCIA', 'COCINA', $6::jsonb, $7, 'PENDIENTE')
    `,
    [
      payload.idPedido,
      payload.codigoVenta,
      payload.idSucursal,
      payload.idUsuarioCocina,
      payload.tipoIncidencia,
      JSON.stringify(payload.detalle || {}),
      payload.mensaje
    ]
  );
};

/**
 * Envía correo de alerta cuando un pedido lleva demasiado tiempo sin ser atendido.
 * No lanza error — falla silenciosamente para no interrumpir el flujo de cocina.
 */
const tryEnviarAlertaExpiracion = async (idPedido, numeroTicket, sucursalNombre, minutosEspera) => {
  try {
    const destinatario = process.env.SMTP_FROM_PEDIDOS || process.env.SMTP_FROM_ADMON;
    if (!destinatario) return false;

    const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0e0704;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:40px auto;background:#1a1108;border-radius:16px;border:1px solid rgba(212,165,116,0.2);">
    <tr>
      <td style="padding:40px 36px;text-align:center;">
        <h1 style="color:#d4a574;font-size:26px;margin:0 0 6px;">JONNY'S</h1>
        <p style="color:rgba(255,255,255,0.4);font-size:11px;letter-spacing:3px;margin:0 0 32px;">SMARTORDER · COCINA</p>
        <div style="background:rgba(219,65,65,0.15);border:1px solid rgba(219,65,65,0.3);border-radius:12px;padding:20px;margin-bottom:24px;">
          <h2 style="color:#f87171;font-size:18px;margin:0 0 8px;">⚠️ Pedido con tiempo de espera excesivo</h2>
          <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:0;">
            El pedido <strong style="color:#fbbf24;">${numeroTicket}</strong> en <strong style="color:#fbbf24;">${sucursalNombre}</strong>
            lleva <strong style="color:#f87171;">${minutosEspera} minutos</strong> sin ser atendido.
          </p>
        </div>
        <p style="color:rgba(255,255,255,0.5);font-size:13px;line-height:1.6;margin:0;">
          Por favor revisa el estado del pedido en el sistema.<br/>
          Si el pedido no se atiende pronto, será marcado automáticamente como <strong style="color:#fbbf24;">NO ENTREGADO</strong>.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 36px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
        <p style="color:rgba(255,255,255,0.2);font-size:11px;margin:0;">
          © ${new Date().getFullYear()} Jonny's Restaurant · Honduras — Alerta automática del KDS
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await enviarCorreo(
      destinatario,
      `⚠️ Pedido ${numeroTicket} lleva ${minutosEspera} min en espera — ${sucursalNombre}`,
      html,
      { tipo_correo: 'alerta_cocina', fromKey: 'PEDIDOS' }
    );
    return true;
  } catch {
    return false;
  }
};

// ══════════════════════════════════════════════════════════════════════
// GET /cocina/pedidos
// Retorna los pedidos activos del tablero KDS.
// Para usuarios no-super_admin fuerza la sucursal del empleado.
// ══════════════════════════════════════════════════════════════════════
router.get('/cocina/pedidos', checkPermission(COCINA_VIEW_PERMISSIONS), async (req, res) => {
  const correlationId = crypto.randomUUID().slice(0, 8);
  try {
    const client = await pool.connect();

    try {
      const estadoRows = await fetchEstadoCatalog(client);
      const estadoIdMap = buildEstadoIdMap(estadoRows);
      const availableBoardCodes = BOARD_CODES.filter((code) => estadoIdMap.has(code));

      if (availableBoardCodes.length === 0) {
        return res.status(200).json([]);
      }

      let requestedSucursalId =
        req.query.id_sucursal === undefined || req.query.id_sucursal === ''
          ? null
          : parsePositiveInt(req.query.id_sucursal);
      if (req.query.id_sucursal !== undefined && req.query.id_sucursal !== '' && !requestedSucursalId) {
        return res.status(400).json({ error: true, message: 'id_sucursal invalido.' });
      }

      const scope = await resolveRequestUserSucursalScope(req, client);
      const isSuperAdmin = Boolean(scope.isSuperAdmin);
      const userSucursalId = parsePositiveInt(scope.userSucursalId);

      if (!isSuperAdmin) {
        if (!userSucursalId) {
          return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
        }
        // Siempre forzamos la sucursal del empleado — nunca permite ver otras
        requestedSucursalId = userSucursalId;
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
            OR COALESCE(dp.observacion, p.descripcion_pedido, '') ILIKE ${qParam}
          )
        `);
      }

      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');

      const result = await client.query(
        `
          SELECT
            p.id_pedido,
            p.id_estado_pedido,
            ep.descripcion AS estado_descripcion,
            p.descripcion_pedido,
            p.descripcion_envio,
            p.fecha_hora_pedido,
            p.visible_en_cocina_at,
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
            dp.observacion,
            ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu,' : 'NULL::jsonb AS configuracion_menu,'}
            COALESCE(prod.nombre_producto, combo.descripcion, rec.nombre_receta, 'Item de cocina') AS nombre_item,
            COALESCE(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN prod.precio
                WHEN dp.id_combo IS NOT NULL THEN combo.precio
                WHEN dp.id_receta IS NOT NULL THEN rec.precio
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
          ${whereClause}
          ORDER BY p.fecha_hora_pedido ASC, dp.id_detalle_pedido ASC
        `,
        params
      );

      const grouped = new Map();
      const now = Date.now();

      for (const row of result.rows) {
        if (!grouped.has(row.id_pedido)) {
          const estadoCode = resolveEstadoCode(row.estado_descripcion);
          const fechaRef = row.visible_en_cocina_at || row.fecha_hora_facturacion || row.fecha_hora_pedido;
          const fechaMs = fechaRef ? new Date(fechaRef).getTime() : null;
          const minutosEnEspera = fechaMs ? Math.floor((now - fechaMs) / 60000) : null;
          const estaProximoAExpirar =
            minutosEnEspera !== null && minutosEnEspera >= EXPIRY_WARN_MINUTES;

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
            visible_en_cocina_at: row.visible_en_cocina_at || row.fecha_hora_facturacion || row.fecha_hora_pedido,
            fecha_hora_facturacion: row.fecha_hora_facturacion || row.fecha_hora_pedido,
            minutos_en_espera: minutosEnEspera,
            esta_proximo_a_expirar: estaProximoAExpirar,
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
            observacion: row.observacion || null,
            configuracion_menu: row.configuracion_menu || null,
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
          items: pedido.items.map((item) => {
            const modificaciones = item.observacion
              ? splitObservationSegments(item.observacion)
              : resolveItemModifications({
                  pedidoNotes,
                  itemName: item.nombre_item,
                  totalItems
                });
            const modificacionesConfiguracion = extractConfigMenuModifications(
              item.configuracion_menu,
              item.tipo_item
            );
            const modificacionesFinales = [...modificacionesConfiguracion, ...modificaciones];
            const modificacionesUnicas = [...new Set(modificacionesFinales)];

            return {
              ...item,
              observacion: item.observacion,
              modificaciones: modificacionesUnicas
            };
          })
        };
      });

      res.status(200).json(data);
    } finally {
      client.release();
    }
  } catch (err) {
    // Log completo solo en servidor — nunca al cliente
    console.error(`[ERROR ${correlationId}] GET /cocina/pedidos:`, err);
    res.status(500).json({
      error: true,
      message: 'Error interno del servidor',
      referencia: correlationId
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// PUT /cocina/pedidos/:id/estado
// Avanza o marca como No Entregado un pedido del KDS.
// Valida permisos por estado Y por sucursal del empleado.
// ══════════════════════════════════════════════════════════════════════
router.put('/cocina/pedidos/:id/estado', checkPermission(COCINA_VIEW_PERMISSIONS), async (req, res) => {
  const correlationId = crypto.randomUUID().slice(0, 8);

  try {
    // ── 1. Validar inputs ──────────────────────────────────────────────
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
    }

    const estadoDestino = String(req.body?.estado_destino || '').trim().toUpperCase();
    const estadosValidos = ['EN_PREPARACION', 'LISTO_PARA_ENTREGA', 'COMPLETADO', 'NO_ENTREGADO'];
    if (!estadosValidos.includes(estadoDestino)) {
      return res.status(400).json({ error: true, message: 'estado_destino invalido.' });
    }

    // ── 2. Resolver scope ANTES de abrir transacción ───────────────────
    // resolveRequestUserSucursalScope y requestHasAnyPermission usan pool
    // internamente. Llamarlos DENTRO de un BEGIN con el mismo client puede
    // contaminar la conexión si cualquier consulta auxiliar falla.
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const userSucursalId = parsePositiveInt(scope.userSucursalId);

    if (!isSuperAdmin && !userSucursalId) {
      return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
    }

    // ── 3. Abrir transacción solo para las operaciones de DB ───────────
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const estadoRows = await fetchEstadoCatalog(client);
      const estadoIdMap = buildEstadoIdMap(estadoRows);
      const estadoCodeByIdMap = buildEstadoCodeByIdMap(estadoRows);

      // ── 4. Leer pedido con bloqueo ─────────────────────────────────
      const pedidoResult = await client.query(
        `SELECT p.id_pedido, p.id_estado_pedido, p.id_sucursal,
                p.fecha_hora_pedido, s.nombre_sucursal
         FROM pedidos p
         LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
         WHERE p.id_pedido = $1
         FOR UPDATE OF p`,
        [idPedido]
      );

      if (pedidoResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
      }

      const pedido = pedidoResult.rows[0];
      const pedidoSucursalId = parsePositiveInt(pedido.id_sucursal);

      // ── 5. Verificar scope de sucursal ─────────────────────────────
      if (!isSuperAdmin && pedidoSucursalId !== userSucursalId) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: true,
          message: 'No tienes permiso para operar pedidos de otra sucursal.'
        });
      }

      // ── 6. Verificar estado actual y transición válida ─────────────
      const estadoActual = estadoCodeByIdMap.get(Number(pedido.id_estado_pedido ?? 0)) || null;

      if (!estadoActual || !TRANSITIONS[estadoActual]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'El pedido no esta en un estado valido para operar desde cocina.'
        });
      }

      const transicionNormal = TRANSITIONS[estadoActual] === estadoDestino;
      const transicionExtra = EXTRA_TRANSITIONS[estadoActual]?.includes(estadoDestino) ?? false;

      if (!transicionNormal && !transicionExtra) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'No se permite esa transicion de estado en el flujo de cocina.'
        });
      }

      // ── 7. Verificar permiso específico (usa pool interno, no client) ─
      const transitionPermission = COCINA_TRANSITION_PERMISSION_BY_STATE[estadoActual];
      const canChangeTransition = await requestHasAnyPermission(req, transitionPermission);
      if (!canChangeTransition) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes para cambiar estado en cocina.'
        });
      }

      // ── 8. Obtener ID del estado destino ───────────────────────────
      const idEstadoDestino = estadoIdMap.get(estadoDestino);
      if (!idEstadoDestino) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'El estado de destino no esta configurado en el sistema.'
        });
      }

      let inventoryResult = null;
      let inventoryConfigWarning = null;
      const shouldDiscountInventory = estadoDestino === 'LISTO_PARA_ENTREGA';
      if (shouldDiscountInventory) {
        const consumoPayloadResult = await buildPedidoConsumoPayload(client, idPedido, pedidoSucursalId);
        if (!consumoPayloadResult.ok) {
          await client.query('ROLLBACK');
          return res.status(consumoPayloadResult.status).json(consumoPayloadResult.body);
        }

        inventoryResult = await validarYDescontarPedido(consumoPayloadResult.payload, {
          id_usuario: req?.user?.id_usuario,
          allowNegativeStock: true,
          shortageMode: 'FALTANTE_COCINA',
          dbClient: client
        });

        if (!inventoryResult?.ok) {
          const isConfigError = String(inventoryResult.code || '').toUpperCase() === 'CONFIGURACION_INVENTARIO_INVALIDA';
          if (!isConfigError) {
            await client.query('ROLLBACK');
            return res.status(409).json({
              error: true,
              code: inventoryResult.code || 'INVENTARIO_ERROR',
              message: inventoryResult.message || 'No se pudo descontar inventario para el pedido.',
              faltantes: Array.isArray(inventoryResult.faltantes) ? inventoryResult.faltantes : []
            });
          }

          inventoryConfigWarning = buildInventoryIncidentPayload({
            idPedido,
            idSucursal: pedidoSucursalId,
            idUsuarioCocina: req?.user?.id_usuario,
            numeroTicket: buildTicketNumber(idPedido),
            faltantes: inventoryResult.faltantes
          });
        }
      }

      // ── 9. Actualizar estado ───────────────────────────────────────
      await client.query(
        `
          UPDATE pedidos
          SET id_estado_pedido = $1,
              visible_en_cocina_at = COALESCE(visible_en_cocina_at, fecha_hora_pedido, NOW())
          WHERE id_pedido = $2
        `,
        [idEstadoDestino, idPedido]
      );

      if (inventoryConfigWarning) {
        await insertCocinaIncident(client, inventoryConfigWarning);
      }

      await client.query('COMMIT');

      // ── 10. Alerta de expiración (fire-and-forget, fuera de la tx) ─
      if (estadoDestino === 'NO_ENTREGADO' || estadoDestino === 'COMPLETADO') {
        const fechaRef = pedido.fecha_hora_pedido;
        const minutosEnEspera = fechaRef
          ? Math.floor((Date.now() - new Date(fechaRef).getTime()) / 60000)
          : null;

        if (minutosEnEspera !== null && minutosEnEspera >= EXPIRY_WARN_MINUTES) {
          tryEnviarAlertaExpiracion(
            idPedido,
            buildTicketNumber(idPedido),
            pedido.nombre_sucursal || 'Sucursal no definida',
            minutosEnEspera
          ).catch(() => {});
        }
      }

      return res.status(200).json({
        ok: true,
        message: inventoryConfigWarning ? INVENTARIO_CONFIG_WARNING_MESSAGE : 'Estado de pedido actualizado correctamente.',
        id_pedido: idPedido,
        estado_anterior: estadoActual,
        estado_actual: estadoDestino,
        warning: inventoryConfigWarning ? true : Boolean(inventoryResult?.warning),
        warning_code: inventoryConfigWarning ? INVENTARIO_CONFIG_WARNING_CODE : null,
        warning_detail: inventoryResult?.warning || null
      });
    } catch (dbErr) {
      try { await client.query('ROLLBACK'); } catch { /* ignorar */ }
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[ERROR ${correlationId}] PUT /cocina/pedidos/:id/estado:`, err.message);
    res.status(500).json({
      error: true,
      message: 'Error interno del servidor',
      referencia: correlationId
    });
  }
});

export default router;
