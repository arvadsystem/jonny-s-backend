import pool from '../config/db-connection.js';

const TEGUCIGALPA_TZ = 'America/Tegucigalpa';
const DEFAULT_BUSINESS_NAME = "JONNY'S";
const DEFAULT_FOOTER = 'Gracias por su compra';

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const toBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value || '').toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value || '').toLowerCase() === 'false') return false;
  return fallback;
};

const toNullableText = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
};

const toTicketWidth = (value) => {
  const width = Number.parseInt(String(value ?? ''), 10);
  return width === 58 ? 58 : 80;
};

const currentDateTimeHonduras = () =>
  new Date().toLocaleString('sv-SE', { timeZone: TEGUCIGALPA_TZ }).replace(' ', 'T');

const readSucursalContext = async (client, idSucursal) => {
  const result = await client.query(
    `
      SELECT
        v.id_sucursal,
        v.nombre_sucursal,
        v.texto_direccion,
        v.texto_telefono,
        v.texto_correo
      FROM public.v_sucursales_info v
      WHERE v.id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );
  return result.rows?.[0] || null;
};

const ensureConfigRow = async (client, idSucursal, sucursal) => {
  await client.query(
    `
      INSERT INTO public.facturacion_config_sucursal (
        id_sucursal,
        prefijo_venta,
        prefijo_reversion,
        longitud_correlativo,
        reinicio_diario,
        modo_fiscal,
        mostrar_logo_ticket,
        ancho_ticket_mm,
        activo,
        nombre_emisor,
        rtn_emisor,
        direccion_emisor,
        telefono_emisor,
        correo_emisor,
        logo_url,
        id_archivo_logo,
        texto_encabezado_ticket,
        texto_pie_ticket,
        mostrar_rtn,
        mostrar_direccion,
        mostrar_telefono,
        mostrar_correo
      )
      VALUES (
        $1,
        'VTA',
        'REV',
        5,
        true,
        'INTERNO',
        true,
        80,
        true,
        $2,
        null,
        $3,
        $4,
        $5,
        null,
        null,
        null,
        $6,
        true,
        true,
        true,
        false
      )
      ON CONFLICT (id_sucursal) DO NOTHING
    `,
    [
      idSucursal,
      toNullableText(sucursal?.nombre_sucursal) || DEFAULT_BUSINESS_NAME,
      toNullableText(sucursal?.texto_direccion),
      toNullableText(sucursal?.texto_telefono),
      toNullableText(sucursal?.texto_correo),
      DEFAULT_FOOTER
    ]
  );
};

const readConfigBySucursal = async (client, idSucursal) => {
  const result = await client.query(
    `
      SELECT
        id_config,
        id_sucursal,
        prefijo_venta,
        prefijo_reversion,
        longitud_correlativo,
        reinicio_diario,
        modo_fiscal,
        mostrar_logo_ticket,
        ancho_ticket_mm,
        activo,
        nombre_emisor,
        rtn_emisor,
        direccion_emisor,
        telefono_emisor,
        correo_emisor,
        logo_url,
        id_archivo_logo,
        texto_encabezado_ticket,
        texto_pie_ticket,
        mostrar_rtn,
        mostrar_direccion,
        mostrar_telefono,
        mostrar_correo
      FROM public.facturacion_config_sucursal
      WHERE id_sucursal = $1
      ORDER BY COALESCE(activo, false) DESC, id_config DESC
      LIMIT 1
    `,
    [idSucursal]
  );
  return result.rows?.[0] || null;
};

const snapshotFromConfig = ({ config, sucursal, idSucursal }) => {
  const nombreSucursal = toNullableText(sucursal?.nombre_sucursal);
  const direccionSucursal = toNullableText(sucursal?.texto_direccion);
  const telefonoSucursal = toNullableText(sucursal?.texto_telefono);
  const correoSucursal = toNullableText(sucursal?.texto_correo);

  const nombreEmisor = toNullableText(config?.nombre_emisor) || nombreSucursal || DEFAULT_BUSINESS_NAME;
  const direccionEmisor = toNullableText(config?.direccion_emisor) || direccionSucursal;
  const telefonoEmisor = toNullableText(config?.telefono_emisor) || telefonoSucursal;
  const correoEmisor = toNullableText(config?.correo_emisor) || correoSucursal;

  return {
    version: 1,
    origen: 'SUCURSALES_FACTURACION',
    id_config_facturacion: toPositiveInt(config?.id_config),
    id_sucursal: idSucursal,
    emisor: {
      nombre_emisor: nombreEmisor,
      rtn_emisor: toNullableText(config?.rtn_emisor),
      direccion_emisor: direccionEmisor,
      telefono_emisor: telefonoEmisor,
      correo_emisor: correoEmisor,
      logo_url: toNullableText(config?.logo_url)
    },
    ticket: {
      ancho_ticket_mm: toTicketWidth(config?.ancho_ticket_mm),
      mostrar_logo_ticket: toBoolean(config?.mostrar_logo_ticket, true),
      mostrar_rtn: toBoolean(config?.mostrar_rtn, true),
      mostrar_direccion: toBoolean(config?.mostrar_direccion, true),
      mostrar_telefono: toBoolean(config?.mostrar_telefono, true),
      mostrar_correo: toBoolean(config?.mostrar_correo, false),
      texto_encabezado_ticket: toNullableText(config?.texto_encabezado_ticket),
      texto_pie_ticket: toNullableText(config?.texto_pie_ticket) || DEFAULT_FOOTER
    },
    correlativo: {
      prefijo_venta: toNullableText(config?.prefijo_venta) || 'VTA',
      prefijo_reversion: toNullableText(config?.prefijo_reversion) || 'REV',
      longitud_correlativo: Number.parseInt(String(config?.longitud_correlativo ?? '5'), 10) || 5,
      reinicio_diario: toBoolean(config?.reinicio_diario, true)
    },
    fiscal: {
      modo_fiscal: 'NO_INTEGRADO',
      cai: '0',
      numero_factura_fiscal: '0',
      id_rango_cai: null
    },
    creado_en: currentDateTimeHonduras()
  };
};

export const obtenerConfigFacturacionParaVenta = async (client, idSucursal) => {
  const idSucursalNum = toPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new Error('FACTURACION_SNAPSHOT_SUCURSAL_INVALIDA');
  }

  const db = client && typeof client.query === 'function' ? client : pool;
  const sucursal = await readSucursalContext(db, idSucursalNum);
  if (!sucursal) {
    throw new Error('FACTURACION_SNAPSHOT_SUCURSAL_NOT_FOUND');
  }

  await ensureConfigRow(db, idSucursalNum, sucursal);
  const config = await readConfigBySucursal(db, idSucursalNum);
  const snapshot = snapshotFromConfig({ config: config || {}, sucursal, idSucursal: idSucursalNum });

  return {
    idSucursal: idSucursalNum,
    sucursal,
    config: config || null,
    idConfig: toPositiveInt(config?.id_config),
    snapshot
  };
};

export const construirSnapshotFacturacion = (config, sucursal) => {
  const idSucursal = toPositiveInt(config?.id_sucursal || sucursal?.id_sucursal) || null;
  return snapshotFromConfig({
    config: config || {},
    sucursal: sucursal || {},
    idSucursal
  });
};

export const aplicarSnapshotEnFactura = async (client, idFactura, snapshot, idConfig) => {
  const idFacturaNum = toPositiveInt(idFactura);
  if (!idFacturaNum) {
    throw new Error('FACTURACION_SNAPSHOT_FACTURA_INVALIDA');
  }
  const db = client && typeof client.query === 'function' ? client : pool;

  const result = await db.query(
    `
      UPDATE public.facturas
      SET
        id_config_facturacion = $1,
        id_rango_cai = NULL,
        numero_factura_fiscal = '0',
        facturacion_snapshot = $2::jsonb
      WHERE id_factura = $3
      RETURNING id_factura
    `,
    [idConfig || null, JSON.stringify(snapshot || {}), idFacturaNum]
  );

  return result.rowCount > 0;
};

const normalizeSnapshotShape = (snapshot) => {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const emisor = source.emisor && typeof source.emisor === 'object' ? source.emisor : {};
  const ticket = source.ticket && typeof source.ticket === 'object' ? source.ticket : {};
  const fiscal = source.fiscal && typeof source.fiscal === 'object' ? source.fiscal : {};

  return {
    version: Number(source.version || 1),
    origen: String(source.origen || 'SUCURSALES_FACTURACION'),
    id_config_facturacion: toPositiveInt(source.id_config_facturacion) || null,
    id_sucursal: toPositiveInt(source.id_sucursal) || null,
    emisor: {
      nombre_emisor: toNullableText(emisor.nombre_emisor) || DEFAULT_BUSINESS_NAME,
      rtn_emisor: toNullableText(emisor.rtn_emisor),
      direccion_emisor: toNullableText(emisor.direccion_emisor),
      telefono_emisor: toNullableText(emisor.telefono_emisor),
      correo_emisor: toNullableText(emisor.correo_emisor),
      logo_url: toNullableText(emisor.logo_url)
    },
    ticket: {
      ancho_ticket_mm: toTicketWidth(ticket.ancho_ticket_mm),
      mostrar_logo_ticket: toBoolean(ticket.mostrar_logo_ticket, true),
      mostrar_rtn: toBoolean(ticket.mostrar_rtn, true),
      mostrar_direccion: toBoolean(ticket.mostrar_direccion, true),
      mostrar_telefono: toBoolean(ticket.mostrar_telefono, true),
      mostrar_correo: toBoolean(ticket.mostrar_correo, false),
      texto_encabezado_ticket: toNullableText(ticket.texto_encabezado_ticket),
      texto_pie_ticket: toNullableText(ticket.texto_pie_ticket) || DEFAULT_FOOTER
    },
    fiscal: {
      modo_fiscal: 'NO_INTEGRADO',
      cai: '0',
      numero_factura_fiscal: '0',
      id_rango_cai: null
    }
  };
};

export const normalizarDatosTicketDesdeSnapshot = async ({ client, factura }) => {
  const db = client && typeof client.query === 'function' ? client : pool;
  const source = factura && typeof factura === 'object' ? factura : {};

  let snapshot = source.facturacion_snapshot;
  if (snapshot && typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      snapshot = null;
    }
  }

  if (!snapshot || typeof snapshot !== 'object') {
    try {
      const fallback = await obtenerConfigFacturacionParaVenta(db, source.id_sucursal);
      snapshot = fallback.snapshot;
    } catch {
      snapshot = snapshotFromConfig({
        config: {},
        sucursal: {},
        idSucursal: toPositiveInt(source.id_sucursal) || null
      });
    }
  }

  return normalizeSnapshotShape(snapshot);
};
