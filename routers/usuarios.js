import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
// ------------------------------------------------------------------------------------
// GET: Obtener usuarios
router.get('/usuarios', async (req, res) => {
    try {
        const tabla = 'usuarios';
        
        // CORRECCIÓN AQUÍ: Cambiamos 'cod_usuario' por 'id_usuario'
        // También aseguramos que 'clave' y 'estado' estén bien escritos.
        const columnas = 'id_usuario, nombre_usuario, clave, estado, id_empleado'; 

        // Llamamos a la función
        const query = 'SELECT function_select($1, $2) as resultado';
        const result = await pool.query(query, [tabla, columnas]);

        // Extraemos el resultado
        const datos = result.rows[0].resultado || [];
        res.status(200).json(datos);

    } catch (err) {
        console.error('Error al obtener usuarios:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// POST: Crear nuevo usuario
// ------------------------------------------------------------------------------------
router.post('/usuarios', async (req, res) => {
    try {
        const tabla = 'usuarios';
        const datosUsuario = req.body; 
        
/* IMPORTANTE: 
Desde Postman debes enviar el JSON con las llaves correctas:
{
"nombre_usuario": "Juan",
"clave": "12345",
"estado": true,
"id_empleado": 1
}
*/

        const query = 'CALL pa_insert($1, $2)';
        await pool.query(query, [tabla, datosUsuario]);

        res.status(201).json({ message: 'Usuario creado exitosamente.' });

    } catch (err) {
        console.error('Error al crear usuario:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar usuario
// ------------------------------------------------------------------------------------
router.put('/usuarios', async (req, res) => {
    try {
        const { campo, valor, id_campo, id_valor } = req.body;

        if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
            return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
        }

        const tabla = 'usuarios';
        
/* EN POSTMAN, para actualizar el nombre del usuario 1, enviarías:
{
"campo": "nombre_usuario",
"valor": "NuevoNombre",
"id_campo": "id_usuario",   <-- OJO AQUÍ: id_usuario
"id_valor": 1 
}
*/

        const strNuevoDato = String(valor);
        const strValorCondicion = String(id_valor);

        const query = 'CALL pa_update($1, $2, $3, $4, $5)';
        await pool.query(query, [tabla, campo, strNuevoDato, id_campo, strValorCondicion]);

        res.status(200).json({ message: 'Usuario actualizado correctamente.' });

    } catch (err) {
        console.error('Error al actualizar:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});

// ------------------------------------------------------------------------------------
// DELETE: Eliminar usuario
// ------------------------------------------------------------------------------------
router.delete('/usuarios', async (req, res) => {
    try {
        const { columna_id, valor_id } = req.body;
        // En Postman enviarías: { "columna_id": "id_usuario", "valor_id": 1 }

        if (!columna_id || !valor_id) {
            return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
        }

        const tabla = 'usuarios';
        const strValorId = String(valor_id);

        const query = 'CALL pa_delete($1, $2, $3)';
        await pool.query(query, [tabla, columna_id, strValorId]);

        res.status(200).json({ message: 'Usuario eliminado.' });

    } catch (err) {
        console.error('Error al eliminar:', err.message);
        res.status(500).json({ error: true, message: err.message });
    }
});
export default router;
// ====================================================================================
// V2: Submodulo de usuarios (CRUD + credenciales temporales)
// NOTA: se agrega al final para no alterar endpoints existentes.
// ====================================================================================

const USUARIOS_V2_MAX_LIMIT = 100;
const USUARIOS_V2_FOTO_PERFIL_MAX_LENGTH = 500;
const USUARIOS_V2_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const USUARIOS_V2_BCRYPT_PREFIX_RE = /^\$2[abxy]?\$/i;
const USUARIOS_V2_IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;
const USUARIOS_V2_IMAGE_URL_RE = /^(https?:\/\/|\/uploads\/)/i;
const USUARIOS_V2_CREATE_PASSWORD_MIN = 10;
// Compatibilidad con login legacy:
// routers/login.js valida con SQL directo: WHERE nombre_usuario = $1 AND clave = $2
// por lo tanto, el valor almacenado en usuarios.clave debe coincidir en texto plano.
const USUARIOS_V2_LOGIN_EXPECTS_PLAIN_PASSWORD = true;

let usuariosV2CapabilitiesPromise = null;

const v2ParsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const v2ParseBoolean = (value) => {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 't', 'si', 'activo', 'activa'].includes(normalized)) return true;
  if (['false', '0', 'f', 'no', 'inactivo', 'inactiva'].includes(normalized)) return false;
  return null;
};

const v2NormalizeText = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const v2ValidateCreatePassword = (plainPassword) => {
  const value = String(plainPassword ?? '');
  if (!value) {
    return { ok: false, message: 'Contrasena requerida' };
  }
  if (value.length < USUARIOS_V2_CREATE_PASSWORD_MIN) {
    return { ok: false, message: 'La contrasena debe tener minimo 10 caracteres' };
  }
  if (!/[A-Z]/.test(value)) {
    return { ok: false, message: 'La contrasena debe incluir al menos una mayuscula (A-Z)' };
  }
  if (!/[0-9]/.test(value)) {
    return { ok: false, message: 'La contrasena debe incluir al menos un numero (0-9)' };
  }
  return { ok: true, message: '' };
};

const v2ToUpperNoAccents = (value) =>
  v2NormalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

const v2SanitizeUsernameToken = (value) => v2ToUpperNoAccents(value).replace(/[^A-Z0-9]/g, '');

const v2SplitWords = (value) =>
  v2NormalizeText(value)
    .split(/\s+/)
    .map((part) => v2SanitizeUsernameToken(part))
    .filter(Boolean);

const v2EstimateDataUrlBytes = (dataUrl) => {
  const safe = v2NormalizeText(dataUrl);
  const commaIndex = safe.indexOf(',');
  if (commaIndex < 0) return 0;

  const base64 = safe.slice(commaIndex + 1);
  const paddingMatch = base64.match(/=+$/);
  const padding = paddingMatch ? paddingMatch[0].length : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
};

const v2ValidatePhotoPayload = (fotoPerfil) => {
  if (fotoPerfil === null || fotoPerfil === undefined || v2NormalizeText(fotoPerfil) === '') {
    return { ok: true, value: '' };
  }

  const value = v2NormalizeText(fotoPerfil);
  const isDataImage = USUARIOS_V2_IMAGE_DATA_URL_RE.test(value);
  const isShortUrl = USUARIOS_V2_IMAGE_URL_RE.test(value);

  if (value.length > USUARIOS_V2_FOTO_PERFIL_MAX_LENGTH) {
    return {
      ok: false,
      status: 413,
      message: 'La imagen es demasiado grande para almacenarse. Use una URL o una imagen mas ligera.',
    };
  }

  if (isDataImage) {
    return {
      ok: false,
      status: 400,
      message: 'No se puede guardar archivo directo; use URL de imagen o habilite almacenamiento en servidor.',
    };
  }

  if (isShortUrl) {
    return { ok: true, value };
  }

  return {
    ok: false,
    status: 400,
    message: 'Formato de foto no valido. Use una URL (http/https o /uploads/...) o una imagen mas ligera.',
  };
};

const v2IsBcryptHash = (value) => USUARIOS_V2_BCRYPT_PREFIX_RE.test(v2NormalizeText(value));

const v2HashPasswordBcrypt = async (plainPassword, queryRunner = pool) => {
  const safePassword = String(plainPassword ?? '');
  if (!safePassword) throw new Error('La contrasena temporal no puede estar vacia');

  const result = await queryRunner.query(
    'SELECT crypt($1::text, gen_salt(\'bf\')) AS hash',
    [safePassword]
  );

  const hash = result.rows?.[0]?.hash;
  if (!hash) throw new Error('No se pudo generar el hash de la contrasena');
  return String(hash);
};

const v2VerifyPassword = async (plainPassword, storedPassword, queryRunner = pool) => {
  const plain = String(plainPassword ?? '');
  const stored = String(storedPassword ?? '');

  if (!plain || !stored) return false;
  if (plain === stored) return true;
  if (!v2IsBcryptHash(stored)) return false;

  const result = await queryRunner.query(
    'SELECT crypt($1::text, $2::text) = $2::text AS ok',
    [plain, stored]
  );

  return Boolean(result.rows?.[0]?.ok);
};

const v2BuildPasswordForStorage = async (plainPassword, queryRunner = pool) => {
  const safePassword = String(plainPassword ?? '');
  if (!safePassword) throw new Error('La contrasena no puede estar vacia');

  if (USUARIOS_V2_LOGIN_EXPECTS_PLAIN_PASSWORD) {
    // TODO: migrar login legacy a bcrypt.compare y cambiar esta rama a hash seguro.
    return safePassword;
  }

  return v2HashPasswordBcrypt(safePassword, queryRunner);
};

const v2GenerateTemporaryPassword = async () => {
  const { randomInt } = await import('node:crypto');
  const length = randomInt(10, 13);

  let output = '';
  for (let i = 0; i < length; i += 1) {
    const idx = randomInt(0, USUARIOS_V2_PASSWORD_ALPHABET.length);
    output += USUARIOS_V2_PASSWORD_ALPHABET[idx];
  }

  return output;
};

const v2GetCapabilities = async () => {
  if (!usuariosV2CapabilitiesPromise) {
    usuariosV2CapabilitiesPromise = (async () => {
      const columnsResult = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'usuarios'
      `);

      const columns = new Set(columnsResult.rows.map((row) => row.column_name));
      const mustChangeFieldCandidates = [
        'must_change_password',
        'debe_cambiar_clave',
        'requiere_cambio_clave',
        'force_password_change',
        'password_temporal',
      ];

      const mustChangePasswordField =
        mustChangeFieldCandidates.find((field) => columns.has(field)) || null;

      return {
        columns,
        hasEstado: columns.has('estado'),
        hasFotoPerfil: columns.has('foto_perfil'),
        hasFechaCreacion: columns.has('fecha_creacion'),
        mustChangePasswordField,
      };
    })().catch((error) => {
      usuariosV2CapabilitiesPromise = null;
      throw error;
    });
  }

  return usuariosV2CapabilitiesPromise;
};

const v2MapUsuarioRow = (row) => {
  if (!row) return null;

  const empleado = {
    id_empleado: row.id_empleado ?? null,
    nombre_completo: v2NormalizeText(row.nombre_completo),
    dni: row.dni ?? null,
    telefono: row.telefono ?? null,
    correo: row.correo ?? null,
    sucursal: row.sucursal_nombre ?? null,
    sucursal_nombre: row.sucursal_nombre ?? null,
  };

  const rolId = row.id_rol ?? row.rol_id ?? null;
  const rolNombre = row.rol_nombre ?? row.nombre_rol ?? row.nombre_rol_usuario ?? null;
  const rol = rolId
    ? {
      id_rol: Number(rolId),
      nombre: v2NormalizeText(rolNombre) || null,
    }
    : null;

  return {
    id_usuario: row.id_usuario,
    nombre_usuario: row.nombre_usuario,
    estado: row.estado,
    foto_perfil: row.foto_perfil ?? '',
    fecha_creacion: row.fecha_creacion ?? null,
    id_empleado: row.id_empleado ?? null,
    nombre_completo: empleado.nombre_completo,
    dni: empleado.dni,
    telefono: empleado.telefono,
    correo: empleado.correo,
    sucursal_nombre: empleado.sucursal_nombre,
    rol,
    empleado,
  };
};

const v2FetchUsuarioById = async (idUsuario, queryRunner = pool) => {
  const query = `
    SELECT
      u.id_usuario,
      u.nombre_usuario,
      u.estado,
      u.foto_perfil,
      u.fecha_creacion,
      e.id_empleado,
      TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS nombre_completo,
      p.dni,
      t.telefono,
      c.direccion_correo AS correo,
      s.nombre_sucursal AS sucursal_nombre,
      ru.id_rol,
      r.nombre AS rol_nombre
    FROM usuarios u
    LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
    LEFT JOIN personas p ON p.id_persona = e.id_persona
    LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
    LEFT JOIN correos c ON c.id_correo = p.id_correo
    LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
    LEFT JOIN LATERAL (
      SELECT ru2.id_rol
      FROM roles_usuarios ru2
      WHERE ru2.id_usuario = u.id_usuario
      ORDER BY ru2.id_rol ASC
      LIMIT 1
    ) ru ON TRUE
    LEFT JOIN roles r ON r.id_rol = ru.id_rol
    WHERE u.id_usuario = $1
    LIMIT 1
  `;

  const result = await queryRunner.query(query, [idUsuario]);
  return v2MapUsuarioRow(result.rows[0] || null);
};

const v2UsernameExists = async (nombreUsuario, { excludeId = null, queryRunner = pool } = {}) => {
  const safeUsername = v2NormalizeText(nombreUsuario);
  if (!safeUsername) return false;

  if (excludeId) {
    const result = await queryRunner.query(
      'SELECT 1 FROM usuarios WHERE UPPER(nombre_usuario) = UPPER($1) AND id_usuario <> $2 LIMIT 1',
      [safeUsername, excludeId]
    );
    return result.rows.length > 0;
  }

  const result = await queryRunner.query(
    'SELECT 1 FROM usuarios WHERE UPPER(nombre_usuario) = UPPER($1) LIMIT 1',
    [safeUsername]
  );

  return result.rows.length > 0;
};

const v2BuildUniqueUsername = async ({ nombre, apellido, idEmpleado, queryRunner = pool }) => {
  const nombres = v2SplitWords(nombre);
  const apellidos = v2SplitWords(apellido);

  const primerNombre = nombres[0] || '';
  const segundoNombre = nombres[1] || '';
  const primerApellido = apellidos[0] || '';

  const base1 = `${primerNombre.slice(0, 1)}${primerApellido}` || `USR${idEmpleado}`;
  const base2 = segundoNombre ? `${primerNombre.slice(0, 1)}${segundoNombre.slice(0, 1)}${primerApellido}` : base1;

  const candidate1 = v2SanitizeUsernameToken(base1) || `USR${idEmpleado}`;
  const candidate2 = v2SanitizeUsernameToken(base2) || candidate1;

  if (!(await v2UsernameExists(candidate1, { queryRunner }))) {
    return candidate1;
  }

  if (candidate2 !== candidate1 && !(await v2UsernameExists(candidate2, { queryRunner }))) {
    return candidate2;
  }

  const baseForSuffix = candidate2 || candidate1;
  let suffix = 2;
  while (suffix <= 9999) {
    const candidate = `${baseForSuffix}${suffix}`;
    if (!(await v2UsernameExists(candidate, { queryRunner }))) {
      return candidate;
    }
    suffix += 1;
  }

  throw new Error('No se pudo generar un nombre de usuario unico');
};

const v2FindEmployeeForUser = async (idEmpleado, queryRunner = pool) => {
  const query = `
    SELECT
      e.id_empleado,
      p.nombre,
      p.apellido,
      p.dni,
      t.telefono,
      c.direccion_correo AS correo,
      s.nombre_sucursal AS sucursal_nombre
    FROM empleados e
    LEFT JOIN personas p ON p.id_persona = e.id_persona
    LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
    LEFT JOIN correos c ON c.id_correo = p.id_correo
    LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
    WHERE e.id_empleado = $1
    LIMIT 1
  `;

  const result = await queryRunner.query(query, [idEmpleado]);
  return result.rows[0] || null;
};

const v2FindRoleById = async (idRol, queryRunner = pool) => {
  const result = await queryRunner.query(
    'SELECT id_rol, nombre FROM roles WHERE id_rol = $1 LIMIT 1',
    [idRol]
  );
  return result.rows[0] || null;
};

router.get('/usuarios/v2/roles', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_rol, nombre FROM roles ORDER BY id_rol ASC'
    );
    return res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error en /usuarios/v2/roles:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.get('/usuarios/v2/list', async (req, res) => {
  try {
    const page = req.query.page === undefined ? 1 : v2ParsePositiveInt(req.query.page);
    const requestedLimit = req.query.limit === undefined ? 10 : v2ParsePositiveInt(req.query.limit);

    if (!page || !requestedLimit) {
      return res.status(400).json({ error: true, message: 'page y limit deben ser enteros positivos' });
    }

    const limit = Math.min(requestedLimit, USUARIOS_V2_MAX_LIMIT);
    const offset = (page - 1) * limit;
    const q = v2NormalizeText(req.query.q);

    const params = [];
    const whereParts = [];

    if (q) {
      params.push(`%${q}%`);
      whereParts.push(`(
        u.nombre_usuario ILIKE $${params.length}
        OR COALESCE(p.nombre, '') ILIKE $${params.length}
        OR COALESCE(p.apellido, '') ILIKE $${params.length}
        OR COALESCE(p.dni::text, '') ILIKE $${params.length}
        OR COALESCE(t.telefono, '') ILIKE $${params.length}
        OR COALESCE(c.direccion_correo, '') ILIKE $${params.length}
        OR COALESCE(s.nombre_sucursal, '') ILIKE $${params.length}
        OR COALESCE(r.nombre, '') ILIKE $${params.length}
      )`);
    }

    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
      LEFT JOIN LATERAL (
        SELECT ru2.id_rol
        FROM roles_usuarios ru2
        WHERE ru2.id_usuario = u.id_usuario
        ORDER BY ru2.id_rol ASC
        LIMIT 1
      ) ru ON TRUE
      LEFT JOIN roles r ON r.id_rol = ru.id_rol
      ${whereSql}
    `;

    const dataQuery = `
      SELECT
        u.id_usuario,
        u.nombre_usuario,
        u.estado,
        u.foto_perfil,
        u.fecha_creacion,
        e.id_empleado,
        TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))) AS nombre_completo,
        p.dni,
        t.telefono,
        c.direccion_correo AS correo,
        s.nombre_sucursal AS sucursal_nombre,
        ru.id_rol,
        r.nombre AS rol_nombre
      FROM usuarios u
      LEFT JOIN empleados e ON e.id_empleado = u.id_empleado
      LEFT JOIN personas p ON p.id_persona = e.id_persona
      LEFT JOIN telefonos t ON t.id_telefono = p.id_telefono
      LEFT JOIN correos c ON c.id_correo = p.id_correo
      LEFT JOIN sucursales s ON s.id_sucursal = e.id_sucursal
      LEFT JOIN LATERAL (
        SELECT ru2.id_rol
        FROM roles_usuarios ru2
        WHERE ru2.id_usuario = u.id_usuario
        ORDER BY ru2.id_rol ASC
        LIMIT 1
      ) ru ON TRUE
      LEFT JOIN roles r ON r.id_rol = ru.id_rol
      ${whereSql}
      ORDER BY u.id_usuario DESC
      LIMIT $${params.length + 1}
      OFFSET $${params.length + 2}
    `;

    const [countResult, dataResult] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(dataQuery, [...params, limit, offset]),
    ]);

    const total = countResult.rows?.[0]?.total || 0;
    const items = dataResult.rows.map(v2MapUsuarioRow);

    return res.status(200).json({
      error: false,
      items,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/list:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/usuarios/v2/create', async (req, res) => {
  const client = await pool.connect();

  try {
    const idEmpleado = v2ParsePositiveInt(req.body?.id_empleado);
    if (!idEmpleado) {
      return res.status(400).json({ error: true, message: 'id_empleado es obligatorio y debe ser positivo' });
    }

    const idRol = v2ParsePositiveInt(req.body?.id_rol);
    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol es obligatorio y debe ser positivo' });
    }

    let estado = true;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'estado')) {
      const parsedEstado = v2ParseBoolean(req.body.estado);
      if (parsedEstado === null) {
        return res.status(400).json({ error: true, message: 'estado debe ser booleano' });
      }
      estado = parsedEstado;
    }

    const plainPassword =
      v2NormalizeText(req.body?.password)
      || v2NormalizeText(req.body?.clave_plana);
    const passwordValidation = v2ValidateCreatePassword(plainPassword);
    if (!passwordValidation.ok) {
      return res.status(400).json({ error: true, message: passwordValidation.message });
    }

    await client.query('BEGIN');

    const role = await v2FindRoleById(idRol, client);
    if (!role) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'Rol no encontrado' });
    }

    const empleado = await v2FindEmployeeForUser(idEmpleado, client);
    if (!empleado) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Empleado no encontrado' });
    }

    const duplicateEmployee = await client.query(
      'SELECT id_usuario FROM usuarios WHERE id_empleado = $1 LIMIT 1',
      [idEmpleado]
    );

    if (duplicateEmployee.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'Empleado ya tiene usuario' });
    }

    const generatedUsername = await v2BuildUniqueUsername({
      nombre: empleado.nombre,
      apellido: empleado.apellido,
      idEmpleado,
      queryRunner: client,
    });

    const passwordForStorage = await v2BuildPasswordForStorage(plainPassword, client);
    const capabilities = await v2GetCapabilities();

    const insertColumns = ['nombre_usuario', 'clave', 'estado', 'id_empleado'];
    const insertValues = [generatedUsername, passwordForStorage, estado, idEmpleado];
    const insertFragments = insertValues.map((_, idx) => `$${idx + 1}`);

    if (capabilities.hasFechaCreacion) {
      insertColumns.push('fecha_creacion');
      insertFragments.push('NOW()');
    }

    if (capabilities.mustChangePasswordField) {
      insertColumns.push(capabilities.mustChangePasswordField);
      insertValues.push(true);
      insertFragments.push(`$${insertValues.length}`);
    }

    const insertResult = await client.query(
      `
        INSERT INTO usuarios (${insertColumns.join(', ')})
        VALUES (${insertFragments.join(', ')})
        RETURNING id_usuario
      `,
      insertValues
    );

    const idUsuarioCreado = insertResult.rows?.[0]?.id_usuario;
    if (!idUsuarioCreado) {
      throw new Error('No se pudo obtener el id del usuario creado');
    }

    await client.query(
      'INSERT INTO roles_usuarios (id_usuario, id_rol) VALUES ($1, $2)',
      [idUsuarioCreado, idRol]
    );

    const usuarioCreado = await v2FetchUsuarioById(idUsuarioCreado, client);

    await client.query('COMMIT');

    return res.status(201).json({
      error: false,
      message: 'Usuario creado exitosamente',
      usuario: usuarioCreado,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error en /usuarios/v2/create:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.put('/usuarios/v2/update/:id_usuario', async (req, res) => {
  const client = await pool.connect();
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const current = await v2FetchUsuarioById(idUsuario);
    if (!current) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const updates = [];
    const values = [];
    const hasRoleUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, 'id_rol');
    let nextRoleId = null;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'estado')) {
      const parsedEstado = v2ParseBoolean(req.body.estado);
      if (parsedEstado === null) {
        return res.status(400).json({ error: true, message: 'estado debe ser booleano' });
      }
      values.push(parsedEstado);
      updates.push(`estado = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'nombre_usuario')) {
      const nextNombreUsuario = v2SanitizeUsernameToken(req.body.nombre_usuario);
      if (!nextNombreUsuario) {
        return res.status(400).json({ error: true, message: 'nombre_usuario no es valido' });
      }

      const exists = await v2UsernameExists(nextNombreUsuario, { excludeId: idUsuario });
      if (exists) {
        return res.status(409).json({ error: true, message: 'El nombre_usuario ya existe' });
      }

      values.push(nextNombreUsuario);
      updates.push(`nombre_usuario = $${values.length}`);
    }

    if (hasRoleUpdate) {
      nextRoleId = v2ParsePositiveInt(req.body?.id_rol);
      if (!nextRoleId) {
        return res.status(400).json({ error: true, message: 'id_rol debe ser un entero positivo' });
      }

      const role = await v2FindRoleById(nextRoleId, client);
      if (!role) {
        return res.status(400).json({ error: true, message: 'Rol no encontrado' });
      }
    }

    if (!updates.length && !hasRoleUpdate) {
      return res.status(200).json({
        error: false,
        message: 'No hay cambios para actualizar',
        usuario: current,
      });
    }

    await client.query('BEGIN');

    if (updates.length) {
      values.push(idUsuario);
      await client.query(
        `UPDATE usuarios SET ${updates.join(', ')} WHERE id_usuario = $${values.length}`,
        values
      );
    }

    if (hasRoleUpdate && nextRoleId) {
      await client.query('DELETE FROM roles_usuarios WHERE id_usuario = $1', [idUsuario]);
      await client.query(
        'INSERT INTO roles_usuarios (id_usuario, id_rol) VALUES ($1, $2)',
        [idUsuario, nextRoleId]
      );
    }

    await client.query('COMMIT');

    const updated = await v2FetchUsuarioById(idUsuario);
    return res.status(200).json({
      error: false,
      message: 'Usuario actualizado correctamente',
      usuario: updated,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Error en /usuarios/v2/update/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.put('/usuarios/v2/photo/:id_usuario', async (req, res) => {
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'foto_perfil')) {
      return res.status(400).json({ error: true, message: 'foto_perfil es requerida' });
    }

    const fotoPerfil = req.body?.foto_perfil;
    console.log('foto_perfil length:', typeof fotoPerfil === 'string' ? fotoPerfil.length : null);

    const photoValidation = v2ValidatePhotoPayload(fotoPerfil);
    if (!photoValidation.ok) {
      return res.status(photoValidation.status || 400).json({ error: true, message: photoValidation.message });
    }

    const result = await pool.query(
      'UPDATE usuarios SET foto_perfil = $1 WHERE id_usuario = $2',
      [photoValidation.value, idUsuario]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const updated = await v2FetchUsuarioById(idUsuario);
    return res.status(200).json({
      error: false,
      message: 'Foto de perfil actualizada correctamente',
      usuario: updated,
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/photo/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.delete('/usuarios/v2/delete/:id_usuario', async (req, res) => {
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const capabilities = await v2GetCapabilities();

    if (capabilities.hasEstado) {
      const result = await pool.query(
        'UPDATE usuarios SET estado = FALSE WHERE id_usuario = $1',
        [idUsuario]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
      }

      return res.status(200).json({
        error: false,
        message: 'Usuario inactivado correctamente',
      });
    }

    const result = await pool.query(
      'DELETE FROM usuarios WHERE id_usuario = $1',
      [idUsuario]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    return res.status(200).json({ error: false, message: 'Usuario eliminado correctamente' });
  } catch (err) {
    console.error('Error en /usuarios/v2/delete/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/usuarios/v2/change-password', async (req, res) => {
  try {
    const idUsuarioBody = v2ParsePositiveInt(req.body?.id_usuario);
    const idUsuarioJwt = v2ParsePositiveInt(req.user?.id_usuario);
    const idUsuario = idUsuarioBody || idUsuarioJwt;

    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario es requerido' });
    }

    const claveActual =
      v2NormalizeText(req.body?.clave_actual)
      || v2NormalizeText(req.body?.password_actual);
    const claveNueva =
      v2NormalizeText(req.body?.clave_nueva)
      || v2NormalizeText(req.body?.password_nueva);

    if (!claveActual || !claveNueva) {
      return res.status(400).json({
        error: true,
        message: 'clave_actual y clave_nueva son requeridas',
      });
    }

    const userResult = await pool.query(
      'SELECT id_usuario, clave FROM usuarios WHERE id_usuario = $1 LIMIT 1',
      [idUsuario]
    );

    if (!userResult.rows.length) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const storedPassword = userResult.rows[0].clave;
    const passwordOk = await v2VerifyPassword(claveActual, storedPassword);

    if (!passwordOk) {
      return res.status(400).json({ error: true, message: 'La contrasena actual no es correcta' });
    }

    const samePassword = await v2VerifyPassword(claveNueva, storedPassword);
    if (samePassword) {
      return res.status(400).json({ error: true, message: 'La nueva contrasena no puede ser igual a la actual' });
    }

    const { validatePasswordPolicy } = await import('../utils/security/passwordPolicy.js');
    const policyCheck = await validatePasswordPolicy(claveNueva);
    if (!policyCheck?.ok) {
      return res.status(400).json({
        error: true,
        message: policyCheck?.message || 'La contrasena no cumple la politica',
      });
    }

    const capabilities = await v2GetCapabilities();
    const passwordForStorage = await v2BuildPasswordForStorage(claveNueva);

    const setParts = ['clave = $1'];
    const values = [passwordForStorage];

    if (capabilities.mustChangePasswordField) {
      setParts.push(`${capabilities.mustChangePasswordField} = FALSE`);
    }

    values.push(idUsuario);

    await pool.query(
      `UPDATE usuarios SET ${setParts.join(', ')} WHERE id_usuario = $${values.length}`,
      values
    );

    return res.status(200).json({
      error: false,
      message: 'Contrasena actualizada correctamente',
      must_change_password_supported: Boolean(capabilities.mustChangePasswordField),
      todo: capabilities.mustChangePasswordField
        ? null
        : 'TODO: agregar columna must_change_password en usuarios para forzar cambio en primer login',
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/change-password:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/usuarios/v2/generate', async (req, res) => {
  const client = await pool.connect();
  let createdUser = null;
  let temporaryPassword = '';

  try {
    const idEmpleado = v2ParsePositiveInt(req.body?.id_empleado);
    const idRol = v2ParsePositiveInt(req.body?.id_rol);

    if (!idEmpleado) {
      return res.status(400).json({ error: true, message: 'id_empleado es obligatorio y debe ser positivo' });
    }

    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol es obligatorio y debe ser positivo' });
    }

    await client.query('BEGIN');

    const role = await v2FindRoleById(idRol, client);
    if (!role) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: true, message: 'Rol no encontrado' });
    }

    const empleado = await v2FindEmployeeForUser(idEmpleado, client);
    if (!empleado) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: true, message: 'Empleado no encontrado' });
    }

    const duplicateEmployee = await client.query(
      'SELECT id_usuario FROM usuarios WHERE id_empleado = $1 LIMIT 1',
      [idEmpleado]
    );

    if (duplicateEmployee.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'Empleado ya tiene usuario' });
    }

    const generatedUsername = await v2BuildUniqueUsername({
      nombre: empleado.nombre,
      apellido: empleado.apellido,
      idEmpleado,
      queryRunner: client,
    });

    temporaryPassword = await v2GenerateTemporaryPassword();
    const passwordForStorage = await v2BuildPasswordForStorage(temporaryPassword, client);
    const capabilities = await v2GetCapabilities();

    const insertColumns = ['nombre_usuario', 'clave', 'estado', 'id_empleado'];
    const insertValues = [generatedUsername, passwordForStorage, true, idEmpleado];
    const insertFragments = insertValues.map((_, idx) => `$${idx + 1}`);

    if (capabilities.hasFechaCreacion) {
      insertColumns.push('fecha_creacion');
      insertFragments.push('NOW()');
    }

    if (capabilities.mustChangePasswordField) {
      insertColumns.push(capabilities.mustChangePasswordField);
      insertValues.push(true);
      insertFragments.push(`$${insertValues.length}`);
    }

    const insertResult = await client.query(
      `
        INSERT INTO usuarios (${insertColumns.join(', ')})
        VALUES (${insertFragments.join(', ')})
        RETURNING id_usuario
      `,
      insertValues
    );

    const idUsuarioCreado = insertResult.rows?.[0]?.id_usuario;
    if (!idUsuarioCreado) {
      throw new Error('No se pudo obtener el id del usuario creado');
    }

    await client.query(
      'INSERT INTO roles_usuarios (id_usuario, id_rol) VALUES ($1, $2)',
      [idUsuarioCreado, idRol]
    );

    createdUser = await v2FetchUsuarioById(idUsuarioCreado, client);
    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      usuario: {
        id_usuario: createdUser?.id_usuario,
        nombre_usuario: createdUser?.nombre_usuario,
        estado: createdUser?.estado,
        fecha_creacion: createdUser?.fecha_creacion,
        foto_perfil: createdUser?.foto_perfil || '',
        id_empleado: createdUser?.id_empleado,
      },
      temp_password: temporaryPassword,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('Error en /usuarios/v2/generate:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.post('/usuarios/v2/reset-password/:id_usuario', async (req, res) => {
  try {
    const idUsuario = v2ParsePositiveInt(req.params.id_usuario);
    if (!idUsuario) {
      return res.status(400).json({ error: true, message: 'id_usuario invalido' });
    }

    const currentUser = await v2FetchUsuarioById(idUsuario);
    if (!currentUser) {
      return res.status(404).json({ error: true, message: 'Usuario no encontrado' });
    }

    const temporaryPassword = await v2GenerateTemporaryPassword();
    const passwordForStorage = await v2BuildPasswordForStorage(temporaryPassword);
    const capabilities = await v2GetCapabilities();

    const setParts = ['clave = $1'];
    const values = [passwordForStorage];

    if (capabilities.mustChangePasswordField) {
      setParts.push(`${capabilities.mustChangePasswordField} = TRUE`);
    }

    values.push(idUsuario);

    await pool.query(
      `UPDATE usuarios SET ${setParts.join(', ')} WHERE id_usuario = $${values.length}`,
      values
    );

    return res.status(200).json({
      ok: true,
      nombre_usuario: currentUser?.nombre_usuario || null,
      temp_password: temporaryPassword,
    });
  } catch (err) {
    console.error('Error en /usuarios/v2/reset-password/:id_usuario:', err.message);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});
