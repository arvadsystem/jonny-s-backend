import pool from '../config/db-connection.js';
import { isRequestUserSuperAdmin } from '../middleware/checkPermission.js';

const SHOULD_INCLUDE_ERROR_STACK = ['development', 'dev', 'local'].includes(
  String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase()
);

const truncateLogValue = (value, maxLength = 240) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
};

const sanitizeErrorForLog = (error) => {
  const payload = {
    name: truncateLogValue(error?.name || 'Error', 120) || 'Error',
    code: truncateLogValue(error?.code || '', 80) || null,
    message: truncateLogValue(error?.message || 'Unexpected error', 260) || 'Unexpected error'
  };

  if (SHOULD_INCLUDE_ERROR_STACK && typeof error?.stack === 'string') {
    payload.stack = truncateLogValue(
      error.stack
        .split('\n')
        .slice(0, 5)
        .join('\n'),
      900
    );
  }

  return payload;
};

const logScopeWarning = (context, error) => {
  console.warn('[sucursalScope] warning', {
    context: truncateLogValue(context || 'Unhandled context', 160) || 'Unhandled context',
    ...sanitizeErrorForLog(error)
  });
};

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

  const isSuperAdmin = await isRequestUserSuperAdmin(req, queryRunner);
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

  const allowedIds = new Set();
  if (userSucursalId) {
    allowedIds.add(userSucursalId);
  }

  if (!isSuperAdmin) {
    const candidateQueries = [
      {
        sql: `
          SELECT vus.id_sucursal, vus.es_principal
          FROM public.v_usuarios_sucursales_scope vus
          WHERE vus.id_usuario = $1
            AND COALESCE(vus.estado, true) = true
        `,
        params: [idUsuario]
      },
      {
        sql: `
          SELECT es.id_sucursal, es.es_principal
          FROM public.usuarios u
          INNER JOIN public.empleados_sucursales es
            ON es.id_empleado = u.id_empleado
          WHERE u.id_usuario = $1
            AND COALESCE(es.estado, true) = true
        `,
        params: [idUsuario]
      },
      {
        sql: `
          SELECT us.id_sucursal, true AS es_principal
          FROM public.usuarios_sucursales us
          WHERE us.id_usuario = $1
        `,
        params: [idUsuario]
      }
    ];

    for (const candidate of candidateQueries) {
      try {
        const resultExtra = await queryRunner.query(candidate.sql, candidate.params);
        if (resultExtra.rowCount === 0) continue;

        for (const row of resultExtra.rows) {
          const parsedId = parsePositiveInt(row.id_sucursal);
          if (parsedId) allowedIds.add(parsedId);
        }

        break;
      } catch (err) {
        if (!['42P01', '42703'].includes(err.code)) {
          console.error('resolveRequestUserSucursalScope error:', err);
        }
      }
    }
  }

  return {
    idUsuario,
    isSuperAdmin,
    userSucursalId,
    allowedSucursalIds: isSuperAdmin ? [] : Array.from(allowedIds)
  };
};
