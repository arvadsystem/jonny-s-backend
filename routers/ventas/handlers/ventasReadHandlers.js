import pool from '../../../config/db-connection.js';
import { resolveRequestUserSucursalScope } from '../../../utils/sucursalScope.js';
import {
  VENTAS_HISTORY_ADMIN_ROLES,
  VENTAS_HISTORY_CAJERO_ROLE
} from '../constants.js';
import { roundMoney } from '../utils/moneyUtils.js';
import {
  normalizeRoleName,
  parseOptionalDateInput,
  parseOptionalPositiveInt
} from '../utils/parseUtils.js';

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
