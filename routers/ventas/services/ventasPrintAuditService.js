const PRINT_EVENT_TYPES = new Set(['FACTURA', 'COMANDA']);
const PRINT_EVENT_STATES = new Set(['GENERADA', 'ENVIADA', 'CANCELADA', 'ERROR']);

const normalizeOptionalText = (value, { maxLength = 255 } = {}) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const hasTable = async (client, tableName) => {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
      LIMIT 1
    `,
    [tableName]
  );
  return result.rowCount > 0;
};

export const normalizePrintEventPayload = (payload = {}) => {
  const tipoDocumento = String(payload?.tipo_documento || '').trim().toUpperCase();
  const estado = String(payload?.estado || '').trim().toUpperCase();
  if (!PRINT_EVENT_TYPES.has(tipoDocumento)) {
    return {
      ok: false,
      message: 'tipo_documento debe ser FACTURA o COMANDA.'
    };
  }
  if (!PRINT_EVENT_STATES.has(estado)) {
    return {
      ok: false,
      message: 'estado debe ser GENERADA, ENVIADA, CANCELADA o ERROR.'
    };
  }

  const metadata = payload?.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};

  return {
    ok: true,
    value: {
      tipo_documento: tipoDocumento,
      estado,
      id_impresora: toPositiveInt(payload?.id_impresora),
      nombre_impresora_snapshot: normalizeOptionalText(payload?.nombre_impresora_snapshot),
      nombre_logico: normalizeOptionalText(payload?.nombre_logico, { maxLength: 120 }),
      ancho_mm: Number.parseInt(String(payload?.ancho_mm ?? 80), 10) === 58 ? 58 : 80,
      detalle_error: normalizeOptionalText(payload?.detalle_error, { maxLength: 2000 }),
      metadata
    }
  };
};

export const registerVentaPrintEvent = async ({
  client,
  idFactura,
  idPedido = null,
  idUsuario = null,
  idSucursal = null,
  payload
}) => {
  if (!(await hasTable(client, 'impresiones_pedidos'))) {
    return {
      stored: false,
      audit_available: false,
      warning: 'La tabla impresiones_pedidos no existe en esta base de datos.'
    };
  }

  const insertResult = await client.query(
    `
      INSERT INTO public.impresiones_pedidos (
        id_pedido,
        id_factura,
        tipo_documento,
        estado,
        id_usuario,
        id_sucursal,
        id_impresora,
        nombre_impresora_snapshot,
        ancho_mm,
        fecha_impresion,
        detalle_error,
        metadata
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        CASE WHEN $4 IN ('ENVIADA', 'ERROR') THEN now() ELSE NULL END,
        $10,
        $11::jsonb
      )
      RETURNING id_impresion
    `,
    [
      toPositiveInt(idPedido),
      toPositiveInt(idFactura),
      payload.tipo_documento,
      payload.estado,
      toPositiveInt(idUsuario),
      toPositiveInt(idSucursal),
      payload.id_impresora,
      payload.nombre_impresora_snapshot || payload.nombre_logico || null,
      payload.ancho_mm,
      payload.detalle_error,
      JSON.stringify({
        ...payload.metadata,
        logical_printer_type: payload.tipo_documento,
        logical_printer_name: payload.nombre_logico || payload.tipo_documento
      })
    ]
  );

  return {
    stored: true,
    audit_available: true,
    id_impresion: Number(insertResult.rows?.[0]?.id_impresion || 0) || null
  };
};
