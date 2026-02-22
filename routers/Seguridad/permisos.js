import express from "express";
import pool from "../../config/db-connection.js";

const router = express.Router();

/**
 * GET /seguridad/permisos
 * Devuelve permisos del usuario autenticado.
 */
router.get("/permisos", async (req, res) => {
  try {
    const idUsuario = req.user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: "No autorizado" });
    }

    const sql = `
      SELECT DISTINCT p.nombre_permiso
      FROM roles_usuarios ru
      INNER JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
      INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
      WHERE ru.id_usuario = $1
      ORDER BY p.nombre_permiso
    `;

    const result = await pool.query(sql, [idUsuario]);

    return res.json({
      error: false,
      permisos: result.rows.map((r) => r.nombre_permiso),
    });
  } catch (err) {
    console.error("GET /seguridad/permisos error:", err);
    return res.status(500).json({ error: true, message: "Error interno del servidor" });
  }
});

export default router;