import express from 'express';
import pool from '../config/db-connection.js';

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
  'estado'
]);

// NUEVO: codigos de conflicto SQL para responder 409 en constraints
const CODIGOS_CONFLICTO_CONSTRAINT = new Set(['23503', '23505', '23514', '23502']);

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

// NUEVO: helper para clasificar errores SQL de constraint como conflicto
function esErrorConflictoConstraint(err) {
  return Boolean(err?.code && CODIGOS_CONFLICTO_CONSTRAINT.has(err.code));
}

// GET: Obtener productos
router.get('/productos', async (req, res) => {
  try {
    const tabla = 'productos';

    // AJUSTE: se incluye estado para compatibilidad con soft delete
    const columnas =
      'id_producto, nombre_producto, precio, cantidad, stock_minimo, descripcion_producto, fecha_ingreso_producto, fecha_caducidad, id_categoria_producto, id_almacen, id_tipo_departamento, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const datos = result.rows[0].resultado || [];
    res.status(200).json(datos);

  } catch (err) {
    console.error('Error al obtener productos:', err.message);
    res.status(500).json({ error: true, message: err.message });
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

    res.status(500).json({ error: true, message: err.message });
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
    if (!Number.isInteger(idProducto) || idProducto <= 0) {
      return res.status(400).json({
        error: true,
        message: 'id_valor debe ser un entero mayor a 0.'
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

    const tabla = 'productos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    // AJUSTE: soporte para limpiar id_tipo_departamento enviando null/vacio
    const valorParaUpdate =
      campo === 'id_tipo_departamento' && resultado.valor === null
        ? 'null'
        : String(resultado.valor);

    await pool.query(query, [tabla, campo, valorParaUpdate, id_campo, String(idProducto)]);

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

    res.status(500).json({ error: true, message: err.message });
  }
});

// DELETE: Eliminar producto
router.delete('/productos', async (req, res) => {
  // AJUSTE: se declara fuera del try para reutilizar en hard/soft delete
  let idProducto = null;

  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // VALIDACION: columna_id fijo para evitar deletes arbitrarios
    if (columna_id !== 'id_producto') {
      return res.status(400).json({
        error: true,
        message: 'columna_id invalido. Debe ser exactamente id_producto.'
      });
    }

    // VALIDACION: id del producto a eliminar
    idProducto = Number(valor_id);
    if (!Number.isInteger(idProducto) || idProducto <= 0) {
      return res.status(400).json({
        error: true,
        message: 'valor_id debe ser un entero mayor a 0.'
      });
    }

    const tabla = 'productos';
    const query = 'CALL pa_delete($1, $2, $3)';

    // AJUSTE: primero intenta hard delete
    await pool.query(query, [tabla, columna_id, String(idProducto)]);

    return res.status(200).json({ message: 'Producto eliminado.', hard_deleted: true });

  } catch (err) {
    // NUEVO: fallback soft delete cuando el hard delete falla por FK
    if (err.code === '23503') {
      try {
        await pool.query(
          'CALL pa_update($1, $2, $3, $4, $5)',
          ['productos', 'estado', 'false', 'id_producto', String(idProducto)]
        );

        return res.status(200).json({
          message: 'Producto desactivado porque est\u00E1 en uso y no se puede eliminar.',
          soft_deleted: true
        });
      } catch (softErr) {
        console.error('Error al aplicar soft delete de producto:', softErr.message);
        return res.status(500).json({ error: true, message: softErr.message });
      }
    }

    console.error('Error al eliminar producto:', err.message);
    return res.status(500).json({ error: true, message: err.message });
  }
});

export default router;
