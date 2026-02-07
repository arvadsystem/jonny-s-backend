/**
 * routers/perfil.js
 * HU80: Endpoints del perfil del usuario autenticado.
 */

import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

/**
 * GET /perfil
 * Devuelve información del perfil (usuario + persona + contacto + roles + último acceso).
 */
router.get('/perfil', async (req, res) => {
  try {
    const user = req.user; // lo setea authRequired
    const idUsuario = user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    // Perfil base: usuario -> empleado -> persona -> (correo/telefono/direccion)
    const sqlPerfil = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        e.id_empleado,
        p.id_persona,
        p.nombre,
        p.apellido,
        p.fecha_nacimiento,
        p.genero,
        p.dni,
        p.rtn,
        t.telefono,
        c.direccion_correo AS email,
        d.direccion
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN direcciones d ON d.id_direccion = p.id_direccion
      WHERE u.id_usuario = $1
      LIMIT 1
    `;

    const perfil = await pool.query(sqlPerfil, [idUsuario]);

    if (perfil.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Perfil no encontrado' });
    }

    // Roles del usuario (many-to-many)
    const sqlRoles = `
      SELECT r.id_rol, r.nombre
      FROM roles_usuarios ru
      INNER JOIN roles r ON r.id_rol = ru.id_rol
      WHERE ru.id_usuario = $1
      ORDER BY r.nombre
    `;
    const roles = await pool.query(sqlRoles, [idUsuario]);

    // Último acceso exitoso (logins)
    const sqlUltimoAcceso = `
      SELECT fecha_hora, ip_origen, navegador, sistema_operativo, dispositivo, ubicacion
      FROM logins
      WHERE id_usuario = $1 AND exito = TRUE
      ORDER BY fecha_hora DESC
      LIMIT 1
    `;
    const ultimo = await pool.query(sqlUltimoAcceso, [idUsuario]);

    return res.json({
      error: false,
      perfil: perfil.rows[0],
      roles: roles.rows,
      ultimo_acceso: ultimo.rows[0] || null
    });
  } catch (err) {
    console.error('GET /perfil error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;
