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

/**
 * PUT /perfil
 * Actualiza información del perfil del usuario autenticado.
 * Recomendación: enviar solo los campos que el usuario puede editar.
 */
router.put('/perfil', async (req, res) => {
  const client = await pool.connect();

  try {
    const user = req.user;
    const idUsuario = user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    // Campos permitidos (evita que te manden cosas que no deben)
    const {
      // personas
      nombre,
      apellido,
      fecha_nacimiento,
      genero,
      dni,
      rtn,

      // contacto (valores)
      telefono,
      email,
      direccion,

      // usuarios
      foto_perfil
    } = req.body;

    await client.query('BEGIN');

    // 1) Obtener ids relacionados (empleado, persona y sus referencias)
    const qIds = `
      SELECT
        u.id_usuario,
        u.id_empleado,
        e.id_persona,
        p.id_telefono,
        p.id_correo,
        p.id_direccion
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      WHERE u.id_usuario = $1
      LIMIT 1
    `;
    const idsRes = await client.query(qIds, [idUsuario]);

    if (idsRes.rows.length === 0 || !idsRes.rows[0].id_persona) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Perfil no encontrado' });
    }

    const { id_persona, id_telefono, id_correo, id_direccion } = idsRes.rows[0];

    // 2) Actualizar PERSONAS (solo si vienen campos)
    const setParts = [];
    const values = [];
    let idx = 1;

    const addField = (fieldName, value) => {
      if (value !== undefined) {
        setParts.push(`${fieldName} = $${idx++}`);
        values.push(value);
      }
    };

    addField('nombre', nombre);
    addField('apellido', apellido);
    addField('fecha_nacimiento', fecha_nacimiento);
    addField('genero', genero);
    addField('dni', dni);
    addField('rtn', rtn);

    if (setParts.length > 0) {
      values.push(id_persona);
      const qPersona = `
        UPDATE personas
        SET ${setParts.join(', ')}
        WHERE id_persona = $${idx}
      `;
      await client.query(qPersona, values);
    }

    // 3) Actualizar / crear TELEFONO (si viene)
    if (telefono !== undefined) {
      if (id_telefono) {
        await client.query(
          'UPDATE telefonos SET telefono = $1 WHERE id_telefono = $2',
          [telefono, id_telefono]
        );
      } else {
        // si no existía, creamos y lo referenciamos en personas
        const telRes = await client.query(
          'INSERT INTO telefonos (telefono) VALUES ($1) RETURNING id_telefono',
          [telefono]
        );
        const newIdTel = telRes.rows[0].id_telefono;
        await client.query(
          'UPDATE personas SET id_telefono = $1 WHERE id_persona = $2',
          [newIdTel, id_persona]
        );
      }
    }

    // 4) Actualizar / crear CORREO (si viene)
    if (email !== undefined) {
      if (id_correo) {
        await client.query(
          'UPDATE correos SET direccion_correo = $1 WHERE id_correo = $2',
          [email, id_correo]
        );
      } else {
        const mailRes = await client.query(
          'INSERT INTO correos (direccion_correo) VALUES ($1) RETURNING id_correo',
          [email]
        );
        const newIdMail = mailRes.rows[0].id_correo;
        await client.query(
          'UPDATE personas SET id_correo = $1 WHERE id_persona = $2',
          [newIdMail, id_persona]
        );
      }
    }

    // 5) Actualizar / crear DIRECCION (si viene)
    if (direccion !== undefined) {
      if (id_direccion) {
        await client.query(
          'UPDATE direcciones SET direccion = $1 WHERE id_direccion = $2',
          [direccion, id_direccion]
        );
      } else {
        const dirRes = await client.query(
          'INSERT INTO direcciones (direccion) VALUES ($1) RETURNING id_direccion',
          [direccion]
        );
        const newIdDir = dirRes.rows[0].id_direccion;
        await client.query(
          'UPDATE personas SET id_direccion = $1 WHERE id_persona = $2',
          [newIdDir, id_persona]
        );
      }
    }

    // 6) Actualizar foto en USUARIOS (si viene)
    if (foto_perfil !== undefined) {
      await client.query(
        'UPDATE usuarios SET foto_perfil = $1 WHERE id_usuario = $2',
        [foto_perfil, idUsuario]
      );
    }

    await client.query('COMMIT');
    return res.json({ error: false, message: 'Perfil actualizado correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /perfil error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

import { validatePasswordPolicy } from '../utils/security/passwordPolicy.js';

/**
 * PUT /perfil/password
 * Cambia contraseña del usuario autenticado.
 * Body:
 * {
 *   "clave_actual": "....",
 *   "clave_nueva": "...."
 * }
 */
router.put('/perfil/password', async (req, res) => {
  try {
    const user = req.user;
    const idUsuario = user?.id_usuario;

    if (!idUsuario) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    const { clave_actual, clave_nueva } = req.body;

    if (!clave_actual || !clave_nueva) {
      return res.status(400).json({ error: true, message: 'clave_actual y clave_nueva son requeridas' });
    }

    // 1) Validar política (HU81)
    const policyCheck = await validatePasswordPolicy(clave_nueva);
    if (!policyCheck.ok) {
      return res.status(400).json({ error: true, message: policyCheck.message });
    }

    // 2) Validar clave actual (por ahora en texto plano, como tu sistema actual)
    const qUser = `SELECT clave FROM usuarios WHERE id_usuario = $1 LIMIT 1`;
    const rUser = await pool.query(qUser, [idUsuario]);

    if (rUser.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const claveBD = rUser.rows[0].clave;

    if (String(claveBD) !== String(clave_actual)) {
      return res.status(400).json({ error: true, message: 'La contraseña actual no es correcta' });
    }

    // 3) Evitar que ponga la misma clave
    if (String(clave_actual) === String(clave_nueva)) {
      return res.status(400).json({ error: true, message: 'La nueva contraseña no puede ser igual a la actual' });
    }

    // 4) Actualizar clave
    await pool.query(`UPDATE usuarios SET clave = $1 WHERE id_usuario = $2`, [clave_nueva, idUsuario]);

    return res.json({ error: false, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('PUT /perfil/password error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});


export default router;
