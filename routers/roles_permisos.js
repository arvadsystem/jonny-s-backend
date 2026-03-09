import express from 'express';
import pool from '../config/db-connection.js';

const router = express.Router();

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

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

// GET /api/roles-permisos/roles
router.get('/roles', async (_req, res) => {
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
router.get('/permisos', async (_req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT id_permiso, nombre_permiso
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
router.get('/rol/:id_rol', async (req, res) => {
  try {
    const idRol = parsePositiveInt(req.params.id_rol);
    const page = parsePositiveInt(req.query.page) || 1;
    const limitInput = parsePositiveInt(req.query.limit) || 10;
    const limit = Math.min(limitInput, 50);
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
        ${hasSearch ? 'WHERE p.nombre_permiso ILIKE $1' : ''}
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
      searchParamRef = `WHERE p.nombre_permiso ILIKE $2`;
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
router.put('/rol/:id_rol', async (req, res) => {
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
router.get('/rol/:id_rol/usuarios', async (req, res) => {
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

export default router;

