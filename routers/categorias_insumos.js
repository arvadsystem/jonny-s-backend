import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';

const router = express.Router();
const CATEGORIAS_INSUMOS_VIEW_PERMISSIONS = ['INVENTARIO_CATEGORIAS_INSUMOS_VER'];
const CATEGORIAS_INSUMOS_CREATE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_INSUMOS_CREAR'];
const CATEGORIAS_INSUMOS_EDIT_PERMISSIONS = ['INVENTARIO_CATEGORIAS_INSUMOS_EDITAR'];
const CATEGORIAS_INSUMOS_STATE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_INSUMOS_ESTADO_CAMBIAR'];
const CATEGORIAS_INSUMOS_DELETE_PERMISSIONS = ['INVENTARIO_CATEGORIAS_INSUMOS_ELIMINAR'];
const CATEGORY_ACTIVE_INSUMOS_BLOCK_CODE = 'CATEGORY_HAS_ACTIVE_INSUMOS';
const CATEGORY_ACTIVE_INSUMOS_LEGACY_CODE = 'CATEGORY_INSUMO_HAS_ACTIVE_ITEMS';
const CATEGORY_ACTIVE_INSUMOS_BLOCK_MESSAGE = 'No se puede inactivar la categoria porque tiene insumos activos asignados.';
const CATEGORY_ACTIVE_INSUMOS_PREVIEW_LIMIT = 10;

// NEW: mensaje estándar para bloqueo de inactivación por insumos activos asociados.
// WHY: alinear backend con la regla de negocio para categorías de insumos.
// IMPACT: solo respuestas 409 de DELETE /categorias_insumos; no cambia contratos de entrada.

// NEW: permite incluir inactivos solo bajo solicitud explícita.
// WHY: GET debe devolver activos por defecto tras migrar a soft delete.
// IMPACT: `?incluir_inactivos=1` habilita vista administrativa sin endpoint nuevo.
const shouldIncludeInactive = (query) => String(query?.incluir_inactivos ?? '').trim() === '1';

// NEW: normaliza el valor de `estado` para soportar boolean/string/number.
// WHY: `function_select` puede serializar booleans de distintas formas según entorno.
// IMPACT: solo afecta el filtrado del GET.
const isRowActive = (row) => {
  const raw = row?.estado;
  if (raw === undefined || raw === null || raw === '') return true;
  if (raw === true || raw === 1 || raw === '1') return true;
  return String(raw).trim().toLowerCase() === 'true';
};

// NEW: helper para validar IDs enteros positivos.
// WHY: responder 400 antes de invocar SPs/queries con valores inválidos.
// IMPACT: solo endurece validaciones; requests válidos no cambian.
const isPositiveIntegerId = (value) => Number.isSafeInteger(value) && value > 0;

// NEW: normaliza entradas booleanas usadas en updates por campo (PUT) para detectar inactivaciones.
// WHY: `pa_update` recibe strings y el frontend puede enviar boolean/0/1/'false'; la regla debe aplicarse igual.
// IMPACT: solo agrega validación previa cuando `campo === "estado"`; no altera otros updates.
const normalizeBooleanInput = (value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 't', 'si', 'sí', 'on'].includes(raw)) return true;
  if (['false', '0', 'f', 'no', 'off'].includes(raw)) return false;
  return null;
};

// NEW: mensaje seguro para no exponer detalles internos de BD.
// WHY: evitar mensajes crudos al cliente en errores 500.
// IMPACT: solo cambia el copy de errores 500.
const safeServerErrorMessage = (fallback = 'No se pudo completar la acción. Verifica los datos e intenta de nuevo.') => fallback;

// NEW: helpers de payload para endurecer validaciones sin cambiar contratos del módulo.
// WHY: prevenir entradas con estructura inválida o campos inesperados en create/edición completa.
// IMPACT: solo aplica a POST y PUT /edicion.
const INPUT_CATEGORY_CREATE_ALLOWED_FIELDS = new Set(['nombre_categoria', 'codigo_categoria', 'descripcion', 'estado']);
const INPUT_CATEGORY_FULL_EDIT_ALLOWED_FIELDS = new Set(['id_categoria_insumo', 'nombre_categoria', 'codigo_categoria', 'descripcion', 'estado']);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasOnlyAllowedFields = (payload, allowedSet) => Object.keys(payload).every((key) => allowedSet.has(key));

// AM: resumen reutilizable de insumos activos asociados para bloqueo de inactivacion.
const getCategoriaInsumoActiveInsumosSummary = async (categoriaId) => {
  const query = `
    SELECT
      i.id_insumo,
      i.nombre_insumo,
      COUNT(*) OVER()::int AS total_count
    FROM insumos i
    WHERE i.id_categoria_insumo = $1
      AND i.estado = true
    ORDER BY i.id_insumo ASC
    LIMIT $2
  `;
  const result = await pool.query(query, [categoriaId, CATEGORY_ACTIVE_INSUMOS_PREVIEW_LIMIT]);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const total = Number(rows?.[0]?.total_count ?? 0);
  const items = rows.map((row) => ({
    id_insumo: Number(row.id_insumo),
    nombre: String(row.nombre_insumo ?? '')
  }));
  const remaining = Math.max(0, total - items.length);
  return {
    entity: 'categoria_insumo',
    blocking_relation: 'insumos_activos',
    total,
    items,
    remaining
  };
};

// AM: assertion centralizada para bloquear inactivacion de categoria con insumos activos.
const assertCategoriaInsumoCanBeDeactivated = async (res, categoriaId) => {
  const dependency_summary = await getCategoriaInsumoActiveInsumosSummary(categoriaId);
  if (dependency_summary.total <= 0) return true;

  res.status(409).json({
    error: true,
    code: CATEGORY_ACTIVE_INSUMOS_BLOCK_CODE,
    legacy_code: CATEGORY_ACTIVE_INSUMOS_LEGACY_CODE,
    message: CATEGORY_ACTIVE_INSUMOS_BLOCK_MESSAGE,
    dependency_summary
  });
  return false;
};

// ------------------------------------------------------------------------------------
// GET: Obtener categorias_insumos
// ------------------------------------------------------------------------------------
router.get('/categorias_insumos', checkPermission(CATEGORIAS_INSUMOS_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const tabla = 'categorias_insumos';
    const columnas = 'id_categoria_insumo, nombre_categoria, codigo_categoria, descripcion, estado';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);

    const baseDatos = result.rows?.[0]?.resultado || [];
    // NEW: por defecto se devuelven solo categorías activas.
    // WHY: alinear GET con la regla de soft delete basada en `estado=false`.
    // IMPACT: admin puede incluir inactivas con `?incluir_inactivos=1`.
    const datos = shouldIncludeInactive(req.query) ? baseDatos : baseDatos.filter(isRowActive);
    res.status(200).json(datos);
  } catch (err) {
    console.error('Error al obtener categorias_insumos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar las categorías de insumos.') });
  }
});

// ------------------------------------------------------------------------------------
// POST: Crear categoria_insumo
// ------------------------------------------------------------------------------------
router.post('/categorias_insumos', checkPermission(CATEGORIAS_INSUMOS_CREATE_PERMISSIONS), async (req, res) => {
  try {
    const tabla = 'categorias_insumos';
    const datosEntrada = req.body;
    if (!isPlainObject(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido.' });
    }
    if (!hasOnlyAllowedFields(datosEntrada, INPUT_CATEGORY_CREATE_ALLOWED_FIELDS)) {
      return res.status(400).json({ error: true, message: 'El payload contiene campos no permitidos.' });
    }

    const nombre = String(datosEntrada?.nombre_categoria ?? '').trim();
    const codigo = String(datosEntrada?.codigo_categoria ?? '').trim();
    const descripcion = datosEntrada?.descripcion === undefined || datosEntrada?.descripcion === null
      ? ''
      : String(datosEntrada.descripcion).trim();

    if (!nombre) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (!codigo) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (descripcion.length > 150) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 150 caracteres.' });
    }

    const datos = {
      ...datosEntrada,
      nombre_categoria: nombre,
      codigo_categoria: codigo,
      descripcion
    };

    const query = 'CALL pa_insert($1, $2)';
    await pool.query(query, [tabla, datos]);

    res.status(201).json({ message: 'Categoría de insumo creada exitosamente.' });
  } catch (err) {
    console.error('Error al crear categoria_insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_insumo completa (edicion atomica)
// ------------------------------------------------------------------------------------
router.put('/categorias_insumos/edicion', checkPermission(CATEGORIAS_INSUMOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const datosEntrada = req.body;
    if (!isPlainObject(datosEntrada)) {
      return res.status(400).json({ error: true, message: 'Payload invalido.' });
    }
    if (!hasOnlyAllowedFields(datosEntrada, INPUT_CATEGORY_FULL_EDIT_ALLOWED_FIELDS)) {
      return res.status(400).json({ error: true, message: 'El payload contiene campos no permitidos.' });
    }

    const {
      id_categoria_insumo,
      nombre_categoria,
      codigo_categoria,
      descripcion,
      estado
    } = datosEntrada;

    const categoriaId = Number(id_categoria_insumo);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'id_categoria_insumo debe ser un entero mayor a 0.' });
    }

    const nombre = String(nombre_categoria ?? '').trim();
    const codigo = String(codigo_categoria ?? '').trim();
    const descripcionNormalizada = descripcion === undefined || descripcion === null
      ? ''
      : String(descripcion).trim();
    const estadoNormalizado = normalizeBooleanInput(estado);

    if (!nombre) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (!codigo) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (descripcionNormalizada.length > 150) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 150 caracteres.' });
    }
    if (estadoNormalizado === null) {
      return res.status(400).json({ error: true, message: 'estado invalido.' });
    }

    // NEW: conserva la misma regla de negocio para inactivar cuando hay insumos activos asociados.
    // WHY: mantener consistencia con DELETE y PUT por campo.
    // IMPACT: solo bloquea cuando la edicion intenta dejar `estado=false` y hay dependencias activas.
    if (estadoNormalizado === false) {
      const canDeactivate = await assertCategoriaInsumoCanBeDeactivated(res, categoriaId);
      if (!canDeactivate) return;
    }

    const updateRes = await pool.query(
      `UPDATE categorias_insumos
       SET nombre_categoria = $1,
           codigo_categoria = $2,
           descripcion = $3,
           estado = $4
       WHERE id_categoria_insumo = $5`,
      [nombre, codigo, descripcionNormalizada, estadoNormalizado, categoriaId]
    );

    if (updateRes.rowCount === 0) {
      return res.status(404).json({ error: true, code: 'CATEGORY_INSUMO_NOT_FOUND', message: 'Categoría de insumo no encontrada.' });
    }

    res.status(200).json({ message: 'Categoría de insumo actualizada correctamente.' });
  } catch (err) {
    console.error('Error en edicion atomica de categoria_insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PUT: Actualizar categoria_insumo (actualiza 1 campo)
// ------------------------------------------------------------------------------------
router.put('/categorias_insumos', checkPermission(CATEGORIAS_INSUMOS_EDIT_PERMISSIONS), async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body || {};

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan campos obligatorios' });
    }

    const isTextField = campo === 'nombre_categoria' || campo === 'codigo_categoria' || campo === 'descripcion';
    const valorSaneado = isTextField ? String(valor ?? '').trim() : valor;

    if (campo === 'nombre_categoria' && !valorSaneado) {
      return res.status(400).json({ error: true, message: 'nombre_categoria es obligatorio.' });
    }
    if (campo === 'codigo_categoria' && !valorSaneado) {
      return res.status(400).json({ error: true, message: 'codigo_categoria es obligatorio.' });
    }
    if (campo === 'descripcion' && String(valorSaneado).length > 150) {
      return res.status(400).json({ error: true, message: 'La descripcion no puede exceder 150 caracteres.' });
    }

    // NEW: aplica la misma regla de bloqueo en PUT cuando el frontend intenta inactivar via `estado=false`.
    // WHY: el drawer de edicion puede cambiar `estado`; backend debe proteger igual en desktop/responsive.
    // IMPACT: responde 409 estandar en inactivaciones bloqueadas; otros updates siguen intactos.
    if (campo === 'estado') {
      const normalizedEstado = normalizeBooleanInput(valor);
      if (normalizedEstado === false) {
        if (id_campo !== 'id_categoria_insumo') {
          return res.status(400).json({
            error: true,
            message: 'id_campo invalido. Debe ser exactamente id_categoria_insumo para actualizar estado.'
          });
        }
        const categoriaId = Number(id_valor);
        if (!isPositiveIntegerId(categoriaId)) {
          return res.status(400).json({ error: true, message: 'id_valor debe ser un entero mayor a 0.' });
        }
        const canDeactivate = await assertCategoriaInsumoCanBeDeactivated(res, categoriaId);
        if (!canDeactivate) return;
      }
    }

    const tabla = 'categorias_insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';

    await pool.query(query, [
      tabla,
      campo,
      String(valorSaneado),
      id_campo,
      String(id_valor)
    ]);

    res.status(200).json({ message: 'Categoría de insumo actualizada correctamente.' });
  } catch (err) {
    console.error('Error al actualizar categoria_insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// PATCH: Cambiar estado categoria_insumo (flujo dedicado activar/inactivar)
// ------------------------------------------------------------------------------------
router.patch('/categorias_insumos/estado', checkPermission(CATEGORIAS_INSUMOS_STATE_PERMISSIONS), async (req, res) => {
  try {
    const categoriaId = Number(req.body?.id_categoria_insumo);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'id_categoria_insumo debe ser un entero mayor a 0.' });
    }

    const normalizedEstado = normalizeBooleanInput(req.body?.estado);
    if (normalizedEstado === null) {
      return res.status(400).json({ error: true, message: 'estado invalido.' });
    }

    const categoriaRes = await pool.query(
      'SELECT 1 FROM categorias_insumos WHERE id_categoria_insumo = $1 LIMIT 1',
      [categoriaId]
    );
    if (categoriaRes.rowCount === 0) {
      return res.status(404).json({ error: true, code: 'CATEGORY_INSUMO_NOT_FOUND', message: 'CategorÃ­a de insumo no encontrada.' });
    }

    if (normalizedEstado === false) {
      const canDeactivate = await assertCategoriaInsumoCanBeDeactivated(res, categoriaId);
      if (!canDeactivate) return;
    }

    await pool.query(
      'UPDATE categorias_insumos SET estado = $1 WHERE id_categoria_insumo = $2',
      [normalizedEstado, categoriaId]
    );

    return res.status(200).json({
      error: false,
      message: normalizedEstado ? 'CategorÃ­a de insumo activada.' : 'CategorÃ­a de insumo inactivada.'
    });
  } catch (err) {
    console.error('Error al actualizar estado de categoria_insumo:', err.message);
    return res.status(500).json({ error: true, code: 'INTERNAL_ERROR', message: safeServerErrorMessage() });
  }
});

// ------------------------------------------------------------------------------------
// DELETE: Inactivar categoria_insumo (soft delete)
// ------------------------------------------------------------------------------------
router.delete('/categorias_insumos', checkPermission(CATEGORIAS_INSUMOS_DELETE_PERMISSIONS), async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body || {};

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar' });
    }

    // NEW: mantiene la firma actual pero valida la columna esperada.
    // WHY: evitar operaciones arbitrarias y conservar el contrato retrocompatible.
    // IMPACT: solo responde 400 en requests mal formados.
    if (columna_id !== 'id_categoria_insumo') {
      return res.status(400).json({
        error: true,
        message: 'columna_id invalido. Debe ser exactamente id_categoria_insumo.'
      });
    }

    const categoriaId = Number(valor_id);
    if (!isPositiveIntegerId(categoriaId)) {
      return res.status(400).json({ error: true, message: 'valor_id debe ser un entero mayor a 0.' });
    }

    // NEW: 404 explícito para IDs inexistentes.
    // WHY: estandarizar respuestas y evitar "éxito" sobre registros no existentes.
    // IMPACT: solo afecta requests con IDs inválidos/inexistentes.
    const categoriaRes = await pool.query(
      'SELECT 1 FROM categorias_insumos WHERE id_categoria_insumo = $1 LIMIT 1',
      [categoriaId]
    );
    if (categoriaRes.rowCount === 0) {
      return res.status(404).json({ error: true, code: 'CATEGORY_INSUMO_NOT_FOUND', message: 'Categoría de insumo no encontrada.' });
    }

    // NEW: regla de negocio para bloquear inactivación si hay insumos activos asociados.
    // WHY: evitar dejar insumos activos ligados a categorías inactivas.
    // IMPACT: responde 409 con código/mensaje estándar para manejo explícito en frontend.
    const canDeactivate = await assertCategoriaInsumoCanBeDeactivated(res, categoriaId);
    if (!canDeactivate) return;

    const tabla = 'categorias_insumos';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, 'estado', 'false', columna_id, String(categoriaId)]);

    res.status(200).json({ error: false, message: 'Categoría de insumo inactivada.' });
  } catch (err) {
    console.error('Error al inactivar categoria_insumo:', err.message);
    res.status(500).json({ error: true, code: 'INTERNAL_ERROR', message: safeServerErrorMessage() });
  }
});

export default router;
