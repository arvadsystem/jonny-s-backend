const TEGUCIGALPA_TIMEZONE = 'America/Tegucigalpa';
const DOCUMENT_TYPES = Object.freeze({
  VENTA: 'VENTA',
  REVERSION: 'REVERSION'
});

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeDocumentType = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === DOCUMENT_TYPES.VENTA) return DOCUMENT_TYPES.VENTA;
  if (normalized === DOCUMENT_TYPES.REVERSION) return DOCUMENT_TYPES.REVERSION;
  return null;
};

const sanitizePrefix = (value, fallback) => {
  const cleaned = String(value || fallback || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');

  if (!cleaned) return fallback;
  return cleaned.slice(0, 10);
};

const padCorrelative = (value, length) => String(value).padStart(length, '0');

export const getFechaOperacionHonduras = (baseDate = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TEGUCIGALPA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(baseDate);
};

export const generarCodigoDocumento = async ({
  client,
  idSucursal,
  tipoDocumento
}) => {
  if (!client || typeof client.query !== 'function') {
    throw new Error('FACTURACION_CORRELATIVO_CLIENT_REQUIRED');
  }

  const sucursalId = toPositiveInt(idSucursal);
  if (!sucursalId) {
    throw new Error('FACTURACION_CORRELATIVO_SUCURSAL_INVALIDA');
  }

  const normalizedType = normalizeDocumentType(tipoDocumento);
  if (!normalizedType) {
    throw new Error('FACTURACION_CORRELATIVO_TIPO_INVALIDO');
  }

  const fechaOperacion = getFechaOperacionHonduras();

  await client.query(
    `
      INSERT INTO public.facturacion_config_sucursal (
        id_sucursal
      )
      VALUES ($1)
      ON CONFLICT (id_sucursal) DO NOTHING
    `,
    [sucursalId]
  );

  const configResult = await client.query(
    `
      SELECT
        prefijo_venta,
        prefijo_reversion,
        longitud_correlativo
      FROM public.facturacion_config_sucursal
      WHERE id_sucursal = $1
      FOR UPDATE
    `,
    [sucursalId]
  );

  if (configResult.rowCount === 0) {
    throw new Error('FACTURACION_CONFIG_NOT_FOUND');
  }

  const config = configResult.rows[0];
  const correlativeLength = Math.min(
    10,
    Math.max(3, Number.parseInt(String(config.longitud_correlativo ?? '5'), 10) || 5)
  );

  const prefix =
    normalizedType === DOCUMENT_TYPES.VENTA
      ? sanitizePrefix(config.prefijo_venta, 'VTA')
      : sanitizePrefix(config.prefijo_reversion, 'REV');

  await client.query(
    `
      INSERT INTO public.facturacion_correlativos_diarios (
        id_sucursal,
        fecha_operacion,
        tipo_documento,
        prefijo,
        ultimo_numero
      )
      VALUES ($1, $2::date, $3, $4, 0)
      ON CONFLICT (id_sucursal, fecha_operacion, tipo_documento) DO NOTHING
    `,
    [sucursalId, fechaOperacion, normalizedType, prefix]
  );

  const correlativoRow = await client.query(
    `
      SELECT
        id_correlativo,
        ultimo_numero
      FROM public.facturacion_correlativos_diarios
      WHERE id_sucursal = $1
        AND fecha_operacion = $2::date
        AND tipo_documento = $3
      FOR UPDATE
    `,
    [sucursalId, fechaOperacion, normalizedType]
  );

  if (correlativoRow.rowCount === 0) {
    throw new Error('FACTURACION_CORRELATIVO_ROW_NOT_FOUND');
  }

  const row = correlativoRow.rows[0];
  const nextNumber = (Number.parseInt(String(row.ultimo_numero ?? '0'), 10) || 0) + 1;

  await client.query(
    `
      UPDATE public.facturacion_correlativos_diarios
      SET
        ultimo_numero = $2,
        prefijo = $3,
        actualizado_en = NOW()
      WHERE id_correlativo = $1
    `,
    [row.id_correlativo, nextNumber, prefix]
  );

  return {
    codigo: `${prefix}-${padCorrelative(nextNumber, correlativeLength)}`,
    prefijo: prefix,
    numero: nextNumber,
    tipo_documento: normalizedType,
    fechaOperacion,
    fecha_operacion: fechaOperacion,
    id_sucursal: sucursalId
  };
};
