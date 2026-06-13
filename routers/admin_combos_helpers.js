import pool from '../config/db-connection.js';
import { resolveMenuDepartmentIds } from './menu_departamentos.js';
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const schemaCache = new Map();

const CAMPOS_PERMITIDOS_COMBO = new Set([
  'id_menu',
  'nombre_combo',
  'descripcion',
  'cant_personas',
  'estado',
  'id_usuario',
  'id_archivo',
  'precio',
  'detalle'
]);

const CAMPOS_REQUERIDOS_COMBO = [
  'id_menu',
  'precio',
  'estado',
  'id_usuario'
];

const CODIGOS_CONFLICTO_CONSTRAINT = new Set(['23503', '23505', '23514', '23502']);

export const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

const esVacio = (valor) =>
  valor === undefined ||
  valor === null ||
  (typeof valor === 'string' && valor.trim() === '');

export const esEnteroPositivo = (valor) => Number.isSafeInteger(valor) && valor > 0;

export const normalizePositiveIdList = (value) => {
  const rawList = Array.isArray(value) ? value : [];
  return [...new Set(rawList
    .map((item) => Number.parseInt(String(item ?? '').trim(), 10))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
};

const hasTable = async (client, tableName) => {
  const key = `table:${String(tableName || '').trim().toLowerCase()}`;
  if (schemaCache.has(key)) return schemaCache.get(key);

  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  const exists = result.rowCount > 0;
  schemaCache.set(key, exists);
  return exists;
};

export const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

function normalizarBoolean(valor) {
  if (valor === true || valor === false) return { valido: true, valor };
  if (valor === 1 || valor === 0) return { valido: true, valor: valor === 1 };

  if (typeof valor === 'string') {
    const limpio = valor.trim().toLowerCase();
    if (limpio === 'true' || limpio === '1') return { valido: true, valor: true };
    if (limpio === 'false' || limpio === '0') return { valido: true, valor: false };
  }

  return { valido: false };
}

export function validarCampoCombo(campo, valor) {
  if (campo === 'nombre_combo') {
    if (typeof valor !== 'string') {
      return { valido: false, message: 'nombre_combo debe ser texto.' };
    }

    const limpio = valor.trim();
    if (!limpio) {
      return { valido: false, message: 'nombre_combo es obligatorio.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'descripcion') {
    if (esVacio(valor)) return { valido: true, valor: null };
    if (typeof valor !== 'string') {
      return { valido: false, message: 'descripcion debe ser texto.' };
    }

    const limpio = valor.trim();
    return { valido: true, valor: limpio || null };
  }

  if (campo === 'cant_personas') {
    if (esVacio(valor)) return { valido: true, valor: 1 };
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'cant_personas debe ser un entero mayor a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'id_menu') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_menu debe ser un entero mayor a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'id_usuario') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_usuario debe ser un entero mayor a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'id_archivo') {
    if (esVacio(valor)) return { valido: true, valor: null };
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_archivo debe ser un entero mayor a 0 o null/vacio.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'precio') {
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) {
      return { valido: false, message: 'precio debe ser un numero mayor o igual a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'estado') {
    const bool = normalizarBoolean(valor);
    if (!bool.valido) {
      return { valido: false, message: 'estado debe ser boolean (true/false, "true"/"false" o 1/0).' };
    }
    return { valido: true, valor: bool.valor };
  }

  return { valido: false, message: `El campo ${campo} no esta permitido.` };
}

/**
 * Valida y normaliza el detalle del combo.
 * - Evita duplicados activos por id_receta.
 * - Estandariza cantidad/orden a enteros positivos.
 */
export function normalizarDetalleCombo(detalle) {
  if (detalle === undefined) {
    return { ok: true, provided: false, data: [] };
  }

  if (!Array.isArray(detalle)) {
    return { ok: false, message: 'detalle debe ser un arreglo.' };
  }

  const normalized = [];
  const recetasUnicas = new Set();

  for (const item of detalle) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: 'Cada item de detalle debe ser un objeto valido.' };
    }

    const idReceta = Number(item.id_receta);
    const cantidad = Number(item.cantidad ?? 1);
    const ordenRaw = item.orden === undefined || item.orden === null || item.orden === '' ? null : Number(item.orden);

    if (!esEnteroPositivo(idReceta)) {
      return { ok: false, message: 'Cada item de detalle requiere id_receta entero mayor a 0.' };
    }
    if (!esEnteroPositivo(cantidad)) {
      return { ok: false, message: 'Cada item de detalle requiere cantidad entera mayor a 0.' };
    }
    if (ordenRaw !== null && !esEnteroPositivo(ordenRaw)) {
      return { ok: false, message: 'orden debe ser entero mayor a 0 cuando se envia.' };
    }
    if (recetasUnicas.has(idReceta)) {
      return { ok: false, message: `No se permite repetir id_receta ${idReceta} en detalle.` };
    }

    recetasUnicas.add(idReceta);
    normalized.push({
      id_receta: idReceta,
      cantidad,
      orden: ordenRaw
    });
  }

  return { ok: true, provided: true, data: normalized };
}

export function validarEstructuraPayloadCombo(payload, { soloEstadoUsuario = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'Payload invalido.' };
  }

  const keys = Object.keys(payload);
  const unknown = keys.filter((k) => !CAMPOS_PERMITIDOS_COMBO.has(k));
  if (unknown.length > 0) {
    return { ok: false, message: `Campos no permitidos: ${unknown.join(', ')}` };
  }

  if (soloEstadoUsuario) {
    const required = ['estado', 'id_usuario'];
    const faltantes = required.filter((campo) => !Object.prototype.hasOwnProperty.call(payload, campo));
    if (faltantes.length > 0) {
      return { ok: false, message: `Faltan campos obligatorios: ${faltantes.join(', ')}` };
    }

    const extras = keys.filter((campo) => !required.includes(campo));
    if (extras.length > 0) {
      return {
        ok: false,
        message: `PATCH /estado solo permite: estado, id_usuario. Campos extras: ${extras.join(', ')}`
      };
    }

    return { ok: true };
  }

  const faltantes = CAMPOS_REQUERIDOS_COMBO.filter(
    (campo) => !Object.prototype.hasOwnProperty.call(payload, campo)
  );
  if (faltantes.length > 0) {
    return { ok: false, message: `Faltan campos obligatorios: ${faltantes.join(', ')}` };
  }

  return { ok: true };
}

const getComboDepartmentId = async () => {
  const departmentIds = await resolveMenuDepartmentIds();
  const comboDepartmentId = Number(departmentIds?.comboDepartmentId);
  if (!esEnteroPositivo(comboDepartmentId)) {
    throw new Error('No existe tipo_departamento "Combos".');
  }
  return comboDepartmentId;
};

export async function normalizarPayloadCombo(payload) {
  const datosNormalizados = {};

  for (const campo of Object.keys(payload)) {
    if (campo === 'detalle') continue;

    const validacionCampo = validarCampoCombo(campo, payload[campo]);
    if (!validacionCampo.valido) {
      return { ok: false, message: validacionCampo.message };
    }
    datosNormalizados[campo] = validacionCampo.valor;
  }

  if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'cant_personas')) {
    datosNormalizados.cant_personas = 1;
  }
  if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo')) {
    datosNormalizados.id_archivo = null;
  }

  // Compatibilidad: acepta payloads legacy con "descripcion" como nombre visible.
  // Nuevo estandar: nombre_combo es el campo principal del titulo del combo.
  const nombreCombo = String(datosNormalizados.nombre_combo || '').trim();
  const descripcion = String(datosNormalizados.descripcion || '').trim();
  const nombreFinal = nombreCombo || descripcion;
  if (!nombreFinal) {
    return { ok: false, message: 'nombre_combo es obligatorio.' };
  }
  datosNormalizados.nombre_combo = nombreFinal;
  if (!descripcion) {
    datosNormalizados.descripcion = nombreFinal;
  }

  // Regla explicita del proyecto: los combos siempre se asignan al departamento "Combos".
  datosNormalizados.id_tipo_departamento = await getComboDepartmentId();

  return { ok: true, datos: datosNormalizados };
}

export function esErrorConflictoConstraint(err) {
  return Boolean(err?.code && CODIGOS_CONFLICTO_CONSTRAINT.has(err.code));
}

export function getSafeServerErrorMessage(err, fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') {
  return fallback;
}

async function existeMenu(idMenu) {
  const result = await pool.query('SELECT 1 FROM menu WHERE id_menu = $1 LIMIT 1', [idMenu]);
  return result.rowCount > 0;
}

export async function existeUsuario(idUsuario) {
  const result = await pool.query('SELECT 1 FROM usuarios WHERE id_usuario = $1 LIMIT 1', [idUsuario]);
  return result.rowCount > 0;
}

async function existeArchivo(idArchivo) {
  const result = await pool.query('SELECT 1 FROM archivos WHERE id_archivo = $1 LIMIT 1', [idArchivo]);
  return result.rowCount > 0;
}

async function existeReceta(idReceta) {
  const result = await pool.query('SELECT 1 FROM recetas WHERE id_receta = $1 LIMIT 1', [idReceta]);
  return result.rowCount > 0;
}

async function obtenerRecetasExistentes(recetaIds = []) {
  const ids = [...new Set((Array.isArray(recetaIds) ? recetaIds : []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return new Set();

  const result = await pool.query(
    `
      SELECT id_receta
      FROM recetas
      WHERE id_receta = ANY($1::int[])
    `,
    [ids]
  );

  return new Set((result.rows || []).map((row) => Number(row.id_receta)).filter((id) => Number.isInteger(id) && id > 0));
}

export async function existeComboPorId(idCombo) {
  const result = await pool.query('SELECT 1 FROM combos WHERE id_combo = $1 LIMIT 1', [idCombo]);
  return result.rowCount > 0;
}

export async function validateComboAlmacenes(client, idAlmacenes = []) {
  const normalized = normalizePositiveIdList(idAlmacenes);
  if (normalized.length === 0) {
    return { ok: false, status: 400, message: 'Selecciona al menos un almacén para el combo.' };
  }

  const tableExists = await hasTable(client, 'menu_combo_almacenes');
  if (!tableExists) {
    return { ok: false, status: 500, message: 'La tabla de asignaciones de combos no está disponible en la base de datos.' };
  }

  const result = await client.query(
    `
      SELECT
        a.id_almacen,
        COALESCE(a.estado, true) AS estado,
        COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacén #', a.id_almacen::text)) AS nombre_almacen,
        s.id_sucursal,
        s.nombre_sucursal,
        COALESCE(s.estado, true) AS sucursal_estado
      FROM public.almacenes a
      INNER JOIN public.sucursales s
        ON s.id_sucursal = a.id_sucursal
      WHERE a.id_almacen = ANY($1::int[])
    `,
    [normalized]
  );

  const rows = result.rows || [];
  const found = new Set(rows.map((row) => Number(row.id_almacen)));
  const missing = normalized.filter((id) => !found.has(id));
  if (missing.length) {
    return { ok: false, status: 400, message: `Almacenes inválidos: ${missing.join(', ')}` };
  }

  const branchMap = new Map();
  for (const row of rows) {
    if (row.estado !== true || row.sucursal_estado !== true) {
      return { ok: false, status: 409, message: 'Todos los almacenes seleccionados deben estar activos.' };
    }
    const idSucursal = Number(row.id_sucursal);
    if (branchMap.has(idSucursal)) {
      return {
        ok: false,
        status: 409,
        code: 'COMBO_MULTIPLE_WAREHOUSES_SAME_BRANCH',
        message: 'Selecciona como máximo un almacén por sucursal.'
      };
    }
    branchMap.set(idSucursal, Number(row.id_almacen));
  }

  return { ok: true, rows };
}

export const replaceComboAlmacenes = async (client, idCombo, idAlmacenes = []) => {
  const normalized = normalizePositiveIdList(idAlmacenes);
  await client.query(
    `
      UPDATE public.menu_combo_almacenes
      SET estado = false,
          fecha_actualizacion = NOW()
      WHERE id_combo = $1
        AND NOT (id_almacen = ANY($2::int[]))
    `,
    [idCombo, normalized]
  );

  if (normalized.length === 0) return;

  await client.query(
    `
      INSERT INTO public.menu_combo_almacenes (id_combo, id_almacen, estado, fecha_actualizacion)
      SELECT $1, UNNEST($2::int[]), true, NOW()
      ON CONFLICT (id_combo, id_almacen)
      DO UPDATE SET
        estado = true,
        fecha_actualizacion = NOW()
    `,
    [idCombo, normalized]
  );
};

export const listComboAssignments = async (client, idCombo) => {
  try {
    const result = await client.query(
      `
        SELECT
          mca.id_combo,
          mca.id_almacen,
          COALESCE(mca.estado, true) AS estado,
          COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacén #', a.id_almacen::text)) AS nombre_almacen,
          a.id_sucursal,
          s.nombre_sucursal
        FROM public.menu_combo_almacenes mca
        INNER JOIN public.almacenes a
          ON a.id_almacen = mca.id_almacen
        INNER JOIN public.sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE mca.id_combo = $1
        ORDER BY s.nombre_sucursal ASC, COALESCE(NULLIF(TRIM(COALESCE(a.nombre, '')), ''), CONCAT('Almacén #', a.id_almacen::text)) ASC, a.id_almacen ASC
      `,
      [idCombo]
    );
    return result.rows || [];
  } catch (error) {
    if (error?.code === SQLSTATE_UNDEFINED_TABLE) return [];
    throw error;
  }
};

export const attachComboAlmacenes = async (client, rows = []) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;
  const ids = normalizePositiveIdList(list.map((row) => row?.id_combo));
  if (ids.length === 0) {
    return list.map((row) => ({ ...row, id_almacenes: [], total_almacenes: 0, total_sucursales: 0, nombres_sucursales: [] }));
  }

  try {
    const assignments = await client.query(
      `
        SELECT
          mca.id_combo,
          ARRAY_AGG(mca.id_almacen ORDER BY mca.id_almacen) FILTER (WHERE COALESCE(mca.estado, true) = true) AS id_almacenes,
          COUNT(*) FILTER (WHERE COALESCE(mca.estado, true) = true)::int AS total_almacenes,
          COUNT(DISTINCT a.id_sucursal) FILTER (WHERE COALESCE(mca.estado, true) = true)::int AS total_sucursales,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT s.nombre_sucursal) FILTER (WHERE COALESCE(mca.estado, true) = true), NULL) AS nombres_sucursales
        FROM public.menu_combo_almacenes mca
        INNER JOIN public.almacenes a
          ON a.id_almacen = mca.id_almacen
        INNER JOIN public.sucursales s
          ON s.id_sucursal = a.id_sucursal
        WHERE mca.id_combo = ANY($1::int[])
        GROUP BY mca.id_combo
      `,
      [ids]
    );

    const map = new Map((assignments.rows || []).map((row) => [
      Number(row.id_combo),
      {
        id_almacenes: normalizePositiveIdList(row.id_almacenes),
        total_almacenes: Number(row.total_almacenes || 0),
        total_sucursales: Number(row.total_sucursales || 0),
        nombres_sucursales: Array.isArray(row.nombres_sucursales) ? row.nombres_sucursales : []
      }
    ]));

    return list.map((row) => {
      const assignment = map.get(Number(row.id_combo));
      return {
        ...row,
        id_almacenes: assignment?.id_almacenes || [],
        total_almacenes: assignment?.total_almacenes || 0,
        total_sucursales: assignment?.total_sucursales || 0,
        nombres_sucursales: assignment?.nombres_sucursales || []
      };
    });
  } catch (error) {
    if (error?.code === SQLSTATE_UNDEFINED_TABLE) {
      return list.map((row) => ({ ...row, id_almacenes: [], total_almacenes: 0, total_sucursales: 0, nombres_sucursales: [] }));
    }
    throw error;
  }
};

export async function listarCombosAdmin() {
  const result = await pool.query(
    `
      SELECT
        c.id_combo,
        c.id_menu,
        COALESCE(NULLIF(c.nombre_combo, ''), NULLIF(c.descripcion, ''), CONCAT('Combo #', c.id_combo::text)) AS nombre_combo,
        c.descripcion,
        c.cant_personas,
        c.estado,
        c.fecha_creacion,
        c.id_usuario,
        c.id_archivo,
        c.precio,
        c.id_tipo_departamento,
        a.url_publica AS url_imagen_publica,
        COALESCE(d.total_detalle, 0)::int AS total_detalle
      FROM combos c
      LEFT JOIN archivos a
        ON a.id_archivo = c.id_archivo
       AND (a.estado = true OR a.estado IS NULL)
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS total_detalle
        FROM detalle_combo dc
        WHERE dc.id_combo = c.id_combo
          AND COALESCE(dc.estado, true) = true
      ) d ON true
      ORDER BY c.id_combo DESC
    `
  );

  return result.rows || [];
}

export async function obtenerComboPorId(idCombo, { includeInactiveDetail = true } = {}) {
  const headerResult = await pool.query(
    `
      SELECT
        c.id_combo,
        c.id_menu,
        COALESCE(NULLIF(c.nombre_combo, ''), NULLIF(c.descripcion, ''), CONCAT('Combo #', c.id_combo::text)) AS nombre_combo,
        c.descripcion,
        c.cant_personas,
        c.estado,
        c.fecha_creacion,
        c.id_usuario,
        c.id_archivo,
        c.precio,
        c.id_tipo_departamento,
        a.url_publica AS url_imagen_publica
      FROM combos c
      LEFT JOIN archivos a
        ON a.id_archivo = c.id_archivo
       AND (a.estado = true OR a.estado IS NULL)
      WHERE c.id_combo = $1
      LIMIT 1
    `,
    [idCombo]
  );

  if (headerResult.rowCount === 0) return null;

  const detalleResult = await pool.query(
    `
      SELECT
        dc.id_detalle_combo,
        dc.id_combo,
        dc.id_receta,
        r.nombre_receta,
        dc.cantidad,
        dc.orden,
        dc.estado,
        dc.fecha_creacion
      FROM detalle_combo dc
      INNER JOIN recetas r
        ON r.id_receta = dc.id_receta
      WHERE dc.id_combo = $1
        AND ($2::boolean = true OR COALESCE(dc.estado, true) = true)
      ORDER BY COALESCE(dc.orden, 2147483647), dc.id_detalle_combo
    `,
    [idCombo, includeInactiveDetail]
  );

  return {
    ...headerResult.rows[0],
    detalle: detalleResult.rows || []
  };
}

/**
 * Valida FKs del combo y de su detalle para evitar errores tardios en DB.
 */
export async function validarReglasNegocioYFks(datosNormalizados, detalle = []) {
  const existeFkMenu = await existeMenu(datosNormalizados.id_menu);
  if (!existeFkMenu) {
    return { ok: false, status: 400, message: 'id_menu no existe en menu.' };
  }

  const existeFkUsuario = await existeUsuario(datosNormalizados.id_usuario);
  if (!existeFkUsuario) {
    return { ok: false, status: 400, message: 'id_usuario no existe en usuarios.' };
  }

  if (datosNormalizados.id_archivo !== null) {
    const existeFkArchivo = await existeArchivo(datosNormalizados.id_archivo);
    if (!existeFkArchivo) {
      return { ok: false, status: 400, message: 'id_archivo no existe en archivos.' };
    }
  }

  const recetaIds = (Array.isArray(detalle) ? detalle : [])
    .map((item) => Number(item?.id_receta))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (recetaIds.length > 0) {
    const recetasExistentes = await obtenerRecetasExistentes(recetaIds);
    const recetaFaltante = recetaIds.find((id) => !recetasExistentes.has(id));
    if (recetaFaltante) {
      return { ok: false, status: 400, message: `id_receta no existe: ${recetaFaltante}` };
    }
  }

  return { ok: true };
}

const insertDetalleRows = async (client, idCombo, detalle) => {
  const rows = (Array.isArray(detalle) ? detalle : [])
    .map((item) => ({
      id_receta: Number(item?.id_receta || 0),
      cantidad: Number(item?.cantidad || 1),
      orden: Number(item?.orden || 1)
    }))
    .filter((item) => Number.isInteger(item.id_receta) && item.id_receta > 0);

  if (rows.length === 0) return;

  await client.query(
    `
      INSERT INTO detalle_combo (
        id_combo,
        id_receta,
        cantidad,
        orden,
        estado,
        fecha_creacion
      )
      SELECT
        $1,
        item.id_receta,
        item.cantidad,
        item.orden,
        true,
        timezone('America/Tegucigalpa', now())
      FROM jsonb_to_recordset($2::jsonb) AS item(
        id_receta int,
        cantidad int,
        orden int
      )
    `,
    [idCombo, JSON.stringify(rows)]
  );
};

export async function existeRecetaPorId(idReceta) {
  return existeReceta(idReceta);
}

export async function crearComboConDetalle(client, datosNormalizados, detalle) {
  const insertComboResult = await client.query(
    `
      INSERT INTO combos (
        id_menu,
        nombre_combo,
        descripcion,
        cant_personas,
        estado,
        id_usuario,
        id_archivo,
        precio,
        id_tipo_departamento
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id_combo
    `,
    [
      datosNormalizados.id_menu,
      datosNormalizados.nombre_combo,
      datosNormalizados.descripcion,
      datosNormalizados.cant_personas,
      datosNormalizados.estado,
      datosNormalizados.id_usuario,
      datosNormalizados.id_archivo,
      datosNormalizados.precio,
      datosNormalizados.id_tipo_departamento
    ]
  );

  const idCombo = Number(insertComboResult.rows[0]?.id_combo || 0);

  if (Array.isArray(detalle) && detalle.length > 0) {
    await insertDetalleRows(client, idCombo, detalle);
  }

  return idCombo;
}

export async function actualizarComboConDetalle(client, idCombo, datosNormalizados, detalle, { replaceDetalle = false } = {}) {
  await client.query(
    `
      UPDATE combos
      SET
        id_menu = $2,
        nombre_combo = $3,
        descripcion = $4,
        cant_personas = $5,
        estado = $6,
        id_usuario = $7,
        id_archivo = $8,
        precio = $9,
        id_tipo_departamento = $10
      WHERE id_combo = $1
    `,
    [
      idCombo,
      datosNormalizados.id_menu,
      datosNormalizados.nombre_combo,
      datosNormalizados.descripcion,
      datosNormalizados.cant_personas,
      datosNormalizados.estado,
      datosNormalizados.id_usuario,
      datosNormalizados.id_archivo,
      datosNormalizados.precio,
      datosNormalizados.id_tipo_departamento
    ]
  );

  if (replaceDetalle) {
    await client.query(
      `
        UPDATE detalle_combo
        SET estado = false
        WHERE id_combo = $1
          AND COALESCE(estado, true) = true
      `,
      [idCombo]
    );

    if (Array.isArray(detalle) && detalle.length > 0) {
      await insertDetalleRows(client, idCombo, detalle);
    }
  }
}

export async function actualizarEstadoCombo(client, idCombo, estado, idUsuario) {
  await client.query(
    `
      UPDATE combos
      SET
        estado = $2,
        id_usuario = $3
      WHERE id_combo = $1
    `,
    [idCombo, estado, idUsuario]
  );
}

export async function agregarDetalleCombo(client, idCombo, detalleItem) {
  const result = await client.query(
    `
      INSERT INTO detalle_combo (
        id_combo,
        id_receta,
        cantidad,
        orden,
        estado,
        fecha_creacion
      ) VALUES ($1, $2, $3, $4, true, timezone('America/Tegucigalpa', now()))
      RETURNING id_detalle_combo, id_combo, id_receta, cantidad, orden, estado, fecha_creacion
    `,
    [idCombo, detalleItem.id_receta, detalleItem.cantidad, detalleItem.orden]
  );

  return result.rows[0] || null;
}

export async function desactivarDetalleCombo(client, idCombo, idDetalleCombo) {
  const result = await client.query(
    `
      UPDATE detalle_combo
      SET estado = false
      WHERE id_combo = $1
        AND id_detalle_combo = $2
        AND COALESCE(estado, true) = true
      RETURNING id_detalle_combo, id_combo, id_receta, cantidad, orden, estado, fecha_creacion
    `,
    [idCombo, idDetalleCombo]
  );

  return result.rows[0] || null;
}

export async function listarRecetasParaCombos() {
  const result = await pool.query(
    `
      SELECT
        id_receta,
        nombre_receta,
        precio,
        estado,
        id_tipo_departamento
      FROM recetas
      ORDER BY nombre_receta
    `
  );

  const rows = result.rows || [];
  return rows.filter(isRowActive);
}
