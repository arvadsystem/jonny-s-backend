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
import { registrarAlertasInventarioPedido } from '../services/inventarioAlertasService.js';
import {
  buildSalsaConsumptionItemsFromPedidoDetails,
  loadLegacySalsaConsumptionByStockKey
} from '../services/salsasPedidoSnapshotService.js';
import { readPedidoOperationalRouting } from './ventas/services/pedidoOperationalRoutingService.js';

const router = express.Router();

// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
// Constantes del módulo
// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�

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
const KDS_VISIBLE_CODES = ['EN_COCINA', 'EN_PREPARACION'];
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

const buildValidStandaloneExtraPredicate = (detailAlias) => `(
  SELECT COUNT(*) = 1
     AND COUNT(*) FILTER (
       WHERE dpe_route.id_extra IS NOT NULL
         AND NULLIF(TRIM(dpe_route.nombre_extra_snapshot), '') IS NOT NULL
         AND COALESCE(dpe_route.cantidad, 0) > 0
     ) = 1
  FROM public.detalle_pedido_extras dpe_route
  WHERE dpe_route.id_detalle_pedido = ${detailAlias}.id_detalle_pedido
    AND COALESCE(dpe_route.estado, true) = true
)`;

const buildPreparedLinePredicate = (detailAlias) => `(
  (${detailAlias}.id_producto IS NULL AND ${detailAlias}.id_receta IS NOT NULL)
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND ${buildValidStandaloneExtraPredicate(detailAlias)}
  )
)`;

const buildInvalidOperationalLinePredicate = (detailAlias) => `(
  (${detailAlias}.id_producto IS NOT NULL AND ${detailAlias}.id_receta IS NOT NULL)
  OR (
    ${detailAlias}.id_producto IS NULL
    AND ${detailAlias}.id_receta IS NULL
    AND NOT ${buildValidStandaloneExtraPredicate(detailAlias)}
  )
)`;
const COCINA_TRANSITION_PERMISSION_BY_STATE = Object.freeze({
  EN_COCINA: 'COCINA_PEDIDO_INICIAR',
  EN_PREPARACION: 'COCINA_PEDIDO_MARCAR_LISTO',
  LISTO_PARA_ENTREGA: 'COCINA_PEDIDO_ENTREGAR'
});

// Tiempo máximo en minutos antes de considerar un pedido como "próximo a expirar"
const EXPIRY_WARN_MINUTES = parseInt(process.env.COCINA_EXPIRY_WARN_MINUTES || '45', 10);
const schemaColumnCache = new Map();
const NO_SUCURSAL_ASSIGNMENT_MESSAGE =
  'No tienes una sucursal asignada para visualizar Cocina. Contacta al administrador.';
const KDS_EXPECTED_RULES = Object.freeze([
  { code: 'RANGO_0_9', min: 0, max: 9, minutes: 25 },
  { code: 'RANGO_10_15', min: 10, max: 15, minutes: 30 },
  { code: 'RANGO_16_25', min: 16, max: 25, minutes: 45 },
  { code: 'RANGO_26_PLUS', min: 26, max: Number.POSITIVE_INFINITY, minutes: 50 }
]);

// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
// Helpers internos
// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');

const parsePositiveInt = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  const normalized = String(value ?? '').trim();
  if (!/^0*[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const resolveKdsRuleByActiveCount = (activeCount) => {
  const safeCount = Math.max(0, Number(activeCount) || 0);
  return (
    KDS_EXPECTED_RULES.find((rule) => safeCount >= rule.min && safeCount <= rule.max) ||
    KDS_EXPECTED_RULES[KDS_EXPECTED_RULES.length - 1]
  );
};

const resolveOperationalDateValue = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const tegucigalpaDate = new Date(
    date.toLocaleString('en-US', { timeZone: 'America/Tegucigalpa' })
  );
  return tegucigalpaDate.toISOString().slice(0, 10);
};

export const assignPersistedKdsTiming = async ({
  client,
  pedidoId,
  idSucursal,
  activeEstadoIds,
  operationalDate
}) => {
  const safePedidoId = parsePositiveInt(pedidoId);
  const safeSucursalId = parsePositiveInt(idSucursal);
  if (!safePedidoId || !safeSucursalId) return null;
  if (!Array.isArray(activeEstadoIds) || activeEstadoIds.length === 0) return null;

  const existingResult = await client.query(
    `
      SELECT
        kds_started_at,
        kds_expected_minutes,
        kds_expected_rule,
        visible_en_cocina_at,
        fecha_hora_pedido
      FROM public.pedidos
      WHERE id_pedido = $1
      LIMIT 1
    `,
    [safePedidoId]
  );
  if (existingResult.rowCount === 0) return null;

  const existing = existingResult.rows[0];
  const hasPersistedTiming =
    existing.kds_started_at && parsePositiveInt(existing.kds_expected_minutes) && existing.kds_expected_rule;
  if (hasPersistedTiming) {
    return {
      kds_started_at: existing.kds_started_at,
      kds_expected_minutes: Number(existing.kds_expected_minutes),
      kds_expected_rule: existing.kds_expected_rule
    };
  }

  const operationalDateValue =
    resolveOperationalDateValue(operationalDate) ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Tegucigalpa' });

  // AM: Cuenta la carga visible del KDS aunque el pedido aun no tenga factura o codigo de venta.
  const activeCountResult = await client.query(
    `
      SELECT COUNT(DISTINCT p.id_pedido)::int AS total
      FROM public.pedidos p
      LEFT JOIN LATERAL (
        SELECT f.fecha_operacion
        FROM public.facturas f
        WHERE f.id_pedido = p.id_pedido
          AND f.id_sucursal = p.id_sucursal
        ORDER BY
          f.fecha_operacion DESC NULLS LAST,
          f.fecha_hora_facturacion DESC NULLS LAST,
          f.id_factura DESC
        LIMIT 1
      ) f ON TRUE
      WHERE p.id_sucursal = $1
        AND p.id_estado_pedido = ANY($2::int[])
        AND COALESCE(
          f.fecha_operacion::date,
          p.visible_en_cocina_at::date,
          p.fecha_hora_pedido::date
        ) = $3::date
    `,
    [safeSucursalId, activeEstadoIds, operationalDateValue]
  );
  const activeCount = Number(activeCountResult.rows?.[0]?.total ?? 0) || 0;
  const rule = resolveKdsRuleByActiveCount(activeCount);

  const updatedResult = await client.query(
    `
      UPDATE public.pedidos
      SET
        kds_started_at = COALESCE(
          kds_started_at,
          CASE
            WHEN visible_en_cocina_at IS NOT NULL
              THEN visible_en_cocina_at AT TIME ZONE 'America/Tegucigalpa'
            WHEN fecha_hora_pedido IS NOT NULL
              THEN fecha_hora_pedido AT TIME ZONE 'America/Tegucigalpa'
            ELSE NOW()
          END
        ),
        kds_expected_minutes = COALESCE(kds_expected_minutes, $2::int),
        kds_expected_rule = COALESCE(kds_expected_rule, $3)
      WHERE id_pedido = $1
      RETURNING kds_started_at, kds_expected_minutes, kds_expected_rule
    `,
    [safePedidoId, rule.minutes, rule.code]
  );

  if (updatedResult.rowCount === 0) return null;
  return {
    kds_started_at: updatedResult.rows[0].kds_started_at,
    kds_expected_minutes: Number(updatedResult.rows[0].kds_expected_minutes ?? 0) || null,
    kds_expected_rule: updatedResult.rows[0].kds_expected_rule || null
  };
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

const hasTable = async (client, tableName) => {
  const key = `table.${String(tableName || '').trim().toLowerCase()}`;
  if (schemaColumnCache.has(key)) return schemaColumnCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  schemaColumnCache.set(key, exists);
  return exists;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const buildTicketNumber = (idPedido, idFactura, codigoVenta) => {
  const codigo = String(codigoVenta || '').trim();
  if (codigo) return codigo;
  const baseId = parsePositiveInt(idFactura) || parsePositiveInt(idPedido);
  if (!baseId) return 'VTA-S/N';
  return `VTA-${String(baseId).padStart(5, '0')}`;
};

export const buildPedidoConsumoPayload = async (client, idPedido, idSucursal) => {
  const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
  const detailsResult = await client.query(
    `
      SELECT
        dp.id_detalle_pedido,
        dp.id_producto,
        dp.id_receta,
        dp.cantidad,
        ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu' : 'NULL::jsonb AS configuracion_menu'}
      FROM public.detalle_pedido dp
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
      const idReceta = parsePositiveInt(row.id_receta);
      const quantity = parsePositiveInt(row.cantidad);

      const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);
      if (idProducto) return { tipo_item: 'PRODUCTO', id_item: idProducto, id_producto: idProducto, id_detalle_pedido: idDetallePedido, cantidad: quantity };
      if (idReceta) return { tipo_item: 'RECETA', id_item: idReceta, id_receta: idReceta, id_detalle_pedido: idDetallePedido, cantidad: quantity };
      return null;
    })
    .filter(Boolean);

  const invalidQuantityRow = items.find((item) => !parsePositiveInt(item.cantidad));
  if (invalidQuantityRow) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: 'PEDIDO_CANTIDAD_INVALIDA',
        message: `La linea ${invalidQuantityRow.id_detalle_pedido || 'del pedido'} tiene cantidad invalida para descontar inventario.`
      }
    };
  }

  const extrasByDetalle = new Map();
  if (await hasTable(client, 'detalle_pedido_extras')) {
    const extraRowsResult = await client.query(
      `
        SELECT
          dpe.id_detalle_pedido,
          dpe.id_extra,
          dpe.codigo_extra_snapshot,
          dpe.nombre_extra_snapshot,
          COALESCE(dpe.cantidad, 0)::numeric AS cantidad,
          dpe.id_insumo,
          dpe.cant,
          dpe.id_unidad_medida,
          dpe.origen_snapshot
        FROM public.detalle_pedido_extras dpe
        INNER JOIN public.detalle_pedido dp
          ON dp.id_detalle_pedido = dpe.id_detalle_pedido
         AND dp.id_pedido = $1
         AND COALESCE(dp.estado, true) = true
        WHERE COALESCE(dpe.estado, true) = true
      `,
      [idPedido]
    );
    for (const row of extraRowsResult.rows) {
      const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);
      const idExtra = parsePositiveInt(row.id_extra);
      const cantidad = Number(row.cantidad || 0);
      if (!idDetallePedido || !idExtra || cantidad <= 0) continue;
      const key = `${idDetallePedido}:${idExtra}`;
      extrasByDetalle.set(key, {
        id_detalle_pedido: idDetallePedido,
        id_extra: idExtra,
        codigo: row.codigo_extra_snapshot || row.origen_snapshot?.codigo || null,
        nombre: row.nombre_extra_snapshot || row.origen_snapshot?.nombre || null,
        cantidad,
        id_insumo: parsePositiveInt(row.id_insumo),
        cant: Number(row.cant || 0) || null,
        id_unidad_medida: parsePositiveInt(row.id_unidad_medida)
      });
    }
  }

  for (const row of detailsResult.rows) {
    const idDetallePedido = parsePositiveInt(row.id_detalle_pedido);
    if (!idDetallePedido) continue;
    const config = row.configuracion_menu && typeof row.configuracion_menu === 'object'
      ? row.configuracion_menu
      : null;
    const extras = Array.isArray(config?.extras) ? config.extras : [];
    for (const extra of extras) {
      const idExtra = parsePositiveInt(extra?.id_extra);
      const cantidad = Number(extra?.cantidad || 0);
      if (!idExtra || cantidad <= 0) continue;
      const key = `${idDetallePedido}:${idExtra}`;
      if (extrasByDetalle.has(key)) continue;
      extrasByDetalle.set(key, {
        id_detalle_pedido: idDetallePedido,
        id_extra: idExtra,
        codigo: String(extra?.codigo || '').trim() || null,
        nombre: String(extra?.nombre || '').trim() || null,
        cantidad,
        id_insumo: parsePositiveInt(extra?.id_insumo),
        cant: Number(extra?.cant ?? extra?.cantidad_insumo ?? 0) || null,
        id_unidad_medida: parsePositiveInt(extra?.id_unidad_medida)
      });
    }
  }

  for (const extra of extrasByDetalle.values()) {
    items.push({
      tipo_item: 'EXTRA',
      id_item: extra.id_extra,
      id_extra: extra.id_extra,
      id_detalle_pedido: extra.id_detalle_pedido,
      codigo: extra.codigo,
      nombre: extra.nombre,
      id_insumo: extra.id_insumo,
      cant: extra.cant,
      id_unidad_medida: extra.id_unidad_medida,
      cantidad: extra.cantidad
    });
  }

  const legacySalsaConsumption = await loadLegacySalsaConsumptionByStockKey(client, idPedido);
  const salsaConsumption = buildSalsaConsumptionItemsFromPedidoDetails(detailsResult.rows, {
    legacyConsumedByStockKey: legacySalsaConsumption
  });
  if (salsaConsumption.errors.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: true,
        code: salsaConsumption.errors[0].code || 'SALSA_SNAPSHOT_INVALIDO',
        message: salsaConsumption.errors[0].message || 'No se pudo validar el snapshot de inventario de salsas.',
        details: salsaConsumption.errors
      }
    };
  }
  items.push(...salsaConsumption.items);

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
    .filter(Boolean)
    .filter((note) => !isTechnicalOrderNote(note));

const splitObservationSegments = (value) => {
  const source = String(value || '').trim();
  if (!source) return [];
  const separator = source.includes('|') ? '|' : ',';
  return source
    .split(separator)
    .map((segment) => segment.trim())
    .filter(Boolean);
};

const isTechnicalKitchenObservation = (value) => {
  const source = String(value || '').trim();
  if (!source) return false;
  return (
    source.includes('PUBCFG:v1') ||
    /^(extras|salsas|complementos|config|cfg)=/i.test(source) ||
    /(?:^|[|,\s])(extras|salsas|complementos)=\d+(?:\*\d+)?(?:[;,|]\d+(?:\*\d+)?)*($|[|,\s])/i.test(source)
  );
};

const isTechnicalOrderNote = (note) => {
  const source = String(note || '').trim().toLowerCase();
  if (!source) return false;

  return (
    source.includes('[public-menu]') ||
    source.includes('[menu-publico]') ||
    source.startsWith('idem:') ||
    source.startsWith('idempotency:') ||
    source.startsWith('idempotencia:') ||
    source.startsWith('tel:') ||
    source.startsWith('telefono:') ||
    source.includes('schema_version') ||
    source.includes('menu_publico_linea_v1') ||
    source.includes('pubcfg:v1') ||
    /(?:^|[\s|,;])salsas=/.test(source) ||
    /(?:^|[\s|,;])extras=/.test(source)
  );
};

const extractConfigMenuModifications = (configuracionMenu, itemTipo, salsaNameMap = new Map()) => {
  const source = configuracionMenu && typeof configuracionMenu === 'object'
    ? configuracionMenu
    : null;
  const complementos = Array.isArray(source?.complementos) ? source.complementos : [];
  const extras = Array.isArray(source?.extras) ? source.extras : [];
  const salsasPorUnidad = Array.isArray(source?.salsas_por_unidad) ? source.salsas_por_unidad : [];
  const notaCliente = String(source?.nota_cliente || '').trim();
  if (!complementos.length && !extras.length && !salsasPorUnidad.length && !notaCliente) return [];

  const complementosText = complementos
    .map((entry) => {
      const nombre = String(entry?.nombre || '').trim();
      if (!nombre) return null;
      const porOrden = Number(entry?.porciones_por_orden || entry?.cantidad_por_orden || entry?.inventario?.porciones_por_orden || entry?.inventario?.porciones || 1);
      const total = Number(entry?.porciones_total || entry?.cantidad_total || entry?.inventario?.porciones_total || 0);
      if (total > 0 && total !== porOrden) {
        return `Salsa: ${nombre} x${porOrden} por orden, total ${total}`;
      }
      return porOrden > 1 ? `Salsa: ${nombre} x${porOrden} por orden` : `Salsa: ${nombre}`;
    });
  const extrasText = extras
    .map((entry) => {
      const nombre = String(entry?.nombre || entry?.nombre_extra || '').trim();
      const porOrden = Number(entry?.cantidad_por_orden || entry?.cantidad || 0);
      const total = Number(entry?.cantidad_total || entry?.cantidad || 0);
      if (!nombre || porOrden <= 0) return null;
      if (total > 0 && total !== porOrden) {
        return `Extra: ${nombre} x${porOrden} por orden, total ${total}`;
      }
      return `Extra: ${nombre} x${porOrden} por orden`;
    })
    .filter(Boolean);

  const publicMenuSalsasText = [];
  if (String(source?.schema_version || '') === 'menu_publico_linea_v1' && salsasPorUnidad.length) {
    const salsaCounts = new Map();
    for (const entry of salsasPorUnidad) {
      const idSalsa = parsePositiveInt(entry?.id_salsa);
      const cantidad = parsePositiveInt(entry?.cantidad) || 1;
      if (!idSalsa || cantidad <= 0) continue;
      const nombre = String(salsaNameMap.get(idSalsa) || `Salsa #${idSalsa}`).trim();
      if (!nombre) continue;
      salsaCounts.set(nombre, (salsaCounts.get(nombre) || 0) + cantidad);
    }
    const salsas = [...salsaCounts.entries()].map(([nombre, cantidad]) =>
      cantidad > 1 ? `${nombre} x${cantidad}` : nombre
    );
    if (salsas.length) {
      publicMenuSalsasText.push(`${salsas.length > 1 ? 'Salsas' : 'Salsa'}: ${salsas.join(', ')}`);
    }
  }

  const notaClienteText = notaCliente && !isTechnicalKitchenObservation(notaCliente)
    ? [`Notas: ${notaCliente}`]
    : [];

  return [...new Set([...extrasText, ...complementosText, ...publicMenuSalsasText, ...notaClienteText])];
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

/**
 * Envía correo de alerta cuando un pedido lleva demasiado tiempo sin ser atendido.
 * No lanza error � falla silenciosamente para no interrumpir el flujo de cocina.
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
          <h2 style="color:#f87171;font-size:18px;margin:0 0 8px;">�a�️ Pedido con tiempo de espera excesivo</h2>
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
          © ${new Date().getFullYear()} Jonny's Restaurant · Honduras � Alerta automática del KDS
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

    await enviarCorreo(
      destinatario,
      `�a�️ Pedido ${numeroTicket} lleva ${minutosEspera} min en espera � ${sucursalNombre}`,
      html,
      { tipo_correo: 'alerta_cocina', fromKey: 'PEDIDOS' }
    );
    return true;
  } catch {
    return false;
  }
};

// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
// GET /cocina/pedidos
// Retorna los pedidos activos del tablero KDS.
// Para usuarios no-super_admin fuerza la sucursal del empleado.
// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
router.get('/cocina/pedidos', checkPermission(COCINA_VIEW_PERMISSIONS), async (req, res) => {
  const correlationId = crypto.randomUUID().slice(0, 8);
  try {
    const client = await pool.connect();

    try {
      const estadoRows = await fetchEstadoCatalog(client);
      const estadoIdMap = buildEstadoIdMap(estadoRows);
      const availableBoardCodes = KDS_VISIBLE_CODES.filter((code) => estadoIdMap.has(code));

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
          return res.status(403).json({ error: true, message: NO_SUCURSAL_ASSIGNMENT_MESSAGE });
        }
        // Siempre forzamos la sucursal del empleado � nunca permite ver otras
        requestedSucursalId = userSucursalId;
      }

      const requestedEstado = req.query.estado
        ? String(req.query.estado).trim().toUpperCase()
        : null;
      if (requestedEstado && !KDS_VISIBLE_CODES.includes(requestedEstado)) {
        return res.status(400).json({ error: true, message: 'estado inválido para el tablero KDS.' });
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
      filters.push(`
        EXISTS (
          SELECT 1
          FROM public.detalle_pedido dp_route
          WHERE dp_route.id_pedido = p.id_pedido
            AND COALESCE(dp_route.estado, true) = true
            AND ${buildPreparedLinePredicate('dp_route')}
        )
      `);
      filters.push(`
        NOT EXISTS (
          SELECT 1
          FROM public.detalle_pedido dp_invalid
          WHERE dp_invalid.id_pedido = p.id_pedido
            AND COALESCE(dp_invalid.estado, true) = true
            AND ${buildInvalidOperationalLinePredicate('dp_invalid')}
        )
      `);

      if (requestedSucursalId) {
        filters.push(`p.id_sucursal = ${pushParam(requestedSucursalId)}`);
      }

      if (isSuperAdmin && !requestedSucursalId) {
        return res.status(400).json({
          error: true,
          message: 'Selecciona una sucursal para consultar el tablero de cocina.'
        });
      }

      // AM: Filtro operativo diario sin depender obligatoriamente de factura/codigo_venta.
      const operationalDateExpr = `(NOW() AT TIME ZONE 'America/Tegucigalpa')::date`;
      filters.push(`
        COALESCE(
          f.fecha_operacion::date,
          p.visible_en_cocina_at::date,
          p.fecha_hora_pedido::date
        ) = ${operationalDateExpr}
      `);

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      if (q) {
        const qLike = `%${q}%`;
        const qParam = pushParam(qLike);
        filters.push(`
          (
            p.id_pedido::text ILIKE ${qParam}
            OR COALESCE(s.nombre_sucursal, '') ILIKE ${qParam}
            OR COALESCE(NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''), emp.nombre_empresa, 'Consumidor final') ILIKE ${qParam}
            OR COALESCE(prod.nombre_producto, rec.nombre_receta, standalone_extra.nombre_extra_snapshot, '') ILIKE ${qParam}
            OR COALESCE(dp.observacion, p.descripcion_pedido, '') ILIKE ${qParam}
          )
        `);
      }

      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
      const hasKdsStartedAt = await hasColumn(client, 'pedidos', 'kds_started_at');
      const hasKdsExpectedMinutes = await hasColumn(client, 'pedidos', 'kds_expected_minutes');
      const hasKdsExpectedRule = await hasColumn(client, 'pedidos', 'kds_expected_rule');
      const hasEnPreparacionAt = await hasColumn(client, 'pedidos', 'en_preparacion_at');
      const hasKdsTimingColumns = hasKdsStartedAt && hasKdsExpectedMinutes && hasKdsExpectedRule;
      const hasPedidosInventarioAlertas = await hasTable(client, 'pedidos_inventario_alertas');
      const activeKdsEstadoIds = ['EN_COCINA', 'EN_PREPARACION']
        .map((code) => estadoIdMap.get(code))
        .filter((value) => Number.isInteger(value) && value > 0);

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
            ${hasEnPreparacionAt ? 'p.en_preparacion_at,' : 'NULL::timestamptz AS en_preparacion_at,'}
            ${hasKdsStartedAt ? 'p.kds_started_at,' : 'NULL::timestamptz AS kds_started_at,'}
            ${hasKdsExpectedMinutes ? 'p.kds_expected_minutes,' : 'NULL::int AS kds_expected_minutes,'}
            ${hasKdsExpectedRule ? 'p.kds_expected_rule,' : 'NULL::text AS kds_expected_rule,'}
            p.total,
            p.sub_total,
            p.isv,
            p.id_sucursal,
            s.nombre_sucursal,
            p.id_cliente,
            ${hasPedidosInventarioAlertas ? 'COALESCE(inv_alertas.total, 0)::int AS inventario_alertas_total,' : '0::int AS inventario_alertas_total,'}
            ${hasPedidosInventarioAlertas ? 'COALESCE(inv_alertas.pendientes, 0)::int AS inventario_alertas_pendientes,' : '0::int AS inventario_alertas_pendientes,'}
            COALESCE(
              NULLIF(trim(concat_ws(' ', per.nombre, per.apellido)), ''),
              emp.nombre_empresa,
              'Consumidor final'
            ) AS cliente_nombre,
            f.fecha_hora_facturacion,
            f.fecha_operacion,
            f.id_factura,
            f.codigo_venta,
            dp.id_detalle_pedido,
            dp.id_producto,
            dp.id_receta,
            standalone_extra.id_extra AS id_extra_independiente,
            CASE
              WHEN standalone_extra.id_extra IS NOT NULL THEN standalone_extra.cantidad
              ELSE dp.cantidad
            END AS cantidad,
            dp.observacion,
            ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu,' : 'NULL::jsonb AS configuracion_menu,'}
            COALESCE(prod.nombre_producto, rec.nombre_receta, standalone_extra.nombre_extra_snapshot, 'Item de cocina') AS nombre_item,
            COALESCE(dp.total_pedido, COALESCE(dp.sub_total_pedido, 0)) AS total_linea
          FROM pedidos p
          LEFT JOIN estados_pedido ep ON ep.id_estado_pedido = p.id_estado_pedido
          LEFT JOIN sucursales s ON s.id_sucursal = p.id_sucursal
          LEFT JOIN clientes c ON c.id_cliente = p.id_cliente
          LEFT JOIN personas per ON per.id_persona = c.id_persona
          LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
          -- AM: Usa LEFT JOIN LATERAL para tomar una sola factura por pedido y evitar duplicados por multiples facturas.
          LEFT JOIN LATERAL (
            SELECT f.*
            FROM facturas f
            WHERE f.id_pedido = p.id_pedido
              AND f.id_sucursal = p.id_sucursal
            ORDER BY
              f.fecha_operacion DESC NULLS LAST,
              f.fecha_hora_facturacion DESC NULLS LAST,
              f.id_factura DESC
            LIMIT 1
          ) f ON TRUE
          ${hasPedidosInventarioAlertas ? `
          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(a.estado, 'PENDIENTE')) = 'PENDIENTE')::int AS pendientes
            FROM public.pedidos_inventario_alertas a
            WHERE a.id_pedido = p.id_pedido
          ) inv_alertas ON TRUE
          ` : ''}
          LEFT JOIN detalle_pedido dp
            ON dp.id_pedido = p.id_pedido
           AND COALESCE(dp.estado, true) = true
           AND (
             (
               dp.id_producto IS NOT NULL
               AND dp.id_receta IS NULL
               ${hasDetallePedidoConfiguracionMenu
                 ? `AND LOWER(COALESCE(NULLIF(TRIM(dp.configuracion_menu->>'entregar_con_pedido'), ''), 'true'))
                      NOT IN ('false', '0', 'no')`
                 : ''}
             )
             OR ${buildPreparedLinePredicate('dp')}
           )
          LEFT JOIN productos prod ON prod.id_producto = dp.id_producto
          LEFT JOIN recetas rec ON rec.id_receta = dp.id_receta
          LEFT JOIN LATERAL (
            SELECT
              dpe.id_extra,
              dpe.nombre_extra_snapshot,
              dpe.codigo_extra_snapshot,
              dpe.cantidad,
              dpe.precio_unitario,
              dpe.subtotal
            FROM public.detalle_pedido_extras dpe
            WHERE dpe.id_detalle_pedido = dp.id_detalle_pedido
              AND COALESCE(dpe.estado, true) = true
              AND dpe.id_extra IS NOT NULL
              AND NULLIF(TRIM(dpe.nombre_extra_snapshot), '') IS NOT NULL
              AND COALESCE(dpe.cantidad, 0) > 0
            ORDER BY dpe.id_detalle_pedido_extra
            LIMIT 1
          ) standalone_extra ON true
          ${whereClause}
          ORDER BY
            ${hasEnPreparacionAt
              ? `CASE
                   WHEN REPLACE(REPLACE(UPPER(TRIM(COALESCE(ep.descripcion, ''))), ' ', '_'), '-', '_') = 'EN_PREPARACION'
                     THEN COALESCE(
                       p.en_preparacion_at,
                       p.visible_en_cocina_at AT TIME ZONE 'America/Tegucigalpa',
                       f.fecha_hora_facturacion AT TIME ZONE 'America/Tegucigalpa',
                       p.fecha_hora_pedido AT TIME ZONE 'America/Tegucigalpa'
                     )
                   ELSE COALESCE(
                     p.visible_en_cocina_at AT TIME ZONE 'America/Tegucigalpa',
                     f.fecha_hora_facturacion AT TIME ZONE 'America/Tegucigalpa',
                     p.fecha_hora_pedido AT TIME ZONE 'America/Tegucigalpa'
                   )
                 END ASC NULLS LAST,`
              : `COALESCE(p.visible_en_cocina_at, f.fecha_hora_facturacion, p.fecha_hora_pedido) ASC NULLS LAST,`}
            p.id_pedido ASC,
            dp.id_detalle_pedido ASC
        `,
        params
      );

      const salsaIds = [
        ...new Set(
          result.rows.flatMap((row) => {
            const config = row.configuracion_menu && typeof row.configuracion_menu === 'object'
              ? row.configuracion_menu
              : null;
            const salsasPorUnidad = Array.isArray(config?.salsas_por_unidad)
              ? config.salsas_por_unidad
              : [];
            return salsasPorUnidad
              .map((entry) => parsePositiveInt(entry?.id_salsa))
              .filter(Boolean);
          })
        )
      ];
      let salsaNameMap = new Map();
      if (salsaIds.length) {
        const salsasResult = await client.query(
          `
            SELECT id_salsa, nombre
            FROM public.salsas
            WHERE id_salsa = ANY($1::int[])
              AND COALESCE(estado, true) = true
          `,
          [salsaIds]
        );
        salsaNameMap = new Map(
          salsasResult.rows
            .map((row) => [parsePositiveInt(row.id_salsa), String(row.nombre || '').trim()])
            .filter(([idSalsa, nombre]) => idSalsa && nombre)
        );
      }

      const grouped = new Map();
      const now = Date.now();

      for (const row of result.rows) {
        if (!grouped.has(row.id_pedido)) {
          const estadoCode = resolveEstadoCode(row.estado_descripcion);
          // AM: Base del atraso prioriza kds_started_at para evitar falsos retrasos al inicializar pedidos.
          const kdsBaseRef =
            row.kds_started_at || row.visible_en_cocina_at || row.fecha_hora_facturacion || row.fecha_hora_pedido;
          const kdsBaseMs = kdsBaseRef ? new Date(kdsBaseRef).getTime() : null;
          const minutosEnEspera = Number.isFinite(kdsBaseMs)
            ? Math.max(0, Math.floor((now - kdsBaseMs) / 60000))
            : null;
          // AM: Usa minutos esperados del pedido; fallback seguro solo cuando no exista kds_expected_minutes.
          const expectedMinutes =
            parsePositiveInt(row.kds_expected_minutes) || parsePositiveInt(EXPIRY_WARN_MINUTES) || 20;
          const estaProximoAExpirar =
            minutosEnEspera !== null &&
            Number.isInteger(expectedMinutes) &&
            expectedMinutes > 0 &&
            minutosEnEspera >= expectedMinutes;

          grouped.set(row.id_pedido, {
            id_pedido: Number(row.id_pedido),
            numero_ticket: buildTicketNumber(row.id_pedido, row.id_factura, row.codigo_venta),
            codigo_venta: String(row.codigo_venta || '').trim() || null,
            id_sucursal: Number(row.id_sucursal ?? 0) || null,
            nombre_sucursal: row.nombre_sucursal || 'Sucursal no definida',
            id_estado_pedido: Number(row.id_estado_pedido ?? 0) || null,
            estado_codigo: estadoCode,
            columna_kds: COLUMN_BY_CODE[estadoCode] || 'PENDIENTES',
            cliente_nombre: row.cliente_nombre || 'Consumidor final',
            tipo_servicio: inferTipoServicio(row.descripcion_envio),
            descripcion_pedido: row.descripcion_pedido || null,
            descripcion_envio: row.descripcion_envio || null,
            fecha_operacion: row.fecha_operacion || null,
            fecha_hora_pedido: row.fecha_hora_pedido,
            visible_en_cocina_at: row.visible_en_cocina_at || row.fecha_hora_facturacion || row.fecha_hora_pedido,
            en_preparacion_at: row.en_preparacion_at || null,
            kds_started_at: row.kds_started_at || null,
            kds_expected_minutes: parsePositiveInt(row.kds_expected_minutes),
            kds_expected_rule: row.kds_expected_rule || null,
            fecha_hora_facturacion: row.fecha_hora_facturacion || row.fecha_hora_pedido,
            minutos_en_espera: minutosEnEspera,
            esta_proximo_a_expirar: estaProximoAExpirar,
            total: roundMoney(row.total),
            inventario_alertas_total: Number(row.inventario_alertas_total ?? 0) || 0,
            inventario_alertas_pendientes: Number(row.inventario_alertas_pendientes ?? 0) || 0,
            total_items: 0,
            items: []
          });
        }

        const pedido = grouped.get(row.id_pedido);

        if (row.id_detalle_pedido) {
          const cantidad = parsePositiveInt(row.cantidad) || 0;
          pedido.items.push({
            id_detalle: Number(row.id_detalle_pedido),
            tipo_item:
              row.id_extra_independiente !== null
                ? 'EXTRA'
                : row.id_producto !== null
                ? 'PRODUCTO'
                : row.id_receta !== null
                    ? 'RECETA'
                  : 'ITEM',
            id_producto: Number(row.id_producto ?? 0) || null,
            id_receta: Number(row.id_receta ?? 0) || null,
            id_extra: Number(row.id_extra_independiente ?? 0) || null,
            es_linea_extra_independiente: row.id_extra_independiente !== null,
            instruccion_operativa: row.id_producto !== null
              ? 'ENTREGAR_JUNTO_CON_EL_PEDIDO'
              : 'PREPARAR',
            nombre_item: row.nombre_item || 'Item de cocina',
            cantidad,
            observacion: row.observacion || null,
            configuracion_menu: row.configuracion_menu || null,
            modificaciones: []
          });
          pedido.total_items += cantidad;
        }
      }

      if (hasKdsTimingColumns && activeKdsEstadoIds.length > 0) {
        const orderedPedidos = Array.from(grouped.values()).sort((left, right) => {
          const leftDate = new Date(left.visible_en_cocina_at || left.fecha_hora_pedido || 0).getTime();
          const rightDate = new Date(right.visible_en_cocina_at || right.fecha_hora_pedido || 0).getTime();
          return leftDate - rightDate;
        });

        for (const pedido of orderedPedidos) {
          if (pedido.kds_started_at && parsePositiveInt(pedido.kds_expected_minutes) && pedido.kds_expected_rule) {
            continue;
          }
          const persistedTiming = await assignPersistedKdsTiming({
            client,
            pedidoId: pedido.id_pedido,
            idSucursal: pedido.id_sucursal,
            activeEstadoIds: activeKdsEstadoIds,
            operationalDate: pedido.fecha_operacion || pedido.fecha_hora_pedido || null
          });
          if (!persistedTiming) continue;
          pedido.kds_started_at = persistedTiming.kds_started_at || pedido.kds_started_at;
          pedido.kds_expected_minutes =
            parsePositiveInt(persistedTiming.kds_expected_minutes) || pedido.kds_expected_minutes;
          pedido.kds_expected_rule = persistedTiming.kds_expected_rule || pedido.kds_expected_rule;
        }
      }

      const data = Array.from(grouped.values()).filter((pedido) => pedido.items.length > 0).map((pedido) => {
        const pedidoNotes = extractPedidoNotes(pedido.descripcion_pedido);
        const totalItems = pedido.items.length;
        return {
          ...pedido,
          items: pedido.items.map((item) => {
            const hasTechnicalObservation = isTechnicalKitchenObservation(item.observacion);
            const modificaciones = item.observacion && !hasTechnicalObservation
              ? splitObservationSegments(item.observacion)
              : resolveItemModifications({
                  pedidoNotes,
                  itemName: item.nombre_item,
                  totalItems
                });
            const modificacionesConfiguracion = extractConfigMenuModifications(
              item.configuracion_menu,
              item.tipo_item,
              salsaNameMap
            );
            const modificacionesFinales = [...modificacionesConfiguracion, ...modificaciones];
            const modificacionesUnicas = [
              ...new Set(
                modificacionesFinales
                  .filter(Boolean)
                  .map((entry) => String(entry).trim())
                  .filter(Boolean)
                  .filter((entry) => !isTechnicalKitchenObservation(entry))
                  .filter((entry) => !isTechnicalOrderNote(entry))
              )
            ];

            return {
              ...item,
              observacion: hasTechnicalObservation ? null : item.observacion,
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
    // Log completo solo en servidor � nunca al cliente
    console.error(`[ERROR ${correlationId}] GET /cocina/pedidos:`, err);
    res.status(500).json({
      error: true,
      message: 'Error interno del servidor',
      referencia: correlationId
    });
  }
});

// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
// PUT /cocina/pedidos/:id/estado
// Avanza o marca como No Entregado un pedido del KDS.
// Valida permisos por estado Y por sucursal del empleado.
// �"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"��"�
router.put('/cocina/pedidos/:id/estado', checkPermission(COCINA_VIEW_PERMISSIONS), async (req, res) => {
  const correlationId = crypto.randomUUID().slice(0, 8);

  try {
    // ���� 1. Validar inputs ��������������������������������������������������������������������������������������������
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
    }

    const estadoDestino = String(req.body?.estado_destino || '').trim().toUpperCase();
    const estadosValidos = ['EN_PREPARACION', 'LISTO_PARA_ENTREGA', 'COMPLETADO', 'NO_ENTREGADO'];
    if (!estadosValidos.includes(estadoDestino)) {
      return res.status(400).json({ error: true, message: 'estado_destino invalido.' });
    }

    // ���� 2. Resolver scope ANTES de abrir transacción ��������������������������������������
    // resolveRequestUserSucursalScope y requestHasAnyPermission usan pool
    // internamente. Llamarlos DENTRO de un BEGIN con el mismo client puede
    // contaminar la conexión si cualquier consulta auxiliar falla.
    const scope = await resolveRequestUserSucursalScope(req);
    const isSuperAdmin = Boolean(scope.isSuperAdmin);
    const userSucursalId = parsePositiveInt(scope.userSucursalId);

    if (!isSuperAdmin && !userSucursalId) {
      return res.status(403).json({ error: true, message: NO_SUCURSAL_ASSIGNMENT_MESSAGE });
    }

    // ���� 3. Abrir transacción solo para las operaciones de DB ����������������������
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const estadoRows = await fetchEstadoCatalog(client);
      const estadoIdMap = buildEstadoIdMap(estadoRows);
      const estadoCodeByIdMap = buildEstadoCodeByIdMap(estadoRows);

      // ���� 4. Leer pedido con bloqueo ������������������������������������������������������������������
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

      // ���� 5. Verificar scope de sucursal ����������������������������������������������������������
      if (!isSuperAdmin && pedidoSucursalId !== userSucursalId) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: true,
          message: 'No tienes permiso para operar pedidos de otra sucursal.'
        });
      }

      // ���� 6. Verificar estado actual y transición válida ��������������������������
      const estadoActual = estadoCodeByIdMap.get(Number(pedido.id_estado_pedido ?? 0)) || null;

      const routing = await readPedidoOperationalRouting({ client, idPedido });
      if (routing.requiere_revision) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'VENTAS_PEDIDO_RUTEO_REQUIERE_REVISION',
          message: 'El pedido tiene lineas invalidas y requiere revision antes de avanzar.',
          ...routing
        });
      }
      if (!routing.requiere_cocina) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          code: 'VENTAS_PEDIDO_NO_REQUIERE_COCINA',
          message: 'Este pedido no contiene preparaciones para cocina.',
          ...routing
        });
      }

      if (!estadoActual || !TRANSITIONS[estadoActual]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'El pedido no esta en un estado valido para operar desde cocina.'
        });
      }

      if (estadoActual === estadoDestino) {
        await client.query('ROLLBACK');
        return res.status(200).json({
          ok: true,
          message: 'El pedido ya se encuentra en el estado solicitado.',
          id_pedido: idPedido,
          estado_anterior: estadoActual,
          estado_actual: estadoDestino,
          warning: false,
          warning_code: null,
          warning_detail: null,
          ...routing
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

      // ���� 7. Verificar permiso específico (usa pool interno, no client) ��
      const transitionPermission = COCINA_TRANSITION_PERMISSION_BY_STATE[estadoActual];
      const canChangeTransition = await requestHasAnyPermission(req, transitionPermission);
      if (!canChangeTransition) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes para cambiar estado en cocina.'
        });
      }

      // ���� 8. Obtener ID del estado destino ������������������������������������������������������
      const idEstadoDestino = estadoIdMap.get(estadoDestino);
      if (!idEstadoDestino) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: true,
          message: 'El estado de destino no esta configurado en el sistema.'
        });
      }

      let inventoryResult = null;
      let inventoryAlreadyDiscounted = false;
      const shouldDiscountInventory = estadoDestino === 'EN_PREPARACION';
      if (shouldDiscountInventory) {
        const consumoPayloadResult = await buildPedidoConsumoPayload(client, idPedido, pedidoSucursalId);
        if (!consumoPayloadResult.ok) {
          await client.query('ROLLBACK');
          return res.status(consumoPayloadResult.status).json(consumoPayloadResult.body);
        }

        try {
          const strictSalsaInsumoIds = new Set(
            consumoPayloadResult.payload.items
              .filter((item) => item.tipo_item === 'SALSA')
              .map((item) => parsePositiveInt(item.id_insumo))
              .filter(Boolean)
          );
          inventoryResult = await validarYDescontarPedido(consumoPayloadResult.payload, {
            id_usuario: req?.user?.id_usuario,
            allowNegativeStock: true,
            allowIncompleteConfiguration: true,
            strictInsumoIds: strictSalsaInsumoIds,
            dbClient: client
          });
        } catch (inventoryError) {
          const errorCode = String(inventoryError?.code || '').trim().toUpperCase();
          if (errorCode !== 'PEDIDO_YA_DESCONTADO') {
            await client.query('ROLLBACK');
            return res.status(inventoryError?.httpStatus || 409).json({
              error: true,
              code: inventoryError?.code || 'INVENTARIO_ERROR',
              message: inventoryError?.publicMessage || inventoryError?.message || 'No se pudo descontar inventario para el pedido.',
              details: inventoryError?.details || null
            });
          }
          inventoryAlreadyDiscounted = true;
        }

        if (!inventoryAlreadyDiscounted && !inventoryResult?.ok) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: true,
            code: inventoryResult.code || 'INVENTARIO_ERROR',
            message: inventoryResult.message || 'No se pudo descontar inventario para el pedido.',
            faltantes: Array.isArray(inventoryResult.faltantes) ? inventoryResult.faltantes : []
          });
        }
      }

      // ���� 9. Actualizar estado ������������������������������������������������������������������������������
      const hasEnPreparacionAt = await hasColumn(client, 'pedidos', 'en_preparacion_at');
      const updatedPedidoResult = await client.query(
        `
          UPDATE pedidos
          SET id_estado_pedido = $1,
              visible_en_cocina_at = COALESCE(visible_en_cocina_at, fecha_hora_pedido, NOW())
              ${hasEnPreparacionAt && estadoDestino === 'EN_PREPARACION'
                ? ', en_preparacion_at = COALESCE(en_preparacion_at, NOW())'
                : ''}
          WHERE id_pedido = $2
          RETURNING ${hasEnPreparacionAt ? 'en_preparacion_at' : 'NULL::timestamptz AS en_preparacion_at'}
        `,
        [idEstadoDestino, idPedido]
      );

      await client.query('COMMIT');

      if (!inventoryAlreadyDiscounted && Array.isArray(inventoryResult?.warning?.faltantes)) {
        await registrarAlertasInventarioPedido({
          id_pedido: idPedido,
          id_usuario: req?.user?.id_usuario,
          warnings: inventoryResult.warning.faltantes
        });
      }

      // ���� 10. Alerta de expiración (fire-and-forget, fuera de la tx) ��
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
        message: inventoryAlreadyDiscounted
          ? 'Pedido marcado como listo. El inventario ya habia sido descontado previamente.'
          : 'Estado de pedido actualizado correctamente.',
        id_pedido: idPedido,
        estado_anterior: estadoActual,
        estado_actual: estadoDestino,
        ...routing,
        en_preparacion_at: updatedPedidoResult.rows[0]?.en_preparacion_at || null,
        warning: Boolean(inventoryResult?.warning || inventoryAlreadyDiscounted),
        warning_code: inventoryAlreadyDiscounted
          ? 'INVENTARIO_YA_DESCONTADO'
          : inventoryResult?.warning?.code || null,
        warning_detail: Array.isArray(inventoryResult?.warning?.faltantes)
          ? inventoryResult.warning.faltantes
          : inventoryResult?.warning || null
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

