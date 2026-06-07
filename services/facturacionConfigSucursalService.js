import pool from '../config/db-connection.js';
import { supabase } from './supabaseClient.js';
import {
  SUPABASE_ADMIN_BUCKET,
  SUPABASE_ASSETS_BUCKET
} from '../utils/uploads.js';

const VALID_MODO_FISCAL = new Set(['INTERNO', 'CAI_PREPARADO', 'CAI_ACTIVO']);
const VALID_TICKET_WIDTH = new Set([58, 80]);
const VALID_PREFIX_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
const LOGO_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

class ServiceError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.details = details;
  }
}

const asPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
};

const parseStoredStoragePath = (rawValue) => {
  const input = String(rawValue || '').trim();
  if (!input || /^https?:\/\//i.test(input)) return null;
  const [bucket, ...pathParts] = input.split('/').filter(Boolean);
  if (!bucket || pathParts.length === 0) return null;
  return { bucket, filePath: pathParts.join('/') };
};

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value ?? '').toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value ?? '').toLowerCase() === 'false') return false;
  return null;
};

const resolveTicketFlags = (row = {}) =>
  TICKET_FLAG_FIELDS.reduce((acc, field) => ({
    ...acc,
    [field]: row?.[field] === undefined || row?.[field] === null
      ? TICKET_FLAG_DEFAULTS[field]
      : Boolean(row[field])
  }), {});

const sanitizeOutboundConfig = (row) => ({
  id_config: Number(row?.id_config ?? 0) || null,
  id_sucursal: Number(row?.id_sucursal ?? 0) || null,
  nombre_emisor: row?.nombre_emisor ?? null,
  rtn_emisor: row?.rtn_emisor ?? null,
  direccion_emisor: row?.direccion_emisor ?? null,
  telefono_emisor: row?.telefono_emisor ?? null,
  correo_emisor: row?.correo_emisor ?? null,
  logo_url: row?.logo_url ?? null,
  id_archivo_logo: row?.id_archivo_logo ?? null,
  texto_encabezado_ticket: row?.texto_encabezado_ticket ?? null,
  texto_pie_ticket: row?.texto_pie_ticket ?? null,
  ancho_ticket_mm: Number(row?.ancho_ticket_mm ?? 0) || null,
  prefijo_venta: row?.prefijo_venta ?? null,
  prefijo_reversion: row?.prefijo_reversion ?? null,
  longitud_correlativo: Number(row?.longitud_correlativo ?? 0) || null,
  reinicio_diario: Boolean(row?.reinicio_diario),
  modo_fiscal: row?.modo_fiscal ?? null,
  mostrar_logo_ticket: Boolean(row?.mostrar_logo_ticket),
  mostrar_rtn: Boolean(row?.mostrar_rtn),
  mostrar_direccion: Boolean(row?.mostrar_direccion),
  mostrar_telefono: Boolean(row?.mostrar_telefono),
  mostrar_correo: Boolean(row?.mostrar_correo),
  ...resolveTicketFlags(row),
  activo: Boolean(row?.activo)
});

const buildPreviewFromConfig = (config) => {
  const prefix = String(config?.prefijo_venta || 'VTA').trim().toUpperCase();
  const len = Number(config?.longitud_correlativo || 5);
  const sampleNumber = `${prefix}-${String(1).padStart(Math.max(3, Math.min(10, len)), '0')}`;

  return {
    emisor: {
      nombre: config?.nombre_emisor ?? null,
      rtn: config?.rtn_emisor ?? null,
      direccion: config?.direccion_emisor ?? null,
      telefono: config?.telefono_emisor ?? null,
      correo: config?.correo_emisor ?? null,
      logo_url: config?.logo_url ?? null
    },
    documento: {
      tipo: 'TICKET',
      numero_ejemplo: sampleNumber,
      modo_fiscal: config?.modo_fiscal ?? 'INTERNO',
      ancho_ticket_mm: Number(config?.ancho_ticket_mm ?? 80)
    },
    items: [
      {
        descripcion: 'Producto ejemplo',
        cantidad: 1,
        precio_unitario: 100,
        total: 100
      }
    ],
    totales: {
      subtotal: 100,
      impuesto: 0,
      descuento: 0,
      total: 100
    },
    textos: {
      encabezado: config?.texto_encabezado_ticket ?? null,
      pie: config?.texto_pie_ticket ?? 'Gracias por su compra'
    },
    opciones: {
      mostrar_logo_ticket: Boolean(config?.mostrar_logo_ticket),
      mostrar_rtn: Boolean(config?.mostrar_rtn),
      mostrar_direccion: Boolean(config?.mostrar_direccion),
      mostrar_telefono: Boolean(config?.mostrar_telefono),
      mostrar_correo: Boolean(config?.mostrar_correo),
      ...resolveTicketFlags(config)
    }
  };
};

const ensureSucursalExists = async (idSucursal, db = pool) => {
  const sucursalResult = await db.query(
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

  if (sucursalResult.rowCount === 0) {
    throw new ServiceError('La sucursal indicada no existe.', 404);
  }

  return sucursalResult.rows[0];
};

const getConfigBySucursal = async (idSucursal, db = pool) => {
  const configResult = await db.query(
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
      LIMIT 1
    `,
    [idSucursal]
  );

  return configResult.rows?.[0] || null;
};

const ensureValidLogoArchivo = async (idArchivo, db = pool) => {
  const parsedId = asPositiveInt(idArchivo);
  if (!parsedId) return null;

  const result = await db.query(
    `
      SELECT id_archivo, url_publica, tipo_archivo, COALESCE(estado, true) AS estado
      FROM public.archivos
      WHERE id_archivo = $1
      LIMIT 1
    `,
    [parsedId]
  );

  if (result.rowCount === 0) {
    throw new ServiceError('El logo seleccionado no existe.', 400, [
      { field: 'id_archivo_logo', message: 'id_archivo_logo no existe en archivos.' }
    ]);
  }

  const archivo = result.rows[0];
  const storagePath = parseStoredStoragePath(archivo.url_publica);
  const mimeType = String(archivo.tipo_archivo || '').toLowerCase();
  if (
    archivo.estado !== true ||
    !storagePath ||
    storagePath.bucket !== SUPABASE_ADMIN_BUCKET ||
    !LOGO_ALLOWED_MIME_TYPES.has(mimeType)
  ) {
    throw new ServiceError('El logo seleccionado no es válido para facturación.', 400, [
      { field: 'id_archivo_logo', message: 'El logo debe ser una imagen activa en admin-docs.' }
    ]);
  }

  return archivo;
};

const disableLogoArchivoIfUnused = async ({ oldArchivoId, newArchivoId }, db = pool) => {
  const oldId = asPositiveInt(oldArchivoId);
  const newId = asPositiveInt(newArchivoId);
  if (!oldId || oldId === newId) return null;

  const refCount = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.facturacion_config_sucursal
      WHERE id_archivo_logo = $1
    `,
    [oldId]
  );

  if (Number(refCount.rows?.[0]?.total || 0) > 0) return null;

  const oldArchivo = await db.query(
    `
      SELECT id_archivo, url_publica
      FROM public.archivos
      WHERE id_archivo = $1
      LIMIT 1
      FOR UPDATE
    `,
    [oldId]
  );

  if (oldArchivo.rowCount === 0) return null;

  await db.query(
    `
      UPDATE public.archivos
      SET estado = false
      WHERE id_archivo = $1
    `,
    [oldId]
  );

  return oldArchivo.rows[0].url_publica || null;
};

const tryRemoveStorageObject = async (storedPath) => {
  const parsed = parseStoredStoragePath(storedPath);
  if (
    !parsed ||
    (parsed.bucket !== SUPABASE_ADMIN_BUCKET && parsed.bucket !== SUPABASE_ASSETS_BUCKET)
  ) {
    return;
  }

  const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.filePath]);
  if (error) {
    console.warn('[facturacion-config] logo storage cleanup warning:', error.message);
  }
};

const resolveLogoDisplayUrl = async (rawValue) => {
  const normalized = trimOrNull(rawValue);
  if (!normalized) return null;
  const storagePath = parseStoredStoragePath(normalized);
  if (!storagePath || storagePath.bucket !== SUPABASE_ADMIN_BUCKET) return normalized;

  const { data, error } = await supabase.storage
    .from(SUPABASE_ADMIN_BUCKET)
    .createSignedUrl(storagePath.filePath, 900);

  if (error || !data?.signedUrl) {
    console.warn('[facturacion-config] logo signed url warning:', error?.message || 'missing signed url');
    return null;
  }

  return data.signedUrl;
};

const validateMergedConfig = (merged) => {
  const errors = [];

  const nombreEmisor = trimOrNull(merged.nombre_emisor);
  if (!nombreEmisor) {
    errors.push({ field: 'nombre_emisor', message: 'nombre_emisor es requerido.' });
  } else if (nombreEmisor.length > 150) {
    errors.push({ field: 'nombre_emisor', message: 'nombre_emisor excede 150 caracteres.' });
  }

  const rtnEmisor = trimOrNull(merged.rtn_emisor);
  if (rtnEmisor && rtnEmisor.length > 30) {
    errors.push({ field: 'rtn_emisor', message: 'rtn_emisor excede 30 caracteres.' });
  }

  const direccionEmisor = trimOrNull(merged.direccion_emisor);
  if (direccionEmisor && direccionEmisor.length > 250) {
    errors.push({ field: 'direccion_emisor', message: 'direccion_emisor excede 250 caracteres.' });
  }

  const telefonoEmisor = trimOrNull(merged.telefono_emisor);
  if (telefonoEmisor && telefonoEmisor.length > 40) {
    errors.push({ field: 'telefono_emisor', message: 'telefono_emisor excede 40 caracteres.' });
  }

  const correoEmisor = trimOrNull(merged.correo_emisor);
  if (correoEmisor) {
    if (correoEmisor.length > 120) {
      errors.push({ field: 'correo_emisor', message: 'correo_emisor excede 120 caracteres.' });
    } else if (!SAFE_EMAIL_RE.test(correoEmisor)) {
      errors.push({ field: 'correo_emisor', message: 'correo_emisor tiene un formato inválido.' });
    }
  }

  const headerText = trimOrNull(merged.texto_encabezado_ticket);
  if (headerText && headerText.length > 250) {
    errors.push({ field: 'texto_encabezado_ticket', message: 'texto_encabezado_ticket excede 250 caracteres.' });
  }

  const footerText = trimOrNull(merged.texto_pie_ticket);
  if (footerText && footerText.length > 250) {
    errors.push({ field: 'texto_pie_ticket', message: 'texto_pie_ticket excede 250 caracteres.' });
  }

  const prefijoVenta = trimOrNull(merged.prefijo_venta);
  if (!prefijoVenta) {
    errors.push({ field: 'prefijo_venta', message: 'prefijo_venta es requerido.' });
  } else if (prefijoVenta.length > 10 || !VALID_PREFIX_RE.test(prefijoVenta)) {
    errors.push({ field: 'prefijo_venta', message: 'prefijo_venta es inválido.' });
  }

  const prefijoReversion = trimOrNull(merged.prefijo_reversion);
  if (!prefijoReversion) {
    errors.push({ field: 'prefijo_reversion', message: 'prefijo_reversion es requerido.' });
  } else if (prefijoReversion.length > 10 || !VALID_PREFIX_RE.test(prefijoReversion)) {
    errors.push({ field: 'prefijo_reversion', message: 'prefijo_reversion es inválido.' });
  }

  const longitudCorrelativo = Number.parseInt(String(merged.longitud_correlativo ?? ''), 10);
  if (!Number.isInteger(longitudCorrelativo) || longitudCorrelativo < 3 || longitudCorrelativo > 10) {
    errors.push({ field: 'longitud_correlativo', message: 'longitud_correlativo debe estar entre 3 y 10.' });
  }

  const anchoTicket = Number.parseInt(String(merged.ancho_ticket_mm ?? ''), 10);
  if (!VALID_TICKET_WIDTH.has(anchoTicket)) {
    errors.push({ field: 'ancho_ticket_mm', message: 'ancho_ticket_mm debe ser 58 u 80.' });
  }

  const modoFiscal = String(merged.modo_fiscal ?? '').trim().toUpperCase();
  if (!VALID_MODO_FISCAL.has(modoFiscal)) {
    errors.push({ field: 'modo_fiscal', message: 'modo_fiscal es inválido.' });
  }

  const boolFields = [
    'reinicio_diario',
    'mostrar_logo_ticket',
    'mostrar_rtn',
    'mostrar_direccion',
    'mostrar_telefono',
    'mostrar_correo',
    ...TICKET_FLAG_FIELDS,
    'activo'
  ];
  for (const field of boolFields) {
    const parsed = normalizeBoolean(merged[field]);
    if (parsed === null) {
      errors.push({ field, message: `${field} debe ser boolean.` });
    }
  }

  const idArchivoLogo = merged.id_archivo_logo;
  if (idArchivoLogo !== null && idArchivoLogo !== undefined && idArchivoLogo !== '') {
    const parsedIdArchivoLogo = asPositiveInt(idArchivoLogo);
    if (!parsedIdArchivoLogo) {
      errors.push({ field: 'id_archivo_logo', message: 'id_archivo_logo debe ser un entero positivo.' });
    }
  }

  if (errors.length > 0) {
    throw new ServiceError('Datos inválidos para la configuración de facturación.', 400, errors);
  }

  return {
    nombre_emisor: nombreEmisor,
    rtn_emisor: rtnEmisor,
    direccion_emisor: direccionEmisor,
    telefono_emisor: telefonoEmisor,
    correo_emisor: correoEmisor,
    logo_url: trimOrNull(merged.logo_url),
    id_archivo_logo: asPositiveInt(merged.id_archivo_logo),
    texto_encabezado_ticket: headerText,
    texto_pie_ticket: footerText,
    ancho_ticket_mm: Number.parseInt(String(merged.ancho_ticket_mm), 10),
    prefijo_venta: prefijoVenta,
    prefijo_reversion: prefijoReversion,
    longitud_correlativo: Number.parseInt(String(merged.longitud_correlativo), 10),
    reinicio_diario: normalizeBoolean(merged.reinicio_diario),
    modo_fiscal: modoFiscal,
    mostrar_logo_ticket: normalizeBoolean(merged.mostrar_logo_ticket),
    mostrar_rtn: normalizeBoolean(merged.mostrar_rtn),
    mostrar_direccion: normalizeBoolean(merged.mostrar_direccion),
    mostrar_telefono: normalizeBoolean(merged.mostrar_telefono),
    mostrar_correo: normalizeBoolean(merged.mostrar_correo),
    ...TICKET_FLAG_FIELDS.reduce((acc, field) => ({
      ...acc,
      [field]: normalizeBoolean(merged[field])
    }), {}),
    activo: normalizeBoolean(merged.activo)
  };
};

export const obtenerConfiguracionPorSucursal = async (idSucursal) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es inválido.', 400);
  }
  const config = await crearConfiguracionInicialSiNoExiste(idSucursalNum);
  return sanitizeOutboundConfig(config);
};

export const crearConfiguracionInicialSiNoExiste = async (idSucursal, db = pool) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es inválido.', 400);
  }

  const client = db === pool ? await pool.connect() : db;
  let ownClient = db === pool;
  let txOpen = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    const sucursal = await ensureSucursalExists(idSucursalNum, client);
    const existing = await getConfigBySucursal(idSucursalNum, client);
    if (existing) {
      await client.query('COMMIT');
      txOpen = false;
      return existing;
    }

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
          $1, 'VTA', 'REV', 5, true, 'INTERNO', true, 80, true,
          $2, null, $3, $4, $5, null, null, null, 'Gracias por su compra', true, true, true, false,
          true, true, true, true,
          false, false, false, false, false, false, false, false,
          true, true, true,
          true, true, true, true, true, true, true, true
        )
        ON CONFLICT (id_sucursal) DO NOTHING
      `,
      [
        idSucursalNum,
        trimOrNull(sucursal?.nombre_sucursal) || "JONNY'S",
        trimOrNull(sucursal?.texto_direccion),
        trimOrNull(sucursal?.texto_telefono),
        trimOrNull(sucursal?.texto_correo)
      ]
    );

    const createdOrExisting = await getConfigBySucursal(idSucursalNum, client);
    await client.query('COMMIT');
    txOpen = false;
    return createdOrExisting;
  } catch (error) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
};

export const actualizarConfiguracionSucursal = async (idSucursal, payload = {}) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es inválido.', 400);
  }

  const currentConfig = await crearConfiguracionInicialSiNoExiste(idSucursalNum);
  const allowedFields = [
    'nombre_emisor',
    'rtn_emisor',
    'direccion_emisor',
    'telefono_emisor',
    'correo_emisor',
    'logo_url',
    'id_archivo_logo',
    'texto_encabezado_ticket',
    'texto_pie_ticket',
    'ancho_ticket_mm',
    'prefijo_venta',
    'prefijo_reversion',
    'longitud_correlativo',
    'reinicio_diario',
    'modo_fiscal',
    'mostrar_logo_ticket',
    'mostrar_rtn',
    'mostrar_direccion',
    'mostrar_telefono',
    'mostrar_correo',
    ...TICKET_FLAG_FIELDS,
    'activo'
  ];

  const merged = { ...currentConfig };
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      merged[key] = payload[key];
    }
  }

  const validated = validateMergedConfig(merged);
  const logoArchivo = await ensureValidLogoArchivo(validated.id_archivo_logo);
  const nextLogoUrl = logoArchivo?.url_publica || null;
  const oldArchivoId = asPositiveInt(currentConfig?.id_archivo_logo);
  const client = await pool.connect();
  let txOpen = false;
  let oldLogoPathToRemove = null;

  try {
    await client.query('BEGIN');
    txOpen = true;

    const updateResult = await client.query(
      `
        UPDATE public.facturacion_config_sucursal
        SET
          nombre_emisor = $1,
          rtn_emisor = $2,
          direccion_emisor = $3,
          telefono_emisor = $4,
          correo_emisor = $5,
          logo_url = $6,
          id_archivo_logo = $7,
          texto_encabezado_ticket = $8,
          texto_pie_ticket = $9,
          ancho_ticket_mm = $10,
          prefijo_venta = $11,
          prefijo_reversion = $12,
          longitud_correlativo = $13,
          reinicio_diario = $14,
          modo_fiscal = $15,
          mostrar_logo_ticket = $16,
          mostrar_rtn = $17,
          mostrar_direccion = $18,
          mostrar_telefono = $19,
          mostrar_correo = $20,
          mostrar_datos_fiscales = $21,
          mostrar_cai_ticket = $22,
          mostrar_numero_fiscal_ticket = $23,
          mostrar_codigo_interno_ticket = $24,
          aplicar_impuestos = $25,
          mostrar_impuestos_ticket = $26,
          mostrar_importe_exento = $27,
          mostrar_importe_gravado_15 = $28,
          mostrar_isv_15 = $29,
          mostrar_importe_gravado_18 = $30,
          mostrar_isv_18 = $31,
          mostrar_total_isv = $32,
          mostrar_descuento_linea = $33,
          mostrar_descuento_porcentaje_linea = $34,
          mostrar_descuento_total = $35,
          imprimir_comprobante_reversion = $36,
          mostrar_venta_original_reversion = $37,
          mostrar_codigo_reversion = $38,
          mostrar_usuario_reversion = $39,
          mostrar_caja_sesion_reversion = $40,
          mostrar_motivo_reversion = $41,
          mostrar_detalle_reversion = $42,
          mostrar_total_reversion = $43,
          activo = $44,
          actualizado_en = timezone('America/Tegucigalpa', now())
        WHERE id_sucursal = $45
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
        validated.nombre_emisor,
        validated.rtn_emisor,
        validated.direccion_emisor,
        validated.telefono_emisor,
        validated.correo_emisor,
        nextLogoUrl,
        validated.id_archivo_logo,
        validated.texto_encabezado_ticket,
        validated.texto_pie_ticket,
        validated.ancho_ticket_mm,
        validated.prefijo_venta,
        validated.prefijo_reversion,
        validated.longitud_correlativo,
        validated.reinicio_diario,
        validated.modo_fiscal,
        validated.mostrar_logo_ticket,
        validated.mostrar_rtn,
        validated.mostrar_direccion,
        validated.mostrar_telefono,
        validated.mostrar_correo,
        ...TICKET_FLAG_FIELDS.map((field) => validated[field]),
        validated.activo,
        idSucursalNum
      ]
    );

    if (updateResult.rowCount === 0) {
      throw new ServiceError('La sucursal indicada no existe.', 404);
    }

    oldLogoPathToRemove = await disableLogoArchivoIfUnused({
      oldArchivoId,
      newArchivoId: validated.id_archivo_logo
    }, client);

    await client.query('COMMIT');
    txOpen = false;

    if (oldLogoPathToRemove) {
      await tryRemoveStorageObject(oldLogoPathToRemove);
    }

    return sanitizeOutboundConfig(updateResult.rows[0]);
  } catch (error) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
};

export const obtenerPreviewFacturacionSucursal = async (idSucursal) => {
  const config = await obtenerConfiguracionPorSucursal(idSucursal);
  const preview = buildPreviewFromConfig(config);
  preview.emisor.logo_url = await resolveLogoDisplayUrl(preview.emisor.logo_url);
  return preview;
};

export const FacturacionConfigSucursalService = Object.freeze({
  ServiceError,
  obtenerConfiguracionPorSucursal,
  crearConfiguracionInicialSiNoExiste,
  actualizarConfiguracionSucursal,
  obtenerPreviewFacturacionSucursal
});
