import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const MENU_DEPARTAMENTOS_VIEW_PERMISSIONS = ['MENU_DEPARTAMENTOS_VER', 'MENU_VER'];
const MENU_DEPARTAMENTOS_CREATE_PERMISSIONS = ['MENU_DEPARTAMENTOS_CREAR', 'MENU_VER'];
const MENU_DEPARTAMENTOS_EDIT_PERMISSIONS = ['MENU_DEPARTAMENTOS_EDITAR', 'MENU_VER'];
const MENU_DEPARTAMENTOS_DELETE_PERMISSIONS = ['MENU_DEPARTAMENTOS_ELIMINAR', 'MENU_VER'];
const TIPO_DEPARTAMENTO_EDITABLE_FIELDS = Object.freeze({
  nombre_departamento: 'nombre_departamento',
  descripcion: 'descripcion',
  codigo_departamento: 'codigo_departamento',
  orden_menu: 'orden_menu',
  estado: 'estado',
});

const normalizeText = (value) => String(value ?? '').trim();

const normalizeDepartmentCode = (value) =>
  normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);

const parsePositiveInteger = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseBooleanStrict = (value) => {
  if (value === true || value === false) return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
};

const validateTipoDepartamentoPayload = (payload, { partial = false } = {}) => {
  const source = payload || {};
  const normalized = {};

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'nombre_departamento')) {
    const nombre = normalizeText(source.nombre_departamento);
    if (!nombre) return { error: 'NOMBRE_DEPARTAMENTO ES OBLIGATORIO' };
    if (nombre.length > 50) return { error: 'NOMBRE_DEPARTAMENTO NO PUEDE EXCEDER 50 CARACTERES' };
    normalized.nombre_departamento = nombre;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'descripcion')) {
    const descripcion = normalizeText(source.descripcion);
    if (descripcion.length > 50) return { error: 'DESCRIPCION NO PUEDE EXCEDER 50 CARACTERES' };
    normalized.descripcion = descripcion;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'codigo_departamento')) {
    const fallbackName = normalized.nombre_departamento || source.nombre_departamento;
    const codigo = normalizeDepartmentCode(source.codigo_departamento || fallbackName);
    if (!codigo) return { error: 'CODIGO_DEPARTAMENTO ES OBLIGATORIO' };
    if (codigo.length > 80) return { error: 'CODIGO_DEPARTAMENTO NO PUEDE EXCEDER 80 CARACTERES' };
    normalized.codigo_departamento = codigo;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'orden_menu')) {
    const ordenMenu = parsePositiveInteger(source.orden_menu);
    if (ordenMenu === null) return { error: 'ORDEN_MENU DEBE SER UN ENTERO POSITIVO' };
    normalized.orden_menu = ordenMenu;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'estado')) {
    const estado = parseBooleanStrict(source.estado);
    if (estado === null) return { error: 'ESTADO DEBE SER BOOLEANO' };
    normalized.estado = estado;
  }

  return { value: normalized };
};

const ensureUniqueTipoDepartamento = async ({ nombre, codigo, idToIgnore = null }) => {
  if (nombre) {
    const result = await pool.query(
      `
        SELECT id_tipo_departamento
        FROM tipo_departamento
        WHERE regexp_replace(upper(trim(nombre_departamento)), '\\s+', '', 'g') =
              regexp_replace(upper(trim($1)), '\\s+', '', 'g')
          AND ($2::int IS NULL OR id_tipo_departamento <> $2::int)
        LIMIT 1
      `,
      [nombre, idToIgnore]
    );
    if (result.rowCount > 0) return 'YA EXISTE UN DEPARTAMENTO CON ESE NOMBRE';
  }

  if (codigo) {
    const result = await pool.query(
      `
        SELECT id_tipo_departamento
        FROM tipo_departamento
        WHERE upper(trim(codigo_departamento)) = upper(trim($1))
          AND ($2::int IS NULL OR id_tipo_departamento <> $2::int)
        LIMIT 1
      `,
      [codigo, idToIgnore]
    );
    if (result.rowCount > 0) return 'YA EXISTE UN DEPARTAMENTO CON ESE CODIGO';
  }

  return '';
};

// =====================================================
// GET: LISTAR TIPO_DEPARTAMENTO
// =====================================================
router.get('/tipo_departamento', checkPermission(MENU_DEPARTAMENTOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id_tipo_departamento,
        nombre_departamento,
        descripcion,
        estado,
        orden_menu,
        codigo_departamento
      FROM tipo_departamento
      ORDER BY orden_menu ASC NULLS LAST, nombre_departamento ASC
    `);

    return res.status(200).json(result.rows || []);
  } catch (err) {
    console.error('ERROR GET /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: 'NO SE PUDO LISTAR TIPO_DEPARTAMENTO' });
  }
});

// =====================================================
// POST: CREAR TIPO_DEPARTAMENTO
// BODY ESPERADO (EJEMPLO):
// { "nombre_departamento": "Hamburguesas", "descripcion": "...", "estado": true }
// =====================================================
router.post('/tipo_departamento', checkPermission(MENU_DEPARTAMENTOS_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const validation = validateTipoDepartamentoPayload(req.body);
    if (validation.error) {
      return res.status(400).json({ error: true, message: validation.error });
    }

    const datos = validation.value;
    const duplicateMessage = await ensureUniqueTipoDepartamento({
      nombre: datos.nombre_departamento,
      codigo: datos.codigo_departamento,
    });
    if (duplicateMessage) {
      return res.status(409).json({ error: true, message: duplicateMessage });
    }

    const result = await pool.query(
      `
        INSERT INTO tipo_departamento (
          nombre_departamento,
          descripcion,
          codigo_departamento,
          orden_menu,
          estado
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id_tipo_departamento,
          nombre_departamento,
          descripcion,
          estado,
          orden_menu,
          codigo_departamento
      `,
      [
        datos.nombre_departamento,
        datos.descripcion,
        datos.codigo_departamento,
        datos.orden_menu,
        datos.estado,
      ]
    );

    return res.status(201).json({
      message: 'TIPO_DEPARTAMENTO CREADO EXITOSAMENTE.',
      data: result.rows?.[0] || null,
    });
  } catch (err) {
    console.error('ERROR POST /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: 'NO SE PUDO CREAR TIPO_DEPARTAMENTO' });
  }
});

// =====================================================
// PUT: ACTUALIZAR (1 CAMPO POR PETICION)
// BODY ESPERADO:
// {
//   "campo": "nombre_departamento",
//   "valor": "Tacos",
//   "id_campo": "id_tipo_departamento",
//   "id_valor": 2
// }
// =====================================================
router.put('/tipo_departamento', checkPermission(MENU_DEPARTAMENTOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || id_valor === undefined || !id_campo) {
      return res.status(400).json({ error: true, message: 'FALTAN CAMPOS OBLIGATORIOS' });
    }
    if (String(id_campo) !== 'id_tipo_departamento') {
      return res.status(400).json({ error: true, message: 'ID_CAMPO NO PERMITIDO' });
    }

    const column = TIPO_DEPARTAMENTO_EDITABLE_FIELDS[String(campo || '').trim()];
    if (!column) {
      return res.status(400).json({ error: true, message: 'CAMPO NO PERMITIDO' });
    }

    const idDepartamento = parsePositiveInteger(id_valor);
    if (idDepartamento === null) {
      return res.status(400).json({ error: true, message: 'ID_VALOR INVALIDO' });
    }

    const validation = validateTipoDepartamentoPayload({ [column]: valor }, { partial: true });
    if (validation.error) {
      return res.status(400).json({ error: true, message: validation.error });
    }

    const nextValue = validation.value[column];
    const duplicateMessage = await ensureUniqueTipoDepartamento({
      nombre: column === 'nombre_departamento' ? nextValue : '',
      codigo: column === 'codigo_departamento' ? nextValue : '',
      idToIgnore: idDepartamento,
    });
    if (duplicateMessage) {
      return res.status(409).json({ error: true, message: duplicateMessage });
    }

    const result = await pool.query(
      `
        UPDATE tipo_departamento
        SET ${column} = $1
        WHERE id_tipo_departamento = $2
        RETURNING
          id_tipo_departamento,
          nombre_departamento,
          descripcion,
          estado,
          orden_menu,
          codigo_departamento
      `,
      [nextValue, idDepartamento]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'TIPO_DEPARTAMENTO NO ENCONTRADO' });
    }

    return res.status(200).json({
      message: 'TIPO_DEPARTAMENTO ACTUALIZADO CORRECTAMENTE.',
      data: result.rows?.[0] || null,
    });
  } catch (err) {
    console.error('ERROR PUT /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: 'NO SE PUDO ACTUALIZAR TIPO_DEPARTAMENTO' });
  }
});

// =====================================================
// DELETE: ELIMINAR
// BODY ESPERADO:
// { "columna_id": "id_tipo_departamento", "valor_id": 2 }
// Nota: el submodulo administrativo nuevo no usa DELETE; inactiva/reactiva con PUT estado.
// =====================================================
router.delete('/tipo_departamento', checkPermission(MENU_DEPARTAMENTOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    // VALIDACION MINIMA
    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'FALTAN DATOS PARA ELIMINAR' });
    }

    const tabla = 'tipo_departamento';
    const query = 'CALL pa_delete($1, $2, $3)';

    await pool.query(query, [tabla, String(columna_id), String(valor_id)]);

    return res.status(200).json({ message: 'TIPO_DEPARTAMENTO ELIMINADO.' });
  } catch (err) {
    console.error('ERROR DELETE /tipo_departamento:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
