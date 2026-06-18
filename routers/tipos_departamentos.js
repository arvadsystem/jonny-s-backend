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
const INTEGER_MAX = 2147483647;

const normalizeDepartmentCode = (value) =>
  normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

const parsePositiveIntegerStrict = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed > INTEGER_MAX) return null;
  return parsed;
};

const parseBooleanStrict = (value) => {
  if (value === true || value === false) return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
};

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isScalarValue = (value) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);

const hasOwn = (source, key) => Object.prototype.hasOwnProperty.call(source, key);

const validateTipoDepartamentoPayload = (payload, { partial = false } = {}) => {
  const source = payload || {};
  const normalized = {};

  if (!partial || hasOwn(source, 'nombre_departamento')) {
    if (!isScalarValue(source.nombre_departamento)) return { error: 'NOMBRE_DEPARTAMENTO INVALIDO' };
    const nombre = normalizeText(source.nombre_departamento);
    if (!nombre) return { error: 'NOMBRE_DEPARTAMENTO ES OBLIGATORIO' };
    if (nombre.length > 50) return { error: 'NOMBRE_DEPARTAMENTO NO PUEDE EXCEDER 50 CARACTERES' };
    normalized.nombre_departamento = nombre;
  }

  if (!partial || hasOwn(source, 'descripcion')) {
    if (!isScalarValue(source.descripcion)) return { error: 'DESCRIPCION INVALIDA' };
    const descripcion = normalizeText(source.descripcion);
    if (descripcion.length > 50) return { error: 'DESCRIPCION NO PUEDE EXCEDER 50 CARACTERES' };
    normalized.descripcion = descripcion;
  }

  if (!partial || hasOwn(source, 'codigo_departamento')) {
    if (!isScalarValue(source.codigo_departamento)) return { error: 'CODIGO_DEPARTAMENTO INVALIDO' };
    const fallbackName = normalized.nombre_departamento || source.nombre_departamento;
    const codigo = normalizeDepartmentCode(source.codigo_departamento || fallbackName);
    if (!codigo) return { error: 'CODIGO_DEPARTAMENTO ES OBLIGATORIO' };
    if (codigo.length > 80) return { error: 'CODIGO_DEPARTAMENTO NO PUEDE EXCEDER 80 CARACTERES' };
    normalized.codigo_departamento = codigo;
  }

  if (!partial || hasOwn(source, 'orden_menu')) {
    if (!isScalarValue(source.orden_menu)) return { error: 'ORDEN_MENU INVALIDO' };
    const ordenMenu = parsePositiveIntegerStrict(source.orden_menu);
    if (ordenMenu === null) {
      return { error: 'ORDEN_MENU DEBE SER UN ENTERO POSITIVO ENTRE 1 Y 2147483647' };
    }
    normalized.orden_menu = ordenMenu;
  }

  if (!partial || hasOwn(source, 'estado')) {
    if (!isScalarValue(source.estado)) return { error: 'ESTADO INVALIDO' };
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

const normalizeUpdateChanges = (body) => {
  const legacyCampo = normalizeText(body?.campo);
  const hasCambios = hasOwn(body || {}, 'cambios');
  const rawCambios = hasCambios ? body.cambios : { [legacyCampo]: body?.valor };

  if (!hasCambios && !legacyCampo) {
    return { error: 'NO HAY CAMBIOS VALIDOS PARA ACTUALIZAR' };
  }
  if (!isPlainObject(rawCambios)) {
    return { error: 'CAMBIOS DEBE SER UN OBJETO PLANO' };
  }

  const entries = Object.entries(rawCambios);
  if (entries.length === 0) {
    return { error: 'NO HAY CAMBIOS VALIDOS PARA ACTUALIZAR' };
  }

  const payload = {};
  for (const [key, value] of entries) {
    const field = normalizeText(key);
    if (!field || field === '__proto__' || field === 'constructor') {
      return { error: 'CAMPO NO PERMITIDO' };
    }

    const column = TIPO_DEPARTAMENTO_EDITABLE_FIELDS[field];
    if (!column) {
      return { error: 'CAMPO NO PERMITIDO' };
    }

    if (!isScalarValue(value)) {
      return { error: 'VALOR INVALIDO' };
    }

    payload[column] = value;
  }

  const validation = validateTipoDepartamentoPayload(payload, { partial: true });
  if (validation.error) return validation;

  const normalizedEntries = Object.entries(validation.value);
  if (normalizedEntries.length === 0) {
    return { error: 'NO HAY CAMBIOS VALIDOS PARA ACTUALIZAR' };
  }

  return { value: validation.value };
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
    const { id_campo, id_valor } = req.body;

    if (id_valor === undefined || !id_campo) {
      return res.status(400).json({ error: true, message: 'FALTAN CAMPOS OBLIGATORIOS' });
    }
    if (String(id_campo) !== 'id_tipo_departamento') {
      return res.status(400).json({ error: true, message: 'ID_CAMPO NO PERMITIDO' });
    }

    const idDepartamento = parsePositiveIntegerStrict(id_valor);
    if (idDepartamento === null) {
      return res.status(400).json({ error: true, message: 'ID_VALOR INVALIDO' });
    }

    const changesValidation = normalizeUpdateChanges(req.body);
    if (changesValidation.error) {
      return res.status(400).json({ error: true, message: changesValidation.error });
    }

    const cambios = changesValidation.value;
    const duplicateMessage = await ensureUniqueTipoDepartamento({
      nombre: hasOwn(cambios, 'nombre_departamento') ? cambios.nombre_departamento : '',
      codigo: hasOwn(cambios, 'codigo_departamento') ? cambios.codigo_departamento : '',
      idToIgnore: idDepartamento,
    });
    if (duplicateMessage) {
      return res.status(409).json({ error: true, message: duplicateMessage });
    }

    const updateEntries = Object.entries(cambios);
    if (updateEntries.length === 0) {
      return res.status(400).json({ error: true, message: 'NO HAY CAMBIOS VALIDOS PARA ACTUALIZAR' });
    }
    const setClauses = updateEntries.map(([column], index) => `${column} = $${index + 1}`);
    const values = updateEntries.map(([, value]) => value);
    values.push(idDepartamento);

    const result = await pool.query(
      `
        UPDATE tipo_departamento
        SET ${setClauses.join(', ')}
        WHERE id_tipo_departamento = $${values.length}
        RETURNING
          id_tipo_departamento,
          nombre_departamento,
          descripcion,
          estado,
          orden_menu,
          codigo_departamento
      `,
      values
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
