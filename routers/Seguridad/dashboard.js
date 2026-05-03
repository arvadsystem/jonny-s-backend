/**
 * routers/Seguridad/dashboard.js
 * HU161: Dashboard de monitoreo en seguridad (resumen consolidado).
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { checkPermission, isRequestUserSuperAdmin } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from '../../utils/dates.js';
import { closeInactiveSessions } from '../../utils/security/sessionService.js';
import { securityReadLimiter } from './securityRateLimit.js';

const router = express.Router();

const PERMISOS_DASHBOARD_VER = [
  'SEGURIDAD_VER',
  'SEGURIDAD_SESIONES_VER_GLOBAL',
  'SEGURIDAD_USUARIOS_AUDITORIA_VER'
];

const SUPPORTED_RANGES = Object.freeze({
  '24h': Object.freeze({
    key: '24h',
    label: '24 horas',
    rangeStartSql: "date_trunc('day', timezone('America/Tegucigalpa', now()))",
    bucketStepSql: "INTERVAL '1 hour'",
    bucketTrunc: 'hour',
    bucketLabelSql: "TO_CHAR(bucket_start, 'HH24:MI')"
  }),
  '7d': Object.freeze({
    key: '7d',
    label: '7 dias',
    rangeStartSql: "timezone('America/Tegucigalpa', now()) - INTERVAL '7 days'",
    bucketStepSql: "INTERVAL '1 day'",
    bucketTrunc: 'day',
    bucketLabelSql: "TO_CHAR(bucket_start, 'DD/MM')"
  }),
  '30d': Object.freeze({
    key: '30d',
    label: '30 dias',
    rangeStartSql: "timezone('America/Tegucigalpa', now()) - INTERVAL '30 days'",
    bucketStepSql: "INTERVAL '1 day'",
    bucketTrunc: 'day',
    bucketLabelSql: "TO_CHAR(bucket_start, 'DD/MM')"
  })
});

const DEFAULT_RANGE = '24h';
const RECENT_ACTIVITY_LIMIT = 5;
const TOP_IPS_LIMIT = 5;
const BLOCKED_USERS_LIMIT = 5;
const SUSPICIOUS_USERS_LIMIT = 5;
const SUSPICIOUS_MIN_CONSECUTIVE_FAILS = 3;

const SEMAFORO_THRESHOLDS = Object.freeze({
  logins_fallidos: Object.freeze({ amarillo: 15, rojo: 35 }),
  usuarios_bloqueados: Object.freeze({ amarillo: 5, rojo: 12 }),
  usuarios_sospechosos: Object.freeze({ amarillo: 2, rojo: 5 })
});

const parseRange = (raw) => {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (SUPPORTED_RANGES[normalized]) return normalized;
  return DEFAULT_RANGE;
};

const toSafeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const resolveSemaforo = (value, thresholds) => {
  const current = toSafeInt(value);
  const amarillo = toSafeInt(thresholds?.amarillo);
  const rojo = toSafeInt(thresholds?.rojo);

  if (current >= rojo) {
    return {
      valor: current,
      estado: 'rojo',
      umbral_amarillo: amarillo,
      umbral_rojo: rojo
    };
  }

  if (current >= amarillo) {
    return {
      valor: current,
      estado: 'amarillo',
      umbral_amarillo: amarillo,
      umbral_rojo: rojo
    };
  }

  return {
    valor: current,
    estado: 'verde',
    umbral_amarillo: amarillo,
    umbral_rojo: rojo
  };
};

const requireSuperAdmin = async (req, res) => {
  const isSuperAdmin = await isRequestUserSuperAdmin(req);
  if (!isSuperAdmin) {
    res.status(403).json({ error: true, message: 'Acceso denegado: solo Super Admin' });
    return false;
  }
  return true;
};

const hasBitacorasTable = async () => {
  const result = await pool.query(`SELECT to_regclass('public.bitacoras') AS reg`);
  return Boolean(result.rows?.[0]?.reg);
};

const buildLoginsSeriesSql = (rangeConfig) => `
  WITH buckets AS (
    SELECT
      gs AS bucket_start,
      gs + ${rangeConfig.bucketStepSql} AS bucket_end
    FROM generate_series(
      date_trunc('${rangeConfig.bucketTrunc}', $1::timestamp),
      date_trunc('${rangeConfig.bucketTrunc}', $2::timestamp),
      ${rangeConfig.bucketStepSql}
    ) AS gs
  )
  SELECT
    ${rangeConfig.bucketLabelSql} AS bucket_label,
    bucket_start,
    bucket_end,
    COALESCE(COUNT(l.id_login), 0)::int AS total
  FROM buckets
  LEFT JOIN logins l
    ON l.fecha_hora >= buckets.bucket_start
   AND l.fecha_hora < buckets.bucket_end
   AND (l.exito = FALSE OR l.exito IS NULL)
  GROUP BY bucket_start, bucket_end
  ORDER BY bucket_start ASC
`;

const buildSesionesSeriesSql = (rangeConfig) => `
  WITH buckets AS (
    SELECT
      gs AS bucket_start,
      gs + ${rangeConfig.bucketStepSql} AS bucket_end
    FROM generate_series(
      date_trunc('${rangeConfig.bucketTrunc}', $1::timestamp),
      date_trunc('${rangeConfig.bucketTrunc}', $2::timestamp),
      ${rangeConfig.bucketStepSql}
    ) AS gs
  )
  SELECT
    ${rangeConfig.bucketLabelSql} AS bucket_label,
    bucket_start,
    bucket_end,
    (
      SELECT COUNT(*)::int
      FROM sesiones_activas sa
      WHERE sa.fecha_inicio <= buckets.bucket_end
        AND (
          sa.activa = TRUE
          OR sa.fecha_cierre IS NULL
          OR sa.fecha_cierre > buckets.bucket_end
        )
    ) AS total
  FROM buckets
  ORDER BY bucket_start ASC
`;

const SUMMARY_SQL = `
  SELECT
    (
      SELECT COUNT(*)::int
      FROM logins l
      WHERE (l.exito = FALSE OR l.exito IS NULL)
        AND l.fecha_hora >= $1::timestamp
    ) AS logins_fallidos,
    (
      SELECT COUNT(*)::int
      FROM usuarios u
      WHERE COALESCE(u.estado, FALSE) = FALSE
    ) AS usuarios_bloqueados,
    (
      SELECT COUNT(*)::int
      FROM sesiones_activas sa
      WHERE sa.activa = TRUE
    ) AS sesiones_activas_totales
`;

const TOP_IPS_SQL = `
  SELECT
    COALESCE(NULLIF(TRIM(l.ip_origen), ''), 'IP no registrada') AS ip_origen,
    COUNT(*)::int AS total_fallos
  FROM logins l
  WHERE (l.exito = FALSE OR l.exito IS NULL)
    AND l.fecha_hora >= $1::timestamp
  GROUP BY 1
  ORDER BY total_fallos DESC, ip_origen ASC
  LIMIT $2
`;

const BLOCKED_USERS_SQL = `
  SELECT
    u.id_usuario,
    u.nombre_usuario,
    NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') AS nombre_completo,
    COALESCE(STRING_AGG(DISTINCT r.nombre, ', '), 'N/D') AS rol,
    COALESCE(fr.fallos_en_rango, 0)::int AS fallos_en_rango,
    COALESCE(sc.sesiones_activas, 0)::int AS sesiones_activas,
    la.ultimo_acceso
  FROM usuarios u
  LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
  LEFT JOIN personas p ON p.id_persona = e.id_persona
  LEFT JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
  LEFT JOIN roles r ON r.id_rol = ru.id_rol
  LEFT JOIN (
    SELECT
      l.id_usuario,
      COUNT(*)::int AS fallos_en_rango
    FROM logins l
    WHERE (l.exito = FALSE OR l.exito IS NULL)
      AND l.fecha_hora >= $1::timestamp
      AND l.id_usuario IS NOT NULL
    GROUP BY l.id_usuario
  ) fr ON fr.id_usuario = u.id_usuario
  LEFT JOIN (
    SELECT
      sa.id_usuario,
      COUNT(*)::int AS sesiones_activas
    FROM sesiones_activas sa
    WHERE sa.activa = TRUE
    GROUP BY sa.id_usuario
  ) sc ON sc.id_usuario = u.id_usuario
  LEFT JOIN (
    SELECT
      l.id_usuario,
      MAX(l.fecha_hora) AS ultimo_acceso
    FROM logins l
    WHERE l.exito = TRUE
      AND l.id_usuario IS NOT NULL
    GROUP BY l.id_usuario
  ) la ON la.id_usuario = u.id_usuario
  WHERE COALESCE(u.estado, FALSE) = FALSE
  GROUP BY
    u.id_usuario,
    u.nombre_usuario,
    p.nombre,
    p.apellido,
    fr.fallos_en_rango,
    sc.sesiones_activas,
    la.ultimo_acceso
  ORDER BY
    fr.fallos_en_rango DESC,
    la.ultimo_acceso DESC NULLS LAST,
    u.id_usuario ASC
  LIMIT $2
`;

const SUSPICIOUS_USERS_SQL = `
  WITH ranked AS (
    SELECT
      l.id_login,
      l.id_usuario,
      l.fecha_hora,
      COALESCE(l.exito, FALSE) AS exito,
      COALESCE(NULLIF(TRIM(l.ip_origen), ''), 'IP no registrada') AS ip_origen,
      ROW_NUMBER() OVER (
        PARTITION BY l.id_usuario
        ORDER BY l.fecha_hora DESC, l.id_login DESC
      ) AS rn
    FROM logins l
    WHERE l.id_usuario IS NOT NULL
      AND l.fecha_hora >= $1::timestamp
  ),
  first_success AS (
    SELECT
      r.id_usuario,
      MIN(r.rn) FILTER (WHERE r.exito = TRUE) AS first_success_rn
    FROM ranked r
    GROUP BY r.id_usuario
  ),
  fails_range AS (
    SELECT
      r.id_usuario,
      COUNT(*)::int AS fallos_en_rango
    FROM ranked r
    WHERE r.exito = FALSE
    GROUP BY r.id_usuario
  ),
  consecutive AS (
    SELECT
      r.id_usuario,
      COUNT(*)::int AS fallos_consecutivos,
      MAX(r.fecha_hora) AS ultimo_fallo,
      (ARRAY_AGG(r.ip_origen ORDER BY r.fecha_hora DESC, r.id_login DESC))[1] AS ultima_ip
    FROM ranked r
    INNER JOIN first_success fs ON fs.id_usuario = r.id_usuario
    WHERE r.exito = FALSE
      AND (fs.first_success_rn IS NULL OR r.rn < fs.first_success_rn)
    GROUP BY r.id_usuario
  )
  SELECT
    u.id_usuario,
    u.nombre_usuario,
    NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), '') AS nombre_completo,
    COALESCE(STRING_AGG(DISTINCT ro.nombre, ', '), 'N/D') AS rol,
    c.fallos_consecutivos::int AS fallos_consecutivos,
    COALESCE(fr.fallos_en_rango, 0)::int AS fallos_en_rango,
    c.ultimo_fallo,
    COALESCE(c.ultima_ip, 'IP no registrada') AS ultima_ip
  FROM consecutive c
  INNER JOIN usuarios u ON u.id_usuario = c.id_usuario
  LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
  LEFT JOIN personas p ON p.id_persona = e.id_persona
  LEFT JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
  LEFT JOIN roles ro ON ro.id_rol = ru.id_rol
  LEFT JOIN fails_range fr ON fr.id_usuario = u.id_usuario
  WHERE COALESCE(u.estado, FALSE) = TRUE
    AND c.fallos_consecutivos >= $2
  GROUP BY
    u.id_usuario,
    u.nombre_usuario,
    p.nombre,
    p.apellido,
    c.fallos_consecutivos,
    fr.fallos_en_rango,
    c.ultimo_fallo,
    c.ultima_ip
  ORDER BY
    c.fallos_consecutivos DESC,
    c.ultimo_fallo DESC
  LIMIT $3
`;

const RECENT_ACTIVITY_SQL = `
  SELECT
    b.id_bitacora,
    b.accion,
    COALESCE(b.descripcion, '') AS descripcion,
    b.fecha_hora,
    b.id_usuario,
    COALESCE(
      NULLIF(TRIM(COALESCE(u.nombre_usuario, '')), ''),
      NULLIF(TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))), ''),
      'N/D'
    ) AS actor,
    COALESCE(NULLIF(TRIM(COALESCE(b.ip_origen, '')), ''), 'IP no registrada') AS ip_origen,
    COALESCE(b.modulo, '') AS modulo,
    COALESCE(b.tabla_afectada, '') AS tabla_afectada
  FROM bitacoras b
  LEFT JOIN usuarios u ON u.id_usuario = b.id_usuario
  LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
  LEFT JOIN personas p ON p.id_persona = e.id_persona
  WHERE b.fecha_hora >= $1::timestamp
    AND (
      UPPER(COALESCE(b.modulo, '')) = 'SEGURIDAD'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%ELIMINAR%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%INACTIVAR%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%ACTIVAR%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%CERRAR%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%PASSWORD%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%PERMISO%'
      OR UPPER(COALESCE(b.accion, '')) LIKE '%ROL%'
    )
  ORDER BY b.fecha_hora DESC, b.id_bitacora DESC
  LIMIT $2
`;

const getSummary = async (req, res) => {
  try {
    const actor = req.user || req.usuario;
    if (!actor?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }

    if (!(await requireSuperAdmin(req, res))) return;

    await closeInactiveSessions();

    const range = parseRange(req.query.range);
    const rangeConfig = SUPPORTED_RANGES[range];

    const windowSql = `
      SELECT
        timezone('America/Tegucigalpa', now()) AS now_hn,
        ${rangeConfig.rangeStartSql} AS range_start
    `;

    const windowResult = await pool.query(windowSql);
    const nowHn = windowResult.rows?.[0]?.now_hn || null;
    const rangeStart = windowResult.rows?.[0]?.range_start || null;

    if (!rangeStart || !nowHn) {
      return res.status(500).json({ error: true, message: 'No se pudo resolver el rango de tiempo' });
    }

    const loginsSeriesSql = buildLoginsSeriesSql(rangeConfig);
    const sesionesSeriesSql = buildSesionesSeriesSql(rangeConfig);
    const includeActivity = await hasBitacorasTable();

    const recentActivityPromise = includeActivity
      ? pool.query(RECENT_ACTIVITY_SQL, [rangeStart, RECENT_ACTIVITY_LIMIT])
      : Promise.resolve({ rows: [] });

    const [
      summaryResult,
      loginsSeriesResult,
      sesionesSeriesResult,
      topIpsResult,
      blockedUsersResult,
      suspiciousUsersResult,
      recentActivityResult
    ] = await Promise.all([
      pool.query(SUMMARY_SQL, [rangeStart]),
      pool.query(loginsSeriesSql, [rangeStart, nowHn]),
      pool.query(sesionesSeriesSql, [rangeStart, nowHn]),
      pool.query(TOP_IPS_SQL, [rangeStart, TOP_IPS_LIMIT]),
      pool.query(BLOCKED_USERS_SQL, [rangeStart, BLOCKED_USERS_LIMIT]),
      pool.query(SUSPICIOUS_USERS_SQL, [
        rangeStart,
        SUSPICIOUS_MIN_CONSECUTIVE_FAILS,
        SUSPICIOUS_USERS_LIMIT
      ]),
      recentActivityPromise
    ]);

    const resumen = summaryResult.rows?.[0] || {};
    const loginsFallidos = toSafeInt(resumen.logins_fallidos);
    const usuariosBloqueados = toSafeInt(resumen.usuarios_bloqueados);
    const sesionesActivas = toSafeInt(resumen.sesiones_activas_totales);
    const usuariosSospechososTotal = toSafeInt(suspiciousUsersResult.rows?.length || 0);
    const actividadCriticaTotal = toSafeInt(recentActivityResult.rows?.length || 0);

    return res.json({
      error: false,
      range: rangeConfig.key,
      range_label: rangeConfig.label,
      generated_at: timestampAsHNToISO(nowHn),
      resumen: {
        logins_fallidos: loginsFallidos,
        usuarios_bloqueados: usuariosBloqueados,
        sesiones_activas_totales: sesionesActivas,
        actividad_critica_total: actividadCriticaTotal,
        usuarios_sospechosos_total: usuariosSospechososTotal
      },
      semaforo: {
        logins_fallidos: resolveSemaforo(loginsFallidos, SEMAFORO_THRESHOLDS.logins_fallidos),
        usuarios_bloqueados: resolveSemaforo(usuariosBloqueados, SEMAFORO_THRESHOLDS.usuarios_bloqueados),
        usuarios_sospechosos: resolveSemaforo(usuariosSospechososTotal, SEMAFORO_THRESHOLDS.usuarios_sospechosos)
      },
      umbrales: SEMAFORO_THRESHOLDS,
      graficos: {
        logins_fallidos_barras: (loginsSeriesResult.rows || []).map((row) => ({
          bucket_label: String(row?.bucket_label || ''),
          bucket_inicio: timestampAsHNToISO(row?.bucket_start),
          bucket_fin: timestampAsHNToISO(row?.bucket_end),
          total: toSafeInt(row?.total)
        })),
        sesiones_activas_linea: (sesionesSeriesResult.rows || []).map((row) => ({
          bucket_label: String(row?.bucket_label || ''),
          bucket_inicio: timestampAsHNToISO(row?.bucket_start),
          bucket_fin: timestampAsHNToISO(row?.bucket_end),
          total: toSafeInt(row?.total)
        }))
      },
      tablas: {
        top_ips: (topIpsResult.rows || []).map((row) => ({
          ip_origen: String(row?.ip_origen || 'IP no registrada'),
          total_fallos: toSafeInt(row?.total_fallos)
        })),
        usuarios_bloqueados: (blockedUsersResult.rows || []).map((row) => ({
          id_usuario: toSafeInt(row?.id_usuario),
          nombre_usuario: String(row?.nombre_usuario || ''),
          nombre_completo: String(row?.nombre_completo || ''),
          rol: String(row?.rol || 'N/D'),
          fallos_en_rango: toSafeInt(row?.fallos_en_rango),
          sesiones_activas: toSafeInt(row?.sesiones_activas),
          ultimo_acceso: timestampAsHNToISO(row?.ultimo_acceso)
        }))
      },
      actividad_reciente: (recentActivityResult.rows || []).map((row) => ({
        id_bitacora: toSafeInt(row?.id_bitacora),
        accion: String(row?.accion || ''),
        descripcion: String(row?.descripcion || ''),
        fecha_hora: timestampAsHNToISO(row?.fecha_hora),
        id_usuario: toSafeInt(row?.id_usuario),
        actor: String(row?.actor || 'N/D'),
        ip_origen: String(row?.ip_origen || 'IP no registrada'),
        modulo: String(row?.modulo || ''),
        tabla_afectada: String(row?.tabla_afectada || '')
      })),
      usuarios_sospechosos: (suspiciousUsersResult.rows || []).map((row) => ({
        id_usuario: toSafeInt(row?.id_usuario),
        nombre_usuario: String(row?.nombre_usuario || ''),
        nombre_completo: String(row?.nombre_completo || ''),
        rol: String(row?.rol || 'N/D'),
        fallos_consecutivos: toSafeInt(row?.fallos_consecutivos),
        fallos_en_rango: toSafeInt(row?.fallos_en_rango),
        ultimo_fallo: timestampAsHNToISO(row?.ultimo_fallo),
        ultima_ip: String(row?.ultima_ip || 'IP no registrada')
      }))
    });
  } catch (err) {
    console.error('GET /api/security/summary error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
};

/**
 * GET /seguridad/dashboard (compatibilidad)
 * GET /seguridad/summary
 * GET /api/security/dashboard (si se monta en /api/security)
 * GET /api/security/summary
 */
router.get('/dashboard', securityReadLimiter, checkPermission(PERMISOS_DASHBOARD_VER), getSummary);
router.get('/summary', securityReadLimiter, checkPermission(PERMISOS_DASHBOARD_VER), getSummary);

export default router;
