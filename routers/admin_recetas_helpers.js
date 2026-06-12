import pool from '../config/db-connection.js';

const NOMBRES_DEPARTAMENTOS_PRODUCTOS = new Set([
  'cervezas',
  'cerveza',
  'refrescos/agua',
  'helados sarita',
  'snacks',
  'snack'
]);

const normalizarNombreDepartamento = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .replace(/\s*\/\s*/g, '/')
  .replace(/\s+/g, ' ');

// Allowlist de campos permitidos para crear/actualizar recetas.
const CAMPOS_PERMITIDOS_RECETAS = new Set([
  'nombre_receta',
  'descripcion',
  'id_menu',
  'id_nivel_picante',
  'url_imagen_publica',
  'id_archivo',
  'id_usuario',
  'estado',
  'id_tipo_departamento',
  'precio'
]);

// Campos obligatorios para POST/PUT.
const CAMPOS_REQUERIDOS_RECETA = [
  'nombre_receta',
  'id_menu',
  'id_nivel_picante',
  'id_tipo_departamento',
  'precio',
  'estado',
  'id_usuario'
];

// Campos que aceptan NULL real en la tabla.
const CAMPOS_NULLABLES_RECETA = new Set(['descripcion', 'id_archivo']);

// Codigos SQLSTATE de conflicto para mapear a HTTP 409.
const CODIGOS_CONFLICTO_CONSTRAINT = new Set(['23503', '23505', '23514', '23502']);

// Query param opcional para incluir inactivos en listado admin.
export const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

const esVacio = (valor) =>
  valor === undefined ||
  valor === null ||
  (typeof valor === 'string' && valor.trim() === '');

export const esEnteroPositivo = (valor) => Number.isSafeInteger(valor) && valor > 0;

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

// Valida y normaliza cada campo permitido de recetas.
export function validarCampoReceta(campo, valor) {
  if (campo === 'nombre_receta') {
    if (typeof valor !== 'string') {
      return { valido: false, message: 'nombre_receta debe ser un texto.' };
    }

    const limpio = valor.trim();
    if (!limpio) {
      return { valido: false, message: 'nombre_receta es obligatorio.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'descripcion') {
    if (esVacio(valor)) return { valido: true, valor: null };
    if (typeof valor !== 'string') {
      return { valido: false, message: 'descripcion debe ser un texto.' };
    }
    return { valido: true, valor: valor.trim() };
  }

  if (campo === 'id_menu') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_menu debe ser un entero mayor a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'id_nivel_picante') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_nivel_picante debe ser un entero mayor a 0.' };
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

  if (campo === 'url_imagen_publica') {
    if (esVacio(valor)) return { valido: true, valor: null };
    if (typeof valor !== 'string') {
      return { valido: false, message: 'url_imagen_publica debe ser un texto.' };
    }

    const raw = valor.trim();
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { valido: false, message: 'url_imagen_publica debe iniciar con http:// o https://.' };
      }
      return { valido: true, valor: raw };
    } catch {
      return { valido: false, message: 'url_imagen_publica no es una URL valida.' };
    }
  }

  if (campo === 'id_usuario') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_usuario debe ser un entero mayor a 0.' };
    }
    return { valido: true, valor: numero };
  }

  if (campo === 'id_tipo_departamento') {
    const numero = Number(valor);
    if (!esEnteroPositivo(numero)) {
      return { valido: false, message: 'id_tipo_departamento debe ser un entero mayor a 0.' };
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

export function esErrorConflictoConstraint(err) {
  return Boolean(err?.code && CODIGOS_CONFLICTO_CONSTRAINT.has(err.code));
}

export function getSafeServerErrorMessage(err, fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') {
  return fallback;
}

export function validarEstructuraPayloadReceta(payload, { soloEstadoUsuario = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'Payload invalido.' };
  }

  const keys = Object.keys(payload);
  const unknown = keys.filter((k) => !CAMPOS_PERMITIDOS_RECETAS.has(k));
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

  const faltantes = CAMPOS_REQUERIDOS_RECETA.filter(
    (campo) => !Object.prototype.hasOwnProperty.call(payload, campo)
  );
  if (faltantes.length > 0) {
    return { ok: false, message: `Faltan campos obligatorios: ${faltantes.join(', ')}` };
  }

  return { ok: true };
}

export function normalizarPayloadReceta(payload) {
  const datosNormalizados = {};

  for (const campo of Object.keys(payload)) {
    const validacionCampo = validarCampoReceta(campo, payload[campo]);
    if (!validacionCampo.valido) {
      return { ok: false, message: validacionCampo.message };
    }
    datosNormalizados[campo] = validacionCampo.valor;
  }

  // Defaults explicitos para campos opcionales.
  if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'descripcion')) {
    datosNormalizados.descripcion = null;
  }

  return { ok: true, datos: datosNormalizados };
}

export async function existeUsuario(idUsuario) {
  const result = await pool.query('SELECT 1 FROM usuarios WHERE id_usuario = $1 LIMIT 1', [idUsuario]);
  return result.rowCount > 0;
}

export async function existeRecetaPorId(idReceta) {
  const result = await pool.query('SELECT 1 FROM recetas WHERE id_receta = $1 LIMIT 1', [idReceta]);
  return result.rowCount > 0;
}

export async function obtenerRecetaPorId(idReceta) {
  const result = await pool.query(
    `
      SELECT
        r.id_receta,
        r.nombre_receta,
        r.descripcion,
        r.fecha_modificacion,
        r.id_menu,
        r.id_nivel_picante,
        r.id_archivo,
        r.fecha_creacion,
        r.id_usuario,
        r.estado,
        r.id_tipo_departamento,
        r.precio,
        a.url_publica AS url_imagen_publica
      FROM recetas r
      LEFT JOIN archivos a
        ON a.id_archivo = r.id_archivo
       AND (a.estado = true OR a.estado IS NULL)
      WHERE r.id_receta = $1
      LIMIT 1
    `,
    [idReceta]
  );
  return result.rows[0] || null;
}

export async function validarReglasNegocioYFks(datosNormalizados, db = pool) {
  const idArchivo = Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo')
    ? datosNormalizados.id_archivo
    : null;
  const result = await db.query(
    `
      SELECT
        EXISTS(SELECT 1 FROM menu WHERE id_menu = $1) AS existe_menu,
        EXISTS(SELECT 1 FROM nivel_picante WHERE id_nivel_picante = $2) AS existe_nivel_picante,
        EXISTS(SELECT 1 FROM usuarios WHERE id_usuario = $3) AS existe_usuario,
        EXISTS(SELECT 1 FROM tipo_departamento WHERE id_tipo_departamento = $4) AS existe_tipo_departamento,
        CASE
          WHEN $5::integer IS NULL THEN true
          ELSE EXISTS(
            SELECT 1
            FROM archivos
            WHERE id_archivo = $5
              AND COALESCE(estado, true) = true
          )
        END AS existe_archivo
    `,
    [
      datosNormalizados.id_menu,
      datosNormalizados.id_nivel_picante,
      datosNormalizados.id_usuario,
      datosNormalizados.id_tipo_departamento,
      idArchivo
    ]
  );
  const fks = result.rows?.[0] || {};

  if (!fks.existe_menu) {
    return { ok: false, status: 400, message: 'id_menu no existe en menu.' };
  }

  if (datosNormalizados.id_nivel_picante !== null && !fks.existe_nivel_picante) {
    return { ok: false, status: 400, message: 'id_nivel_picante no existe en nivel_picante.' };
  }

  if (!fks.existe_usuario) {
    return { ok: false, status: 400, message: 'id_usuario no existe en usuarios.' };
  }

  if (!fks.existe_tipo_departamento) {
    return { ok: false, status: 400, message: 'id_tipo_departamento no existe en tipo_departamento.' };
  }

  if (idArchivo !== null && !fks.existe_archivo) {
    return { ok: false, status: 400, message: 'id_archivo no existe o esta inactivo en archivos.' };
  }

  const departamentosResult = await db.query(
    `
      SELECT id_tipo_departamento, nombre_departamento
      FROM tipo_departamento
      ORDER BY id_tipo_departamento ASC
    `
  );
  const primerIdPorNombre = new Map();
  for (const row of departamentosResult.rows || []) {
    const nombre = normalizarNombreDepartamento(row.nombre_departamento);
    const id = Number(row.id_tipo_departamento);
    if (nombre && esEnteroPositivo(id) && !primerIdPorNombre.has(nombre)) {
      primerIdPorNombre.set(nombre, id);
    }
  }
  const productDepartmentIds = [...NOMBRES_DEPARTAMENTOS_PRODUCTOS]
    .map((nombre) => primerIdPorNombre.get(nombre))
    .filter(esEnteroPositivo);
  if (productDepartmentIds.includes(Number(datosNormalizados.id_tipo_departamento))) {
    return {
      ok: false,
      status: 409,
      message: 'El id_tipo_departamento corresponde a productos y no puede asignarse a recetas.'
    };
  }

  return { ok: true };
}

export async function actualizarCampoReceta(client, idReceta, campo, valor) {
  // `pa_update` no maneja NULL real en todos los casos, por eso estos campos se limpian con UPDATE directo.
  if (valor === null && CAMPOS_NULLABLES_RECETA.has(campo)) {
    if (campo === 'descripcion') {
      await client.query('UPDATE recetas SET descripcion = NULL WHERE id_receta = $1', [idReceta]);
      return;
    }
    if (campo === 'id_archivo') {
      await client.query('UPDATE recetas SET id_archivo = NULL WHERE id_receta = $1', [idReceta]);
      return;
    }
  }

  await client.query(
    'CALL pa_update($1, $2, $3, $4, $5)',
    ['recetas', campo, String(valor), 'id_receta', String(idReceta)]
  );
}
