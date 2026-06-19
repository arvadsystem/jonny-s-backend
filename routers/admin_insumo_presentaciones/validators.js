const MAX_NOMBRE_PRESENTACION_LENGTH = 120;

export const isPositiveIntegerId = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
};

export const parsePositiveIntegerId = (value, fieldName) => {
  const parsed = Number(value);
  if (!isPositiveIntegerId(parsed)) {
    return { ok: false, message: `${fieldName} invalido.` };
  }
  return { ok: true, value: parsed };
};

const parsePositiveDecimal = (value, fieldName) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { ok: false, message: `${fieldName} es obligatorio.` };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, message: `${fieldName} debe ser un numero positivo.` };
  }
  return { ok: true, value: parsed };
};

const parseBoolean = (value, fieldName, { required = true, defaultValue = null } = {}) => {
  if (value === undefined || value === null || value === '') {
    if (!required) return { ok: true, value: defaultValue };
    return { ok: false, message: `${fieldName} es obligatorio.` };
  }
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 1 || value === '1') return { ok: true, value: true };
  if (value === 0 || value === '0') return { ok: true, value: false };

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return { ok: true, value: true };
  if (normalized === 'false') return { ok: true, value: false };
  return { ok: false, message: `${fieldName} debe ser booleano.` };
};

const sanitizeName = (value) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');

export const normalizePresentationPayload = (payload = {}, { currentEstado = undefined } = {}) => {
  const nombrePresentacion = sanitizeName(payload.nombre_presentacion);
  if (!nombrePresentacion) return { ok: false, message: 'nombre_presentacion es obligatorio.' };
  if (nombrePresentacion.length > MAX_NOMBRE_PRESENTACION_LENGTH) {
    return {
      ok: false,
      message: `nombre_presentacion no puede exceder ${MAX_NOMBRE_PRESENTACION_LENGTH} caracteres.`
    };
  }

  const cantidadPresentacion = parsePositiveDecimal(payload.cantidad_presentacion, 'cantidad_presentacion');
  if (!cantidadPresentacion.ok) return cantidadPresentacion;

  const idUnidadPresentacion = parsePositiveIntegerId(
    payload.id_unidad_presentacion,
    'id_unidad_presentacion'
  );
  if (!idUnidadPresentacion.ok) return idUnidadPresentacion;

  const cantidadBase = parsePositiveDecimal(payload.cantidad_base, 'cantidad_base');
  if (!cantidadBase.ok) return cantidadBase;

  const idUnidadBase = parsePositiveIntegerId(payload.id_unidad_base, 'id_unidad_base');
  if (!idUnidadBase.ok) return idUnidadBase;

  const usoCompra = parseBoolean(payload.uso_compra, 'uso_compra');
  if (!usoCompra.ok) return usoCompra;

  const usoReceta = parseBoolean(payload.uso_receta, 'uso_receta');
  if (!usoReceta.ok) return usoReceta;

  if (!usoCompra.value && !usoReceta.value) {
    return { ok: false, message: 'La presentacion debe tener uso_compra o uso_receta activo.' };
  }

  const predCompra = parseBoolean(payload.es_predeterminada_compra, 'es_predeterminada_compra', {
    required: false,
    defaultValue: false
  });
  if (!predCompra.ok) return predCompra;

  const predReceta = parseBoolean(payload.es_predeterminada_receta, 'es_predeterminada_receta', {
    required: false,
    defaultValue: false
  });
  if (!predReceta.ok) return predReceta;

  if (predCompra.value && !usoCompra.value) {
    return {
      ok: false,
      message: 'es_predeterminada_compra solo puede ser true si uso_compra es true.'
    };
  }
  if (predReceta.value && !usoReceta.value) {
    return {
      ok: false,
      message: 'es_predeterminada_receta solo puede ser true si uso_receta es true.'
    };
  }

  const estado = parseBoolean(payload.estado, 'estado', {
    required: false,
    defaultValue: Boolean(currentEstado)
  });
  if (!estado.ok) return estado;

  return {
    ok: true,
    data: {
      nombre_presentacion: nombrePresentacion,
      cantidad_presentacion: cantidadPresentacion.value,
      id_unidad_presentacion: idUnidadPresentacion.value,
      cantidad_base: cantidadBase.value,
      id_unidad_base: idUnidadBase.value,
      uso_compra: usoCompra.value,
      uso_receta: usoReceta.value,
      es_predeterminada_compra: predCompra.value,
      es_predeterminada_receta: predReceta.value,
      estado: estado.value
    }
  };
};

export const normalizeEstadoPayload = (payload = {}) => {
  const estado = parseBoolean(payload.estado, 'estado');
  if (!estado.ok) return estado;
  return { ok: true, data: { estado: estado.value } };
};
