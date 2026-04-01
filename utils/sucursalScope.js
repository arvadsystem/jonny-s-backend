import pool from '../config/db-connection.js';
import { isRequestUserSuperAdmin } from '../middleware/checkPermission.js';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const resolveRequestUserId = (req) => parsePositiveInt(req?.user?.id_usuario);

export const resolveRequestUserSucursalScope = async (req, queryRunner = pool) => {
  const idUsuario = resolveRequestUserId(req);
  if (!idUsuario) {
    return {
      idUsuario: null,
      isSuperAdmin: false,
      userSucursalId: null,
      allowedSucursalIds: []
    };
  }

  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  const sucursalResult = await queryRunner.query(
    `
      SELECT e.id_sucursal
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      WHERE u.id_usuario = $1
      LIMIT 1
    `,
    [idUsuario]
  );

  const userSucursalId = parsePositiveInt(sucursalResult.rows?.[0]?.id_sucursal);

  return {
    idUsuario,
    isSuperAdmin,
    userSucursalId,
    allowedSucursalIds: isSuperAdmin
      ? []
      : userSucursalId
        ? [userSucursalId]
        : []
  };
};
