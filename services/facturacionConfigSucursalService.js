import pool from '../config/db-connection.js';

const VALID_MODO_FISCAL = new Set(['INTERNO', 'CAI_PREPARADO', 'CAI_ACTIVO']);
const VALID_TICKET_WIDTH = new Set([58, 80]);
const VALID_PREFIX_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value ?? '').toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value ?? '').toLowerCase() === 'false') return false;
  return null;
};

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
      impuesto: 15,
      descuento: 0,
      total: 115
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
      mostrar_correo: Boolean(config?.mostrar_correo)
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
        mostrar_correo
      FROM public.facturacion_config_sucursal
      WHERE id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );

  return configResult.rows?.[0] || null;
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
          mostrar_correo
        )
        VALUES (
          $1, 'VTA', 'REV', 5, true, 'INTERNO', true, 80, true,
          $2, null, $3, $4, $5, null, null, null, 'Gracias por su compra', true, true, true, false
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
    'activo'
  ];

  const merged = { ...currentConfig };
  for (const key of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined) {
      merged[key] = payload[key];
    }
  }

  const validated = validateMergedConfig(merged);
  const updateResult = await pool.query(
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
        activo = $21,
        actualizado_en = timezone('America/Tegucigalpa', now())
      WHERE id_sucursal = $22
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
        mostrar_correo
    `,
    [
      validated.nombre_emisor,
      validated.rtn_emisor,
      validated.direccion_emisor,
      validated.telefono_emisor,
      validated.correo_emisor,
      validated.logo_url,
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
      validated.activo,
      idSucursalNum
    ]
  );

  if (updateResult.rowCount === 0) {
    throw new ServiceError('La sucursal indicada no existe.', 404);
  }

  return sanitizeOutboundConfig(updateResult.rows[0]);
};

export const obtenerPreviewFacturacionSucursal = async (idSucursal) => {
  const config = await obtenerConfiguracionPorSucursal(idSucursal);
  return buildPreviewFromConfig(config);
};

export const FacturacionConfigSucursalService = Object.freeze({
  ServiceError,
  obtenerConfiguracionPorSucursal,
  crearConfiguracionInicialSiNoExiste,
  actualizarConfiguracionSucursal,
  obtenerPreviewFacturacionSucursal
});
