/**
 * routers/Seguridad/sesiones.js
 * HU79: endpoints para ver y controlar sesiones activas.
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { closeSession } from '../../utils/security/sessionService.js';

const router = express.Router();

/**
 * GET /seguridad/sesiones
 * Lista sesiones del usuario autenticado.
 */
router.get('/sesiones', async (req, res) => {
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
        motivo_cierre
      FROM sesiones_activas
      WHERE id_usuario = $1
      ORDER BY activa DESC, ultima_actividad DESC
    `;

    const result = await pool.query(sql, [user.id_usuario]);
    return res.json({ error: false, sesiones: result.rows });
  } catch (err) {
    console.error('GET /seguridad/sesiones error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/sesiones/cerrar
 * Cierra (remotamente) una sesión por id_sesion.
 * Body: { id_sesion: "uuid..." }
 */
router.post('/sesiones/cerrar', async (req, res) => {
  try {
    const user = req.user || req.usuario;
    const { id_sesion } = req.body;

    if (!user?.id_usuario) {
      return res.status(401).json({ error: true, message: 'No autenticado' });
    }
    if (!id_sesion) {
      return res.status(400).json({ error: true, message: 'id_sesion es requerido' });
    }

    // ✅ Seguridad: verifica que la sesión pertenece al usuario
    const check = await pool.query(
      'SELECT id_sesion FROM sesiones_activas WHERE id_sesion = $1 AND id_usuario = $2',
      [id_sesion, user.id_usuario]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Sesión no encontrada' });
    }

    await closeSession(id_sesion, 'cierre_remoto');

    // Nota: si cierras la sesión actual, el usuario seguirá con token hasta que lo bloqueemos
    // (en HU79 paso 4 agregamos "validar sesión activa" en auth para forzar logout)
    return res.json({ error: false, message: 'Sesión cerrada' });
  } catch (err) {
    console.error('POST /seguridad/sesiones/cerrar error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

/**
 * POST /seguridad/sesiones/cerrar-otras
 * Cierra todas las sesiones activas del usuario EXCEPTO la sesión actual (sid del JWT).
 */
router.post('/sesiones/cerrar-otras', async (req, res) => {
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
          fecha_cierre = CURRENT_TIMESTAMP,
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

export default router;
