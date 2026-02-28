/**
 * routers/Seguridad/sesiones.js
 * HU79: endpoints para ver y controlar sesiones activas.
 *
 * ✅ Sprint 3 (HU31 adaptada):
 * - Listado GLOBAL de sesiones ACTIVAS (solo Super Admin)
 * - Cerrar TODAS las sesiones activas (menos la actual) (solo Super Admin)
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { closeSession } from '../../utils/security/sessionService.js';
import { checkPermission } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from '../../utils/dates.js';

const router = express.Router();

// =====================================================
// Helpers
// =====================================================
const isSuperAdmin = (user) => Number(user?.rol) === 1;

const requireSuperAdmin = (req, res) => {
  const user = req.user || req.usuario;
  if (!isSuperAdmin(user)) {
    res.status(403).json({ error: true, message: 'Acceso denegado: solo Super Admin' });
    return false;
  }
  return true;
};

const clampInt = (value, def, min, max) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const toHNISO = (val) => timestampAsHNToISO(val);

/**
 * Construye cláusula de búsqueda con placeholders.
 * @param {string} buscar
 * @param {number} startIdx índice inicial de placeholders ($N)
 */
const buildBuscarClause = (buscar, startIdx) => {
  const term = String(buscar ?? '').trim();
  if (!term) return { sql: '', params: [], nextIdx: startIdx };

  const like = `%${term}%`;
  const params = [];
  let i = startIdx;

  const p1 = `$${i++}`; params.push(like); // usuario
  const p2 = `$${i++}`; params.push(like); // nombre
  const p3 = `$${i++}`; params.push(like); // apellido
  const p4 = `$${i++}`; params.push(like); // ip

  return {
    sql: `AND (
      u.nombre_usuario ILIKE ${p1} OR
      COALESCE(p.nombre,'') ILIKE ${p2} OR
      COALESCE(p.apellido,'') ILIKE ${p3} OR
      COALESCE(sa.ip_origen,'') ILIKE ${p4}
    )`,
    params,
    nextIdx: i
  };
};

// =====================================================
// HU79: Sesiones del usuario actual
// =====================================================

/**
 * GET /seguridad/sesiones
 * Lista sesiones del usuario autenticado.
 */
router.get('/sesiones', checkPermission('SEGURIDAD_VER'), async (req, res) => {
  try {
    const user = req.user || req.usuario;
    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }

    const sql = `
      SELECT
        id_sesion,
        ip_origen,
        dispositivo,
        navegador,
        sistema_operativo,
        ubicacion,
        fecha_inicio,
        ultima_actividad,
        activa,
        fecha_cierre,
        motivo_cierre,
        (id_sesion = $2) AS es_actual
      FROM sesiones_activas
      WHERE id_usuario = $1
      ORDER BY activa DESC, ultima_actividad DESC
    `;

    const result = await pool.query(sql, [user.id_usuario, user.sid]);

    // ✅ timestamp sin TZ (HN) -> ISO UTC con Z
    const sesiones = result.rows.map((s) => ({
      ...s,
      fecha_inicio: toHNISO(s.fecha_inicio),
      ultima_actividad: toHNISO(s.ultima_actividad),
      fecha_cierre: toHNISO(s.fecha_cierre)
    }));

    return res.json({ error: false, sesiones });
  } catch (err) {
    console.error('GET /seguridad/sesiones error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/sesiones/cerrar
 * Body: { id_sesion: "uuid..." }
 */
router.post('/sesiones/cerrar', checkPermission('SEGURIDAD_SESIONES_CERRAR'), async (req, res) => {
  try {
    const user = req.user || req.usuario;
    const { id_sesion } = req.body;

    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!id_sesion) {
      return res.status(400).json({ error: true, message: 'id_sesion es requerido' });
    }

    // ✅ Verifica que la sesión pertenece al usuario
    const check = await pool.query(
      'SELECT id_sesion FROM sesiones_activas WHERE id_sesion = $1 AND id_usuario = $2',
      [id_sesion, user.id_usuario]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Sesión no encontrada' });
    }

    await closeSession(id_sesion, 'cierre_remoto');
    return res.json({ error: false, message: 'Sesión cerrada' });
  } catch (err) {
    console.error('POST /seguridad/sesiones/cerrar error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/sesiones/cerrar-otras
 * Cierra todas las sesiones del usuario autenticado menos la actual.
 */
router.post('/sesiones/cerrar-otras', checkPermission('SEGURIDAD_SESIONES_CERRAR'), async (req, res) => {
  try {
    const user = req.user || req.usuario;
    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!user?.sid) {
      return res.status(400).json({ error: true, message: 'Sesión actual no identificada (sid)' });
    }

    const sql = `
      UPDATE sesiones_activas
      SET activa = FALSE,
          fecha_cierre = timezone('America/Tegucigalpa', now()),
          motivo_cierre = 'cierre_otras'
      WHERE id_usuario = $1
        AND activa = TRUE
        AND id_sesion <> $2
    `;

    const result = await pool.query(sql, [user.id_usuario, user.sid]);
    return res.json({
      error: false,
      message: 'Otras sesiones cerradas',
      cerradas: result.rowCount
    });
  } catch (err) {
    console.error('POST /seguridad/sesiones/cerrar-otras error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

// =====================================================
// Sprint 3 (HU31 adaptada): Sesiones globales (solo Super Admin)
// =====================================================

/**
 * GET /seguridad/sesiones/global
 * Lista sesiones ACTIVAS de TODO el sistema.
 * Query:
 * - buscar (opcional)
 * - limit (default 10)
 * - offset (default 0)
 */
router.get('/sesiones/global', checkPermission('SEGURIDAD_VER'), async (req, res) => {
  try {
    const user = req.user || req.usuario;
    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }

    // 🔒 Solo Super Admin
    if (!requireSuperAdmin(req, res)) return;

    const buscar = String(req.query.buscar ?? '').trim();
    const limit = clampInt(req.query.limit, 10, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    // COUNT (placeholders empiezan en $1)
    const buscarCount = buildBuscarClause(buscar, 1);

    const sqlCount = `
      SELECT COUNT(*)::int AS total
      FROM sesiones_activas sa
      INNER JOIN usuarios u ON u.id_usuario = sa.id_usuario
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      WHERE sa.activa = TRUE
      ${buscarCount.sql}
    `;

    // DATA (placeholders: $1 reservado para sid -> es_actual)
    const buscarData = buildBuscarClause(buscar, 2);

    const sqlData = `
      SELECT
        sa.id_sesion,
        sa.id_usuario,
        u.nombre_usuario,
        p.nombre,
        p.apellido,
        sa.ip_origen,
        sa.dispositivo,
        sa.navegador,
        sa.sistema_operativo,
        sa.ubicacion,
        sa.fecha_inicio,
        sa.ultima_actividad,
        sa.activa,
        (sa.id_sesion = $1) AS es_actual
      FROM sesiones_activas sa
      INNER JOIN usuarios u ON u.id_usuario = sa.id_usuario
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      WHERE sa.activa = TRUE
      ${buscarData.sql}
      ORDER BY sa.ultima_actividad DESC
      LIMIT $${buscarData.nextIdx}
      OFFSET $${buscarData.nextIdx + 1}
    `;

    const countRes = await pool.query(sqlCount, buscarCount.params);

    const dataParams = [user.sid, ...buscarData.params, limit, offset];
    const dataRes = await pool.query(sqlData, dataParams);

    const rows = dataRes.rows.map((s) => ({
      ...s,
      fecha_inicio: toHNISO(s.fecha_inicio),
      ultima_actividad: toHNISO(s.ultima_actividad)
    }));

    return res.json({
      error: false,
      total: countRes.rows?.[0]?.total ?? 0,
      limit,
      offset,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/sesiones/global error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/sesiones/cerrar-global-menos-actual
 * Cierra TODAS las sesiones activas del sistema, excepto la actual.
 */
router.post(
  '/sesiones/cerrar-global-menos-actual',
  checkPermission('SEGURIDAD_SESIONES_CERRAR'),
  async (req, res) => {
    try {
      const user = req.user || req.usuario;

      if (!user?.id_usuario) {
        return res.status(401).json({ error: true, message: 'No autenticado' });
      }
      if (!user?.sid) {
        return res.status(400).json({ error: true, message: 'Sesión actual no identificada (sid)' });
      }

      // 🔒 Solo Super Admin
      if (!requireSuperAdmin(req, res)) return;

      const sql = `
        UPDATE sesiones_activas
        SET activa = FALSE,
            fecha_cierre = timezone('America/Tegucigalpa', now()),
            motivo_cierre = 'cierre_global_superadmin'
        WHERE activa = TRUE
          AND id_sesion <> $1
      `;

      const result = await pool.query(sql, [user.sid]);
      return res.json({
        error: false,
        message: 'Sesiones globales cerradas (menos la actual)',
        cerradas: result.rowCount
      });
    } catch (err) {
      console.error('POST /seguridad/sesiones/cerrar-global-menos-actual error:', err);
      return res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
  }
);

export default router;