import pool from '../config/db-connection.js';
import { supabase } from './supabaseClient.js';
import { SUPABASE_ADMIN_BUCKET } from '../utils/uploads.js';

const TEGUCIGALPA_TZ = 'America/Tegucigalpa';
const DEFAULT_BUSINESS_NAME = "JONNY'S";
const DEFAULT_FOOTER = 'Gracias por su compra';
const MAX_LOGO_DATA_URL_BYTES = 1024 * 1024;
const LOGO_ASSET_CACHE_TTL_MS = 5 * 60 * 1000;
const LOGO_MIME_BY_EXTENSION = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
});
const logoAssetCache = new Map();
const TICKET_FLAG_DEFAULTS = Object.freeze({
  mostrar_datos_fiscales: true,
  mostrar_cai_ticket: true,
  mostrar_numero_fiscal_ticket: true,
  mostrar_codigo_interno_ticket: true,
  aplicar_impuestos: false,
  mostrar_impuestos_ticket: false,
  mostrar_importe_exento: false,
  mostrar_importe_gravado_15: false,
  mostrar_isv_15: false,
  mostrar_importe_gravado_18: false,
  mostrar_isv_18: false,
  mostrar_total_isv: false,
  mostrar_descuento_linea: true,
  mostrar_descuento_porcentaje_linea: true,
  mostrar_descuento_total: true,
  imprimir_comprobante_reversion: true,
  mostrar_venta_original_reversion: true,
  mostrar_codigo_reversion: true,
  mostrar_usuario_reversion: true,
  mostrar_caja_sesion_reversion: true,
  mostrar_motivo_reversion: true,
  mostrar_detalle_reversion: true,
  mostrar_total_reversion: true
});
const TICKET_FLAG_FIELDS = Object.keys(TICKET_FLAG_DEFAULTS);

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

const parseStoredStoragePath = (rawValue) => {
  const input = String(rawValue || '').trim();
  if (!input || /^https?:\/\//i.test(input)) return null;
  const [bucket, ...pathParts] = input.split('/').filter(Boolean);
  if (!bucket || pathParts.length === 0) return null;
  return { bucket, filePath: pathParts.join('/') };
};

const getLogoMimeType = (filePath, fallback = 'image/png') => {
  const extension = String(filePath || '').split('.').pop()?.toLowerCase();
  return LOGO_MIME_BY_EXTENSION[extension] || fallback;
};

const resolveLogoDisplayAsset = async (rawValue) => {
  const normalized = toNullableText(rawValue);
  if (!normalized) return { url: null, dataUrl: null };
  const storagePath = parseStoredStoragePath(normalized);
  if (!storagePath || storagePath.bucket !== SUPABASE_ADMIN_BUCKET) {
    return { url: normalized, dataUrl: null };
  }

  const cacheKey = `${storagePath.bucket}/${storagePath.filePath}`;
  const cached = logoAssetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.asset;
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(SUPABASE_ADMIN_BUCKET)
    .createSignedUrl(storagePath.filePath, 900);

  const signedUrl = signedError || !signedData?.signedUrl ? null : signedData.signedUrl;
  if (signedError || !signedUrl) {
    console.warn('[facturacion-snapshot] logo signed url warning:', signedError?.message || 'missing signed url');
  }

  const { data: logoFile, error: downloadError } = await supabase.storage
    .from(SUPABASE_ADMIN_BUCKET)
    .download(storagePath.filePath);

  if (downloadError || !logoFile || typeof logoFile.arrayBuffer !== 'function') {
    console.warn('[facturacion-snapshot] logo download warning:', downloadError?.message || 'missing logo file');
    const asset = { url: signedUrl, dataUrl: null };
    logoAssetCache.set(cacheKey, { asset, expiresAt: Date.now() + LOGO_ASSET_CACHE_TTL_MS });
    return asset;
  }

  const buffer = Buffer.from(await logoFile.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_LOGO_DATA_URL_BYTES) {
    const asset = { url: signedUrl, dataUrl: null };
    logoAssetCache.set(cacheKey, { asset, expiresAt: Date.now() + LOGO_ASSET_CACHE_TTL_MS });
    return asset;
  }

  const mimeType = logoFile.type || getLogoMimeType(storagePath.filePath);
  const asset = {
    url: signedUrl,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
  };
  logoAssetCache.set(cacheKey, { asset, expiresAt: Date.now() + LOGO_ASSET_CACHE_TTL_MS });
  return asset;
};

const toTicketWidth = (value) => {
  const width = Number.parseInt(String(value ?? ''), 10);
  return width === 58 ? 58 : 80;
};

const resolveTicketFlags = (source = {}) =>
  TICKET_FLAG_FIELDS.reduce((acc, field) => ({
    ...acc,
    [field]: toBoolean(source?.[field], TICKET_FLAG_DEFAULTS[field])
  }), {});

const VISUAL_TICKET_FLAG_FIELDS = [
  'mostrar_logo_ticket',
  'mostrar_rtn',
  'mostrar_direccion',
  'mostrar_telefono',
  'mostrar_correo',
  ...TICKET_FLAG_FIELDS
];

const pickVisualTicketFlags = (ticket = {}) =>
  VISUAL_TICKET_FLAG_FIELDS.reduce((acc, field) => (
    ticket?.[field] === undefined || ticket?.[field] === null
      ? acc
      : { ...acc, [field]: Boolean(ticket[field]) }
  ), {});

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
  const result = await client.query(
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
        mostrar_correo,
        mostrar_datos_fiscales,
        mostrar_cai_ticket,
        mostrar_numero_fiscal_ticket,
        mostrar_codigo_interno_ticket,
        aplicar_impuestos,
        mostrar_impuestos_ticket,
        mostrar_importe_exento,
        mostrar_importe_gravado_15,
        mostrar_isv_15,
        mostrar_importe_gravado_18,
        mostrar_isv_18,
        mostrar_total_isv,
        mostrar_descuento_linea,
        mostrar_descuento_porcentaje_linea,
        mostrar_descuento_total,
        imprimir_comprobante_reversion,
        mostrar_venta_original_reversion,
        mostrar_codigo_reversion,
        mostrar_usuario_reversion,
        mostrar_caja_sesion_reversion,
        mostrar_motivo_reversion,
        mostrar_detalle_reversion,
        mostrar_total_reversion
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
        false,
        true, true, true, true,
        false, false, false, false, false, false, false, false,
        true, true, true,
        true, true, true, true, true, true, true, true
      )
      ON CONFLICT (id_sucursal) DO NOTHING
      RETURNING
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
        mostrar_correo,
        mostrar_datos_fiscales,
        mostrar_cai_ticket,
        mostrar_numero_fiscal_ticket,
        mostrar_codigo_interno_ticket,
        aplicar_impuestos,
        mostrar_impuestos_ticket,
        mostrar_importe_exento,
        mostrar_importe_gravado_15,
        mostrar_isv_15,
        mostrar_importe_gravado_18,
        mostrar_isv_18,
        mostrar_total_isv,
        mostrar_descuento_linea,
        mostrar_descuento_porcentaje_linea,
        mostrar_descuento_total,
        imprimir_comprobante_reversion,
        mostrar_venta_original_reversion,
        mostrar_codigo_reversion,
        mostrar_usuario_reversion,
        mostrar_caja_sesion_reversion,
        mostrar_motivo_reversion,
        mostrar_detalle_reversion,
        mostrar_total_reversion
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
  return result.rows?.[0] || null;
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
        mostrar_correo,
        mostrar_datos_fiscales,
        mostrar_cai_ticket,
        mostrar_numero_fiscal_ticket,
        mostrar_codigo_interno_ticket,
        aplicar_impuestos,
        mostrar_impuestos_ticket,
        mostrar_importe_exento,
        mostrar_importe_gravado_15,
        mostrar_isv_15,
        mostrar_importe_gravado_18,
        mostrar_isv_18,
        mostrar_total_isv,
        mostrar_descuento_linea,
        mostrar_descuento_porcentaje_linea,
        mostrar_descuento_total,
        imprimir_comprobante_reversion,
        mostrar_venta_original_reversion,
        mostrar_codigo_reversion,
        mostrar_usuario_reversion,
        mostrar_caja_sesion_reversion,
        mostrar_motivo_reversion,
        mostrar_detalle_reversion,
        mostrar_total_reversion
      FROM public.facturacion_config_sucursal
      WHERE id_sucursal = $1
      ORDER BY COALESCE(activo, false) DESC, id_config DESC
      LIMIT 1
    `,
    [idSucursal]
  );
  return result.rows?.[0] || null;
};

const readSucursalFacturacionContext = async (client, idSucursal) => {
  const result = await client.query(
    `
      SELECT
        v.id_sucursal,
        v.nombre_sucursal,
        v.texto_direccion,
        v.texto_telefono,
        v.texto_correo,
        cfg.id_config AS cfg_id_config,
        cfg.id_sucursal AS cfg_id_sucursal,
        cfg.prefijo_venta AS cfg_prefijo_venta,
        cfg.prefijo_reversion AS cfg_prefijo_reversion,
        cfg.longitud_correlativo AS cfg_longitud_correlativo,
        cfg.reinicio_diario AS cfg_reinicio_diario,
        cfg.modo_fiscal AS cfg_modo_fiscal,
        cfg.mostrar_logo_ticket AS cfg_mostrar_logo_ticket,
        cfg.ancho_ticket_mm AS cfg_ancho_ticket_mm,
        cfg.activo AS cfg_activo,
        cfg.nombre_emisor AS cfg_nombre_emisor,
        cfg.rtn_emisor AS cfg_rtn_emisor,
        cfg.direccion_emisor AS cfg_direccion_emisor,
        cfg.telefono_emisor AS cfg_telefono_emisor,
        cfg.correo_emisor AS cfg_correo_emisor,
        cfg.logo_url AS cfg_logo_url,
        cfg.id_archivo_logo AS cfg_id_archivo_logo,
        cfg.texto_encabezado_ticket AS cfg_texto_encabezado_ticket,
        cfg.texto_pie_ticket AS cfg_texto_pie_ticket,
        cfg.mostrar_rtn AS cfg_mostrar_rtn,
        cfg.mostrar_direccion AS cfg_mostrar_direccion,
        cfg.mostrar_telefono AS cfg_mostrar_telefono,
        cfg.mostrar_correo AS cfg_mostrar_correo,
        cfg.mostrar_datos_fiscales AS cfg_mostrar_datos_fiscales,
        cfg.mostrar_cai_ticket AS cfg_mostrar_cai_ticket,
        cfg.mostrar_numero_fiscal_ticket AS cfg_mostrar_numero_fiscal_ticket,
        cfg.mostrar_codigo_interno_ticket AS cfg_mostrar_codigo_interno_ticket,
        cfg.aplicar_impuestos AS cfg_aplicar_impuestos,
        cfg.mostrar_impuestos_ticket AS cfg_mostrar_impuestos_ticket,
        cfg.mostrar_importe_exento AS cfg_mostrar_importe_exento,
        cfg.mostrar_importe_gravado_15 AS cfg_mostrar_importe_gravado_15,
        cfg.mostrar_isv_15 AS cfg_mostrar_isv_15,
        cfg.mostrar_importe_gravado_18 AS cfg_mostrar_importe_gravado_18,
        cfg.mostrar_isv_18 AS cfg_mostrar_isv_18,
        cfg.mostrar_total_isv AS cfg_mostrar_total_isv,
        cfg.mostrar_descuento_linea AS cfg_mostrar_descuento_linea,
        cfg.mostrar_descuento_porcentaje_linea AS cfg_mostrar_descuento_porcentaje_linea,
        cfg.mostrar_descuento_total AS cfg_mostrar_descuento_total,
        cfg.imprimir_comprobante_reversion AS cfg_imprimir_comprobante_reversion,
        cfg.mostrar_venta_original_reversion AS cfg_mostrar_venta_original_reversion,
        cfg.mostrar_codigo_reversion AS cfg_mostrar_codigo_reversion,
        cfg.mostrar_usuario_reversion AS cfg_mostrar_usuario_reversion,
        cfg.mostrar_caja_sesion_reversion AS cfg_mostrar_caja_sesion_reversion,
        cfg.mostrar_motivo_reversion AS cfg_mostrar_motivo_reversion,
        cfg.mostrar_detalle_reversion AS cfg_mostrar_detalle_reversion,
        cfg.mostrar_total_reversion AS cfg_mostrar_total_reversion
      FROM public.v_sucursales_info v
      LEFT JOIN LATERAL (
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
          mostrar_correo,
          mostrar_datos_fiscales,
          mostrar_cai_ticket,
          mostrar_numero_fiscal_ticket,
          mostrar_codigo_interno_ticket,
          aplicar_impuestos,
          mostrar_impuestos_ticket,
          mostrar_importe_exento,
          mostrar_importe_gravado_15,
          mostrar_isv_15,
          mostrar_importe_gravado_18,
          mostrar_isv_18,
          mostrar_total_isv,
          mostrar_descuento_linea,
          mostrar_descuento_porcentaje_linea,
          mostrar_descuento_total,
          imprimir_comprobante_reversion,
          mostrar_venta_original_reversion,
          mostrar_codigo_reversion,
          mostrar_usuario_reversion,
          mostrar_caja_sesion_reversion,
          mostrar_motivo_reversion,
          mostrar_detalle_reversion,
          mostrar_total_reversion
        FROM public.facturacion_config_sucursal
        WHERE id_sucursal = v.id_sucursal
        ORDER BY COALESCE(activo, false) DESC, id_config DESC
        LIMIT 1
      ) cfg ON true
      WHERE v.id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );

  const row = result.rows?.[0] || null;
  if (!row) return { sucursal: null, config: null };

  const sucursal = {
    id_sucursal: row.id_sucursal,
    nombre_sucursal: row.nombre_sucursal,
    texto_direccion: row.texto_direccion,
    texto_telefono: row.texto_telefono,
    texto_correo: row.texto_correo
  };

  const config = row.cfg_id_config
    ? {
        id_config: row.cfg_id_config,
        id_sucursal: row.cfg_id_sucursal,
        prefijo_venta: row.cfg_prefijo_venta,
        prefijo_reversion: row.cfg_prefijo_reversion,
        longitud_correlativo: row.cfg_longitud_correlativo,
        reinicio_diario: row.cfg_reinicio_diario,
        modo_fiscal: row.cfg_modo_fiscal,
        mostrar_logo_ticket: row.cfg_mostrar_logo_ticket,
        ancho_ticket_mm: row.cfg_ancho_ticket_mm,
        activo: row.cfg_activo,
        nombre_emisor: row.cfg_nombre_emisor,
        rtn_emisor: row.cfg_rtn_emisor,
        direccion_emisor: row.cfg_direccion_emisor,
        telefono_emisor: row.cfg_telefono_emisor,
        correo_emisor: row.cfg_correo_emisor,
        logo_url: row.cfg_logo_url,
        id_archivo_logo: row.cfg_id_archivo_logo,
        texto_encabezado_ticket: row.cfg_texto_encabezado_ticket,
        texto_pie_ticket: row.cfg_texto_pie_ticket,
        mostrar_rtn: row.cfg_mostrar_rtn,
        mostrar_direccion: row.cfg_mostrar_direccion,
        mostrar_telefono: row.cfg_mostrar_telefono,
        mostrar_correo: row.cfg_mostrar_correo,
        ...TICKET_FLAG_FIELDS.reduce((acc, field) => ({
          ...acc,
          [field]: row[`cfg_${field}`]
        }), {})
      }
    : null;

  return { sucursal, config };
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
      ...resolveTicketFlags(config),
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

export const obtenerConfigFacturacionParaVenta = async (client, idSucursal, options = {}) => {
  const idSucursalNum = toPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new Error('FACTURACION_SNAPSHOT_SUCURSAL_INVALIDA');
  }

  const db = client && typeof client.query === 'function' ? client : pool;
  const perf = options?.perf || null;
  const sucursalStart = perf?.now?.() || 0;
  const context = await readSucursalFacturacionContext(db, idSucursalNum);
  const sucursal = context.sucursal;
  let config = context.config;
  perf?.add?.('factura_snapshot_sucursal_ms', sucursalStart);

  if (!sucursal) {
    throw new Error('FACTURACION_SNAPSHOT_SUCURSAL_NOT_FOUND');
  }

  if (!config) {
    const configStart = perf?.now?.() || 0;
    config = await ensureConfigRow(db, idSucursalNum, sucursal);
    if (!config) {
      config = await readConfigBySucursal(db, idSucursalNum);
    }
    perf?.add?.('factura_snapshot_config_ms', configStart);
  }

  const buildStart = perf?.now?.() || 0;
  const snapshot = snapshotFromConfig({ config: config || {}, sucursal, idSucursal: idSucursalNum });
  perf?.add?.('factura_snapshot_build_ms', buildStart);

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
      logo_url: toNullableText(emisor.logo_url),
      logo_data_url: toNullableText(emisor.logo_data_url)
    },
    ticket: {
      ancho_ticket_mm: toTicketWidth(ticket.ancho_ticket_mm),
      mostrar_logo_ticket: toBoolean(ticket.mostrar_logo_ticket, true),
      mostrar_rtn: toBoolean(ticket.mostrar_rtn, true),
      mostrar_direccion: toBoolean(ticket.mostrar_direccion, true),
      mostrar_telefono: toBoolean(ticket.mostrar_telefono, true),
      mostrar_correo: toBoolean(ticket.mostrar_correo, false),
      ...resolveTicketFlags(ticket),
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

export const normalizarDatosTicketDesdeSnapshot = async ({
  client,
  factura,
  includePrintAssets = false
}) => {
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

  const normalized = normalizeSnapshotShape(snapshot);
  const idSucursal = toPositiveInt(source.id_sucursal || normalized.id_sucursal);
  let currentConfigSnapshot = null;

  if (idSucursal) {
    try {
      const currentConfig = await obtenerConfigFacturacionParaVenta(db, idSucursal);
      currentConfigSnapshot = currentConfig?.snapshot || null;
      normalized.ticket = {
        ...normalized.ticket,
        ...pickVisualTicketFlags(currentConfigSnapshot?.ticket)
      };
    } catch {
      // Si la configuracion vigente no esta disponible, se conserva el snapshot historico.
    }
  }

  if (currentConfigSnapshot?.emisor) {
    normalized.emisor.logo_url = toNullableText(currentConfigSnapshot.emisor.logo_url);
  }

  if (includePrintAssets && normalized.ticket.mostrar_logo_ticket) {
    const logoAsset = await resolveLogoDisplayAsset(normalized.emisor.logo_url);
    normalized.emisor.logo_url = logoAsset.url;
    normalized.emisor.logo_data_url = logoAsset.dataUrl;
  } else {
    normalized.emisor.logo_url = toNullableText(normalized.emisor.logo_url);
    normalized.emisor.logo_data_url = null;
  }

  return normalized;
};
