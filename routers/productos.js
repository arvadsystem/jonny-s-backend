import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';

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
// NEW: query param opt-in para incluir inactivos en listados administrativos.
// WHY: el GET de productos debe devolver activos por defecto tras adoptar soft delete.
// IMPACT: mantiene compatibilidad con `?incluir_inactivos=1` sin crear endpoint nuevo.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

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
async function validarExistenciaFk(campo, valor) {
  if (campo === 'id_categoria_producto') {
    const r = await pool.query(
      'SELECT 1 FROM categorias_productos WHERE id_categoria_producto = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_almacen') {
    const r = await pool.query(
      'SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_tipo_departamento') {
    if (valor === null) return true;

    const r = await pool.query(
      'SELECT 1 FROM tipo_departamento WHERE id_tipo_departamento = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  if (campo === 'id_archivo_imagen_principal') {
    if (valor === null) return true;

    const r = await pool.query(
      'SELECT 1 FROM archivos WHERE id_archivo = $1 LIMIT 1',
      [valor]
    );
    return r.rowCount > 0;
  }

  return true;
}

// NUEVO: existencia de producto para respuesta 404 en PUT
async function existeProductoPorId(idProducto) {
  const r = await pool.query(
    'SELECT 1 FROM productos WHERE id_producto = $1 LIMIT 1',
    [idProducto]
  );
  return r.rowCount > 0;
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
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    const datosConImagen = await attachImagenPrincipalUrls(pool, req, datos);
    res.status(200).json(datosConImagen);

  } catch (err) {
    console.error('Error al obtener productos:', err.message);
    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err, 'No se pudieron cargar los productos.') });
  }
});

// POST: Crear producto
router.post('/productos', async (req, res) => {
  try {
    const tabla = 'productos';
    const datosEntrada = req.body;

    // VALIDACION: body debe ser objeto valido
    if (!datosEntrada || typeof datosEntrada !== 'object' || Array.isArray(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido para crear producto.' });
    }

    const keys = Object.keys(datosEntrada);

    // VALIDACION: allowlist de campos aceptados
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_PRODUCTOS.has(k));
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
      'id_categoria_producto',
      'id_almacen'
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
    const existeCategoria = await validarExistenciaFk('id_categoria_producto', datosNormalizados.id_categoria_producto);
    if (!existeCategoria) {
      return res.status(400).json({
        error: true,
        message: 'id_categoria_producto no existe en categorias_productos.'
      });
    }

    // VALIDACION: existencia FK almacen
    if (!Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_almacen')) {
      return res.status(400).json({ error: true, message: 'id_almacen es obligatorio.' });
    }
    const existeAlmacen = await validarExistenciaFk('id_almacen', datosNormalizados.id_almacen);
    if (!existeAlmacen) {
      return res.status(400).json({
        error: true,
        message: 'id_almacen no existe en almacenes.'
      });
    }

    // VALIDACION: existencia FK tipo_departamento solo si viene con valor
    if (Object.prototype.hasOwnProperty.call(datosNormalizados, 'id_tipo_departamento')) {
      const existeTipoDep = await validarExistenciaFk('id_tipo_departamento', datosNormalizados.id_tipo_departamento);
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
        datosNormalizados.id_archivo_imagen_principal
      );
      if (!existeArchivo) {
        return res.status(400).json({
          error: true,
          message: 'id_archivo_imagen_principal no existe en archivos.'
        });
      }
    }

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datosNormalizados]);

    res.status(201).json({ message: 'Producto creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear producto:', err.message);

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo crear el producto por una restriccion de datos.'
      });
    }

    res.status(500).json({ error: true, message: getSafeProductosServerErrorMessage(err) });
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
      const existeAlmacen = await validarExistenciaFk('id_almacen', resultado.valor);
      if (!existeAlmacen) {
        return res.status(400).json({
          error: true,
          message: 'id_almacen no existe en almacenes.'
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

    res.status(200).json({ message: 'Producto actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar producto:', err.message);

    // AJUSTE: respuesta 409 para conflictos de FK/constraints
    if (esErrorConflictoConstraint(err)) {
      return res.status(409).json({
        error: true,
        message: 'No se pudo actualizar el producto por una restriccion de datos.'
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
