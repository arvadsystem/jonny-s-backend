import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const MAX_ROLE_DETAIL_LIMIT = 500;
const ROLES_PERMISOS_ROLES_LIST_PERMISSIONS = ['ROLES_PERMISOS_ROLES_LISTADO_VER'];
const ROLES_PERMISOS_ROLES_DETAIL_PERMISSIONS = ['ROLES_PERMISOS_ROLES_DETALLE_VER'];
const ROLES_PERMISOS_ROLES_CREATE_PERMISSIONS = ['ROLES_PERMISOS_ROLES_CREAR'];
const ROLES_PERMISOS_ROLES_EDIT_PERMISSIONS = ['ROLES_PERMISOS_ROLES_EDITAR'];
const ROLES_PERMISOS_ROLES_DELETE_PERMISSIONS = ['ROLES_PERMISOS_ROLES_ELIMINAR'];
const ROLES_PERMISOS_PERMISOS_LIST_PERMISSIONS = ['ROLES_PERMISOS_PERMISOS_LISTADO_VER'];
const ROLES_PERMISOS_PERMISOS_GUARDAR_PERMISSIONS = ['ROLES_PERMISOS_PERMISOS_GUARDAR', 'ROLES_PERMISOS_PERMISOS_TOGGLE'];
const ROLES_PERMISOS_AUDITORIA_PERMISSIONS = ['ROLES_PERMISOS_AUDITORIA_VER'];

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeRoleName = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();

const getRoleById = async (idRol, queryRunner = pool) => {
  const result = await queryRunner.query(
    `
      SELECT id_rol, nombre
      FROM roles
      WHERE id_rol = $1
      LIMIT 1
    `,
    [idRol]
  );

  return result.rows[0] || null;
};

const roleNameExists = async (nombre, { excludeId = null, queryRunner = pool } = {}) => {
  const params = [nombre];
  let where = 'LOWER(TRIM(nombre)) = LOWER(TRIM($1))';

  if (excludeId) {
    params.push(excludeId);
    where += ' AND id_rol <> $2';
  }

  const result = await queryRunner.query(
    `
      SELECT 1
      FROM roles
      WHERE ${where}
      LIMIT 1
    `,
    params
  );

  return result.rows.length > 0;
};

const getRoleImpact = async (idRol, queryRunner = pool) => {
  const [usuariosResult, permisosResult] = await Promise.all([
    queryRunner.query(
      `
        SELECT
          COUNT(*)::int AS total_usuarios,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'id_usuario', u.id_usuario,
                'nombre_usuario', u.nombre_usuario
              )
              ORDER BY u.id_usuario ASC
            ) FILTER (WHERE u.id_usuario IS NOT NULL),
            '[]'::json
          ) AS usuarios
        FROM roles_usuarios ru
        INNER JOIN usuarios u ON u.id_usuario = ru.id_usuario
        WHERE ru.id_rol = $1
      `,
      [idRol]
    ),
    queryRunner.query(
      `
        SELECT COUNT(*)::int AS total_permisos
        FROM roles_permisos
        WHERE id_rol = $1
      `,
      [idRol]
    )
  ]);

  const usuariosRow = usuariosResult.rows[0] || {};
  const permisosRow = permisosResult.rows[0] || {};
  const usuarios = Array.isArray(usuariosRow.usuarios) ? usuariosRow.usuarios : [];

  return {
    total_usuarios: Number(usuariosRow.total_usuarios || 0),
    total_permisos: Number(permisosRow.total_permisos || 0),
    usuarios: usuarios.slice(0, 10)
  };
};

// GET /api/roles-permisos/roles
router.get('/roles', checkPermission(ROLES_PERMISOS_ROLES_LIST_PERMISSIONS), async (_req, res) => {
  try {
    const sql = `
      SELECT
        r.id_rol,
        r.nombre,
        COUNT(rp.id_permiso)::int AS total_permisos
      FROM roles r
      LEFT JOIN roles_permisos rp ON rp.id_rol = r.id_rol
      GROUP BY r.id_rol, r.nombre
      ORDER BY r.id_rol
    `;

    const result = await pool.query(sql);
    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('GET /api/roles-permisos/roles error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

// GET /api/roles-permisos/permisos
router.get('/permisos', checkPermission(ROLES_PERMISOS_PERMISOS_LIST_PERMISSIONS), async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id_permiso, nombre_permiso, descripcion
        FROM permisos
        ORDER BY id_permiso
      `
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('GET /api/roles-permisos/permisos error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

// GET /api/roles-permisos/rol/:id_rol
router.get('/rol/:id_rol', checkPermission(ROLES_PERMISOS_ROLES_DETAIL_PERMISSIONS), async (req, res) => {
  try {
    const idRol = parsePositiveInt(req.params.id_rol);
    const page = parsePositiveInt(req.query.page) || 1;
    const limitInput = parsePositiveInt(req.query.limit) || 10;
    const limit = Math.min(limitInput, MAX_ROLE_DETAIL_LIMIT);
    const offset = (page - 1) * limit;
    const search = String(req.query.search ?? '').trim();
    const hasSearch = search.length > 0;

    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rol = await getRoleById(idRol);
    if (!rol) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM permisos p
        ${hasSearch ? 'WHERE p.nombre_permiso ILIKE $1 OR COALESCE(p.descripcion, \'\') ILIKE $1' : ''}
      `,
      hasSearch ? [`%${search}%`] : []
    );

    const total = Number(countResult.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const queryParams = [idRol];
    let searchParamRef = '';
    let limitParamRef = '$2';
    let offsetParamRef = '$3';

    if (hasSearch) {
      queryParams.push(`%${search}%`);
      searchParamRef = `WHERE p.nombre_permiso ILIKE $2 OR COALESCE(p.descripcion, '') ILIKE $2`;
      limitParamRef = '$3';
      offsetParamRef = '$4';
    }

    queryParams.push(limit);
    queryParams.push(offset);

    const permisosResult = await pool.query(
      `
        SELECT
          p.id_permiso,
          p.nombre_permiso,
          p.descripcion,
          CASE
            WHEN rp.id_rol IS NOT NULL THEN TRUE
            ELSE FALSE
          END AS asignado
        FROM permisos p
        LEFT JOIN roles_permisos rp
          ON rp.id_permiso = p.id_permiso
         AND rp.id_rol = $1
        ${searchParamRef}
        ORDER BY p.id_permiso
        LIMIT ${limitParamRef}
        OFFSET ${offsetParamRef}
      `,
      queryParams
    );

    const permisos = permisosResult.rows.map((permiso) => ({
      ...permiso,
      asignado: Boolean(permiso.asignado)
    }));

    return res.status(200).json({
      rol,
      pagination: {
        page,
        limit,
        total,
        totalPages
      },
      permisos
    });
  } catch (error) {
    console.error('GET /api/roles-permisos/rol/:id_rol error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

// PUT /api/roles-permisos/rol/:id_rol
router.put('/rol/:id_rol', checkPermission(ROLES_PERMISOS_PERMISOS_GUARDAR_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idRol = parsePositiveInt(req.params.id_rol);

    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rol = await getRoleById(idRol, client);
    if (!rol) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const permisosInput = req.body?.permisos;
    if (!Array.isArray(permisosInput)) {
      return res.status(400).json({ error: true, message: 'El campo permisos debe ser un arreglo' });
    }

    const parsedPermisos = permisosInput.map((item) => parsePositiveInt(item));
    if (parsedPermisos.some((idPermiso) => !idPermiso)) {
      return res.status(400).json({ error: true, message: 'Todos los permisos deben ser enteros positivos' });
    }

    const permisosUnicos = [...new Set(parsedPermisos)];

    if (permisosUnicos.length > 0) {
      const existentesResult = await client.query(
        `
          SELECT id_permiso
          FROM permisos
          WHERE id_permiso = ANY($1::int[])
        `,
        [permisosUnicos]
      );

      const existentes = new Set(existentesResult.rows.map((row) => Number(row.id_permiso)));
      const noValidos = permisosUnicos.filter((idPermiso) => !existentes.has(idPermiso));

      if (noValidos.length > 0) {
        return res.status(400).json({
          error: true,
          message: 'Uno o mas permisos no existen',
          permisos_invalidos: noValidos
        });
      }
    }

    await client.query('BEGIN');

    await client.query('DELETE FROM roles_permisos WHERE id_rol = $1', [idRol]);

    if (permisosUnicos.length > 0) {
      await client.query(
        `
          INSERT INTO roles_permisos (id_permiso, id_rol)
          SELECT p.id_permiso, $2
          FROM UNNEST($1::int[]) AS p(id_permiso)
        `,
        [permisosUnicos, idRol]
      );
    }

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Permisos del rol actualizados correctamente',
      id_rol: idRol,
      total_permisos: permisosUnicos.length
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }

    console.error('PUT /api/roles-permisos/rol/:id_rol error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

// GET /api/roles-permisos/rol/:id_rol/usuarios (opcional recomendado)
router.get('/rol/:id_rol/usuarios', checkPermission(ROLES_PERMISOS_ROLES_DETAIL_PERMISSIONS), async (req, res) => {
  try {
    const idRol = parsePositiveInt(req.params.id_rol);

    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rol = await getRoleById(idRol);
    if (!rol) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const result = await pool.query(
      `
        SELECT id_usuario
        FROM roles_usuarios
        WHERE id_rol = $1
        ORDER BY id_usuario
      `,
      [idRol]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error('GET /api/roles-permisos/rol/:id_rol/usuarios error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.post('/roles', checkPermission(ROLES_PERMISOS_ROLES_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const nombreNormalizado = normalizeRoleName(req.body?.nombre);
    if (!nombreNormalizado) {
      return res.status(400).json({ error: true, message: 'El nombre del rol es obligatorio' });
    }

    await client.query('BEGIN');
    await client.query('LOCK TABLE roles IN EXCLUSIVE MODE');

    if (await roleNameExists(nombreNormalizado, { queryRunner: client })) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'Ya existe un rol con ese nombre' });
    }

    const insertResult = await client.query(
      `
        INSERT INTO roles (nombre)
        VALUES ($1)
        RETURNING id_rol, nombre
      `,
      [nombreNormalizado]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      message: 'Rol creado correctamente',
      rol: {
        ...insertResult.rows[0],
        total_permisos: 0
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }

    console.error('POST /api/roles-permisos/roles error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.put('/rol/:id_rol/meta', checkPermission(ROLES_PERMISOS_ROLES_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idRol = parsePositiveInt(req.params.id_rol);
    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rolActual = await getRoleById(idRol, client);
    if (!rolActual) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const nombreNormalizado = normalizeRoleName(req.body?.nombre);
    if (!nombreNormalizado) {
      return res.status(400).json({ error: true, message: 'El nombre del rol es obligatorio' });
    }

    await client.query('BEGIN');
    await client.query('LOCK TABLE roles IN EXCLUSIVE MODE');

    if (await roleNameExists(nombreNormalizado, { excludeId: idRol, queryRunner: client })) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: true, message: 'Ya existe un rol con ese nombre' });
    }

    const result = await client.query(
      `
        UPDATE roles
        SET nombre = $1
        WHERE id_rol = $2
        RETURNING id_rol, nombre
      `,
      [nombreNormalizado, idRol]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Rol actualizado correctamente',
      rol: result.rows[0]
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('PUT /api/roles-permisos/rol/:id_rol/meta error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

router.get('/rol/:id_rol/impacto', checkPermission(ROLES_PERMISOS_AUDITORIA_PERMISSIONS), async (req, res) => {
  try {
    const idRol = parsePositiveInt(req.params.id_rol);
    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rol = await getRoleById(idRol);
    if (!rol) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const impacto = await getRoleImpact(idRol);
    return res.status(200).json({
      rol,
      impacto: {
        ...impacto,
        puede_eliminarse: impacto.total_usuarios === 0
      }
    });
  } catch (error) {
    console.error('GET /api/roles-permisos/rol/:id_rol/impacto error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  }
});

router.delete('/rol/:id_rol', checkPermission(ROLES_PERMISOS_ROLES_DELETE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();

  try {
    const idRol = parsePositiveInt(req.params.id_rol);
    if (!idRol) {
      return res.status(400).json({ error: true, message: 'id_rol invalido' });
    }

    const rol = await getRoleById(idRol, client);
    if (!rol) {
      return res.status(404).json({ error: true, message: 'Rol no encontrado' });
    }

    const impacto = await getRoleImpact(idRol, client);
    if (impacto.total_usuarios > 0) {
      return res.status(409).json({
        error: true,
        message: 'No se puede eliminar el rol porque tiene usuarios asignados',
        rol,
        impacto: {
          ...impacto,
          puede_eliminarse: false
        }
      });
    }

    await client.query('BEGIN');
    await client.query('DELETE FROM roles_permisos WHERE id_rol = $1', [idRol]);
    await client.query('DELETE FROM roles WHERE id_rol = $1', [idRol]);
    await client.query('COMMIT');

    return res.status(200).json({
      ok: true,
      message: 'Rol eliminado correctamente',
      rol,
      impacto: {
        ...impacto,
        puede_eliminarse: true
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }

    console.error('DELETE /api/roles-permisos/rol/:id_rol error:', error);
    return res.status(500).json({ error: true, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
});

export default router;

