import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';

const router = express.Router();

// NEW: permite incluir inactivos solo cuando el cliente lo solicita explicitamente.
// WHY: el listado por defecto debe devolver solo registros activos tras migrar a soft delete.
// IMPACT: mantiene compatibilidad agregando soporte opt-in `?incluir_inactivos=1`.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// NEW: normaliza el valor de `estado` para soportar boolean/string/number.
// WHY: `function_select` puede serializar booleans de distintas formas segun el entorno.
// IMPACT: solo afecta el filtrado del GET /insumos.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper para validar IDs enteros positivos.
// WHY: evitar llamadas a BD/SP con IDs invalidos y responder 400/404 de forma consistente.
// IMPACT: solo endurece requests mal formados; requests validos no cambian.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

// NEW: mensaje seguro para no exponer errores crudos de BD.
// WHY: alinear manejo de errores con UX y evitar detalles internos.
// IMPACT: no cambia contratos exitosos ni status codes de validacion.
const safeServerErrorMessage = (fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') => fallback;

// NEW: helper para validar `id_categoria_insumo` y asegurar que exista/este activa.
// WHY: evitar guardar insumos apuntando a categorias inexistentes o inactivas.
// IMPACT: agrega validacion 400 opcional en POST/PUT cuando se envia `id_categoria_insumo`.
const validateCategoriaInsumoActiva = async (rawCategoriaId) => {
  const hasValue = !(rawCategoriaId === undefined || rawCategoriaId === null || String(rawCategoriaId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const categoriaId = Number.parseInt(String(rawCategoriaId), 10);
  if (!isPositiveIntegerId(categoriaId)) {
    return { ok: false, status: 400, code: 'INVALID_INSUMO_CATEGORY_ID', message: 'id_categoria_insumo debe ser un entero mayor a 0.' };
  }

  const result = await pool.query(
    'SELECT estado FROM categorias_insumos WHERE id_categoria_insumo = $1 LIMIT 1',
    [categoriaId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_INSUMO_CATEGORY_ID', message: 'La categoría de insumo no existe.' };
  }

  const row = result.rows?.[0] || {};
  if (!isRowActive(row)) {
    return { ok: false, status: 400, code: 'INACTIVE_INSUMO_CATEGORY', message: 'La categoría de insumo está inactiva.' };
  }

  return { ok: true, id: categoriaId };
};

// NEW: valida FK opcional a `unidades_medida`.
// WHY: `insumos.id_unidad_medida` ya existe en la BD real y debe concordar con el formulario.
// IMPACT: POST/PUT de insumos aceptan la unidad cuando existe y rechazan IDs invalidos con 400.
const validateUnidadMedida = async (rawUnidadId) => {
  const hasValue = !(rawUnidadId === undefined || rawUnidadId === null || String(rawUnidadId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const unidadId = Number.parseInt(String(rawUnidadId), 10);
  if (!isPositiveIntegerId(unidadId)) {
    return { ok: false, status: 400, code: 'INVALID_UNIDAD_MEDIDA_ID', message: 'id_unidad_medida debe ser un entero mayor a 0.' };
  }

  const result = await pool.query(
    'SELECT 1 FROM unidades_medida WHERE id_unidad_medida = $1 LIMIT 1',
    [unidadId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_UNIDAD_MEDIDA_ID', message: 'La unidad de medida no existe.' };
  }

  return { ok: true, id: unidadId };
};

// NEW: valida FK opcional a `archivos.id_archivo` para imagen principal.
// WHY: garantizar que la imagen asociada ya exista antes de persistir el insumo.
// IMPACT: evita errores de FK crudos y habilita el flujo de imagenes en Inventario.
const validateArchivoImagen = async (rawArchivoId) => {
  const hasValue = !(rawArchivoId === undefined || rawArchivoId === null || String(rawArchivoId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const archivoId = Number.parseInt(String(rawArchivoId), 10);
  if (!isPositiveIntegerId(archivoId)) {
    return { ok: false, status: 400, code: 'INVALID_ARCHIVO_ID', message: 'id_archivo_imagen_principal debe ser un entero mayor a 0.' };
  }

  const result = await pool.query(
    'SELECT 1 FROM archivos WHERE id_archivo = $1 LIMIT 1',
    [archivoId]
  );
  if (result.rowCount === 0) {
    return { ok: false, status: 400, code: 'INVALID_ARCHIVO_ID', message: 'La imagen seleccionada no existe.' };
  }

  return { ok: true, id: archivoId };
};

// NEW: actualiza FKs opcionales a SQL NULL real sin pasar por `pa_update`.
// WHY: `pa_update` serializa `null` como texto y PostgreSQL rechaza `"null"` en columnas integer.
// IMPACT: permite limpiar imagen/unidad/categoria opcional desde el frontend sin romper el PUT generico.
const updateNullableInsumoFieldToNull = async (rawInsumoId, campo) => {
  const insumoId = Number.parseInt(String(rawInsumoId ?? ''), 10);
  if (!isPositiveIntegerId(insumoId)) return false;

  if (campo === 'id_categoria_insumo') {
    await pool.query('UPDATE insumos SET id_categoria_insumo = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  if (campo === 'id_unidad_medida') {
    await pool.query('UPDATE insumos SET id_unidad_medida = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  if (campo === 'id_archivo_imagen_principal') {
    await pool.query('UPDATE insumos SET id_archivo_imagen_principal = NULL WHERE id_insumo = $1', [insumoId]);
    return true;
  }

  return false;
};

// GET: Obtener insumos
router.get('/insumos', async (req, res) => {
  try {
    const tabla = 'insumos';

    // COMENTARIO EN MAYUSCULAS: SE AGREGA stock_minimo PARA ALERTAS
    const columnas =
      'id_insumo, nombre_insumo, precio, cantidad, stock_minimo, fecha_ingreso_insumo, id_almacen, id_categoria_insumo, id_unidad_medida, fecha_caducidad, descripcion, estado, id_archivo_imagen_principal';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows[0].resultado || [];
    // NEW: por defecto devuelve solo activos; admin puede pedir todos con query param.
    // WHY: alinear el GET con la regla de soft delete basada en `estado`.
    // IMPACT: `?incluir_inactivos=1` mantiene soporte administrativo sin endpoint nuevo.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    const datosConImagen = await attachImagenPrincipalUrls(pool, req, datos);
    res.status(200).json(datosConImagen);

  } catch (err) {
    console.error('Error al obtener insumos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar los insumos.') });
  }
});

// POST: Crear insumo
router.post('/insumos', async (req, res) => {
  try {
    const tabla = 'insumos';
    const datos = req.body;

    // NEW: valida categoria de insumo si el frontend la envia en alta.
    // WHY: proteger integridad de referencia sin depender solo de la FK.
    // IMPACT: solo bloquea payloads invalidos; altas validas mantienen el mismo flujo.
    const categoriaValidation = await validateCategoriaInsumoActiva(datos?.id_categoria_insumo);
    if (!categoriaValidation.ok) {
      return res.status(categoriaValidation.status).json({
        error: true,
        code: categoriaValidation.code,
        message: categoriaValidation.message
      });
    }

    const unidadValidation = await validateUnidadMedida(datos?.id_unidad_medida);
    if (!unidadValidation.ok) {
      return res.status(unidadValidation.status).json({
        error: true,
        code: unidadValidation.code,
        message: unidadValidation.message
      });
    }

    const archivoValidation = await validateArchivoImagen(datos?.id_archivo_imagen_principal);
    if (!archivoValidation.ok) {
      return res.status(archivoValidation.status).json({
        error: true,
        code: archivoValidation.code,
        message: archivoValidation.message
      });
    }

    const payload = { ...datos };
    if (categoriaValidation.id === null) delete payload.id_categoria_insumo;
    else payload.id_categoria_insumo = categoriaValidation.id;
    if (unidadValidation.id === null) delete payload.id_unidad_medida;
    else payload.id_unidad_medida = unidadValidation.id;
    if (archivoValidation.id === null) delete payload.id_archivo_imagen_principal;
    else payload.id_archivo_imagen_principal = archivoValidation.id;

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, payload]);

    res.status(201).json({ message: 'Insumo creado exitosamente.' });

  } catch (err) {
    console.error('Error al crear insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// PUT: Actualizar insumo (1 campo)
router.put('/insumos', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    // NEW: valida categoria de insumo solo cuando se intenta actualizar ese campo.
    // WHY: mantener PUT genérico pero asegurando coherencia con `categorias_insumos.estado`.
    // IMPACT: no afecta updates de otros campos.
    let valorNormalizado = valor;

    if (campo === 'id_categoria_insumo') {
      const categoriaValidation = await validateCategoriaInsumoActiva(valor);
      if (!categoriaValidation.ok) {
        return res.status(categoriaValidation.status).json({
          error: true,
          code: categoriaValidation.code,
          message: categoriaValidation.message
        });
      }
      valorNormalizado = categoriaValidation.id;
    }

    if (campo === 'id_unidad_medida') {
      const unidadValidation = await validateUnidadMedida(valor);
      if (!unidadValidation.ok) {
        return res.status(unidadValidation.status).json({
          error: true,
          code: unidadValidation.code,
          message: unidadValidation.message
        });
      }
      valorNormalizado = unidadValidation.id;
    }

    if (campo === 'id_archivo_imagen_principal') {
      const archivoValidation = await validateArchivoImagen(valor);
      if (!archivoValidation.ok) {
        return res.status(archivoValidation.status).json({
          error: true,
          code: archivoValidation.code,
          message: archivoValidation.message
        });
      }
      valorNormalizado = archivoValidation.id;
    }

    // NEW: cuando una FK opcional se limpia, se persiste `NULL` real para mantener coherencia con la BD.
    // WHY: corrige el bug de quitar imagen y evita el mismo fallo en categoria/unidad opcionales.
    // IMPACT: los clientes siguen usando el mismo payload `valor: null`; solo cambia la persistencia interna.
    if (valorNormalizado === null && await updateNullableInsumoFieldToNull(id_valor, campo)) {
      return res.status(200).json({ message: 'Insumo actualizado correctamente.' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, campo, String(valorNormalizado), id_campo, String(id_valor)]);

    res.status(200).json({ message: 'Insumo actualizado correctamente.' });

  } catch (err) {
    console.error('Error al actualizar insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// DELETE: Inactivar insumo (soft delete)
router.delete('/insumos', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene el contrato actual del DELETE pero restringe la columna esperada.
    // WHY: evitar operaciones arbitrarias y dejar el endpoint retrocompatible.
    // IMPACT: solo responde 400 en requests malformed.
    if (columna_id !== 'id_insumo') {
      return res.status(400).json({ error: true, message: 'columna_id invalido. Debe ser exactamente id_insumo.' });
    }

    const insumoId = Number(valor_id);
    if (!isPositiveIntegerId(insumoId)) {
      return res.status(400).json({ error: true, message: 'valor_id debe ser un entero mayor a 0.' });
    }

    // NEW: 404 explicito antes de inactivar.
    // WHY: estandarizar respuestas y evitar "exito" sobre IDs inexistentes.
    // IMPACT: no cambia el flujo de IDs validos.
    const existe = await pool.query('SELECT 1 FROM insumos WHERE id_insumo = $1 LIMIT 1', [insumoId]);
    if (existe.rowCount === 0) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    const tabla = 'insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(insumoId)]);

    res.status(200).json({ error: false, message: 'Insumo inactivado.' });

  } catch (err) {
    console.error('Error al inactivar insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

export default router;
