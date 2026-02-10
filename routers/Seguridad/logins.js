/**
 * routers/seguridad/logins.js
 * HU78: Consulta de logs de login
 * - Protegido por RBAC
 * - Soporta filtros + paginación (limit/offset)
 *
 * Endpoint:
 * GET /seguridad/logins?estado=SUCCESS|FAIL&desde=YYYY-MM-DD&hasta=YYYY-MM-DD&limit=10&offset=0
 */

import express from "express";
import pool from "../../config/db-connection.js";
import { checkPermission } from "../../middleware/checkPermission.js";

const router = express.Router();

// Puedes cambiarlo por otro permiso si deseas:
// - "SEGURIDAD_VER" ya existe en tu RBAC (según tu HU82)
const PERMISO_VER = "SEGURIDAD_VER";

router.get("/logins", checkPermission(PERMISO_VER), async (req, res) => {
  try {
    const {
      estado,   // SUCCESS | FAIL | (vacío)
      desde,    // YYYY-MM-DD o ISO
      hasta,    // YYYY-MM-DD o ISO
      id_usuario,
      usuario,  // nombre_usuario_intentado o nombre_usuario real (búsqueda)
      limit,
      offset,
    } = req.query;

    // paginación simple con límites seguros
    const lim = Math.min(Number(limit) || 10, 200);
    const off = Number(offset) || 0;

    // WHERE dinámico
    const where = [];
    const params = [];
    let i = 1;

    // estado -> exito boolean
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

    if (desde) {
      where.push(`l.fecha_hora >= $${i++}`);
      params.push(new Date(desde));
    }

    if (hasta) {
      where.push(`l.fecha_hora <= $${i++}`);
      params.push(new Date(hasta));
    }

    if (id_usuario) {
      where.push(`l.id_usuario = $${i++}`);
      params.push(Number(id_usuario));
    }

    // búsqueda por username real o intentado (LIKE)
    if (usuario) {
      where.push(`(u.nombre_usuario ILIKE $${i++} OR l.nombre_usuario_intentado ILIKE $${i++})`);
      const like = `%${usuario}%`;
      params.push(like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // total
    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM logins l
      LEFT JOIN usuarios u ON u.id_usuario = l.id_usuario
      ${whereSql}
    `;
    const countRes = await pool.query(countSql, params);
    const total = countRes.rows[0]?.total ?? 0;

    // rows
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

    return res.json({
      error: false,
      total,
      limit: lim,
      offset: off,
      rows: dataRes.rows,
    });
  } catch (err) {
    console.error("GET /seguridad/logins error:", err.message);
    return res.status(500).json({ error: true, message: "Error interno del servidor" });
  }
});

export default router;
