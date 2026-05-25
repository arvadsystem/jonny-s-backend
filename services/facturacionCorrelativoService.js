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
  tipoDocumento,
  perf = null
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

  const configStart = perf?.now?.() || 0;
  let configResult = await client.query(
    `
      SELECT
        cfg.prefijo_venta,
        cfg.prefijo_reversion,
        cfg.longitud_correlativo
      FROM public.facturacion_config_sucursal cfg
      WHERE cfg.id_sucursal = $1
      FOR UPDATE
    `,
    [sucursalId]
  );

  if (configResult.rowCount === 0) {
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

    configResult = await client.query(
      `
        SELECT
          cfg.prefijo_venta,
          cfg.prefijo_reversion,
          cfg.longitud_correlativo
        FROM public.facturacion_config_sucursal cfg
        WHERE cfg.id_sucursal = $1
        FOR UPDATE
      `,
      [sucursalId]
    );
  }

  if (configResult.rowCount === 0) {
    throw new Error('FACTURACION_CONFIG_NOT_FOUND');
  }

  const config = configResult.rows[0];
  perf?.add?.('factura_correlativo_config_ms', configStart);

  const correlativeLength = Math.min(
    10,
    Math.max(3, Number.parseInt(String(config.longitud_correlativo ?? '5'), 10) || 5)
  );

  const prefix =
    normalizedType === DOCUMENT_TYPES.VENTA
      ? sanitizePrefix(config.prefijo_venta, 'VTA')
      : sanitizePrefix(config.prefijo_reversion, 'REV');

  const numeroStart = perf?.now?.() || 0;
  const correlativoRow = await client.query(
    `
      INSERT INTO public.facturacion_correlativos_diarios (
        id_sucursal,
        fecha_operacion,
        tipo_documento,
        prefijo,
        ultimo_numero
      )
      VALUES ($1, $2::date, $3, $4, 1)
      ON CONFLICT (id_sucursal, fecha_operacion, tipo_documento)
      DO UPDATE SET
        ultimo_numero = public.facturacion_correlativos_diarios.ultimo_numero + 1,
        prefijo = EXCLUDED.prefijo,
        actualizado_en = NOW()
      RETURNING
        id_correlativo,
        ultimo_numero
    `,
    [sucursalId, fechaOperacion, normalizedType, prefix]
  );

  if (correlativoRow.rowCount === 0) {
    throw new Error('FACTURACION_CORRELATIVO_ROW_NOT_FOUND');
  }

  const row = correlativoRow.rows[0];
  const nextNumber = Number.parseInt(String(row.ultimo_numero ?? '0'), 10) || 1;
  perf?.add?.('factura_correlativo_numero_ms', numeroStart);

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
