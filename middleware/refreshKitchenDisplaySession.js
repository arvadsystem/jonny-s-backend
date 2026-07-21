import pool from '../config/db-connection.js';
import JWT_SECRET from '../config/jwt.js';
import { buildAuthRoleCompatFields } from '../utils/security/authTokenPayload.js';
import { buildAccessTokenCookieOptions } from '../utils/security/authCookieOptions.js';
import {
  KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS,
  KITCHEN_DISPLAY_REFRESH_MIN_AGE_SECONDS,
  hasKitchenDisplayRole,
  issueAccessToken
} from '../utils/security/accessTokenPolicy.js';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseSessionId = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized || null;
};

export const createRefreshKitchenDisplaySession = ({
  sessionPool = pool,
  tokenSecret = JWT_SECRET,
  nowSeconds = () => Math.floor(Date.now() / 1000)
} = {}) => async (req, res, next) => {
  const currentUser = req.user || req.usuario;

  if (!hasKitchenDisplayRole(
    currentUser?.roles,
    currentUser?.nombre_rol,
    currentUser?.rol
  )) {
    return next();
  }

  const idUsuario = parsePositiveInt(currentUser?.id_usuario);
  const sid = parseSessionId(currentUser?.sid);
  const issuedAt = Number(currentUser?.iat);
  const currentTime = nowSeconds();

  if (
    !idUsuario
    || !sid
    || !Number.isInteger(issuedAt)
    || issuedAt <= 0
    || currentTime - issuedAt < KITCHEN_DISPLAY_REFRESH_MIN_AGE_SECONDS
  ) {
    return next();
  }

  try {
    const result = await sessionPool.query(
      `
        SELECT
          u.id_usuario,
          u.nombre_usuario,
          u.estado AS usuario_activo,
          e.id_sucursal,
          sa.id_sesion,
          sa.activa AS sesion_activa,
          ARRAY_AGG(DISTINCT r.nombre ORDER BY r.nombre) AS roles
        FROM usuarios u
        INNER JOIN sesiones_activas sa
          ON sa.id_usuario = u.id_usuario
         AND sa.id_sesion = $2
        LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
        INNER JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
        INNER JOIN roles r ON r.id_rol = ru.id_rol
        WHERE u.id_usuario = $1
          AND u.estado IS TRUE
          AND sa.activa IS TRUE
        GROUP BY
          u.id_usuario,
          u.nombre_usuario,
          u.estado,
          e.id_sucursal,
          sa.id_sesion,
          sa.activa
        LIMIT 1
      `,
      [idUsuario, sid]
    );

    const sessionContext = result.rows?.[0] || null;
    const currentRoles = Array.isArray(sessionContext?.roles) ? sessionContext.roles : [];

    if (
      !sessionContext
      || sessionContext.usuario_activo !== true
      || sessionContext.sesion_activa !== true
      || Number(sessionContext.id_usuario) !== idUsuario
      || String(sessionContext.id_sesion) !== sid
      || !hasKitchenDisplayRole(currentRoles)
    ) {
      return next();
    }

    const roleFields = buildAuthRoleCompatFields(currentRoles, currentUser);
    const renewedPayload = {
      id_usuario: idUsuario,
      nombre_usuario: sessionContext.nombre_usuario || currentUser.nombre_usuario || null,
      id_sucursal: currentUser.id_sucursal ?? sessionContext.id_sucursal ?? null,
      sid,
      rol: roleFields.rol,
      nombre_rol: roleFields.nombre_rol,
      roles: roleFields.roles,
      must_change_password: Boolean(currentUser.must_change_password)
    };
    const renewedToken = issueAccessToken(renewedPayload, {
      ttlSeconds: KITCHEN_DISPLAY_ACCESS_TOKEN_TTL_SECONDS,
      secret: tokenSecret,
      issuedAtSeconds: currentTime
    });

    res.cookie('access_token', renewedToken.token, buildAccessTokenCookieOptions({
      maxAgeMs: renewedToken.cookieMaxAgeMs
    }));
    req.user = renewedToken.payload;

    return next();
  } catch (error) {
    console.error('refreshKitchenDisplaySession error:', error);
    return next();
  }
};

export const refreshKitchenDisplaySession = createRefreshKitchenDisplaySession();
