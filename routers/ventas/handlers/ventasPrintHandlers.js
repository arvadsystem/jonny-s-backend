import pool from '../../../config/db-connection.js';
import {
  ImpresorasConfigSucursalService,
  obtenerConfiguracionImpresorasRuntime,
  registrarDeteccionImpresorasPorCaja
} from '../../../services/impresorasConfigSucursalService.js';
import { buildVentaDetailPayload } from './ventasReadHandlers.js';
import {
  normalizePrintEventPayload,
  registerVentaPrintEvent
} from '../services/ventasPrintAuditService.js';
import {
  getQzCertificateText,
  hasQzSigningConfigured,
  getQzPublicErrorMessage,
  isQzConfigurationError,
  signQzMessage
} from '../services/qzTraySigningService.js';
import { parsePositiveInt } from '../utils/parseUtils.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';

const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de impresion.'
) => res.status(500).json({ error: true, message });

const schemaLookupCache = new Map();

const hasTable = async (client, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (schemaLookupCache.has(key)) return schemaLookupCache.get(key);

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
  schemaLookupCache.set(key, exists);
  return exists;
};

const hasColumn = async (client, tableName, columnName) => {
  const key = `${String(tableName || '').trim().toLowerCase()}.${String(columnName || '').trim().toLowerCase()}`;
  if (schemaLookupCache.has(key)) return schemaLookupCache.get(key);

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
  schemaLookupCache.set(key, exists);
  return exists;
};

const DETECTION_ORIGIN_MAX_LENGTH = 60;

const normalizeRoleSet = (roles = []) =>
  new Set(
    (Array.isArray(roles) ? roles : [])
      .map((role) => String(role || '').trim().replace(/[\s-]+/g, '_').toUpperCase())
      .filter(Boolean)
  );

const normalizeDetectionOrigin = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return 'MANUAL';
  return normalized.slice(0, DETECTION_ORIGIN_MAX_LENGTH);
};

const normalizeDetectedPrintersPayload = (value) => {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'impresoras_detectadas debe ser un arreglo.' };
  }

  const unique = new Map();
  for (const rawItem of value) {
    const normalized = String(rawItem || '').trim();
    if (!normalized) continue;
    if (normalized.length > 160) {
      return { ok: false, message: 'El nombre de una impresora detectada excede 160 caracteres.' };
    }
    const token = normalized.toLowerCase();
    if (!unique.has(token)) unique.set(token, normalized);
  }

  return { ok: true, value: [...unique.values()] };
};

const validateDeviceDetectionSessionScope = async ({
  client,
  req,
  idSucursal,
  idCaja,
  idSesionCaja
}) => {
  const scope = await resolveRequestUserSucursalScope(req, client);
  const roleSet = normalizeRoleSet(req.user?.roles);
  const isSuperAdmin = Boolean(scope.isSuperAdmin || roleSet.has('SUPER_ADMIN'));
  const actorUserId = Number(req.user?.id_usuario || 0) || null;

  if (!actorUserId) {
    throw new ImpresorasConfigSucursalService.ServiceError('Sesion invalida.', 401);
  }

  if (!isSuperAdmin && !scope.allowedSucursalIds.includes(idSucursal)) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'No tienes permiso para operar esta sucursal.',
      403
    );
  }

  const sessionResult = await client.query(
    `
      SELECT
        cs.id_sesion_caja,
        cs.id_caja,
        cs.id_sucursal,
        cs.id_usuario_responsable,
        cs.fecha_cierre,
        c.estado AS caja_activa,
        UPPER(TRIM(st.codigo)) AS estado_codigo,
        EXISTS (
          SELECT 1
          FROM public.cajas_sesiones_participantes csp
          WHERE csp.id_sesion_caja = cs.id_sesion_caja
            AND csp.id_usuario = $4
            AND COALESCE(csp.activo, true) = true
        ) AS actor_participa
      FROM public.cajas_sesiones cs
      INNER JOIN public.cajas c
        ON c.id_caja = cs.id_caja
      INNER JOIN public.cat_cajas_sesiones_estados st
        ON st.id_estado_sesion_caja = cs.id_estado_sesion_caja
      WHERE cs.id_sesion_caja = $1
        AND cs.id_caja = $2
        AND cs.id_sucursal = $3
      LIMIT 1
    `,
    [idSesionCaja, idCaja, idSucursal, actorUserId]
  );

  if (sessionResult.rowCount === 0) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La sesion de caja no coincide con la caja y sucursal enviadas.',
      409
    );
  }

  const session = sessionResult.rows[0];
  const isOpen = session.estado_codigo === 'ABIERTA' && !session.fecha_cierre;
  if (!isOpen) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La sesion de caja no esta abierta.',
      409
    );
  }
  if (session.caja_activa === false) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'La caja indicada no esta activa.',
      409
    );
  }

  const actorCanOperate = isSuperAdmin
    || Number(session.id_usuario_responsable || 0) === actorUserId
    || Boolean(session.actor_participa);
  if (!actorCanOperate) {
    throw new ImpresorasConfigSucursalService.ServiceError(
      'No participas en la sesion de caja indicada.',
      403
    );
  }

  return {
    actorUserId,
    isSuperAdmin
  };
};

const toKitchenExtras = (extras = []) =>
  (Array.isArray(extras) ? extras : []).map((extra) => ({
    id_extra: Number(extra?.id_extra || 0) || null,
    nombre: String(extra?.nombre || extra?.nombre_extra || 'Extra').trim(),
    cantidad: Number(extra?.cantidad_por_orden ?? extra?.origen_snapshot?.cantidad_por_orden ?? extra?.cantidad ?? 0) || 0,
    cantidad_total: Number(extra?.cantidad_total ?? extra?.origen_snapshot?.cantidad_total ?? extra?.cantidad ?? 0) || 0
  }));

const toKitchenComplementos = (item = {}) => {
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

const buildVentaKitchenPrintPayload = (venta = {}, printerConfig = null) => {
  const cocinaConfig = (Array.isArray(printerConfig?.impresoras) ? printerConfig.impresoras : [])
    .find((item) => String(item?.tipo_impresora || '').trim().toUpperCase() === 'COCINA');

  const items = (Array.isArray(venta?.items) ? venta.items : []).map((item, index) => {
    const isStandaloneExtra = Boolean(
      item?.es_linea_extra_independiente || item?.origen_snapshot?.es_linea_extra_independiente
    );

    return {
      linea: index + 1,
      id_detalle: Number(item?.id_detalle || 0) || null,
      tipo_item: String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
      cantidad: Number(item?.cantidad ?? 0) || 0,
      nombre_item: String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
      observacion: String(item?.observacion || '').trim() || null,
      es_linea_extra_independiente: isStandaloneExtra,
      extras: isStandaloneExtra ? [] : toKitchenExtras(item?.extras),
      complementos: toKitchenComplementos(item)
    };
  });

  const totalProductos = items.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad || 0)), 0);

  return {
    id_factura: Number(venta?.id_factura || 0) || null,
    id_pedido: Number(venta?.id_pedido || 0) || null,
    numero_venta: venta?.numero_venta || venta?.codigo_venta || null,
    numero_pedido: venta?.numero_venta || venta?.codigo_venta || null,
    fecha_hora_pedido: venta?.fecha_hora_pedido || venta?.fecha_hora_facturacion || null,
    fecha_hora_facturacion: venta?.fecha_hora_facturacion || venta?.fecha_hora_pedido || null,
    id_sucursal: Number(venta?.id_sucursal || 0) || null,
    nombre_sucursal: venta?.nombre_sucursal || null,
    id_usuario: Number(venta?.id_usuario || 0) || null,
    nombre_usuario: venta?.nombre_usuario || null,
    id_caja: Number(venta?.id_caja || 0) || null,
    nombre_caja: venta?.nombre_caja || venta?.codigo_caja || null,
    cliente_nombre: venta?.contacto?.nombre_contacto || venta?.cliente_nombre || null,
    modalidad: venta?.modalidad || venta?.contexto?.modalidad || null,
    canal: venta?.contexto?.canal || null,
    contacto: venta?.contacto || null,
    delivery: venta?.delivery || null,
    total_productos: totalProductos,
    items,
    print_config: {
      printMode: cocinaConfig?.modo_impresion || 'BROWSER',
      printerType: 'COCINA',
      logicalPrinterName: 'COCINA',
      systemPrinterName: cocinaConfig?.nombre_impresora_sistema || null,
      width_mm: Number(cocinaConfig?.ancho_mm) === 58 ? 58 : 80,
      id_impresora: Number(cocinaConfig?.id_impresora || 0) || null,
      ip_impresora: cocinaConfig?.ip_impresora || null,
      puerto_impresora: Number(cocinaConfig?.puerto_impresora || 0) || 9100
    }
  };
};

const buildPedidoKitchenPrintPayload = async (client, idPedido) => {
  const hasDetallePedidoConfiguracionMenu = await hasColumn(client, 'detalle_pedido', 'configuracion_menu');
  const hasDetallePedidoExtras = await hasTable(client, 'detalle_pedido_extras');
  const hasPedidosContacto = await hasTable(client, 'pedidos_contacto');
  const hasPedidosContexto = await hasTable(client, 'pedidos_contexto');
  const hasPedidosDelivery = await hasTable(client, 'pedidos_delivery');
  const hasPedidosPagoControl = await hasTable(client, 'pedidos_pago_control');

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

  const result = await client.query(
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
        COALESCE(dp_info.items, '[]'::jsonb) AS items
      FROM public.pedidos p
      LEFT JOIN public.sucursales s ON s.id_sucursal = p.id_sucursal
      LEFT JOIN public.usuarios u ON u.id_usuario = p.id_usuario
      ${contactoJoin}
      ${contextoJoin}
      ${deliveryJoin}
      ${pagoControlJoin}
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
  const items = (Array.isArray(row.items) ? row.items : []).map((item, index) => ({
    linea: index + 1,
    id_detalle: Number(item?.id_detalle || 0) || null,
    tipo_item: String(item?.tipo_item || 'ITEM').trim().toUpperCase(),
    cantidad: Number(item?.cantidad ?? 0) || 0,
    nombre_item: String(item?.nombre_item || item?.nombre_producto || 'Item de cocina').trim(),
    observacion: String(item?.observacion || '').trim() || null,
    extras: toKitchenExtras(item?.extras),
    complementos: toKitchenComplementos(item),
    configuracion_menu: item?.configuracion_menu || null
  }));
  const totalProductos = items.reduce((sum, item) => sum + Math.max(0, Number(item.cantidad || 0)), 0);

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
      monto_total: Number(row.monto_total ?? row.total ?? 0) || 0,
      monto_pagado: Number(row.monto_pagado ?? 0) || 0,
      monto_pendiente: Number(row.monto_pendiente ?? row.total ?? 0) || 0
    },
    total_productos: totalProductos,
    items
  };
};

export const getVentasPrinterConfigHandler = async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.query?.id_sucursal);
    const idCaja = parsePositiveInt(req.query?.id_caja);
    if (!idSucursal) {
      return res.status(400).json({ error: true, message: 'id_sucursal es obligatorio.' });
    }

    const data = await obtenerConfiguracionImpresorasRuntime({
      idSucursal,
      idCaja
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('Error al obtener configuracion runtime de impresoras:', error);
    return sendVentasInternalError(res, 'No se pudo obtener la configuracion de impresion.');
  }
};

export const createVentasPrinterDeviceDetectionHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    const idSucursal = parsePositiveInt(req.body?.id_sucursal);
    const idCaja = parsePositiveInt(req.body?.id_caja);
    const idSesionCaja = parsePositiveInt(req.body?.id_sesion_caja);
    const normalizedPrinters = normalizeDetectedPrintersPayload(req.body?.impresoras_detectadas);

    if (!idSucursal || !idCaja || !idSesionCaja) {
      return res.status(400).json({
        error: true,
        message: 'id_sucursal, id_caja e id_sesion_caja son obligatorios.'
      });
    }
    if (!normalizedPrinters.ok) {
      return res.status(400).json({ error: true, message: normalizedPrinters.message });
    }

    await validateDeviceDetectionSessionScope({
      client,
      req,
      idSucursal,
      idCaja,
      idSesionCaja
    });

    const result = await registrarDeteccionImpresorasPorCaja({
      idSucursal,
      idCaja,
      impresorasDetectadas: normalizedPrinters.value,
      db: client
    });

    const statusCode = result.status === 'NO_DETECTADO' ? 200 : 200;
    return res.status(statusCode).json({
      ok: true,
      status: result.status,
      origen: normalizeDetectionOrigin(req.body?.origen),
      id_sucursal: idSucursal,
      id_caja: idCaja,
      id_sesion_caja: idSesionCaja,
      impresoras_detectadas: result.detected_printers,
      summary: result.summary,
      assignments: result.assignments,
      runtime: result.runtime
    });
  } catch (error) {
    if (error instanceof ImpresorasConfigSucursalService.ServiceError) {
      return res.status(error.status || 500).json({
        error: true,
        message: error.message,
        details: error.details || null
      });
    }
    console.error('Error al registrar deteccion operativa de impresoras:', error);
    return sendVentasInternalError(res, 'No se pudo validar la deteccion de impresoras.');
  } finally {
    client.release();
  }
};

export const getQzCertificateHandler = async (_req, res) => {
  try {
    const certificate = await getQzCertificateText();

    return res.status(200).json({
      ok: true,
      configured: await hasQzSigningConfigured(),
      certificate
    });
  } catch (error) {
    if (isQzConfigurationError(error)) {
      console.warn('[ventas.qz.certificate] configuracion no disponible', {
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        configured: false
      });
      return res.status(503).json({
        error: true,
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        message: getQzPublicErrorMessage()
      });
    }

    console.error('[ventas.qz.certificate] error inesperado', {
      code: error?.code || null,
      message: error?.message || 'Error sin mensaje'
    });
    return sendVentasInternalError(res, 'No se pudo obtener el certificado de impresion.');
  }
};

export const signQzRequestHandler = async (req, res) => {
  try {
    const request = typeof req.body?.request === 'string' ? req.body.request : '';
    if (request.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'QZ_SIGN_REQUEST_INVALID',
        message: 'request es obligatorio.'
      });
    }

    const signature = await signQzMessage(request);
    return res.status(200).json({ ok: true, signature });
  } catch (error) {
    if (isQzConfigurationError(error)) {
      console.warn('[ventas.qz.sign] configuracion no disponible', {
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        configured: false
      });
      return res.status(503).json({
        error: true,
        code: error?.code || 'QZ_SIGNING_NOT_CONFIGURED',
        message: getQzPublicErrorMessage()
      });
    }
    if (error?.code === 'QZ_SIGN_REQUEST_INVALID') {
      return res.status(400).json({
        error: true,
        code: error.code,
        message: 'request es obligatorio.'
      });
    }

    console.error('[ventas.qz.sign] error inesperado', {
      code: error?.code || null,
      message: error?.message || 'Error sin mensaje'
    });
    return sendVentasInternalError(res, 'No se pudo firmar la solicitud de impresion.');
  }
};

export const getVentaKitchenComandaByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (result.status !== 200) {
      return res.status(result.status).json(result.body);
    }

    const printerConfig = await obtenerConfiguracionImpresorasRuntime({
      idSucursal: result.body?.id_sucursal,
      idCaja: result.body?.id_caja
    }).catch(() => null);

    return res.status(200).json(buildVentaKitchenPrintPayload(result.body, printerConfig));
  } catch (error) {
    console.error('Error al obtener comanda de cocina:', error);
    return sendVentasInternalError(res, 'No se pudo generar la comanda de cocina.');
  }
};

export const getPedidoKitchenComandaByIdHandler = async (req, res) => {
  const client = await pool.connect();
  try {
    const idPedido = parsePositiveInt(req.params.id);
    if (!idPedido) {
      return res.status(400).json({ error: true, message: 'ID de pedido invalido.' });
    }

    const pedidoComanda = await buildPedidoKitchenPrintPayload(client, idPedido);
    if (!pedidoComanda) {
      return res.status(404).json({ error: true, message: 'Pedido no encontrado.' });
    }

    const printerConfig = await obtenerConfiguracionImpresorasRuntime({
      idSucursal: pedidoComanda.id_sucursal,
      idCaja: pedidoComanda.id_caja
    }).catch(() => null);

    return res.status(200).json(buildVentaKitchenPrintPayload(pedidoComanda, printerConfig));
  } catch (error) {
    console.error('Error al obtener comanda de cocina por pedido:', error);
    return sendVentasInternalError(res, 'No se pudo generar la comanda de cocina del pedido.');
  } finally {
    client.release();
  }
};

export const createVentaPrintEventHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const normalized = normalizePrintEventPayload(req.body);
    if (!normalized.ok) {
      return res.status(400).json({ error: true, message: normalized.message });
    }

    const detailResult = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    if (detailResult.status !== 200) {
      return res.status(detailResult.status).json(detailResult.body);
    }

    const auditResult = await registerVentaPrintEvent({
      client: pool,
      idFactura,
      idPedido: detailResult.body?.id_pedido || null,
      idUsuario: req.user?.id_usuario || null,
      idSucursal: detailResult.body?.id_sucursal || null,
      payload: normalized.value
    });

    return res.status(200).json({
      ok: true,
      ...auditResult
    });
  } catch (error) {
    console.error('Error al registrar auditoria de impresion:', error);
    return sendVentasInternalError(res, 'No se pudo registrar el evento de impresion.');
  }
};
