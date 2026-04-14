/**
 * routers/perfil.js
 * HU80: Endpoints del perfil del usuario autenticado.
 */

import express from 'express';
import pool from '../config/db-connection.js';
import jwt from 'jsonwebtoken';
import JWT_SECRET from '../config/jwt.js';
import { ensurePasswordChangedAtColumn } from '../utils/security/passwordExpiration.js';

const router = express.Router();
const LEGACY_BCRYPT_PREFIX_RE = /^\$2[abxy]?\$/i;

const cookieConfig = () => {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/',
  };
};

const verifyStoredPassword = async (plainPassword, storedPassword) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');
  if (!plain || !stored) return false;

  if (plain === stored) return true;
  if (!LEGACY_BCRYPT_PREFIX_RE.test(stored)) return false;

  const result = await pool.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS ok',
    [plain, stored]
  );
  return Boolean(result.rows?.[0]?.ok);
};

const issueUpdatedAccessToken = (req, res) => {
  const currentUser = req.user || {};
  const payload = {
    id_usuario: currentUser.id_usuario,
    nombre_usuario: currentUser.nombre_usuario,
    rol: currentUser.rol,
    id_sucursal: currentUser.id_sucursal,
    sid: currentUser.sid,
    must_change_password: false,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
  const base = cookieConfig();
  res.cookie('access_token', token, {
    ...base,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 8,
  });
};

/**
 * GET /perfil
 * Devuelve información del perfil (usuario + persona + contacto + roles + último acceso).
 */
router.get('/perfil', async (req, res) => {
  try {
    await ensurePasswordChangedAtColumn();

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
        u.fecha_cambio_clave,
        u.fecha_creacion,
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

    // Conteo historico de sesiones exitosas del usuario
    const sqlSesionesTotales = `
      SELECT COUNT(*)::int AS total
      FROM logins
      WHERE id_usuario = $1 AND exito = TRUE
    `;
    const sesionesTotalesRes = await pool.query(sqlSesionesTotales, [idUsuario]);
    const sesionesTotales = Number(sesionesTotalesRes.rows[0]?.total || 0);

    return res.json({
      error: false,
      perfil: perfil.rows[0],
      roles: roles.rows,
      ultimo_acceso: ultimo.rows[0] || null,
      sesiones_totales: sesionesTotales
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
    const idUsuario = Number.parseInt(String(req.user?.id_usuario ?? ''), 10);
    if (!Number.isInteger(idUsuario) || idUsuario <= 0) {
      return res.status(401).json({ error: true, message: 'No autorizado' });
    }

    const claveActual = String(
      req.body?.clave_actual
      ?? req.body?.password_actual
      ?? ''
    ).trim();
    const claveNueva = String(
      req.body?.clave_nueva
      ?? req.body?.password_nueva
      ?? ''
    ).trim();

    if (!claveActual || !claveNueva) {
      return res.status(400).json({ error: true, message: 'clave_actual y clave_nueva son requeridas' });
    }

    await ensurePasswordChangedAtColumn();

    // 1) Validar clave actual (soporta hash bcrypt y legado plano).
    const qUser = 'SELECT id_usuario, clave FROM usuarios WHERE id_usuario = $1 LIMIT 1';
    const rUser = await pool.query(qUser, [idUsuario]);

    if (rUser.rows.length === 0) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const claveBD = String(rUser.rows[0]?.clave ?? '');
    const passwordOk = await verifyStoredPassword(claveActual, claveBD);
    if (!passwordOk) {
      return res.status(400).json({ error: true, message: 'La contraseña actual no es correcta' });
    }

    // 2) Evitar que ponga la misma clave (incluso si la actual esta hasheada).
    const samePassword = await verifyStoredPassword(claveNueva, claveBD);
    if (samePassword) {
      return res.status(400).json({ error: true, message: 'La nueva contraseña no puede ser igual a la actual' });
    }

    // 3) Reutilizar politicas existentes del modulo de seguridad.
    const policyCheck = await validatePasswordPolicy(claveNueva);
    if (!policyCheck?.ok) {
      return res.status(400).json({ error: true, message: policyCheck?.message || 'La contraseña no cumple la politica' });
    }

    // 4) Actualizar hash + limpiar forzado + fecha de ultimo cambio.
    await pool.query(
      `
        UPDATE usuarios
        SET
          clave = crypt($1::text, gen_salt('bf')),
          must_change_password = FALSE,
          fecha_cambio_clave = timezone('America/Tegucigalpa', now())
        WHERE id_usuario = $2
      `,
      [claveNueva, idUsuario]
    );

    issueUpdatedAccessToken(req, res);
    return res.json({ error: false, message: 'Contraseña actualizada correctamente' });
  } catch (err) {
    console.error('PUT /perfil/password error:', err);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

export default router;
