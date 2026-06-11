import {
  clearDefaultCompra,
  clearDefaultReceta,
  createPresentacion,
  findInsumoById,
  findPresentacionById,
  getClient,
  listPresentacionesByInsumo,
  unidadExists,
  updatePresentacion,
  updatePresentacionEstado
} from './repository.js';

const createHttpError = (status, message, code = undefined) => {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
};

const validateInsumoForPresentation = async (client, idInsumo, { requireActive = false } = {}) => {
  const insumo = await findInsumoById(client, idInsumo);
  if (!insumo) throw createHttpError(404, 'Insumo no encontrado.', 'INSUMO_NOT_FOUND');
  if (requireActive && !insumo.estado) {
    throw createHttpError(409, 'No se pueden administrar presentaciones de un insumo inactivo.', 'INSUMO_INACTIVO');
  }
  if (!insumo.id_unidad_medida) {
    throw createHttpError(409, 'Primero debe definirse la unidad base del insumo.', 'INSUMO_SIN_UNIDAD_BASE');
  }
  return insumo;
};

const validatePresentationData = async (client, idInsumo, data, { requireActiveInsumo = false } = {}) => {
  const insumo = await validateInsumoForPresentation(client, idInsumo, {
    requireActive: requireActiveInsumo || data.estado
  });

  if (Number(insumo.id_unidad_medida) !== Number(data.id_unidad_base)) {
    throw createHttpError(
      400,
      'id_unidad_base debe coincidir con la unidad base configurada en el insumo.',
      'UNIDAD_BASE_NO_COINCIDE'
    );
  }

  if (!(await unidadExists(client, data.id_unidad_presentacion))) {
    throw createHttpError(400, 'La unidad de presentacion no existe.', 'UNIDAD_PRESENTACION_NOT_FOUND');
  }
  if (!(await unidadExists(client, data.id_unidad_base))) {
    throw createHttpError(400, 'La unidad base no existe.', 'UNIDAD_BASE_NOT_FOUND');
  }
};

export const listPresentaciones = async (idInsumo) => {
  const client = await getClient();
  try {
    await validateInsumoForPresentation(client, idInsumo);
    const presentaciones = await listPresentacionesByInsumo(client, idInsumo);
    return { id_insumo: idInsumo, presentaciones };
  } finally {
    client.release();
  }
};

export const createInsumoPresentacion = async (idInsumo, data) => {
  const client = await getClient();
  try {
    await validatePresentationData(client, idInsumo, data, { requireActiveInsumo: true });
    await client.query('BEGIN');
    if (data.estado && data.es_predeterminada_compra) await clearDefaultCompra(client, idInsumo);
    if (data.estado && data.es_predeterminada_receta) await clearDefaultReceta(client, idInsumo);
    const idPresentacion = await createPresentacion(client, idInsumo, data);
    await client.query('COMMIT');
    return { id_presentacion: idPresentacion };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const updateInsumoPresentacion = async (idInsumo, idPresentacion, data) => {
  const client = await getClient();
  try {
    const current = await findPresentacionById(client, idPresentacion);
    if (!current) throw createHttpError(404, 'Presentacion no encontrada.', 'PRESENTACION_NOT_FOUND');
    if (Number(current.id_insumo) !== Number(idInsumo)) {
      throw createHttpError(409, 'La presentacion no pertenece al insumo indicado.', 'PRESENTACION_INSUMO_MISMATCH');
    }

    const nextData = {
      ...data,
      estado: data.estado === undefined ? Boolean(current.estado) : data.estado
    };

    await validatePresentationData(client, idInsumo, nextData);
    await client.query('BEGIN');
    if (nextData.estado && nextData.es_predeterminada_compra) await clearDefaultCompra(client, idInsumo, idPresentacion);
    if (nextData.estado && nextData.es_predeterminada_receta) await clearDefaultReceta(client, idInsumo, idPresentacion);
    await updatePresentacion(client, idPresentacion, nextData);
    await client.query('COMMIT');
    return { id_presentacion: idPresentacion };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const changeInsumoPresentacionEstado = async (idInsumo, idPresentacion, estado) => {
  const client = await getClient();
  try {
    const current = await findPresentacionById(client, idPresentacion);
    if (!current) throw createHttpError(404, 'Presentacion no encontrada.', 'PRESENTACION_NOT_FOUND');
    if (Number(current.id_insumo) !== Number(idInsumo)) {
      throw createHttpError(409, 'La presentacion no pertenece al insumo indicado.', 'PRESENTACION_INSUMO_MISMATCH');
    }

    if (estado) await validateInsumoForPresentation(client, idInsumo, { requireActive: true });
    await client.query('BEGIN');
    if (estado && current.uso_compra && current.es_predeterminada_compra) {
      await clearDefaultCompra(client, idInsumo, idPresentacion);
    }
    if (estado && current.uso_receta && current.es_predeterminada_receta) {
      await clearDefaultReceta(client, idInsumo, idPresentacion);
    }
    await updatePresentacionEstado(client, idPresentacion, estado);
    await client.query('COMMIT');
    return { id_presentacion: idPresentacion };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
