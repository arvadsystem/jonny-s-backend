/**
 * routers/seguridad/logins.js
 * HU78: Consulta de logs de login
 */

import express from "express";
import pool from "../../config/db-connection.js";
import { checkPermission } from "../../middleware/checkPermission.js";
import { timestampAsHNToISO, toHNWallTimestamp } from "../../utils/dates.js";
const router = express.Router();

const PERMISO_VER = ["SEGURIDAD_LOGINS_VER", "SEGURIDAD_VER"];

router.get("/logins", checkPermission(PERMISO_VER), async (req, res) => {
  try {
    const {
      estado,
      desde,
      hasta,
      id_usuario,
      usuario,
      limit,
      offset,
    } = req.query;

    const lim = Math.min(Number(limit) || 10, 200);
    const off = Number(offset) || 0;

    const where = [];
    const params = [];
    let i = 1;

    if (estado) {
      const e = String(estado).toUpperCase();
      if (e === "SUCCESS") {
        where.push(`l.exito = $${i++}`);
        params.push(true);
      } else if (e === "FAIL") {
        where.push(`l.exito = $${i++}`);
        params.push(false);
      }
    }

    // ✅ filtros sobre timestamp sin TZ (HN) sin usar new Date("YYYY-MM-DD")
    if (desde) {
      const v = toHNWallTimestamp(desde, { endOfDay: false });
      if (v) {
        where.push(`l.fecha_hora >= $${i++}::timestamp`);
        params.push(v);
      }
    }

    if (hasta) {
      const v = toHNWallTimestamp(hasta, { endOfDay: true });
      if (v) {
        where.push(`l.fecha_hora <= $${i++}::timestamp`);
        params.push(v);
      }
    }

    if (id_usuario) {
      where.push(`l.id_usuario = $${i++}`);
      params.push(Number(id_usuario));
    }

    if (usuario) {
      where.push(`(u.nombre_usuario ILIKE $${i++} OR l.nombre_usuario_intentado ILIKE $${i++})`);
      const like = `%${usuario}%`;
      params.push(like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM logins l
      LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario
      ${whereSql}
    `;
    const countRes = await pool.query(countSql, params);
    const total = countRes.rows[0]?.total ?? 0;

    const dataSql = `
      SELECT
        l.id_login,
        l.fecha_hora,
        l.ip_origen,
        l.exito,
        l.mensaje_error,
        l.dispositivo,
        l.navegador,
        l.sistema_operativo,
        l.nombre_usuario_intentado,
        l.id_usuario,
        u.nombre_usuario AS usuario
      FROM logins l
      LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario
      ${whereSql}
      ORDER BY l.fecha_hora DESC
      LIMIT $${i++} OFFSET $${i++}
    `;

    const dataRes = await pool.query(dataSql, [...params, lim, off]);

    const rows = dataRes.rows.map((r) => ({
      ...r,
      fecha_hora: timestampAsHNToISO(r.fecha_hora),
    }));

    return res.json({
      error: false,
      total,
      limit: lim,
      offset: off,
      rows,
    });
  } catch (err) {
    console.error("GET /seguridad/logins error:", err.message);
    return res.status(500).json({ error: true, message: "Error interno del servidor" });
  }
});

export default router;
