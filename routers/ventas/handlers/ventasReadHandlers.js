import pool from '../../../config/db-connection.js';
import {
  normalizarDatosTicketDesdeSnapshot
} from '../../../services/facturacionSnapshotService.js';
import {
  listFacturaReversiones
} from '../../../services/ventasReversionService.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import {
  VENTAS_HISTORY_ADMIN_ROLES,
  VENTAS_HISTORY_CAJERO_ROLE
} from '../constants.js';
import { roundMoney } from '../utils/moneyUtils.js';
import {
  normalizeRoleName,
  parseOptionalDateInput,
  parseOptionalPositiveInt,
  parsePositiveInt,
  resolveStandaloneExtraLine
} from '../utils/parseUtils.js';
import {
  buildDirectSaleDetailItems,
  buildKitchenSaleDetailItems,
  fetchCuentaDividida,
  fetchDetalleFacturaExtras,
  fetchDirectSaleDetailRows,
  fetchKitchenSaleDetailRows,
  fetchPedidoDeliveryDetail,
  fetchVentaDetailHeader,
  mergeVentaWithFacturacion,
  resolveVentaNumero
} from '../services/ventaDetalleReadService.js';
import {
  buildVentaTicketPdfBuffer,
  buildVentaTicketPdfFilename
} from '../services/ventaTicketPdfService.js';

const sendVentasInternalError = (
  res,
  message = 'No se pudo procesar la solicitud de ventas.'
) => res.status(500).json({ error: true, message });

const getRequestRoleSet = (req) =>
  new Set(
    (Array.isArray(req.user?.roles) ? req.user.roles : [])
      .map(normalizeRoleName)
      .filter(Boolean)
  );

const resolveVentasHistoryScope = async (req, queryRunner = pool) => {
  const baseScope = await resolveRequestUserSucursalScope(req, queryRunner);
  const roleSet = getRequestRoleSet(req);
  const isSuperAdmin = Boolean(baseScope.isSuperAdmin);
  const isAdminHistoryRole = [...roleSet].some((role) =>
    VENTAS_HISTORY_ADMIN_ROLES.has(role)
  );
  const isCajero = roleSet.has(VENTAS_HISTORY_CAJERO_ROLE);
  const limitedToLast72Hours = !isSuperAdmin && !isAdminHistoryRole;

  let allowedSucursalIds = [];
  if (isSuperAdmin) {
    const result = await queryRunner.query(
      `
        SELECT id_sucursal
        FROM public.sucursales
        WHERE COALESCE(estado, true) = true
        ORDER BY id_sucursal
      `
    );
    allowedSucursalIds = result.rows
      .map((row) => parseOptionalPositiveInt(row.id_sucursal))
      .filter(Boolean);
  } else {
    const empleadoSucursalId = parseOptionalPositiveInt(baseScope.userSucursalId);
    if (empleadoSucursalId) {
      allowedSucursalIds = [empleadoSucursalId];
    }
  }

  return {
    idUsuario: baseScope.idUsuario,
    roles: [...roleSet],
    isSuperAdmin,
    isAdminHistoryRole,
    isCajero,
    limitedToLast72Hours,
    allowedSucursalIds,
    userSucursalId: parseOptionalPositiveInt(baseScope.userSucursalId)
  };
};

export const buscarVentaHandler = async (req, res) => {
  try {
    const codigoVenta = String(req.query.codigo_venta || '').trim().toUpperCase();
    const fechaOperacion = parseOptionalDateInput(req.query.fecha_operacion);
    const idSucursalRequested = parseOptionalPositiveInt(req.query.id_sucursal);

    if (!codigoVenta) {
      return res.status(400).json({ error: true, message: 'Ingresa el código de venta.' });
    }
    if (!fechaOperacion || fechaOperacion === '__INVALID_DATE__') {
      return res.status(400).json({ error: true, message: 'Selecciona la fecha de operación.' });
    }

    const scope = await resolveVentasHistoryScope(req);
    if (!scope.allowedSucursalIds.length) {
      return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
    }

    let idSucursalEffective = null;
    if (scope.isSuperAdmin) {
      idSucursalEffective = idSucursalRequested;
      if (!idSucursalEffective) {
        return res.status(400).json({ error: true, message: 'Selecciona la sucursal.' });
      }
      if (!scope.allowedSucursalIds.includes(idSucursalEffective)) {
        return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
      }
    } else {
      idSucursalEffective = scope.userSucursalId;
      if (!idSucursalEffective) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursal asignada.' });
      }
      if (idSucursalRequested && idSucursalRequested !== idSucursalEffective) {
        return res.status(403).json({
          error: 'SUCURSAL_NO_AUTORIZADA',
          message: 'No tienes permiso para consultar ventas de esta sucursal.'
        });
      }
    }

    const result = await pool.query(
      `
        SELECT
          f.id_factura,
          COALESCE(NULLIF(TRIM(f.codigo_venta), ''), 'VTA-' || LPAD(f.id_factura::text, 5, '0')) AS codigo_venta,
          f.fecha_operacion::date AS fecha_operacion,
          f.id_sucursal,
          s.nombre_sucursal AS sucursal,
          COALESCE(
            NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
            emp.nombre_empresa,
            'Consumidor final'
          ) AS cliente,
          COALESCE(
            (
              SELECT SUM(COALESCE(df.total_detalle, 0))
              FROM detalle_facturas df
              WHERE df.id_factura = f.id_factura
            ),
            0
          )::numeric(12,2) AS total
        FROM facturas f
        LEFT JOIN sucursales s ON s.id_sucursal = f.id_sucursal
        LEFT JOIN clientes c ON c.id_cliente = f.id_cliente
        LEFT JOIN personas per ON per.id_persona = c.id_persona
        LEFT JOIN empresas emp ON emp.id_empresa = c.id_empresa
        WHERE UPPER(COALESCE(f.codigo_venta, '')) = $1
          AND f.fecha_operacion = $2::date
          AND f.id_sucursal = $3
        LIMIT 1
      `,
      [codigoVenta, fechaOperacion, idSucursalEffective]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: true,
        message: 'No se encontró una venta con ese código, fecha y sucursal.'
      });
    }

    const row = result.rows[0];
    return res.status(200).json({
      data: {
        id_factura: Number(row.id_factura),
        codigo_venta: row.codigo_venta,
        fecha_operacion: row.fecha_operacion,
        id_sucursal: Number(row.id_sucursal),
        sucursal: row.sucursal || `Sucursal ${row.id_sucursal}`,
        cliente: row.cliente || 'Consumidor final',
        total: roundMoney(row.total),
        items: []
      }
    });
  } catch (err) {
    console.error('Error en búsqueda exacta de ventas:', err);
    return sendVentasInternalError(res);
  }
};

const attachDetailExtras = (item, extras) => {
  const standaloneExtra = resolveStandaloneExtraLine({
    idProducto: item.id_producto,
    idReceta: item.id_receta,
    extras
  });

  return {
    ...item,
    tipo_item: standaloneExtra ? 'EXTRA' : item.tipo_item,
    nombre_item: standaloneExtra ? standaloneExtra.nombre_extra_snapshot : item.nombre_item,
    nombre_producto: standaloneExtra ? standaloneExtra.nombre_extra_snapshot : item.nombre_producto,
    es_linea_extra_independiente: Boolean(standaloneExtra),
    id_extra: standaloneExtra?.id_extra || null,
    nombre_extra_snapshot: standaloneExtra?.nombre_extra_snapshot || null,
    codigo_extra_snapshot: standaloneExtra?.codigo_extra_snapshot || null,
    extras
  };
};

export const buildVentaDetailPayloadForScope = async ({
  idFactura,
  includePrintAssets = false,
  allowedSucursalIds = [],
  limitedToLast72Hours = false,
  idUsuarioDetalle = null,
  queryRunner = pool
}) => {
  const normalizedSucursalIds = (Array.isArray(allowedSucursalIds) ? allowedSucursalIds : [])
    .map(parseOptionalPositiveInt)
    .filter(Boolean);
  if (!normalizedSucursalIds.length) {
    return {
      status: 403,
      body: { error: true, message: 'El empleado no tiene sucursales asignadas.' }
    };
  }

  const headerResult = await fetchVentaDetailHeader(queryRunner, {
    idFactura,
    limitedToLast72Hours,
    allowedSucursalIds: normalizedSucursalIds
  });
  if (headerResult.rowCount === 0) {
    return {
      status: 404,
      body: { error: true, message: 'Venta no encontrada.' }
    };
  }

  const venta = headerResult.rows[0];
  const facturacionNormalizada = await normalizarDatosTicketDesdeSnapshot({
    client: queryRunner,
    factura: venta,
    includePrintAssets
  });
  Object.assign(venta, mergeVentaWithFacturacion(venta, facturacionNormalizada));

  const normalizedUsuarioDetalle = parsePositiveInt(idUsuarioDetalle);
  const reversiones = normalizedUsuarioDetalle
    ? await listFacturaReversiones({
      idFactura: venta.id_factura,
      idUsuario: normalizedUsuarioDetalle
    })
    : [];

  if (venta.id_pedido) {
    const pedidoItemsResult = await fetchKitchenSaleDetailRows(queryRunner, venta.id_factura);
    const detalleFacturaExtrasById = await fetchDetalleFacturaExtras(
      queryRunner,
      pedidoItemsResult.rows.map((row) => row.id_detalle)
    );
    const pedidoItems = buildKitchenSaleDetailItems(pedidoItemsResult.rows).map((item) =>
      attachDetailExtras(item, detalleFacturaExtrasById.get(Number(item.id_detalle)) || []));
    const cuentaDividida = await fetchCuentaDividida(queryRunner, {
      idFactura: venta.id_factura,
      idPedido: venta.id_pedido
    });
    const pedidoDeliveryDetail = await fetchPedidoDeliveryDetail(queryRunner, venta.id_pedido);
    const delivery = pedidoDeliveryDetail.delivery;

    return {
      status: 200,
      body: {
        ...venta,
        cliente_nombre: pedidoDeliveryDetail.contacto?.nombre_contacto || venta.cliente_nombre || 'Consumidor final',
        numero_venta: resolveVentaNumero(venta),
        metodo_pago: venta.metodo_pago || null,
        items: pedidoItems,
        cuenta_dividida: cuentaDividida,
        contacto: pedidoDeliveryDetail.contacto,
        contexto: pedidoDeliveryDetail.contexto,
        es_delivery: Boolean(delivery),
        modalidad: pedidoDeliveryDetail.contexto?.modalidad || null,
        estado_delivery: delivery?.estado_delivery || null,
        costo_envio: delivery?.costo_envio ?? null,
        nombre_receptor: delivery?.nombre_receptor || null,
        telefono_receptor: delivery?.telefono_receptor || null,
        direccion_entrega: delivery?.direccion_entrega || null,
        referencia_entrega: delivery?.referencia_entrega || null,
        observacion_delivery: delivery?.observacion_delivery || null,
        delivery,
        reversiones
      }
    };
  }

  const directItemsResult = await fetchDirectSaleDetailRows(queryRunner, venta.id_factura);
  const detalleFacturaExtrasById = await fetchDetalleFacturaExtras(
    queryRunner,
    directItemsResult.rows.map((row) => row.id_detalle)
  );
  const directItems = buildDirectSaleDetailItems(directItemsResult.rows).map((item) =>
    attachDetailExtras(item, detalleFacturaExtrasById.get(Number(item.id_detalle)) || []));
  const cuentaDividida = await fetchCuentaDividida(queryRunner, {
    idFactura: venta.id_factura,
    idPedido: venta.id_pedido
  });

  return {
    status: 200,
    body: {
      ...venta,
      numero_venta: resolveVentaNumero(venta),
      metodo_pago: venta.metodo_pago || null,
      items: directItems,
      cuenta_dividida: cuentaDividida,
      reversiones
    }
  };
};

export const buildVentaDetailPayload = async (req, {
  idFactura,
  includePrintAssets = false
}) => {
  const scope = await resolveVentasHistoryScope(req);
  return buildVentaDetailPayloadForScope({
    idFactura,
    includePrintAssets,
    allowedSucursalIds: scope.allowedSucursalIds,
    limitedToLast72Hours: scope.limitedToLast72Hours,
    idUsuarioDetalle: req.user?.id_usuario,
    queryRunner: pool
  });
};

export const getVentaByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: false
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Error al obtener detalle de venta:', err);
    return sendVentasInternalError(res);
  }
};

export const getVentaTicketByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: true
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Error al obtener ticket de venta:', err);
    return sendVentasInternalError(res);
  }
};

export const getVentaTicketPdfByIdHandler = async (req, res) => {
  try {
    const idFactura = parsePositiveInt(req.params.id);
    if (!idFactura) {
      return res.status(400).json({ error: true, message: 'ID de venta invalido.' });
    }

    const result = await buildVentaDetailPayload(req, {
      idFactura,
      includePrintAssets: true
    });
    if (result.status !== 200) {
      return res.status(result.status).json(result.body);
    }

    const pdfBuffer = await buildVentaTicketPdfBuffer(result.body);
    const filename = buildVentaTicketPdfFilename(result.body);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('Error al generar PDF de ticket de venta:', err);
    return sendVentasInternalError(res, 'No se pudo generar el PDF del ticket.');
  }
};
