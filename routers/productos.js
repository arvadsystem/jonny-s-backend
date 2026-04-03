import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';
import { resolveRequestUserSucursalScope } from '../utils/sucursalScope.js';

const router = express.Router();

// NUEVO: allowlist de campos para prevenir updates/inserts arbitrarios
const CAMPOS_PERMITIDOS_PRODUCTOS = new Set([
  'nombre_producto',
  'precio',
  'cantidad',
  'stock_minimo',
  'descripcion_producto',
  'fecha_ingreso_producto',
  'fecha_caducidad',
  'id_categoria_producto',
  'id_almacen',
  'id_tipo_departamento',
  'id_archivo_imagen_principal',
  'estado'
]);

// AM: allowlist extendida solo para altas masivas por multi-almacen.
// AM: mantiene el contrato original (`id_almacen`) y agrega `id_almacenes` sin abrir campos arbitrarios.
const CAMPOS_PERMITIDOS_PRODUCTOS_POST = new Set([
  ...CAMPOS_PERMITIDOS_PRODUCTOS,
  'id_almacenes'
]);

// NUEVO: codigos de conflicto SQL para responder 409 en constraints
const CODIGOS_CONFLICTO_CONSTRAINT = new Set(['23503', '23505', '23514', '23502']);
// NEW: codigo SQLSTATE de PostgreSQL para numeric/integer out of range.
// WHY: identificar y sanitizar respuestas cuando un valor excede el rango del tipo de la BD.
// IMPACT: solo manejo de errores en el router de Productos; no cambia consultas exitosas.
const CODIGO_SQL_OUT_OF_RANGE = '22003';
// NEW: limite superior de INTEGER (int4) usado por IDs en la BD/SPs actuales.
// WHY: bloquear IDs fuera de rango antes de ejecutar `pa_update` / `pa_delete`.
// IMPACT: valida requests invalidos y responde 400 en lugar de dejar que fallen con 500.
const MAX_INT32_DB_ID = 2147483647;
const SQLSTATE_UNDEFINED_TABLE = '42P01';
const PRODUCTOS_DUPLICATE_CONSTRAINT = 'uq_productos_nombre_categoria_departamento_norm';
const PRODUCTOS_DUPLICATE_MESSAGE = 'Ya existe un producto con el mismo nombre, categoría y departamento.';
const SINGLE_ALMACEN_TEMP_MESSAGE = 'Temporalmente solo se permite un almacén por producto o insumo.';
// NEW: query param opt-in para incluir inactivos en listados administrativos.
// WHY: el GET de productos debe devolver activos por defecto tras adoptar soft delete.
// IMPACT: mantiene compatibilidad con `?incluir_inactivos=1` sin crear endpoint nuevo.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// AM: parse opcional de IDs positivos para filtros de catalogo por sucursal/almacen.
const parseOptionalPositiveId = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  return esEnteroPositivoInt32(parsed) ? parsed : null;
};

// AM: normaliza lista de almacenes del item usando pivote (id_almacenes) o fallback legacy (id_almacen).
const resolveRowAlmacenes = (row) => {
  const fromArray = Array.isArray(row?.id_almacenes)
    ? row.id_almacenes
      .map((id) => Number.parseInt(String(id ?? ''), 10))
      .filter((id) => esEnteroPositivoInt32(id))
    : [];
  if (fromArray.length > 0) return Array.from(new Set(fromArray));

  const fallback = Number.parseInt(String(row?.id_almacen ?? ''), 10);
  return esEnteroPositivoInt32(fallback) ? [fallback] : [];
};

// AM: aplica filtros opcionales por id_sucursal/id_almacen para catalogos de OC sin romper contratos legacy.
const filterProductosByCatalogScope = async (rows, query, db = pool) => {
  const idAlmacen = parseOptionalPositiveId(query?.id_almacen);
  const idSucursal = parseOptionalPositiveId(query?.id_sucursal);
  const allowedSucursales = Array.isArray(query?._allowedSucursalIds) ? query._allowedSucursalIds : [];

  if ((query?.id_almacen ?? '') !== '' && query?.id_almacen !== undefined && idAlmacen === null) {
    return { ok: false, message: 'id_almacen invalido.' };
  }
  if ((query?.id_sucursal ?? '') !== '' && query?.id_sucursal !== undefined && idSucursal === null) {
    return { ok: false, message: 'id_sucursal invalido.' };
  }

  if (!idAlmacen && !idSucursal && allowedSucursales.length === 0) return { ok: true, rows };

  let allowedWarehouseSet = null;
  const targetSucursales = idSucursal ? [idSucursal] : allowedSucursales;
  
  if (targetSucursales.length > 0) {
    const allowed = await db.query(
      `
        SELECT a.id_almacen
        FROM public.almacenes a
        WHERE a.id_sucursal = ANY($1::int[])
          AND COALESCE(a.estado, true) = true
      `,
      [targetSucursales]
    );
    allowedWarehouseSet = new Set(
      (allowed.rows || [])
        .map((row) => Number.parseInt(String(row?.id_almacen ?? ''), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    );
  }

  const filtered = (Array.isArray(rows) ? rows : []).filter((row) => {
    const rowAlmacenes = resolveRowAlmacenes(row);
    
    // Si no tenemos un set de almacenes permitidos (Super Admin sin sucursal), 
    // mostramos todo lo que este activo.
    if (!allowedWarehouseSet && !idAlmacen) return true;

    if (rowAlmacenes.length === 0) return false;
    if (idAlmacen && !rowAlmacenes.includes(idAlmacen)) return false;
    if (allowedWarehouseSet && !rowAlmacenes.some((id) => allowedWarehouseSet.has(id))) return false;
    return true;
  });

  return { ok: true, rows: filtered };
};

// NUEVO: helper para detectar valores vacios en campos opcionales
const esVacio = (valor) =>
  valor === undefined ||
  valor === null ||
  (typeof valor === 'string' && valor.trim() === '');

// NUEVO: normaliza estado aceptando boolean, string y 1/0
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

// NEW: valida IDs enteros positivos compatibles con INT32 de PostgreSQL.
// WHY: `Number.isInteger` en JS acepta valores como Date.now() que luego fallan al castear a integer en la BD.
// IMPACT: prevencion temprana en PUT/DELETE de Productos; payloads validos siguen igual.
function esEnteroPositivoInt32(valor) {
  return Number.isSafeInteger(valor) && valor > 0 && valor <= MAX_INT32_DB_ID;
}

// AM: normaliza `id_almacen` / `id_almacenes` para soportar asignacion a uno o varios almacenes.
// AM: se usa en create/edit multi para mantener compatibilidad con payloads legacy.
function parseIdAlmacenes(rawSingle, rawMulti) {
  const source = Array.isArray(rawMulti) ? rawMulti : (rawMulti === undefined || rawMulti === null ? [] : [rawMulti]);
  const out = [];

  for (const raw of source) {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!esEnteroPositivoInt32(parsed)) {
      return { ok: false, message: 'id_almacenes contiene un id_almacen invalido.' };
    }
    if (!out.includes(parsed)) out.push(parsed);
  }

  if (out.length > 1) {
    return { ok: false, message: SINGLE_ALMACEN_TEMP_MESSAGE };
  }
  if (out.length > 0) return { ok: true, ids: out };

  const parsedSingle = Number.parseInt(String(rawSingle ?? '').trim(), 10);
  if (esEnteroPositivoInt32(parsedSingle)) {
    return { ok: true, ids: [parsedSingle] };
  }

  return { ok: false, message: 'Debe seleccionar al menos un id_almacen.' };
}

// AM: convierte valores Date/Timestamp a `YYYY-MM-DD` para reutilizarlos en payloads de edicion.
function toDateOnlyString(value) {
  if (!value) return '';
  const raw = String(value);
  if (raw.includes('T')) return raw.split('T')[0];
  if (raw.length >= 10) return raw.slice(0, 10);
  return raw;
}

// NEW: helper para interpretar `estado` aunque venga como string/number.
// WHY: `function_select` puede serializar booleans de forma distinta segun el entorno.
// IMPACT: solo afecta filtrado del GET /productos.
function isRowActive(row) {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
}

// NUEVO: valida formato de fecha y coherencia de calendario (yyyy-mm-dd)
function esFechaValida(valor) {
  if (typeof valor !== 'string') return false;

  const limpio = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(limpio)) return false;

  const fecha = new Date(`${limpio}T00:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return false;

  return fecha.toISOString().slice(0, 10) === limpio;
}

// NUEVO: valida y normaliza cada campo permitido de productos
function validarCampoProducto(campo, valor) {
  if (campo === 'nombre_producto') {
    // VALIDACION: nombre_producto string con longitud 2..50
    if (typeof valor !== 'string') {
      return { valido: false, message: 'nombre_producto debe ser un texto.' };
    }

    const limpio = valor.trim();
    if (limpio.length < 2 || limpio.length > 50) {
      return { valido: false, message: 'nombre_producto debe tener entre 2 y 50 caracteres.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'descripcion_producto') {
    // VALIDACION: descripcion_producto string <= 250 si viene
    if (typeof valor !== 'string') {
      return { valido: false, message: 'descripcion_producto debe ser un texto.' };
    }

    const limpio = valor.trim();
    if (limpio.length > 250) {
      return { valido: false, message: 'descripcion_producto no puede exceder 250 caracteres.' };
    }

    return { valido: true, valor: limpio };
  }

  if (campo === 'precio') {
    // VALIDACION: precio numerico >= 0
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero < 0) {
      return { valido: false, message: 'precio debe ser un numero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'cantidad') {
    // VALIDACION: cantidad entero >= 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 0) {
      return { valido: false, message: 'cantidad debe ser un entero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'stock_minimo') {
    // VALIDACION: stock_minimo entero >= 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero < 0) {
      return { valido: false, message: 'stock_minimo debe ser un entero mayor o igual a 0.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'fecha_ingreso_producto' || campo === 'fecha_caducidad') {
    // VALIDACION: fechas en formato valido yyyy-mm-dd
    if (!esFechaValida(valor)) {
      return { valido: false, message: `${campo} debe tener formato de fecha valido (YYYY-MM-DD).` };
    }

    return { valido: true, valor: String(valor).trim() };
  }

  if (campo === 'id_categoria_producto' || campo === 'id_almacen') {
    // VALIDACION: FK obligatorias enteras > 0
    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: `${campo} debe ser un entero mayor a 0.` };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'id_tipo_departamento') {
    // VALIDACION: id_tipo_departamento puede ser null/vacio o entero > 0
    if (esVacio(valor)) {
      return { valido: true, valor: null };
    }

    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: 'id_tipo_departamento debe ser un entero mayor a 0 o null/vacio.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'id_archivo_imagen_principal') {
    // NEW: imagen principal opcional referenciando `archivos.id_archivo`.
    // WHY: permitir asociar o limpiar la imagen principal sin crear endpoints extra de productos.
    // IMPACT: POST/PUT aceptan la FK real y mantienen el contrato actual del resto de campos.
    if (esVacio(valor)) {
      return { valido: true, valor: null };
    }

    const numero = Number(valor);
    if (!Number.isInteger(numero) || numero <= 0) {
      return { valido: false, message: 'id_archivo_imagen_principal debe ser un entero mayor a 0 o null/vacio.' };
    }

    return { valido: true, valor: numero };
  }

  if (campo === 'estado') {
    // VALIDACION: estado boolean normalizado
    const bool = normalizarBoolean(valor);
    if (!bool.valido) {
      return { valido: false, message: 'estado debe ser boolean (true/false, "true"/"false" o 1/0).' };
    }

    return { valido: true, valor: bool.valor };
  }

  return { valido: false, message: `El campo ${campo} no esta permitido.` };
}

// NUEVO: valida existencia FK para integridad referencial previa
async function validarExistenciaFk(campo, valor, db = pool) {
  if (campo === 'id_categoria_producto') {
    const r = await db.query(
      'SELECT 1 FROM categorias_productos WHERE id_categoria_producto = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_almacen') {
    const r = await db.query(
      'SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_tipo_departamento') {
    if (valor === null) return true;

    const r = await db.query(
      'SELECT 1 FROM tipo_departamento WHERE id_tipo_departamento = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_archivo_imagen_principal') {
    if (valor === null) return true;

    const r = await db.query(
      'SELECT 1 FROM archivos WHERE id_archivo = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  return true;
}

async function validarAlmacenOperativo(idAlmacen, db = pool) {
  const r = await db.query(
    `
      SELECT id_almacen, COALESCE(estado, true) AS estado
      FROM almacenes
      WHERE id_almacen = $1
      LIMIT 1
    `,
    [idAlmacen]
  );

  if (r.rowCount === 0) {
    return { ok: false, message: `id_almacen ${idAlmacen} no existe en almacenes.` };
  }

  if (!Boolean(r.rows?.[0]?.estado)) {
    return { ok: false, message: 'El almacen seleccionado esta inactivo.' };
  }

  return { ok: true };
}

// NUEVO: existencia de producto para respuesta 404 en PUT
async function existeProductoPorId(idProducto) {
  const r = await pool.query(
    'SELECT 1 FROM productos WHERE id_producto = $1 LIMIT 1',
    [idProducto]
  );
  return r.rowCount > 0;
}

// AM: carga snapshot completo del producto para soportar edicion multi-almacen sin perder campos opcionales.
async function getProductoById(idProducto, db = pool) {
  const r = await db.query(
    `SELECT
      id_producto,
      nombre_producto,
      precio,
      cantidad,
      stock_minimo,
      descripcion_producto,
      fecha_ingreso_producto,
      fecha_caducidad,
      id_categoria_producto,
      id_almacen,
      id_tipo_departamento,
      estado,
      id_archivo_imagen_principal
    FROM productos
    WHERE id_producto = $1
    LIMIT 1`,
    [idProducto]
  );
  return r.rows[0] || null;
}

// AM: busca un producto "equivalente" por llave de negocio operativa (nombre + categoria + depto opcional + almacen).
// AM: se usa para sincronizar seleccion de varios almacenes en edicion sin crear duplicados innecesarios.
async function findProductoByUniqueKey(
  {
    nombre_producto,
    id_categoria_producto,
    id_tipo_departamento,
    id_almacen,
    excludeId = null
  },
  db = pool
) {
  const params = [
    String(nombre_producto ?? '').trim().toLowerCase(),
    id_categoria_producto,
    id_tipo_departamento ?? null,
    id_almacen
  ];

  let sql = `
    SELECT id_producto
    FROM productos
    WHERE lower(trim(nombre_producto)) = $1
      AND id_categoria_producto = $2
      AND (
        (id_tipo_departamento IS NULL AND $3::integer IS NULL)
        OR id_tipo_departamento = $3::integer
      )
      AND id_almacen = $4
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_producto <> $5';
  }

  sql += ' ORDER BY id_producto DESC LIMIT 1';
  const r = await db.query(sql, params);
  return r.rows[0] || null;
}

// AM: busca producto general (sin amarrarlo a un almacen) para evitar duplicados por sucursal en modelo multi-asignacion.
async function findProductoByGeneralKey(
  {
    nombre_producto,
    id_categoria_producto,
    id_tipo_departamento,
    excludeId = null
  },
  db = pool
) {
  const params = [
    String(nombre_producto ?? '').trim().toLowerCase(),
    id_categoria_producto,
    id_tipo_departamento ?? null
  ];

  let sql = `
    SELECT id_producto
    FROM productos
    WHERE lower(trim(nombre_producto)) = $1
      AND id_categoria_producto = $2
      AND (
        (id_tipo_departamento IS NULL AND $3::integer IS NULL)
        OR id_tipo_departamento = $3::integer
      )
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_producto <> $4';
  }

  sql += ' ORDER BY id_producto ASC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows?.[0] || null;
}

// AM: sincroniza las asignaciones multi-almacen del producto sin duplicar filas de productos por sucursal.
async function syncProductoAlmacenes(idProducto, idAlmacenes, db = pool) {
  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(idAlmacenes) ? idAlmacenes : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );

  if (uniqueIds.length === 0) return;

  const primaryAlmacen = uniqueIds[0];
  const singleAlmacenIds = [primaryAlmacen];
  await db.query('UPDATE public.productos SET id_almacen = $1 WHERE id_producto = $2', [primaryAlmacen, idProducto]);

  try {
    await db.query(
      `
        INSERT INTO public.productos_almacenes (id_producto, id_almacen)
        SELECT $1, UNNEST($2::int[])
        ON CONFLICT (id_producto, id_almacen) DO NOTHING
      `,
      [idProducto, singleAlmacenIds]
    );

    await db.query(
      `
        DELETE FROM public.productos_almacenes
        WHERE id_producto = $1
          AND id_almacen <> ALL($2::int[])
      `,
      [idProducto, singleAlmacenIds]
    );
  } catch (error) {
    // AM: fallback legacy cuando la tabla de asignaciones aun no existe.
    if (error?.code !== SQLSTATE_UNDEFINED_TABLE) throw error;
  }
}

// AM: asegura que GET /productos incluya `id_almacenes` sin romper compatibilidad con `id_almacen`.
async function attachProductoAlmacenes(rows, db = pool) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;

  const ids = Array.from(
    new Set(
      list
        .map((row) => Number.parseInt(String(row?.id_producto ?? ''), 10))
        .filter((id) => esEnteroPositivoInt32(id))
    )
  );

  if (ids.length === 0) {
    return list.map((row) => ({ ...row, id_almacenes: [] }));
  }

  try {
    const assignmentsResult = await db.query(
      `
        SELECT pa.id_producto, ARRAY_AGG(pa.id_almacen ORDER BY pa.id_almacen) AS id_almacenes
        FROM public.productos_almacenes pa
        WHERE pa.id_producto = ANY($1::int[])
        GROUP BY pa.id_producto
      `,
      [ids]
    );

    const map = new Map(
      assignmentsResult.rows.map((row) => [
        Number(row.id_producto),
        (Array.isArray(row.id_almacenes) ? row.id_almacenes : [])
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => esEnteroPositivoInt32(id))
      ])
    );

    return list.map((row) => {
      const idProducto = Number.parseInt(String(row?.id_producto ?? ''), 10);
      const fromMap = map.get(idProducto) || [];
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      const idAlmacenesBase =
        fromMap.length > 0
          ? fromMap
          : esEnteroPositivoInt32(fallbackSingle)
          ? [fallbackSingle]
          : [];
      const idAlmacenes = idAlmacenesBase;
      const primaryAlmacen = esEnteroPositivoInt32(fallbackSingle)
        ? fallbackSingle
        : (idAlmacenes[0] ?? null);

      return {
        ...row,
        id_almacen: primaryAlmacen,
        id_almacenes: idAlmacenes
      };
    });
  } catch (error) {
    if (error?.code !== SQLSTATE_UNDEFINED_TABLE) throw error;
    return list.map((row) => {
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      return {
        ...row,
        id_almacenes: esEnteroPositivoInt32(fallbackSingle) ? [fallbackSingle] : []
      };
    });
  }
}

// AM: update explicito de todo el registro para sincronizacion multi-almacen.
// AM: evita encadenar muchos `pa_update` y mantiene una sola transaccion atomica.
async function updateProductoCompleto(idProducto, data, db = pool) {
  await db.query(
    `UPDATE productos
     SET
       nombre_producto = $1,
       precio = $2,
       stock_minimo = $3,
       descripcion_producto = $4,
       fecha_ingreso_producto = $5,
       fecha_caducidad = $6,
       id_categoria_producto = $7,
       id_almacen = $8,
       id_tipo_departamento = $9,
       estado = $10,
       id_archivo_imagen_principal = $11
     WHERE id_producto = $12`,
    [
      data.nombre_producto,
      data.precio,
      data.stock_minimo,
      data.descripcion_producto || '',
      data.fecha_ingreso_producto || null,
      data.fecha_caducidad || null,
      data.id_categoria_producto,
      data.id_almacen,
      data.id_tipo_departamento ?? null,
      data.estado,
      data.id_archivo_imagen_principal ?? null,
      idProducto
    ]
  );
}

// NEW: actualiza campos opcionales a SQL NULL sin pasar por `pa_update`.
// WHY: `pa_update` serializa valores con `%L` y convertiria `null` en el texto `"null"`, rompiendo FKs integer.
// IMPACT: solo se usa al limpiar FKs opcionales; el resto del flujo PUT conserva `pa_update` intacto.
async function updateProductoFieldToNull(idProducto, campo) {
  if (campo === 'id_archivo_imagen_principal') {
    await pool.query(
      'UPDATE productos SET id_archivo_imagen_principal = NULL WHERE id_producto = $1',
      [idProducto]
    );
    return true;
  }

  if (campo === 'id_tipo_departamento') {
    await pool.query(
      'UPDATE productos SET id_tipo_departamento = NULL WHERE id_producto = $1',
      [idProducto]
    );
    return true;
  }

  return false;
}

// NUEVO: helper para clasificar errores SQL de constraint como conflicto
function esErrorConflictoConstraint(err) {
  return Boolean(err?.code && CODIGOS_CONFLICTO_CONSTRAINT.has(err.code));
}

function getProductosConstraintConflictMessage(err) {
  if (!err || err.code !== '23505') return '';
  const trace = String(err?.constraint || err?.detail || err?.message || '').toLowerCase();
  if (!trace.includes(PRODUCTOS_DUPLICATE_CONSTRAINT.toLowerCase())) return '';
  return PRODUCTOS_DUPLICATE_MESSAGE;
}

// NEW: sanitiza mensajes internos de BD para respuestas HTTP del router de Productos.
// WHY: evitar exponer detalles como `out of range for type integer` al frontend/usuario.
// IMPACT: solo cambia el texto de errores internos; status codes y logging del servidor se mantienen.
function getSafeProductosServerErrorMessage(err, fallback = 'No se pudo completar la acción. Verifica los datos e intenta de nuevo.') {
  const raw = String(err?.message || '').toLowerCase();
  if (err?.code === CODIGO_SQL_OUT_OF_RANGE) return fallback;
  if (raw.includes('out of range') && raw.includes('integer')) return fallback;
  return String(err?.message || fallback);
}

// GET: Obtener productos
router.get('/productos', async (req, res) => {
  try {
    const scope = await resolveRequestUserSucursalScope(req);
    const queryPayload = { ...req.query };

    if (!scope.isSuperAdmin) {
      if (!scope.allowedSucursalIds || scope.allowedSucursalIds.length === 0) {
        return res.status(403).json({ error: true, message: 'El empleado no tiene sucursales asignadas.' });
      }
      
      const requestedSucursal = parseOptionalPositiveId(req.query.id_sucursal);
      if (requestedSucursal) {
        if (!scope.allowedSucursalIds.includes(requestedSucursal)) {
          return res.status(403).json({ error: true, message: 'No tiene acceso a la sucursal solicitada.' });
        }
      } else {
        // En productos se permite enviar id_sucursal=X para filtrar, 
        // si no envia, pero está capado, debería listar de sus almacenes permitidos.
        // Pero filterProductosByCatalogScope por ahora toma 1 sucursal,
        // esto requiere que si scope.allowedSucursalIds tiene varias sucursales y no pide una, filtre por todas.
        queryPayload._allowedSucursalIds = scope.allowedSucursalIds;
      }
    }

    const tabla = 'productos';

    // AJUSTE: se incluye estado para compatibilidad con soft delete
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento, estado, id_archivo_imagen_principal';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows[0].resultado || [];
    // NEW: activos por defecto; admin puede solicitar incluir inactivos.
    // WHY: alinear GET /productos con inactivacion via `estado=false`.
    // IMPACT: no rompe clientes actuales; amplia el contrato con query param opcional.
    const datos = shouldIncludeInactive(queryPayload) ? baseDatos : baseDatos.filter(isRowActive);
    const datosConAlmacenes = await attachProductoAlmacenes(datos, pool);
    
    // Filtro legacy o multi sucursal
    const scopedFilter = await filterProductosByCatalogScope(datosConAlmacenes, queryPayload, pool);
    if (!scopedFilter.ok) {
      return res.status(400).json({ error: true, message: scopedFilter.message || 'Filtros de catalogo invalidos.' });
    }
    const datosConImagen = await attachImagenPrincipalUrls(pool, req, scopedFilter.rows || []);
    res.status(200).json(datosConImagen);

  } catch (err) {
    console.error('Error al obtener productos:', err.message);
    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err, 'No se pudieron cargar los productos.') });
  }
});

// POST: Crear producto
router.post('/productos', async (req, res) => {
  const client = await pool.connect();
  try {
    const tabla = 'productos';
    const datosEntrada = req.body;

    // VALIDACION: body debe ser objeto valido
    if (!datosEntrada || typeof datosEntrada !== 'object' || Array.isArray(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido para crear producto.' });
    }

    const keys = Object.keys(datosEntrada);

    // VALIDACION: allowlist de campos aceptados
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_PRODUCTOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    // VALIDACION: requeridos para alta de producto
    const camposRequeridos = [
      'nombre_producto',
      'precio',
      'cantidad',
      'id_categoria_producto'
    ];

    const faltantes = camposRequeridos.filter((campo) => esVacio(datosEntrada[campo]));
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    // NUEVO: normalizacion unificada del payload antes de pa_insert
    const datosNormalizados = {};

    for (const campo of keys) {
      if (campo === 'id_almacenes') continue;
      const resultado = validarCampoProducto(campo, datosEntrada[campo]);
      if (!resultado.valido) {
        return res.status(400).json({ error: true, message: resultado.message });
      }
      datosNormalizados[campo] = resultado.valor;
    }

    // AJUSTE: stock_minimo opcional con default 0 si no viene
    if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'stock_minimo')) {
      datosNormalizados.stock_minimo = 0;
    }

    // VALIDACION: existencia FK categoria
    if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_categoria_producto')) {
      return res.status(400).json({ error: true, message: 'id_categoria_producto es obligatorio.' });
    }
    const existeCategoria = await validarExistenciaFk('id_categoria_producto', datosNormalizados.id_categoria_producto, client);
    if (!existeCategoria) {
      return res.status(400).json({
        error: true,
        message: 'id_categoria_producto no existe en categorias_productos.'
      });
    }

    // VALIDACION: existencia FK almacen
    const almacenesParse = parseIdAlmacenes(datosEntrada?.id_almacen, datosEntrada?.id_almacenes);
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }

    const idAlmacenes = almacenesParse.ids;
    datosNormalizados.id_almacen = idAlmacenes[0];

    // VALIDACION: existencia FK tipo_departamento solo si viene con valor
    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_tipo_departamento')) {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', datosNormalizados.id_tipo_departamento, client);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    // NEW: valida la imagen principal cuando el payload incluye FK a `archivos`.
    // WHY: evitar referencias a archivos inexistentes y fallos de FK mas tarde en la BD.
    // IMPACT: solo rechaza payloads invalidos; altas validas se mantienen intactas.
    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo_imagen_principal')) {
      const existeArchivo = await validarExistenciaFk(
        'id_archivo_imagen_principal',
        datosNormalizados.id_archivo_imagen_principal,
        client
      );
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    await client.query('BEGIN');

    for (const idAlmacen of idAlmacenes) {
      const almacenOperativo = await validarAlmacenOperativo(idAlmacen, client);
      if (!almacenOperativo.ok) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: true,
          message: almacenOperativo.message
        });
      }
    }

    const duplicadoGeneral = await findProductoByGeneralKey(
      {
        nombre_producto: datosNormalizados.nombre_producto,
        id_categoria_producto: datosNormalizados.id_categoria_producto,
        id_tipo_departamento: datosNormalizados.id_tipo_departamento ?? null
      },
      client
    );

    if (duplicadoGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    const payloadPrimary = {
      ...datosNormalizados,
      id_almacen: idAlmacenes[0]
    };

    const query = 'CALL pa_insert($1, $2)';
    await client.query(query, [tabla, payloadPrimary]);

    const inserted = await findProductoByUniqueKey(
      {
        nombre_producto: payloadPrimary.nombre_producto,
        id_categoria_producto: payloadPrimary.id_categoria_producto,
        id_tipo_departamento: payloadPrimary.id_tipo_departamento ?? null,
        id_almacen: payloadPrimary.id_almacen
      },
      client
    );

    const idProductoCreado = Number.parseInt(String(inserted?.id_producto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProductoCreado)) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: true,
        message: 'No se pudo resolver el ID del producto creado.'
      });
    }

    await syncProductoAlmacenes(idProductoCreado, idAlmacenes, client);
    await client.query('COMMIT');

    res.status(201).json({
      message: 'Producto creado exitosamente.',
      id_producto: idProductoCreado,
      id_almacenes: idAlmacenes
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear producto:', err.message);

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: getProductosConstraintConflictMessage(err) || 'No se pudo crear el producto por una restriccion de datos.'
      });
    }

    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// AM: actualizacion completa del producto sincronizando uno o varios almacenes en una sola transaccion.
// AM: conserva el endpoint `PUT /productos` por campo para compatibilidad y agrega flujo especifico multi-almacen.
router.put('/productos/multi-almacen', async (req, res) => {
  const client = await pool.connect();
  try {
    const idProducto = Number.parseInt(String(req.body?.id_producto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({ error: true, message: 'id_producto invalido.' });
    }

    const actual = await getProductoById(idProducto, client);
    if (!actual) {
      return res.status(404).json({ error: true, message: 'Producto no encontrado.' });
    }
    if (!isRowActive(actual)) {
      return res.status(400).json({ error: true, message: 'El producto esta inactivo.' });
    }

    const datosEntrada = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    delete datosEntrada.id_producto;

    if (Object.prototype.hasOwnProperty.call(datosEntrada, 'cantidad')) {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede editarse desde este módulo. Use movimientos de inventario.'
      });
    }

    const keys = Object.keys(datosEntrada);
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_PRODUCTOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const merged = {
      nombre_producto: datosEntrada.nombre_producto ?? actual.nombre_producto,
      precio: datosEntrada.precio ?? actual.precio,
      cantidad: actual.cantidad,
      stock_minimo: datosEntrada.stock_minimo ?? actual.stock_minimo ?? 0,
      descripcion_producto: datosEntrada.descripcion_producto ?? actual.descripcion_producto ?? '',
      fecha_ingreso_producto: datosEntrada.fecha_ingreso_producto ?? toDateOnlyString(actual.fecha_ingreso_producto),
      fecha_caducidad: datosEntrada.fecha_caducidad ?? toDateOnlyString(actual.fecha_caducidad),
      id_categoria_producto: datosEntrada.id_categoria_producto ?? actual.id_categoria_producto,
      id_tipo_departamento: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_tipo_departamento')
        ? datosEntrada.id_tipo_departamento
        : actual.id_tipo_departamento,
      id_archivo_imagen_principal: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_archivo_imagen_principal')
        ? datosEntrada.id_archivo_imagen_principal
        : actual.id_archivo_imagen_principal,
      estado: Object.prototype.hasOwnProperty.call(datosEntrada, 'estado')
        ? datosEntrada.estado
        : (actual.estado ?? true),
      id_almacen: datosEntrada.id_almacen ?? actual.id_almacen
    };

    const datosNormalizados = {};
    for (const [campo, valorRaw] of Object.entries(merged)) {
      if ((campo === 'fecha_ingreso_producto' || campo === 'fecha_caducidad') && esVacio(valorRaw)) {
        continue;
      }
      const resultado = validarCampoProducto(campo, valorRaw);
      if (!resultado.valido) {
        return res.status(400).json({ error: true, message: resultado.message });
      }
      datosNormalizados[campo] = resultado.valor;
    }

    const camposRequeridos = ['nombre_producto', 'precio', 'stock_minimo', 'id_categoria_producto'];
    const faltantes = camposRequeridos.filter((campo) => !Object.prototype.hasOwnProperty.call(datosNormalizados, campo));
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    const almacenesParse = parseIdAlmacenes(
      datosEntrada.id_almacen ?? actual.id_almacen,
      datosEntrada.id_almacenes
    );
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }
    const idAlmacenes = almacenesParse.ids;

    const existeCategoria = await validarExistenciaFk('id_categoria_producto', datosNormalizados.id_categoria_producto, client);
    if (!existeCategoria) {
      return res.status(400).json({
        error: true,
        message: 'id_categoria_producto no existe en categorias_productos.'
      });
    }

    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_tipo_departamento')) {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', datosNormalizados.id_tipo_departamento, client);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_archivo_imagen_principal')) {
      const existeArchivo = await validarExistenciaFk(
        'id_archivo_imagen_principal',
        datosNormalizados.id_archivo_imagen_principal,
        client
      );
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    for (const idAlmacen of idAlmacenes) {
      const almacenOperativo = await validarAlmacenOperativo(idAlmacen, client);
      if (!almacenOperativo.ok) {
        return res.status(400).json({
          error: true,
          message: almacenOperativo.message
        });
      }
    }

    await client.query('BEGIN');

    const duplicateGeneral = await findProductoByGeneralKey(
      {
        nombre_producto: datosNormalizados.nombre_producto,
        id_categoria_producto: datosNormalizados.id_categoria_producto,
        id_tipo_departamento: datosNormalizados.id_tipo_departamento ?? null,
        excludeId: idProducto
      },
      client
    );

    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: PRODUCTOS_DUPLICATE_MESSAGE
      });
    }

    const primaryAlmacen = idAlmacenes[0];
    const payloadPrimary = { ...datosNormalizados, id_almacen: primaryAlmacen };
    await updateProductoCompleto(idProducto, payloadPrimary, client);
    await syncProductoAlmacenes(idProducto, idAlmacenes, client);

    await client.query('COMMIT');
    return res.status(200).json({
      message: `Producto actualizado y asignado en ${idAlmacenes.length} almacen(es).`,
      id_producto: idProducto,
      id_almacenes: idAlmacenes
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error en PUT /productos/multi-almacen:', err.message);
    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: getProductosConstraintConflictMessage(err) || 'No se pudo sincronizar el producto por una restriccion de datos.'
      });
    }
    return res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  } finally {
    client.release();
  }
});

// PUT: Actualizar producto (1 campo)
router.put('/productos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    // VALIDACION: id_campo fijo para evitar updates arbitrarios
    if (id_campo !== 'id_producto') {
      return res.status(400).json({
        error: true,
        message: 'id_campo invalido. Debe ser exactamente id_producto.'
      });
    }

    // VALIDACION: campo de actualizacion dentro de allowlist
    if (!CAMPOS_PERMITIDOS_PRODUCTOS.has(campo)) {
      return res.status(400).json({
        error: true,
        message: `Campo no permitido para actualizar: ${campo}`
      });
    }

    if (campo === 'cantidad') {
      return res.status(400).json({
        error: true,
        message: 'La cantidad no puede editarse desde este módulo. Use movimientos de inventario.'
      });
    }

    // VALIDACION: id objetivo valido
    const idProducto = Number(id_valor);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({
        error: true,
        message: 'id_valor debe ser un entero positivo dentro del rango permitido.'
      });
    }

    // AJUSTE: 404 si el producto objetivo no existe
    const existeProducto = await existeProductoPorId(idProducto);
    if (!existeProducto) {
      return res.status(404).json({
        error: true,
        message: 'Producto no encontrado.'
      });
    }

    const resultado = validarCampoProducto(campo, valor);
    if (!resultado.valido) {
      return res.status(400).json({ error: true, message: resultado.message });
    }

    // VALIDACION: FK categoria si se actualiza
    if (campo === 'id_categoria_producto') {
      const existeCategoria = await validarExistenciaFk('id_categoria_producto', resultado.valor);
      if (!existeCategoria) {
        return res.status(400).json({
          error: true,
          message: 'id_categoria_producto no existe en categorias_productos.'
        });
      }
    }

    // VALIDACION: FK almacen si se actualiza
    if (campo === 'id_almacen') {
      const productoActual = await getProductoById(idProducto, pool);
      if (!productoActual) {
        return res.status(404).json({
          error: true,
          message: 'Producto no encontrado.'
        });
      }
      if (!isRowActive(productoActual)) {
        return res.status(400).json({
          error: true,
          message: 'El producto esta inactivo.'
        });
      }

      const almacenOperativo = await validarAlmacenOperativo(resultado.valor);
      if (!almacenOperativo.ok) {
        return res.status(400).json({
          error: true,
          message: almacenOperativo.message
        });
      }
    }

    // VALIDACION: FK tipo_departamento solo cuando trae valor
    if (campo === 'id_tipo_departamento') {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', resultado.valor);
      if (!existeTipoDep) {
        return res.status(400).json({
          error: true,
          message: 'id_tipo_departamento no existe en tipo_departamento.'
        });
      }
    }

    if (campo === 'id_archivo_imagen_principal') {
      const existeArchivo = await validarExistenciaFk('id_archivo_imagen_principal', resultado.valor);
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    // NEW: desvincula FKs opcionales con SQL NULL real cuando el frontend limpia la imagen/campo.
    // WHY: evita el error `invalid input syntax for type integer: "null"` reportado al quitar imagen.
    // IMPACT: `Quitar imagen` y limpieza de departamento opcional funcionan sin tocar el contrato del endpoint.
    if (resultado.valor === null && await updateProductoFieldToNull(idProducto, campo)) {
      return res.status(200).json({ message: 'Producto actualizado correctamente.' });
    }

    const tabla = 'productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(resultado.valor), id_campo, String(idProducto)]);

    if (campo === 'id_almacen') {
      // AM: al mover almacen primario por endpoint legacy, se preserva coherencia en tabla de asignaciones multi-almacen.
      await syncProductoAlmacenes(idProducto, [resultado.valor], pool);
    }

    res.status(200).json({ message: 'Producto actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar producto:', err.message);

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: getProductosConstraintConflictMessage(err) || 'No se pudo actualizar el producto por una restriccion de datos.'
      });
    }

    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
  }
});

// DELETE: Inactivar producto (soft delete)
router.delete('/productos', async (req, res) => {
  try {
    // NEW: fallback compatible para obtener id del producto desde body/query/params sin romper firmas actuales.
    // WHY: evita `ReferenceError` y tolera clientes legacy que envian distintos nombres del ID.
    // IMPACT: mantiene el endpoint DELETE /productos y amplia la lectura del ID de forma retrocompatible.
    const rawIdProducto =
      req.body?.idProducto ?? req.body?.id_producto ??
      req.query?.idProducto ?? req.query?.id_producto ??
      req.params?.idProducto ?? req.params?.id_producto ??
      req.body?.valor_id ?? req.query?.valor_id;

    // NEW: fallback compatible para columna_id con default seguro.
    // WHY: conservar compatibilidad con la firma actual (`columna_id`,`valor_id`) sin exigirla a otros callers.
    // IMPACT: si no llega `columna_id`, se asume `id_producto`; payloads existentes siguen funcionando.
    const columna_id =
      req.body?.columna_id ?? req.query?.columna_id ?? req.params?.columna_id ?? 'id_producto';

    // VALIDACION: columna_id fijo para evitar deletes arbitrarios
    if (columna_id !== 'id_producto') {
      return res.status(400).json({
        error: true,
        code: 'INVALID_PRODUCT_ID',
        message: 'ID de producto inválido.'
      });
    }

    // VALIDACION: id del producto a eliminar
    const idProducto = Number.parseInt(String(rawIdProducto ?? ''), 10);
    if (!esEnteroPositivoInt32(idProducto)) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_PRODUCT_ID',
        message: 'ID de producto inválido.'
      });
    }

    // NEW: 404 explicito antes de inactivar.
    // WHY: responder consistente sin depender del comportamiento interno de los SPs.
    // IMPACT: solo afecta requests hacia IDs inexistentes.
    const existeProducto = await existeProductoPorId(idProducto);
    if (!existeProducto) {
      return res.status(404).json({
        error: true,
        code: 'PRODUCT_NOT_FOUND',
        message: 'Producto no encontrado.'
      });
    }

    const tabla = 'productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(idProducto)]);

    return res.status(200).json({ error: false, message: 'Producto inactivado.' });

  } catch (err) {
    console.error('Error al inactivar producto:', err.message);
    // NEW: respuesta 500 estandarizada para no exponer detalles internos (ej. ReferenceError / SQL).
    // WHY: el cliente no debe recibir mensajes crudos como `idProducto is not defined`.
    // IMPACT: solo cambia el payload de error en DELETE /productos; logging del servidor se conserva.
    return res.status(500).json({
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'No se pudo completar la acción. Intenta de nuevo.'
    });
  }
});

export default router;
