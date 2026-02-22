/**
 * routers/Seguridad/sesiones.js
 * HU79: endpoints para ver y controlar sesiones activas.
 */

import express from 'express';
import pool from '../../config/db-connection.js';
import { closeSession } from '../../utils/security/sessionService.js';
import { checkPermission } from '../../middleware/checkPermission.js';
import { timestampAsHNToISO } from "../../utils/dates.js";
const router = express.Router();

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
      fecha_inicio: timestampAsHNToISO(s.fecha_inicio),
      ultima_actividad: timestampAsHNToISO(s.ultima_actividad),
      fecha_cierre: timestampAsHNToISO(s.fecha_cierre),
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

export default router;