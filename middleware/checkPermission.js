/**
 * middleware/checkPermission.js
 * HU82: Middleware RBAC para validar permisos del usuario autenticado.
 *
 * Revisa si un usuario tiene un permiso a través de sus roles.
 */

import pool from '../config/db-connection.js';

/**
 * checkPermission(nombrePermiso)
 * Ejemplo: checkPermission('SEGURIDAD_VER')
 */
export function checkPermission(nombrePermiso) {
  return async (req, res, next) => {
    try {
      const user = req.user || req.usuario;

      if (!user?.id_usuario) {
        return res.status(401).json({ error: true, message: 'No autorizado' });
      }

      const sql = `
        SELECT 1
        FROM roles_usuarios ru
        INNER JOIN roles_permisos rp ON rp.id_rol = ru.id_rol
        INNER JOIN permisos p ON p.id_permiso = rp.id_permiso
        WHERE ru.id_usuario = $1
          AND p.nombre_permiso = $2
        LIMIT 1
      `;

      const result = await pool.query(sql, [user.id_usuario, nombrePermiso]);

      if (result.rows.length === 0) {
        return res.status(403).json({
          error: true,
          message: 'Acceso denegado: permisos insuficientes'
        });
      }

      return next();
    } catch (err) {
      console.error('checkPermission error:', err);
      return res.status(500).json({ error: true, message: 'Error interno del servidor' });
    }
  };
}
