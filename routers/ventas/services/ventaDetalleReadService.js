import { roundMoney } from '../utils/moneyUtils.js';
import {
  normalizeObservation,
  parseOptionalPositiveInt
} from '../utils/parseUtils.js';

const tableExistsCache = new Map();

const hasTable = async (client, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (tableExistsCache.has(key)) return tableExistsCache.get(key);

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
  tableExistsCache.set(key, exists);
  return exists;
};

export const mergeVentaWithFacturacion = (venta = {}, facturacion = {}) => {
  const emisor = facturacion?.emisor || {};
  const ticket = facturacion?.ticket || {};
  const ticketFlags = {
    mostrar_datos_fiscales: ticket?.mostrar_datos_fiscales !== false,
    mostrar_cai_ticket: ticket?.mostrar_cai_ticket !== false,
    mostrar_numero_fiscal_ticket: ticket?.mostrar_numero_fiscal_ticket !== false,
    mostrar_codigo_interno_ticket: ticket?.mostrar_codigo_interno_ticket !== false,
    aplicar_impuestos: Boolean(ticket?.aplicar_impuestos),
    mostrar_impuestos_ticket: Boolean(ticket?.mostrar_impuestos_ticket),
    mostrar_importe_exento: Boolean(ticket?.mostrar_importe_exento),
    mostrar_importe_gravado_15: Boolean(ticket?.mostrar_importe_gravado_15),
    mostrar_isv_15: Boolean(ticket?.mostrar_isv_15),
    mostrar_importe_gravado_18: Boolean(ticket?.mostrar_importe_gravado_18),
    mostrar_isv_18: Boolean(ticket?.mostrar_isv_18),
    mostrar_total_isv: Boolean(ticket?.mostrar_total_isv),
    mostrar_descuento_linea: ticket?.mostrar_descuento_linea !== false,
    mostrar_descuento_porcentaje_linea: ticket?.mostrar_descuento_porcentaje_linea !== false,
    mostrar_descuento_total: ticket?.mostrar_descuento_total !== false,
    imprimir_comprobante_reversion: ticket?.imprimir_comprobante_reversion !== false,
    mostrar_venta_original_reversion: ticket?.mostrar_venta_original_reversion !== false,
    mostrar_codigo_reversion: ticket?.mostrar_codigo_reversion !== false,
    mostrar_usuario_reversion: ticket?.mostrar_usuario_reversion !== false,
    mostrar_caja_sesion_reversion: ticket?.mostrar_caja_sesion_reversion !== false,
    mostrar_motivo_reversion: ticket?.mostrar_motivo_reversion !== false,
    mostrar_detalle_reversion: ticket?.mostrar_detalle_reversion !== false,
    mostrar_total_reversion: ticket?.mostrar_total_reversion !== false
  };
  return {
    ...venta,
    facturacion: {
      emisor: {
        nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
        rtn_emisor: emisor?.rtn_emisor || null,
        direccion_emisor: emisor?.direccion_emisor || null,
        telefono_emisor: emisor?.telefono_emisor || null,
        correo_emisor: emisor?.correo_emisor || null,
        logo_url: emisor?.logo_url || null
      },
      ticket: {
        ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
        mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
        mostrar_rtn: Boolean(ticket?.mostrar_rtn),
        mostrar_direccion: Boolean(ticket?.mostrar_direccion),
        mostrar_telefono: Boolean(ticket?.mostrar_telefono),
        mostrar_correo: Boolean(ticket?.mostrar_correo),
        ...ticketFlags,
        texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
        texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra'
      },
      fiscal: {
        modo_fiscal: 'NO_INTEGRADO',
        cai: '0',
        numero_factura_fiscal: '0'
      }
    },
    nombre_emisor: emisor?.nombre_emisor || "JONNY'S",
    rtn_emisor: emisor?.rtn_emisor || null,
    sucursal_direccion: emisor?.direccion_emisor || null,
    sucursal_telefono: emisor?.telefono_emisor || null,
    sucursal_correo: emisor?.correo_emisor || null,
    logo_url: emisor?.logo_url || null,
    ancho_ticket_mm: Number(ticket?.ancho_ticket_mm) === 58 ? 58 : 80,
    mostrar_logo_ticket: Boolean(ticket?.mostrar_logo_ticket),
    mostrar_rtn: Boolean(ticket?.mostrar_rtn),
    mostrar_direccion: Boolean(ticket?.mostrar_direccion),
    mostrar_telefono: Boolean(ticket?.mostrar_telefono),
    mostrar_correo: Boolean(ticket?.mostrar_correo),
    ...ticketFlags,
    texto_encabezado_ticket: ticket?.texto_encabezado_ticket || null,
    texto_pie_ticket: ticket?.texto_pie_ticket || 'Gracias por su compra',
    modo_fiscal: 'NO_INTEGRADO',
    cai: '0',
    numero_factura_fiscal: '0',
    id_rango_cai: null
  };
};

const formatVentaNumero = (idVenta) => `VTA-${String(idVenta).padStart(5, '0')}`;

export const resolveVentaNumero = (row) =>
  String(row?.codigo_venta || '').trim() || formatVentaNumero(row?.id_factura);

export const inferKitchenItemQuantity = (rawSubtotal, rawUnitPrice) => {
  const subtotal = Number(rawSubtotal || 0);
  const unitPrice = Number(rawUnitPrice || 0);

  if (!Number.isFinite(subtotal) || subtotal <= 0) return 1;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return 1;

  const inferred = Math.round(subtotal / unitPrice);
  return Number.isInteger(inferred) && inferred > 0 ? inferred : 1;
};

export const buildDirectSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    tipo_item: String(row.tipo_item || 'PRODUCTO').toUpperCase(),
    nombre_item: row.nombre_item || row.nombre_producto || 'Producto',
    nombre_producto: row.nombre_producto || row.nombre_item || 'Producto',
    cantidad: Number(row.cantidad ?? 0) || 0,
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    descuento_linea: roundMoney(row.descuento_linea),
    descuento_global: roundMoney(row.descuento_global),
    observacion: null
  }));

export const buildKitchenSaleDetailItems = (rows) =>
  rows.map((row) => ({
    ...row,
    nombre_item: row.nombre_item || 'Item de cocina',
    nombre_producto: row.nombre_item || 'Item de cocina',
    cantidad:
      Number(row.cantidad ?? 0) > 0
        ? Number(row.cantidad)
        : inferKitchenItemQuantity(row.sub_total, row.precio_unitario),
    precio_unitario: roundMoney(row.precio_unitario),
    sub_total: roundMoney(row.sub_total),
    total_linea: roundMoney(row.total_linea),
    descuento: roundMoney(row.descuento),
    descuento_linea: roundMoney(row.descuento_linea),
    descuento_global: roundMoney(row.descuento_global),
    observacion: normalizeObservation(row.observacion)
  }));

export const fetchDetalleFacturaExtras = async (client, detalleFacturaIds = []) => {
  const ids = [...new Set((Array.isArray(detalleFacturaIds) ? detalleFacturaIds : [])
    .map((id) => parseOptionalPositiveInt(id))
    .filter(Boolean))];
  if (!ids.length || !(await hasTable(client, 'detalle_factura_extras'))) return new Map();

  const result = await client.query(
    `
      SELECT
        id_detalle_factura,
        id_extra,
        nombre_extra_snapshot AS nombre,
        cantidad,
        precio_unitario,
        subtotal
      FROM public.detalle_factura_extras
      WHERE id_detalle_factura = ANY($1::int[])
        AND COALESCE(estado, true) = true
      ORDER BY id_detalle_factura, id_detalle_factura_extra
    `,
    [ids]
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.id_detalle_factura);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({
      id_extra: Number(row.id_extra),
      nombre: row.nombre,
      cantidad: Number(row.cantidad),
      precio_unitario: roundMoney(row.precio_unitario),
      subtotal: roundMoney(row.subtotal)
    });
  }
  return grouped;
};

export const fetchCuentaDividida = async (client, { idFactura = null, idPedido = null } = {}) => {
  const facturaId = parseOptionalPositiveInt(idFactura);
  const pedidoId = parseOptionalPositiveInt(idPedido);
  if (!facturaId && !pedidoId) return null;

  const params = [];
  const filters = [];
  if (facturaId) {
    params.push(facturaId);
    filters.push(`vcd.id_factura = $${params.length}`);
  } else if (pedidoId) {
    params.push(pedidoId);
    filters.push(`vcd.id_pedido = $${params.length}`);
  }

  const divisionsResult = await client.query(
    `
      SELECT
        vcd.id_cuenta_division,
        vcd.id_factura,
        vcd.id_pedido,
        vcd.etiqueta,
        vcd.orden,
        vcd.subtotal_base,
        vcd.subtotal_extras,
        vcd.descuento_total,
        vcd.isv_total,
        vcd.total,
        vcd.monto_pagado,
        vcd.monto_pendiente,
        vcd.estado
      FROM public.ventas_cuenta_divisiones vcd
      WHERE (${filters.join(' OR ')})
      ORDER BY vcd.orden, vcd.id_cuenta_division
    `,
    params
  );
  if (divisionsResult.rowCount === 0) return null;

  const divisionIds = divisionsResult.rows.map((row) => Number(row.id_cuenta_division)).filter(Boolean);
  const itemsResult = await client.query(
    `
      SELECT *
      FROM public.ventas_cuenta_division_items
      WHERE id_cuenta_division = ANY($1::bigint[])
      ORDER BY id_cuenta_division, id_cuenta_division_item
    `,
    [divisionIds]
  );
  const cobrosResult = facturaId
    ? await client.query(
      `
        SELECT
          fc.id_factura_cobro,
          fc.id_cuenta_division,
          fc.id_metodo_pago,
          cmp.nombre AS metodo_pago,
          fc.monto,
          fc.referencia,
          fc.observacion,
          fc.fecha_cobro
        FROM public.facturas_cobros fc
        LEFT JOIN public.cat_metodos_pago cmp ON cmp.id_metodo_pago = fc.id_metodo_pago
        WHERE fc.id_factura = $1
          AND fc.id_cuenta_division = ANY($2::bigint[])
        ORDER BY fc.fecha_cobro, fc.id_factura_cobro
      `,
      [facturaId, divisionIds]
    )
    : { rows: [] };

  const itemsByDivision = new Map();
  for (const row of itemsResult.rows) {
    const id = Number(row.id_cuenta_division);
    if (!itemsByDivision.has(id)) itemsByDivision.set(id, []);
    itemsByDivision.get(id).push({
      id_cuenta_division_item: Number(row.id_cuenta_division_item),
      id_detalle_factura: parseOptionalPositiveInt(row.id_detalle_factura),
      id_detalle_pedido: parseOptionalPositiveInt(row.id_detalle_pedido),
      tipo_item: row.tipo_item,
      id_producto: parseOptionalPositiveInt(row.id_producto),
      id_receta: parseOptionalPositiveInt(row.id_receta),
      id_combo: parseOptionalPositiveInt(row.id_combo),
      nombre_item: row.nombre_item_snapshot,
      cantidad: Number(row.cantidad || 0),
      precio_unitario: roundMoney(row.precio_unitario),
      subtotal_base: roundMoney(row.subtotal_base),
      subtotal_extras: roundMoney(row.subtotal_extras),
      descuento_total: roundMoney(row.descuento_total),
      isv_total: roundMoney(row.isv_total),
      total_linea: roundMoney(row.total_linea),
      extras: Array.isArray(row.extras_snapshot) ? row.extras_snapshot : [],
      complementos: Array.isArray(row.complementos_snapshot) ? row.complementos_snapshot : [],
      origen_snapshot: row.origen_snapshot || {}
    });
  }

  const cobrosByDivision = new Map();
  for (const row of cobrosResult.rows) {
    const id = Number(row.id_cuenta_division);
    if (!cobrosByDivision.has(id)) cobrosByDivision.set(id, []);
    cobrosByDivision.get(id).push({
      id_factura_cobro: Number(row.id_factura_cobro),
      id_metodo_pago: Number(row.id_metodo_pago),
      metodo_pago: row.metodo_pago || null,
      monto: roundMoney(row.monto),
      referencia: row.referencia || null,
      observacion: row.observacion || null,
      fecha_cobro: row.fecha_cobro || null
    });
  }

  const divisiones = divisionsResult.rows.map((row) => {
    const id = Number(row.id_cuenta_division);
    return {
      id_cuenta_division: id,
      id_factura: parseOptionalPositiveInt(row.id_factura),
      id_pedido: parseOptionalPositiveInt(row.id_pedido),
      etiqueta: row.etiqueta,
      orden: Number(row.orden || 0),
      subtotal_base: roundMoney(row.subtotal_base),
      subtotal_extras: roundMoney(row.subtotal_extras),
      descuento_total: roundMoney(row.descuento_total),
      isv_total: roundMoney(row.isv_total),
      total: roundMoney(row.total),
      monto_pagado: roundMoney(row.monto_pagado),
      monto_pendiente: roundMoney(row.monto_pendiente),
      estado: String(row.estado || 'PENDIENTE').trim().toUpperCase(),
      items: itemsByDivision.get(id) || [],
      cobros: cobrosByDivision.get(id) || []
    };
  });

  return {
    divisiones,
    total: roundMoney(divisiones.reduce((sum, division) => sum + Number(division.total || 0), 0)),
    monto_pagado: roundMoney(divisiones.reduce((sum, division) => sum + Number(division.monto_pagado || 0), 0)),
    monto_pendiente: roundMoney(divisiones.reduce((sum, division) => sum + Number(division.monto_pendiente || 0), 0))
  };
};

export const fetchKitchenSaleDetailRows = async (client, idFactura) =>
  client.query(
    `
          SELECT
            df.id_detalle_factura AS id_detalle,
            COALESCE(dfo.id_detalle_pedido, df.id_detalle_pedido::int) AS id_detalle_pedido,
            CASE
              WHEN NULLIF(TRIM(dfo.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(dfo.tipo_item))
              WHEN NULLIF(TRIM(df.tipo_item), '') IS NOT NULL THEN UPPER(TRIM(df.tipo_item))
              WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
              WHEN dp.id_combo IS NOT NULL THEN 'COMBO'
              WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
              ELSE 'ITEM'
            END AS tipo_item,
            COALESCE(dfo.id_producto, df.id_producto, dp.id_producto) AS id_producto,
            COALESCE(dfo.id_combo, df.id_combo::int, dp.id_combo) AS id_combo,
            COALESCE(dfo.id_receta, df.id_receta::int, dp.id_receta) AS id_receta,
            COALESCE(
              dfo.origen_snapshot->>'nombre_item',
              df.origen_snapshot->>'nombre_item',
              prod.nombre_producto,
              combo.descripcion,
              rec.nombre_receta,
              'Item de cocina'
            ) AS nombre_item,
            COALESCE(
              dfo.origen_snapshot->>'nombre_item',
              df.origen_snapshot->>'nombre_item',
              prod.nombre_producto,
              combo.descripcion,
              rec.nombre_receta,
              'Item de cocina'
            ) AS nombre_producto,
            COALESCE(df.cantidad, 1) AS cantidad,
            COALESCE(
              CASE
                WHEN dp.id_producto IS NOT NULL THEN prod.precio
                WHEN dp.id_combo IS NOT NULL THEN combo.precio
                WHEN dp.id_receta IS NOT NULL THEN rec.precio
                ELSE NULL
              END,
              CASE
                WHEN COALESCE(dp.sub_total_pedido, 0) > 0 THEN COALESCE(dp.sub_total_pedido, 0)
                ELSE COALESCE(dp.total_pedido, 0)
              END,
              0
            ) AS precio_unitario,
            COALESCE(df.sub_total, dp.sub_total_pedido, 0) AS sub_total,
            COALESCE(df.sub_total, dp.sub_total_pedido, 0) AS subtotal_linea,
            COALESCE(df.total_detalle, dp.total_pedido, COALESCE(dp.sub_total_pedido, 0)) AS total_linea,
            COALESCE(d.monto_descuento, 0) AS descuento,
            COALESCE(NULLIF(COALESCE(dfo.origen_snapshot, df.origen_snapshot)->>'descuento_linea', '')::numeric, COALESCE(d.monto_descuento, 0)) AS descuento_linea,
            COALESCE(NULLIF(COALESCE(dfo.origen_snapshot, df.origen_snapshot)->>'descuento_global', '')::numeric, 0) AS descuento_global,
            NULL::numeric AS isv_15_linea,
            NULL::numeric AS isv_18_linea,
            NULL::numeric AS exento_linea,
            NULL::numeric AS exonerado_linea,
            dp.observacion,
            COALESCE(dfo.origen_snapshot, df.origen_snapshot) AS origen_snapshot
          FROM detalle_facturas df
          LEFT JOIN detalle_facturas_origen dfo
            ON dfo.id_detalle_factura = df.id_detalle_factura
          LEFT JOIN detalle_pedido dp ON dp.id_detalle_pedido = df.id_detalle_pedido
          LEFT JOIN productos prod ON prod.id_producto = COALESCE(dfo.id_producto, df.id_producto, dp.id_producto)
          LEFT JOIN combos combo ON combo.id_combo = COALESCE(dfo.id_combo, df.id_combo::int, dp.id_combo)
          LEFT JOIN recetas rec ON rec.id_receta = COALESCE(dfo.id_receta, df.id_receta::int, dp.id_receta)
          LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
          WHERE df.id_factura = $1
          ORDER BY df.id_detalle_factura
        `,
    [idFactura]
  );

export const fetchDirectSaleDetailRows = async (client, idFactura) =>
  client.query(
    `
        SELECT
          df.id_detalle_factura AS id_detalle,
          COALESCE(dfo.id_detalle_pedido, df.id_detalle_pedido::int) AS id_detalle_pedido,
          COALESCE(NULLIF(TRIM(dfo.tipo_item), ''), NULLIF(TRIM(df.tipo_item), ''), 'PRODUCTO') AS tipo_item,
          COALESCE(dfo.id_producto, df.id_producto) AS id_producto,
          COALESCE(dfo.id_combo, df.id_combo::int) AS id_combo,
          COALESCE(dfo.id_receta, df.id_receta::int) AS id_receta,
          COALESCE(dfo.origen_snapshot->>'nombre_item', df.origen_snapshot->>'nombre_item', p.nombre_producto, 'Producto') AS nombre_item,
          COALESCE(dfo.origen_snapshot->>'nombre_item', df.origen_snapshot->>'nombre_item', p.nombre_producto, 'Producto') AS nombre_producto,
          COALESCE(df.cantidad, 1) AS cantidad,
          COALESCE(df.precio_unitario, p.precio, 0) AS precio_unitario,
          COALESCE(df.sub_total, 0) AS sub_total,
          COALESCE(df.sub_total, 0) AS subtotal_linea,
          COALESCE(df.total_detalle, 0) AS total_linea,
          COALESCE(d.monto_descuento, 0) AS descuento,
          COALESCE(NULLIF(COALESCE(dfo.origen_snapshot, df.origen_snapshot)->>'descuento_linea', '')::numeric, COALESCE(d.monto_descuento, 0)) AS descuento_linea,
          COALESCE(NULLIF(COALESCE(dfo.origen_snapshot, df.origen_snapshot)->>'descuento_global', '')::numeric, 0) AS descuento_global,
          NULL::numeric AS isv_15_linea,
          NULL::numeric AS isv_18_linea,
          NULL::numeric AS exento_linea,
          NULL::numeric AS exonerado_linea,
          NULL::varchar(200) AS observacion,
          COALESCE(dfo.origen_snapshot, df.origen_snapshot) AS origen_snapshot
        FROM detalle_facturas df
        LEFT JOIN detalle_facturas_origen dfo
          ON dfo.id_detalle_factura = df.id_detalle_factura
        LEFT JOIN productos p ON p.id_producto = COALESCE(dfo.id_producto, df.id_producto)
        LEFT JOIN descuentos d ON d.id_descuento = df.id_descuento
        WHERE df.id_factura = $1
        ORDER BY df.id_detalle_factura
      `,
    [idFactura]
  );
