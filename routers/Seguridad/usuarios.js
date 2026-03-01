/**
 * routers/seguridad/usuarios.js
 * HU1085 (Sprint 3): Listado global de usuarios (solo Super Admin)
 *
 * Requisitos:
 * - Tabla con todos los usuarios (filtros + paginación)
 * - Campos mínimos: id, usuario, nombre, rol, estado (activo/bloqueado), último acceso, sesiones activas (contador)
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { checkPermission } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from '../../utils/dates.js';

const router = express.Router();

const PERMISO_VER = 'SEGURIDAD_VER';

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

const normalizeEstado = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;

  // Acepta: activo/bloqueado, true/false, 1/0
  if (s === 'activo' || s === 'true' || s === '1') return true;
  if (s === 'bloqueado' || s === 'false' || s === '0') return false;

  return null;
};

// =====================================================
// HU1085: Listado global de usuarios
// =====================================================

/**
 * GET /seguridad/usuarios/global
 * Query:
 * - buscar (opcional): usuario / nombre / apellido / rol
 * - estado (opcional): activo | bloqueado
 * - limit (default 10)
 * - offset (default 0)
 */
router.get('/usuarios/global', checkPermission(PERMISO_VER), async (req, res) => {
  try {
    const user = req.user || req.usuario;

    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }

    // 🔒 Solo Super Admin
    if (!requireSuperAdmin(req, res)) return;

    const buscar = String(req.query.buscar ?? '').trim();
    const estadoBool = normalizeEstado(req.query.estado);

    const limit = clampInt(req.query.limit, 10, 1, 50);
    const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

    const where = [];
    const params = [];
    let i = 1;

    if (estadoBool !== null) {
      where.push(`u.estado = $${i++}`);
      params.push(estadoBool);
    }

    if (buscar) {
      const like = `%${buscar}%`;
      where.push(`(
        u.nombre_usuario ILIKE $${i} OR
        COALESCE(p.nombre,'') ILIKE $${i} OR
        COALESCE(p.apellido,'') ILIKE $${i} OR
        EXISTS (
          SELECT 1
          FROM roles_usuarios ru2
          INNER JOIN roles r2 ON r2.id_rol = ru2.id_rol
          WHERE ru2.id_usuario = u.id_usuario
            AND r2.nombre ILIKE $${i}
        )
      )`);
      params.push(like);
      i += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // COUNT total
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      ${whereSql}
    `;

    const countRes = await pool.query(countSql, params);
    const total = countRes.rows?.[0]?.total ?? 0;

    // DATA
    const dataSql = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        COALESCE(p.nombre,'') AS nombre,
        COALESCE(p.apellido,'') AS apellido,
        u.estado,
        COALESCE(la.ultimo_acceso, NULL) AS ultimo_acceso,
        COALESCE(sc.sesiones_activas, 0)::int AS sesiones_activas,
        COALESCE(STRING_AGG(DISTINCT r.nombre, ', '), '—') AS rol
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN roles_usuarios ru ON ru.id_usuario = u.id_usuario
      LEFT JOIN roles r ON r.id_rol = ru.id_rol
      LEFT JOIN (
        SELECT id_usuario, MAX(fecha_hora) AS ultimo_acceso
        FROM logins
        WHERE exito = TRUE
        GROUP BY id_usuario
      ) la ON la.id_usuario = u.id_usuario
      LEFT JOIN (
        SELECT id_usuario, COUNT(*)::int AS sesiones_activas
        FROM sesiones_activas
        WHERE activa = TRUE
        GROUP BY id_usuario
      ) sc ON sc.id_usuario = u.id_usuario
      ${whereSql}
      GROUP BY
        u.id_usuario,
        u.nombre_usuario,
        p.nombre,
        p.apellido,
        u.estado,
        la.ultimo_acceso,
        sc.sesiones_activas
      ORDER BY u.id_usuario ASC
      LIMIT $${i++} OFFSET $${i++}
    `;

    const dataRes = await pool.query(dataSql, [...params, limit, offset]);

    const rows = dataRes.rows.map((r) => ({
      ...r,
      ultimo_acceso: toHNISO(r.ultimo_acceso)
    }));

    return res.json({
      error: false,
      total,
      limit,
      offset,
      rows
    });
  } catch (err) {
    console.error('GET /seguridad/usuarios/global error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;