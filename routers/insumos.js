import express from 'express';
import pool from '../config/db-connection.js';
import { attachImagenPrincipalUrls } from '../utils/uploads.js';

const router = express.Router();
const SQLSTATE_UNDEFINED_TABLE = '42P01';

// AM: allowlist de campos permitidos para alta/edicion controlada de insumos.
// AM: mantiene payload legacy (`id_almacen`) y habilita `id_almacenes` para asignacion multi-sucursal.
const CAMPOS_PERMITIDOS_INSUMOS_POST = new Set([
  'nombre_insumo',
  'precio',
  'cantidad',
  'stock_minimo',
  'fecha_ingreso_insumo',
  'id_almacen',
  'id_almacenes',
  'id_categoria_insumo',
  'id_unidad_medida',
  'fecha_caducidad',
  'descripcion',
  'estado',
  'id_archivo_imagen_principal'
]);

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

// AM: normaliza la seleccion de almacenes (uno o varios) para create/edit multi-almacen.
const parseIdAlmacenes = (rawSingle, rawMulti) => {
  const source = Array.isArray(rawMulti) ? rawMulti : (rawMulti === undefined || rawMulti === null ? [] : [rawMulti]);
  const out = [];

  for (const raw of source) {
    const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!isPositiveIntegerId(parsed)) {
      return { ok: false, message: 'id_almacenes contiene un id_almacen invalido.' };
    }
    if (!out.includes(parsed)) out.push(parsed);
  }

  if (out.length > 0) return { ok: true, ids: out };

  const parsedSingle = Number.parseInt(String(rawSingle ?? '').trim(), 10);
  if (isPositiveIntegerId(parsedSingle)) {
    return { ok: true, ids: [parsedSingle] };
  }

  return { ok: false, message: 'Debe seleccionar al menos un id_almacen.' };
};

// AM: normaliza Date/Timestamp a `YYYY-MM-DD` para reusar datos actuales en edicion multi.
const toDateOnlyString = (value) => {
  if (!value) return '';
  const raw = String(value);
  if (raw.includes('T')) return raw.split('T')[0];
  if (raw.length >= 10) return raw.slice(0, 10);
  return raw;
};

// NEW: mensaje seguro para no exponer errores crudos de BD.
// WHY: alinear manejo de errores con UX y evitar detalles internos.
// IMPACT: no cambia contratos exitosos ni status codes de validacion.
const safeServerErrorMessage = (fallback = 'No se pudo completar la accion. Verifica los datos e intenta de nuevo.') => fallback;

// NEW: helper para validar `id_categoria_insumo` y asegurar que exista/este activa.
// WHY: evitar guardar insumos apuntando a categorias inexistentes o inactivas.
// IMPACT: agrega validacion 400 opcional en POST/PUT cuando se envia `id_categoria_insumo`.
const validateCategoriaInsumoActiva = async (rawCategoriaId, db = pool) => {
  const hasValue = !(rawCategoriaId === undefined || rawCategoriaId === null || String(rawCategoriaId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const categoriaId = Number.parseInt(String(rawCategoriaId), 10);
  if (!isPositiveIntegerId(categoriaId)) {
    return { ok: false, status: 400, code: 'INVALID_INSUMO_CATEGORY_ID', message: 'id_categoria_insumo debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
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
const validateUnidadMedida = async (rawUnidadId, db = pool) => {
  const hasValue = !(rawUnidadId === undefined || rawUnidadId === null || String(rawUnidadId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const unidadId = Number.parseInt(String(rawUnidadId), 10);
  if (!isPositiveIntegerId(unidadId)) {
    return { ok: false, status: 400, code: 'INVALID_UNIDAD_MEDIDA_ID', message: 'id_unidad_medida debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
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
const validateArchivoImagen = async (rawArchivoId, db = pool) => {
  const hasValue = !(rawArchivoId === undefined || rawArchivoId === null || String(rawArchivoId).trim() === '');
  if (!hasValue) return { ok: true, id: null };

  const archivoId = Number.parseInt(String(rawArchivoId), 10);
  if (!isPositiveIntegerId(archivoId)) {
    return { ok: false, status: 400, code: 'INVALID_ARCHIVO_ID', message: 'id_archivo_imagen_principal debe ser un entero mayor a 0.' };
  }

  const result = await db.query(
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

// AM: snapshot completo del insumo para edicion multi-almacen sin perder campos opcionales existentes.
const getInsumoById = async (insumoId, db = pool) => {
  const result = await db.query(
    `SELECT
      id_insumo,
      nombre_insumo,
      precio,
      cantidad,
      stock_minimo,
      fecha_ingreso_insumo,
      id_almacen,
      id_categoria_insumo,
      id_unidad_medida,
      fecha_caducidad,
      descripcion,
      estado,
      id_archivo_imagen_principal
    FROM insumos
    WHERE id_insumo = $1
    LIMIT 1`,
    [insumoId]
  );
  return result.rows[0] || null;
};

// AM: llave operativa para detectar/actualizar insumos equivalentes por almacen en flujo multi.
const findInsumoByUniqueKey = async (
  {
    nombre_insumo,
    id_categoria_insumo,
    id_unidad_medida,
    id_almacen,
    excludeId = null
  },
  db = pool
) => {
  const params = [
    String(nombre_insumo ?? '').trim().toLowerCase(),
    id_categoria_insumo ?? null,
    id_unidad_medida ?? null,
    id_almacen
  ];

  let sql = `
    SELECT id_insumo
    FROM insumos
    WHERE lower(trim(nombre_insumo)) = $1
      AND (
        (id_categoria_insumo IS NULL AND $2::integer IS NULL)
        OR id_categoria_insumo = $2::integer
      )
      AND (
        (id_unidad_medida IS NULL AND $3::integer IS NULL)
        OR id_unidad_medida = $3::integer
      )
      AND id_almacen = $4
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_insumo <> $5';
  }

  sql += ' ORDER BY id_insumo DESC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows[0] || null;
};

// AM: busca insumo general (sin amarrarlo a almacen) para evitar duplicados por sucursal en modelo multi-asignacion.
const findInsumoByGeneralKey = async (
  {
    nombre_insumo,
    id_categoria_insumo,
    id_unidad_medida,
    excludeId = null
  },
  db = pool
) => {
  const params = [
    String(nombre_insumo ?? '').trim().toLowerCase(),
    id_categoria_insumo ?? null,
    id_unidad_medida ?? null
  ];

  let sql = `
    SELECT id_insumo
    FROM insumos
    WHERE lower(trim(nombre_insumo)) = $1
      AND (
        (id_categoria_insumo IS NULL AND $2::integer IS NULL)
        OR id_categoria_insumo = $2::integer
      )
      AND (
        (id_unidad_medida IS NULL AND $3::integer IS NULL)
        OR id_unidad_medida = $3::integer
      )
  `;

  if (excludeId !== null && excludeId !== undefined) {
    params.push(excludeId);
    sql += ' AND id_insumo <> $4';
  }

  sql += ' ORDER BY id_insumo ASC LIMIT 1';
  const result = await db.query(sql, params);
  return result.rows?.[0] || null;
};

// AM: sincroniza las asignaciones multi-almacen del insumo sin duplicar filas de `insumos`.
const syncInsumoAlmacenes = async (idInsumo, idAlmacenes, db = pool) => {
  const uniqueIds = Array.from(
    new Set(
      (Array.isArray(idAlmacenes) ? idAlmacenes : [])
        .map((id) => Number.parseInt(String(id ?? '').trim(), 10))
        .filter((id) => isPositiveIntegerId(id))
    )
  );

  if (uniqueIds.length === 0) return;

  const primaryAlmacen = uniqueIds[0];
  await db.query('UPDATE public.insumos SET id_almacen = $1 WHERE id_insumo = $2', [primaryAlmacen, idInsumo]);

  try {
    await db.query(
      `
        INSERT INTO public.insumos_almacenes (id_insumo, id_almacen)
        SELECT $1, UNNEST($2::int[])
        ON CONFLICT (id_insumo, id_almacen) DO NOTHING
      `,
      [idInsumo, uniqueIds]
    );

    await db.query(
      `
        DELETE FROM public.insumos_almacenes
        WHERE id_insumo = $1
          AND id_almacen <> ALL($2::int[])
      `,
      [idInsumo, uniqueIds]
    );
  } catch (error) {
    // AM: fallback legacy cuando la tabla de asignaciones aun no existe.
    if (error?.code !== SQLSTATE_UNDEFINED_TABLE) throw error;
  }
};

// AM: incluye `id_almacenes` en el GET de insumos manteniendo `id_almacen` para contratos legacy.
const attachInsumoAlmacenes = async (rows, db = pool) => {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;

  const ids = Array.from(
    new Set(
      list
        .map((row) => Number.parseInt(String(row?.id_insumo ?? ''), 10))
        .filter((id) => isPositiveIntegerId(id))
    )
  );
  if (ids.length === 0) {
    return list.map((row) => ({ ...row, id_almacenes: [] }));
  }

  try {
    const assignmentsResult = await db.query(
      `
        SELECT ia.id_insumo, ARRAY_AGG(ia.id_almacen ORDER BY ia.id_almacen) AS id_almacenes
        FROM public.insumos_almacenes ia
        WHERE ia.id_insumo = ANY($1::int[])
        GROUP BY ia.id_insumo
      `,
      [ids]
    );

    const map = new Map(
      assignmentsResult.rows.map((row) => [
        Number(row.id_insumo),
        (Array.isArray(row.id_almacenes) ? row.id_almacenes : [])
          .map((id) => Number.parseInt(String(id), 10))
          .filter((id) => isPositiveIntegerId(id))
      ])
    );

    return list.map((row) => {
      const idInsumo = Number.parseInt(String(row?.id_insumo ?? ''), 10);
      const fromMap = map.get(idInsumo) || [];
      const fallbackSingle = Number.parseInt(String(row?.id_almacen ?? ''), 10);
      const idAlmacenesBase =
        fromMap.length > 0
          ? fromMap
          : isPositiveIntegerId(fallbackSingle)
          ? [fallbackSingle]
          : [];
      const idAlmacenes = idAlmacenesBase;
      const primaryAlmacen = isPositiveIntegerId(fallbackSingle)
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
        id_almacenes: isPositiveIntegerId(fallbackSingle) ? [fallbackSingle] : []
      };
    });
  }
};

// AM: update completo para sincronizar insumo en varios almacenes en una transaccion.
const updateInsumoCompleto = async (insumoId, data, db = pool) => {
  await db.query(
    `UPDATE insumos
     SET
      nombre_insumo = $1,
      precio = $2,
      cantidad = $3,
      stock_minimo = $4,
      fecha_ingreso_insumo = $5,
      id_almacen = $6,
      id_categoria_insumo = $7,
      id_unidad_medida = $8,
      fecha_caducidad = $9,
      descripcion = $10,
      estado = $11,
      id_archivo_imagen_principal = $12
     WHERE id_insumo = $13`,
    [
      data.nombre_insumo,
      data.precio,
      data.cantidad,
      data.stock_minimo,
      data.fecha_ingreso_insumo || null,
      data.id_almacen,
      data.id_categoria_insumo ?? null,
      data.id_unidad_medida ?? null,
      data.fecha_caducidad || null,
      data.descripcion || '',
      data.estado,
      data.id_archivo_imagen_principal ?? null,
      insumoId
    ]
  );
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
    const datosConAlmacenes = await attachInsumoAlmacenes(datos, pool);
    const datosConImagen = await attachImagenPrincipalUrls(pool, req, datosConAlmacenes);
    res.status(200).json(datosConImagen);

  } catch (err) {
    console.error('Error al obtener insumos:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage('No se pudieron cargar los insumos.') });
  }
});

// POST: Crear insumo
router.post('/insumos', async (req, res) => {
  const client = await pool.connect();
  try {
    const tabla = 'insumos';
    const datos = req.body && typeof req.body === 'object' ? { ...req.body } : null;
    if (!datos || Array.isArray(datos)) {
      return res.status(400).json({ error: true, message: 'Payload invalido para crear insumo.' });
    }

    const keys = Object.keys(datos);
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_INSUMOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const almacenesParse = parseIdAlmacenes(datos?.id_almacen, datos?.id_almacenes);
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }
    const idAlmacenes = almacenesParse.ids;

    const payloadBase = { ...datos };
    delete payloadBase.id_almacenes;
    payloadBase.id_almacen = idAlmacenes[0];

    // NEW: valida categoria de insumo si el frontend la envia en alta.
    // WHY: proteger integridad de referencia sin depender solo de la FK.
    // IMPACT: solo bloquea payloads invalidos; altas validas mantienen el mismo flujo.
    const categoriaValidation = await validateCategoriaInsumoActiva(payloadBase?.id_categoria_insumo, client);
    if (!categoriaValidation.ok) {
      return res.status(categoriaValidation.status).json({
        error: true,
        code: categoriaValidation.code,
        message: categoriaValidation.message
      });
    }

    const unidadValidation = await validateUnidadMedida(payloadBase?.id_unidad_medida, client);
    if (!unidadValidation.ok) {
      return res.status(unidadValidation.status).json({
        error: true,
        code: unidadValidation.code,
        message: unidadValidation.message
      });
    }

    const archivoValidation = await validateArchivoImagen(payloadBase?.id_archivo_imagen_principal, client);
    if (!archivoValidation.ok) {
      return res.status(archivoValidation.status).json({
        error: true,
        code: archivoValidation.code,
        message: archivoValidation.message
      });
    }

    const payload = { ...payloadBase };
    if (categoriaValidation.id === null) delete payload.id_categoria_insumo;
    else payload.id_categoria_insumo = categoriaValidation.id;
    if (unidadValidation.id === null) delete payload.id_unidad_medida;
    else payload.id_unidad_medida = unidadValidation.id;
    if (archivoValidation.id === null) delete payload.id_archivo_imagen_principal;
    else payload.id_archivo_imagen_principal = archivoValidation.id;

    await client.query('BEGIN');

    for (const idAlmacen of idAlmacenes) {
      const existeAlmacen = await client.query(
        'SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1',
        [idAlmacen]
      );
      if (existeAlmacen.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: true,
          message: `id_almacen ${idAlmacen} no existe en almacenes.`
        });
      }
    }

    const duplicateGeneral = await findInsumoByGeneralKey(
      {
        nombre_insumo: payload.nombre_insumo,
        id_categoria_insumo: payload.id_categoria_insumo ?? null,
        id_unidad_medida: payload.id_unidad_medida ?? null
      },
      client
    );

    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'Ya existe un insumo general con el mismo nombre/categoria/unidad. Edita su asignacion de almacenes.'
      });
    }

    const primaryPayload = { ...payload, id_almacen: idAlmacenes[0] };
    const query = 'CALL pa_insert($1, $2)';
    await client.query(query, [tabla, primaryPayload]);

    const inserted = await findInsumoByUniqueKey(
      {
        nombre_insumo: primaryPayload.nombre_insumo,
        id_categoria_insumo: primaryPayload.id_categoria_insumo ?? null,
        id_unidad_medida: primaryPayload.id_unidad_medida ?? null,
        id_almacen: primaryPayload.id_almacen
      },
      client
    );

    const idInsumoCreado = Number.parseInt(String(inserted?.id_insumo ?? ''), 10);
    if (!isPositiveIntegerId(idInsumoCreado)) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: true,
        message: 'No se pudo resolver el ID del insumo creado.'
      });
    }

    await syncInsumoAlmacenes(idInsumoCreado, idAlmacenes, client);
    await client.query('COMMIT');

    res.status(201).json({
      message: 'Insumo creado exitosamente.',
      id_insumo: idInsumoCreado,
      id_almacenes: idAlmacenes
    });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error al crear insumo:', err.message);
    res.status(500).json({ error: true, message: safeServerErrorMessage() });
  } finally {
    client.release();
  }
});

// AM: actualizacion completa del insumo sincronizando uno o varios almacenes en una sola transaccion.
// AM: conserva `PUT /insumos` por campo y agrega flujo dedicado multi-almacen para crear/editar desde UI.
router.put('/insumos/multi-almacen', async (req, res) => {
  const client = await pool.connect();
  try {
    const idInsumo = Number.parseInt(String(req.body?.id_insumo ?? ''), 10);
    if (!isPositiveIntegerId(idInsumo)) {
      return res.status(400).json({ error: true, message: 'id_insumo invalido.' });
    }

    const actual = await getInsumoById(idInsumo, client);
    if (!actual) {
      return res.status(404).json({ error: true, message: 'Insumo no encontrado.' });
    }

    const datosEntrada = req.body && typeof req.body === 'object' ? { ...req.body } : {};
    delete datosEntrada.id_insumo;

    const keys = Object.keys(datosEntrada);
    const keysDesconocidas = keys.filter((k) => !CAMPOS_PERMITIDOS_INSUMOS_POST.has(k));
    if (keysDesconocidas.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Campos no permitidos: ${keysDesconocidas.join(', ')}`
      });
    }

    const merged = {
      nombre_insumo: datosEntrada.nombre_insumo ?? actual.nombre_insumo,
      precio: datosEntrada.precio ?? actual.precio,
      cantidad: datosEntrada.cantidad ?? actual.cantidad,
      stock_minimo: datosEntrada.stock_minimo ?? actual.stock_minimo ?? 0,
      fecha_ingreso_insumo: datosEntrada.fecha_ingreso_insumo ?? toDateOnlyString(actual.fecha_ingreso_insumo),
      id_almacen: datosEntrada.id_almacen ?? actual.id_almacen,
      id_categoria_insumo: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_categoria_insumo')
        ? datosEntrada.id_categoria_insumo
        : actual.id_categoria_insumo,
      id_unidad_medida: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_unidad_medida')
        ? datosEntrada.id_unidad_medida
        : actual.id_unidad_medida,
      fecha_caducidad: datosEntrada.fecha_caducidad ?? toDateOnlyString(actual.fecha_caducidad),
      descripcion: datosEntrada.descripcion ?? actual.descripcion ?? '',
      estado: Object.prototype.hasOwnProperty.call(datosEntrada, 'estado')
        ? datosEntrada.estado
        : (actual.estado ?? true),
      id_archivo_imagen_principal: Object.prototype.hasOwnProperty.call(datosEntrada, 'id_archivo_imagen_principal')
        ? datosEntrada.id_archivo_imagen_principal
        : actual.id_archivo_imagen_principal
    };

    const required = ['nombre_insumo', 'precio', 'cantidad', 'stock_minimo'];
    const faltantes = required.filter((campo) => {
      const raw = merged[campo];
      return raw === undefined || raw === null || String(raw).trim() === '';
    });
    if (faltantes.length > 0) {
      return res.status(400).json({
        error: true,
        message: `Faltan campos obligatorios: ${faltantes.join(', ')}`
      });
    }

    const nombreInsumo = String(merged.nombre_insumo ?? '').trim();
    const precio = Number(merged.precio);
    const cantidad = Number.parseInt(String(merged.cantidad ?? ''), 10);
    const stockMinimo = Number.parseInt(String(merged.stock_minimo ?? ''), 10);
    if (nombreInsumo.length < 2 || nombreInsumo.length > 80) {
      return res.status(400).json({ error: true, message: 'nombre_insumo debe tener entre 2 y 80 caracteres.' });
    }
    if (!Number.isFinite(precio) || precio < 0) {
      return res.status(400).json({ error: true, message: 'precio debe ser un numero mayor o igual a 0.' });
    }
    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: true, message: 'cantidad debe ser un entero mayor o igual a 0.' });
    }
    if (!Number.isInteger(stockMinimo) || stockMinimo < 0) {
      return res.status(400).json({ error: true, message: 'stock_minimo debe ser un entero mayor o igual a 0.' });
    }

    const categoriaValidation = await validateCategoriaInsumoActiva(merged.id_categoria_insumo, client);
    if (!categoriaValidation.ok) {
      return res.status(categoriaValidation.status).json({
        error: true,
        code: categoriaValidation.code,
        message: categoriaValidation.message
      });
    }

    const unidadValidation = await validateUnidadMedida(merged.id_unidad_medida, client);
    if (!unidadValidation.ok) {
      return res.status(unidadValidation.status).json({
        error: true,
        code: unidadValidation.code,
        message: unidadValidation.message
      });
    }

    const archivoValidation = await validateArchivoImagen(merged.id_archivo_imagen_principal, client);
    if (!archivoValidation.ok) {
      return res.status(archivoValidation.status).json({
        error: true,
        code: archivoValidation.code,
        message: archivoValidation.message
      });
    }

    const almacenesParse = parseIdAlmacenes(merged.id_almacen, datosEntrada.id_almacenes);
    if (!almacenesParse.ok || !Array.isArray(almacenesParse.ids) || almacenesParse.ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: almacenesParse.message || 'Debe seleccionar al menos un id_almacen.'
      });
    }
    const idAlmacenes = almacenesParse.ids;

    for (const idAlmacen of idAlmacenes) {
      const existeAlmacen = await client.query(
        'SELECT 1 FROM almacenes WHERE id_almacen = $1 LIMIT 1',
        [idAlmacen]
      );
      if (existeAlmacen.rowCount === 0) {
        return res.status(400).json({
          error: true,
          message: `id_almacen ${idAlmacen} no existe en almacenes.`
        });
      }
    }

    const normalized = {
      nombre_insumo: nombreInsumo,
      precio,
      cantidad,
      stock_minimo: stockMinimo,
      fecha_ingreso_insumo: String(merged.fecha_ingreso_insumo ?? '').trim(),
      id_categoria_insumo: categoriaValidation.id,
      id_unidad_medida: unidadValidation.id,
      fecha_caducidad: String(merged.fecha_caducidad ?? '').trim(),
      descripcion: String(merged.descripcion ?? '').trim(),
      estado: merged.estado === true || merged.estado === 'true' || merged.estado === 1 || merged.estado === '1',
      id_archivo_imagen_principal: archivoValidation.id
    };

    await client.query('BEGIN');

    const duplicateGeneral = await findInsumoByGeneralKey(
      {
        nombre_insumo: normalized.nombre_insumo,
        id_categoria_insumo: normalized.id_categoria_insumo,
        id_unidad_medida: normalized.id_unidad_medida,
        excludeId: idInsumo
      },
      client
    );

    if (duplicateGeneral) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: true,
        message: 'Ya existe otro insumo general con el mismo nombre/categoria/unidad.'
      });
    }

    const primaryAlmacen = idAlmacenes[0];
    const primaryPayload = { ...normalized, id_almacen: primaryAlmacen };
    await updateInsumoCompleto(idInsumo, primaryPayload, client);
    await syncInsumoAlmacenes(idInsumo, idAlmacenes, client);

    await client.query('COMMIT');
    return res.status(200).json({
      message: `Insumo actualizado y asignado en ${idAlmacenes.length} almacen(es).`,
      id_insumo: idInsumo,
      id_almacenes: idAlmacenes
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error en PUT /insumos/multi-almacen:', err.message);
    return res.status(500).json({ error: true, message: safeServerErrorMessage() });
  } finally {
    client.release();
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

    if (campo === 'id_almacen') {
      // AM: mantiene alineada la tabla de asignaciones cuando el endpoint legacy cambia el almacen primario.
      const insumoId = Number.parseInt(String(id_valor ?? ''), 10);
      if (isPositiveIntegerId(insumoId) && isPositiveIntegerId(valorNormalizado)) {
        await syncInsumoAlmacenes(insumoId, [valorNormalizado], pool);
      }
    }

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
