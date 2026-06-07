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
  parsePositiveInt
} from '../utils/parseUtils.js';
import {
  buildDirectSaleDetailItems,
  buildKitchenSaleDetailItems,
  fetchCuentaDividida,
  fetchDetalleFacturaExtras,
  fetchDirectSaleDetailRows,
  fetchKitchenSaleDetailRows,
  fetchVentaDetailHeader,
  mergeVentaWithFacturacion,
  resolveVentaNumero
} from '../services/ventaDetalleReadService.js';

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

const buildVentaDetailPayload = async (req, {
  idFactura,
  includePrintAssets = false
}) => {
  const scope = await resolveVentasHistoryScope(req);
  if (!scope.allowedSucursalIds.length) {
    return {
      status: 403,
      body: { error: true, message: 'El empleado no tiene sucursales asignadas.' }
    };
  }

  const headerResult = await fetchVentaDetailHeader(pool, {
    idFactura,
    limitedToLast72Hours: scope.limitedToLast72Hours,
    allowedSucursalIds: scope.allowedSucursalIds
  });
  if (headerResult.rowCount === 0) {
    return {
      status: 404,
      body: { error: true, message: 'Venta no encontrada.' }
    };
  }

  const venta = headerResult.rows[0];
  const facturacionNormalizada = await normalizarDatosTicketDesdeSnapshot({
    client: pool,
    factura: venta,
    includePrintAssets
  });
  Object.assign(venta, mergeVentaWithFacturacion(venta, facturacionNormalizada));

  const idUsuarioDetalle = parsePositiveInt(req.user?.id_usuario);
  const reversiones = idUsuarioDetalle
    ? await listFacturaReversiones({
      idFactura: venta.id_factura,
      idUsuario: idUsuarioDetalle
    })
    : [];

  if (venta.id_pedido) {
    const pedidoItemsResult = await fetchKitchenSaleDetailRows(pool, venta.id_factura);
    const detalleFacturaExtrasById = await fetchDetalleFacturaExtras(
      pool,
      pedidoItemsResult.rows.map((row) => row.id_detalle)
    );
    const pedidoItems = buildKitchenSaleDetailItems(pedidoItemsResult.rows).map((item) => ({
      ...item,
      extras: detalleFacturaExtrasById.get(Number(item.id_detalle)) || []
    }));
    const cuentaDividida = await fetchCuentaDividida(pool, {
      idFactura: venta.id_factura,
      idPedido: venta.id_pedido
    });

    return {
      status: 200,
      body: {
        ...venta,
        numero_venta: resolveVentaNumero(venta),
        metodo_pago: venta.metodo_pago || null,
        items: pedidoItems,
        cuenta_dividida: cuentaDividida,
        reversiones
      }
    };
  }

  const directItemsResult = await fetchDirectSaleDetailRows(pool, venta.id_factura);
  const detalleFacturaExtrasById = await fetchDetalleFacturaExtras(
    pool,
    directItemsResult.rows.map((row) => row.id_detalle)
  );
  const directItems = buildDirectSaleDetailItems(directItemsResult.rows).map((item) => ({
    ...item,
    extras: detalleFacturaExtrasById.get(Number(item.id_detalle)) || []
  }));
  const cuentaDividida = await fetchCuentaDividida(pool, {
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
