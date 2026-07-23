import { resolveStandaloneExtraLine } from '../utils/parseUtils.js';
import {
  classifyKitchenPrintItems
} from './kitchenPrintRoutingService.js';

const schemaLookupCache = new Map();

const hasTable = async (queryRunner, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (schemaLookupCache.has(key)) return schemaLookupCache.get(key);

  const result = await queryRunner.query(
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
  schemaLookupCache.set(key, exists);
  return exists;
};

const hasColumn = async (queryRunner, tableName, columnName) => {
  const key = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaLookupCache.has(key)) return schemaLookupCache.get(key);

  const result = await queryRunner.query(
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
  schemaLookupCache.set(key, exists);
  return exists;
};

export const toKitchenExtras = (extras = []) =>
  (Array.isArray(extras) ? extras : []).map((extra) => ({
    id_extra: Number(extra?.id_extra || 0) || null,
    nombre: String(extra?.nombre || extra?.nombre_extra || 'Extra').trim(),
    cantidad: Number(extra?.cantidad_por_orden ?? extra?.origen_snapshot?.cantidad_por_orden ?? extra?.cantidad ?? 0) || 0,
    cantidad_total: Number(extra?.cantidad_total ?? extra?.origen_snapshot?.cantidad_total ?? extra?.cantidad ?? 0) || 0
  }));

export const toKitchenComplementos = (item = {}) => {
  const config = item?.configuracion_menu && typeof item.configuracion_menu === 'object'
    ? item.configuracion_menu
    : {};
  const snapshot = item?.origen_snapshot && typeof item.origen_snapshot === 'object'
    ? item.origen_snapshot
    : {};
  const componentes = Array.isArray(config?.complementos)
    ? config.complementos
    : Array.isArray(config?.salsas)
      ? config.salsas
      : Array.isArray(config?.salsas_por_unidad)
        ? config.salsas_por_unidad.flatMap((entry) => Array.isArray(entry?.salsas) ? entry.salsas : [])
        : Array.isArray(snapshot?.componentes)
          ? snapshot.componentes
          : Array.isArray(snapshot?.componentes?.seleccion)
            ? snapshot.componentes.seleccion
            : Array.isArray(snapshot?.complementos)
              ? snapshot.complementos
              : Array.isArray(snapshot?.complementos?.seleccion)
                ? snapshot.complementos.seleccion
                : [];
  return componentes
    .map((entry) => ({
      id_complemento: Number(entry?.id_complemento || entry?.id_salsa || entry?.id || 0) || null,
      nombre: String(entry?.nombre || entry?.nombre_salsa || entry?.label || 'Salsa').trim()
    }))
    .filter((entry) => entry.id_complemento || entry.nombre);
};

export const buildPedidoKitchenPrintPayload = async (
  queryRunner,
  idPedido,
  { normalizeStandaloneExtras = true, applyOperationalRouting = true } = {}
) => {
  const hasDetallePedidoConfiguracionMenu = await hasColumn(queryRunner, 'detalle_pedido', 'configuracion_menu');
  const hasDetallePedidoExtras = await hasTable(queryRunner, 'detalle_pedido_extras');
  const hasPedidosContacto = await hasTable(queryRunner, 'pedidos_contacto');
  const hasPedidosContexto = await hasTable(queryRunner, 'pedidos_contexto');
  const hasPedidosDelivery = await hasTable(queryRunner, 'pedidos_delivery');
  const hasPedidosPagoControl = await hasTable(queryRunner, 'pedidos_pago_control');

  const contactoJoin = hasPedidosContacto
    ? `
      LEFT JOIN LATERAL (
        SELECT pc_inner.*
        FROM public.pedidos_contacto pc_inner
        WHERE pc_inner.id_pedido = p.id_pedido
        ORDER BY pc_inner.id_pedido_contacto DESC
        LIMIT 1
      ) pc ON true
    `
    : '';
  const contextoJoin = hasPedidosContexto
    ? `
      LEFT JOIN LATERAL (
        SELECT px_inner.*
        FROM public.pedidos_contexto px_inner
        WHERE px_inner.id_pedido = p.id_pedido
        ORDER BY px_inner.id_pedido_contexto DESC
        LIMIT 1
      ) px ON true
      LEFT JOIN public.cat_pedidos_canales cpc
        ON cpc.id_canal_pedido = px.id_canal_pedido
      LEFT JOIN public.cat_pedidos_modalidades_entrega cme
        ON cme.id_modalidad_entrega = px.id_modalidad_entrega
      LEFT JOIN public.usuarios u_toma
        ON u_toma.id_usuario = px.id_usuario_toma
      LEFT JOIN public.cajas_sesiones cs
        ON cs.id_sesion_caja = px.id_sesion_caja_origen
      LEFT JOIN public.cajas cj
        ON cj.id_caja = cs.id_caja
    `
    : '';
  const deliveryJoin = hasPedidosDelivery
    ? `
      LEFT JOIN LATERAL (
        SELECT pd_inner.*
        FROM public.pedidos_delivery pd_inner
        WHERE pd_inner.id_pedido = p.id_pedido
        ORDER BY pd_inner.id_pedido_delivery DESC
        LIMIT 1
      ) pd ON true
      LEFT JOIN public.cat_delivery_estados cde
        ON cde.id_estado_delivery = pd.id_estado_delivery
    `
    : '';
  const pagoControlJoin = hasPedidosPagoControl
    ? `
      LEFT JOIN LATERAL (
        SELECT ppc_inner.*
        FROM public.pedidos_pago_control ppc_inner
        WHERE ppc_inner.id_pedido = p.id_pedido
        ORDER BY ppc_inner.id_pedido_pago_control DESC
        LIMIT 1
      ) ppc ON true
    `
    : '';

  const result = await queryRunner.query(
    `
      SELECT
        p.id_pedido,
        p.descripcion_pedido,
        p.descripcion_envio,
        p.fecha_hora_pedido,
        p.id_sucursal,
        p.id_usuario,
        p.origen_pedido,
        p.canal AS canal_pedido,
        p.tipo_entrega,
        p.total,
        'PED-' || LPAD(p.id_pedido::text, 5, '0') AS numero_pedido,
        s.nombre_sucursal,
        u.nombre_usuario AS nombre_usuario_pedido,
        u.nombre_usuario AS usuario_pedido,
        ${hasPedidosContexto ? 'px.id_sesion_caja_origen' : 'NULL::bigint AS id_sesion_caja_origen'},
        ${hasPedidosContexto ? 'px.id_usuario_toma' : 'NULL::int AS id_usuario_toma'},
        ${hasPedidosContexto ? 'COALESCE(u_toma.nombre_usuario, u.nombre_usuario) AS usuario_toma' : 'u.nombre_usuario AS usuario_toma'},
        ${hasPedidosContexto ? 'cj.id_caja' : 'NULL::int AS id_caja'},
        ${hasPedidosContexto ? 'cj.nombre_caja' : 'NULL::text AS nombre_caja'},
        ${hasPedidosContexto ? 'cj.codigo_caja' : 'NULL::text AS codigo_caja'},
        ${hasPedidosContexto ? 'cpc.codigo AS canal_contexto' : 'NULL::text AS canal_contexto'},
        ${hasPedidosContexto ? 'cme.codigo AS modalidad_contexto' : 'NULL::text AS modalidad_contexto'},
        ${hasPedidosContexto ? 'px.observacion_contexto' : 'NULL::text AS observacion_contexto'},
        ${hasPedidosContacto ? 'pc.nombre_contacto' : 'NULL::text AS nombre_contacto'},
        ${hasPedidosContacto ? 'pc.telefono_contacto' : 'NULL::text AS telefono_contacto'},
        ${hasPedidosContacto ? 'pc.telefono_normalizado' : 'NULL::text AS telefono_normalizado'},
        ${hasPedidosContacto ? 'pc.dni' : 'NULL::text AS dni'},
        ${hasPedidosContacto ? 'pc.rtn' : 'NULL::text AS rtn'},
        ${hasPedidosContacto ? 'pc.correo' : 'NULL::text AS correo'},
        ${hasPedidosDelivery ? 'pd.id_pedido_delivery' : 'NULL::int AS id_pedido_delivery'},
        ${hasPedidosDelivery ? 'pd.costo_envio' : 'NULL::numeric AS costo_envio'},
        ${hasPedidosDelivery ? 'pd.nombre_receptor' : 'NULL::text AS nombre_receptor'},
        ${hasPedidosDelivery ? 'pd.telefono_receptor' : 'NULL::text AS telefono_receptor'},
        ${hasPedidosDelivery ? 'pd.direccion_entrega' : 'NULL::text AS direccion_entrega'},
        ${hasPedidosDelivery ? 'pd.referencia_entrega' : 'NULL::text AS referencia_entrega'},
        ${hasPedidosDelivery ? 'pd.observacion_delivery' : 'NULL::text AS observacion_delivery'},
        ${hasPedidosDelivery ? 'cde.codigo AS estado_delivery' : 'NULL::text AS estado_delivery'},
        ${hasPedidosPagoControl ? 'ppc.monto_total' : 'NULL::numeric AS monto_total'},
        ${hasPedidosPagoControl ? 'ppc.monto_pagado' : 'NULL::numeric AS monto_pagado'},
        ${hasPedidosPagoControl ? 'ppc.monto_pendiente' : 'NULL::numeric AS monto_pendiente'},
        ${hasPedidosPagoControl ? 'ppc.id_factura AS id_factura_pago' : 'NULL::int AS id_factura_pago'},
        factura_info.id_factura AS id_factura_existente,
        COALESCE(dp_info.items, '[]'::jsonb) AS items
      FROM public.pedidos p
      LEFT JOIN public.sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN public.usuarios u ON u.id_usuario = p.id_usuario
      ${contactoJoin}
      ${contextoJoin}
      ${deliveryJoin}
      ${pagoControlJoin}
      LEFT JOIN LATERAL (
        SELECT f_inner.id_factura
        FROM public.facturas f_inner
        WHERE f_inner.id_pedido = p.id_pedido
        ORDER BY f_inner.fecha_hora_facturacion DESC NULLS LAST, f_inner.id_factura DESC
        LIMIT 1
      ) factura_info ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id_detalle', dp.id_detalle_pedido,
            'id_detalle_pedido', dp.id_detalle_pedido,
            'tipo_item',
              CASE
                WHEN dp.id_producto IS NOT NULL THEN 'PRODUCTO'
                WHEN dp.id_receta IS NOT NULL THEN 'RECETA'
                ELSE 'ITEM'
              END,
            'id_producto', dp.id_producto,
            'id_receta', dp.id_receta,
            'nombre_item', COALESCE(prod.nombre_producto, rec.nombre_receta, 'Item de pedido'),
            'nombre_producto', COALESCE(prod.nombre_producto, rec.nombre_receta, 'Item de pedido'),
            'cantidad',
              CASE
                WHEN COALESCE(dp.cantidad, 0) > 0
                  THEN dp.cantidad::int
                WHEN COALESCE(prod.precio, rec.precio, 0) > 0
                  THEN GREATEST(1, ROUND(COALESCE(dp.sub_total_pedido, dp.total_pedido, 0) / COALESCE(prod.precio, rec.precio, 1))::int)
                ELSE 1
              END,
            'observacion', dp.observacion,
            'extras', ${hasDetallePedidoExtras ? `COALESCE(extras_info.extras, '[]'::jsonb)` : `'[]'::jsonb`},
            'configuracion_menu', ${hasDetallePedidoConfiguracionMenu ? 'dp.configuracion_menu' : 'NULL::jsonb'}
          )
          ORDER BY dp.id_detalle_pedido
        ) AS items
        FROM public.detalle_pedido dp
        LEFT JOIN public.productos prod ON prod.id_producto = dp.id_producto
        LEFT JOIN public.recetas rec ON rec.id_receta = dp.id_receta
        ${hasDetallePedidoExtras ? `
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id_detalle_pedido_extra', dpe.id_detalle_pedido_extra,
              'id_extra', dpe.id_extra,
              'nombre', dpe.nombre_extra_snapshot,
              'nombre_extra', dpe.nombre_extra_snapshot,
              'codigo', dpe.codigo_extra_snapshot,
              'codigo_extra_snapshot', dpe.codigo_extra_snapshot,
              'cantidad', dpe.cantidad,
              'precio_unitario', dpe.precio_unitario,
              'subtotal', dpe.subtotal,
              'origen_snapshot', dpe.origen_snapshot
            )
            ORDER BY dpe.id_detalle_pedido_extra
          ) AS extras
          FROM public.detalle_pedido_extras dpe
          WHERE dpe.id_detalle_pedido = dp.id_detalle_pedido
            AND COALESCE(dpe.estado, true) = true
        ) extras_info ON true
        ` : ''}
        WHERE dp.id_pedido = p.id_pedido
          AND COALESCE(dp.estado, true) = true
      ) dp_info ON true
      WHERE p.id_pedido = $1
      LIMIT 1
    `,
    [idPedido]
  );

  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const normalizedItems = (Array.isArray(row.items) ? row.items : []).map((item, index) => {
    const standaloneExtra = normalizeStandaloneExtras
      ? resolveStandaloneExtraLine({
        idProducto: item?.id_producto,
        idReceta: item?.id_receta,
        extras: item?.extras
      })
      : null;
    const standaloneCantidad = standaloneExtra
      && Number.isFinite(standaloneExtra.cantidad) && standaloneExtra.cantidad > 0
      ? standaloneExtra.cantidad
      : null;

    return {
      linea: index + 1,
      id_detalle: Number(item?.id_detalle || 0) || null,
      tipo_item: standaloneExtra ? 'EXTRA' : String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
      id_producto: Number(item?.id_producto || 0) || null,
      id_receta: Number(item?.id_receta || 0) || null,
      cantidad: standaloneCantidad ?? (Number(item?.cantidad ?? 0) || 0),
      nombre_item: standaloneExtra
        ? standaloneExtra.nombre_extra_snapshot
        : String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
      observacion: String(item?.observacion || '').trim() || null,
      es_linea_extra_independiente: Boolean(standaloneExtra),
      id_extra: standaloneExtra?.id_extra || null,
      nombre_extra_snapshot: standaloneExtra?.nombre_extra_snapshot || null,
      codigo_extra_snapshot: standaloneExtra?.codigo_extra_snapshot || null,
      precio_unitario: standaloneExtra?.precio_unitario ?? null,
      subtotal: standaloneExtra?.subtotal ?? null,
      extras: standaloneExtra ? [] : toKitchenExtras(item?.extras),
      complementos: toKitchenComplementos(item),
      configuracion_menu: item?.configuracion_menu || null
    };
  });
  const routing = classifyKitchenPrintItems(normalizedItems);
  const items = normalizeStandaloneExtras && applyOperationalRouting && !routing.requiere_revision
    ? routing.items_operativos
    : normalizedItems;
  // El contador de productos excluye lineas de extra independiente para no
  // inflar el total (p. ej. 1 producto + 4 extras debe reportar 1, no 5).
  const totalProductos = items.reduce(
    (sum, item) => (
      item.tipo_item === 'EXTRA' || item.es_linea_extra_independiente
        ? sum
        : sum + Math.max(0, Number(item.cantidad || 0))
    ),
    0
  );

  return {
    id_factura: null,
    id_pedido: Number(row.id_pedido || 0) || null,
    numero_pedido: row.numero_pedido || null,
    numero_venta: row.numero_pedido || null,
    codigo_venta: row.numero_pedido || null,
    fecha_hora_pedido: row.fecha_hora_pedido || null,
    id_sucursal: Number(row.id_sucursal || 0) || null,
    nombre_sucursal: row.nombre_sucursal || null,
    id_usuario: Number(row.id_usuario_toma || row.id_usuario || 0) || null,
    nombre_usuario: row.usuario_toma || row.nombre_usuario_pedido || row.usuario_pedido || null,
    id_caja: Number(row.id_caja || 0) || null,
    nombre_caja: row.nombre_caja || row.codigo_caja || null,
    id_sesion_caja: Number(row.id_sesion_caja_origen || 0) || null,
    cliente_nombre: row.nombre_contacto || 'Consumidor final',
    contacto: {
      nombre_contacto: row.nombre_contacto || 'Consumidor final',
      telefono_contacto: row.telefono_contacto || null,
      telefono_normalizado: row.telefono_normalizado || null,
      dni: row.dni || null,
      rtn: row.rtn || null,
      correo: row.correo || null
    },
    contexto: {
      origen_pedido: row.origen_pedido || null,
      canal: row.canal_contexto || row.canal_pedido || null,
      modalidad: row.modalidad_contexto || row.tipo_entrega || null,
      observacion_contexto: row.observacion_contexto || null
    },
    modalidad: row.modalidad_contexto || row.tipo_entrega || null,
    canal: row.canal_contexto || row.canal_pedido || null,
    delivery: row.id_pedido_delivery ? {
      id_pedido_delivery: Number(row.id_pedido_delivery || 0) || null,
      estado_delivery: row.estado_delivery || null,
      costo_envio: Number(row.costo_envio || 0) || 0,
      nombre_receptor: row.nombre_receptor || null,
      telefono_receptor: row.telefono_receptor || null,
      direccion_entrega: row.direccion_entrega || null,
      referencia_entrega: row.referencia_entrega || null,
      observacion_delivery: row.observacion_delivery || null
    } : null,
    pago: {
      id_factura: Number(row.id_factura_pago || row.id_factura_existente || 0) || null,
      monto_total: Number(row.monto_total ?? row.total ?? 0) || 0,
      monto_pagado: Number(row.monto_pagado ?? 0) || 0,
      monto_pendiente: Number(row.monto_pendiente ?? row.total ?? 0) || 0
    },
    total_productos: totalProductos,
    requiere_cocina: routing.requiere_cocina,
    requiere_revision: routing.requiere_revision,
    lineas_invalidas: routing.lineas_invalidas,
    items
  };
};
