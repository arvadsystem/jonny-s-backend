import express from 'express';
import pool from '../config/db-connection.js';
import { checkPermission } from '../middleware/checkPermission.js';
import { buildAbsolutePublicUrl } from '../utils/uploads.js';
import { supabase } from '../services/supabaseClient.js';
import {
  SUPABASE_ASSETS_BUCKET,
  SUCURSALES_UPLOADS_SUBDIR
} from '../utils/uploads.js';
import {
  FacturacionConfigSucursalService,
  obtenerConfiguracionPorSucursal,
  actualizarConfiguracionSucursal,
  obtenerPreviewFacturacionSucursal
} from '../services/facturacionConfigSucursalService.js';
import {
  FacturacionCaiSucursalService,
  listarRangosCaiPorSucursal,
  crearRangoCaiSucursal,
  activarRangoCaiSucursal,
  desactivarRangoCaiSucursal
} from '../services/facturacionCaiSucursalService.js';

const router = express.Router();

const calcularAntiguedad = (fechaInauguracion) => {
  if (!fechaInauguracion) return 'Fecha no registrada';

  const fechaInicio = new Date(fechaInauguracion);
  const fechaActual = new Date();

  let anios = fechaActual.getFullYear() - fechaInicio.getFullYear();
  let meses = fechaActual.getMonth() - fechaInicio.getMonth();

  if (meses < 0) {
    anios--;
    meses += 12;
  }

  if (anios < 0) return 'Por inaugurar';
  return `${anios} años, ${meses} meses`;
};

const normalizeHour = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;
  return normalized.length === 5 ? `${normalized}:00` : normalized;
};

const normalizePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const SUCURSALES_VIEW_PERMISSIONS = ['SUCURSALES_VER'];
const SUCURSALES_CREATE_PERMISSIONS = ['SUCURSALES_CREAR'];
const SUCURSALES_EDIT_PERMISSIONS = ['SUCURSALES_EDITAR'];
const SUCURSALES_HORARIOS_MANAGE_PERMISSIONS = ['SUCURSALES_HORARIOS_GESTIONAR'];
const SUCURSALES_FACTURACION_VIEW_PERMISSIONS = ['SUCURSALES_FACTURACION_VER'];
const SUCURSALES_FACTURACION_EDIT_PERMISSIONS = ['SUCURSALES_FACTURACION_EDITAR'];
const SUCURSALES_FACTURACION_PREVIEW_PERMISSIONS = ['SUCURSALES_FACTURACION_PREVIEW_VER'];
const SUCURSALES_FACTURACION_CAI_VIEW_PERMISSIONS = ['SUCURSALES_FACTURACION_CAI_VER', 'SUCURSALES_FACTURACION_CAI_GESTIONAR'];
const SUCURSALES_FACTURACION_CAI_MANAGE_PERMISSIONS = ['SUCURSALES_FACTURACION_CAI_GESTIONAR'];
const SQLSTATE_UNIQUE_VIOLATION = '23505';
const VALID_FECHA_ESPECIAL_TYPES = new Set(['FERIADO', 'CIERRE_ESPECIAL', 'HORARIO_ESPECIAL']);
const VALID_PHONE_RE = /^[\d+\-()\s]+$/;
const VALID_SUCURSAL_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const parsePositiveInt = (value) => normalizePositiveInt(value);

const isValidTime = (value) => /^\d{2}:\d{2}(:\d{2})?$/.test(String(value || '').trim());

const normalizeTime = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  if (!isValidTime(raw)) return null;
  return raw.length === 5 ? `${raw}:00` : raw;
};

const isValidDate = (value) => {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split('-').map((item) => Number(item));
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() + 1 === month &&
    dt.getUTCDate() === day
  );
};

const sanitizePlainText = (value, maxLength = 200) => {
  if (value === undefined || value === null) return null;
  const stripped = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.slice(0, maxLength);
};

const toTitleCase = (value) => {
  const cleaned = sanitizePlainText(value, 200)?.toLocaleLowerCase('es') || '';
  if (!cleaned) return '';
  return cleaned.replace(/(^|\s)(\p{L})/gu, (match, prefix, char) => `${prefix}${char.toLocaleUpperCase('es')}`);
};

const toSentenceCase = (value) => {
  const cleaned = sanitizePlainText(value, 220)?.toLocaleLowerCase('es') || '';
  if (!cleaned) return '';
  return cleaned.replace(/^(\p{L})/u, (char) => char.toLocaleUpperCase('es'));
};

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const hasPhoneLetters = (value) => /[a-zA-Z]/.test(String(value || ''));
const normalizePhone = (value) =>
  sanitizePlainText(value, 30)?.replace(/[^\d+\-()\s]/g, '').replace(/\s+/g, ' ').trim() || '';

const parseStrictBoolean = (value) => {
  if (value === true || value === false) return { ok: true, value };
  if (value === 1 || value === '1' || String(value || '').toLowerCase() === 'true') return { ok: true, value: true };
  if (value === 0 || value === '0' || String(value || '').toLowerCase() === 'false') return { ok: true, value: false };
  return { ok: false, value: null };
};

const buildSucursalNormalizedPayload = (input = {}, { requireNombre = true } = {}) => {
  const errors = {};

  const nombre_sucursal = toTitleCase(input?.nombre_sucursal);
  const texto_direccion = toSentenceCase(input?.texto_direccion);
  const texto_correo = normalizeEmail(sanitizePlainText(input?.texto_correo, 120));
  const texto_telefono = normalizePhone(input?.texto_telefono);
  const fecha_inauguracion = String(input?.fecha_inauguracion ?? '').trim();
  const estadoParsed = parseStrictBoolean(input?.estado);

  if (requireNombre && !nombre_sucursal) {
    errors.nombre_sucursal = 'Ingresa el nombre de la sucursal.';
  } else if (nombre_sucursal && nombre_sucursal.length > 80) {
    errors.nombre_sucursal = 'El nombre de la sucursal excede el máximo permitido.';
  }

  if (texto_direccion && texto_direccion.length > 200) {
    errors.texto_direccion = 'La dirección excede el máximo permitido.';
  }

  if (texto_correo) {
    if (texto_correo.length > 120 || !isValidEmail(texto_correo)) {
      errors.texto_correo = 'Ingresa un correo válido.';
    }
  }

  if (texto_telefono) {
    if (hasPhoneLetters(input?.texto_telefono)) {
      errors.texto_telefono = 'El teléfono no debe contener letras.';
    } else if (!VALID_PHONE_RE.test(texto_telefono) || texto_telefono.length > 30) {
      errors.texto_telefono = 'Ingresa un teléfono válido.';
    }
  }

  if (fecha_inauguracion && !isValidDate(fecha_inauguracion)) {
    errors.fecha_inauguracion = 'Ingresa una fecha válida.';
  }

  if (!estadoParsed.ok) {
    errors.estado = 'El estado de la sucursal es inválido.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      ...input,
      nombre_sucursal,
      texto_direccion: texto_direccion || null,
      texto_correo: texto_correo || null,
      texto_telefono: texto_telefono || null,
      fecha_inauguracion: fecha_inauguracion || null,
      estado: estadoParsed.value
    }
  };
};

const ensureSucursalExists = async (idSucursal, db = pool) => {
  const result = await db.query(
    'SELECT 1 FROM public.sucursales WHERE id_sucursal = $1 LIMIT 1',
    [idSucursal]
  );
  return result.rowCount > 0;
};

const parseBooleanValue = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
};

const validateHorarioItem = (item = {}) => {
  const diaSemana = parsePositiveInt(item?.dia_semana);
  if (!diaSemana || diaSemana < 1 || diaSemana > 7) {
    return { ok: false, message: 'Datos inválidos para el horario.' };
  }

  const cerrado = parseBooleanValue(item?.cerrado, false);
  const estado = parseBooleanValue(item?.estado, true);
  const horaInicio = normalizeTime(item?.hora_inicio);
  const horaFinal = normalizeTime(item?.hora_final);

  if (!cerrado) {
    if (!horaInicio || !horaFinal || horaFinal <= horaInicio) {
      return { ok: false, message: 'Datos inválidos para el horario.' };
    }
  } else if (horaInicio || horaFinal) {
    return { ok: false, message: 'Datos inválidos para el horario.' };
  }

  return {
    ok: true,
    data: {
      dia_semana: diaSemana,
      hora_inicio: cerrado ? null : horaInicio,
      hora_final: cerrado ? null : horaFinal,
      cerrado,
      estado
    }
  };
};

const validateFechaEspecialPayload = (payload = {}) => {
  const fecha = String(payload?.fecha || '').trim();
  if (!isValidDate(fecha)) {
    return { ok: false, status: 400, message: 'Datos inválidos para la fecha especial.' };
  }

  const tipo = String(payload?.tipo || '').trim().toUpperCase();
  if (!VALID_FECHA_ESPECIAL_TYPES.has(tipo)) {
    return { ok: false, status: 400, message: 'Datos inválidos para la fecha especial.' };
  }

  const descripcion = sanitizePlainText(payload?.descripcion, 200);
  if (payload?.descripcion !== undefined && payload?.descripcion !== null && !descripcion) {
    return { ok: false, status: 400, message: 'Datos inválidos para la fecha especial.' };
  }

  const cerrado = parseBooleanValue(payload?.cerrado, true);
  const estado = parseBooleanValue(payload?.estado, true);
  const horaInicio = normalizeTime(payload?.hora_inicio);
  const horaFinal = normalizeTime(payload?.hora_final);

  if (!cerrado) {
    if (!horaInicio || !horaFinal || horaFinal <= horaInicio) {
      return { ok: false, status: 400, message: 'Datos inválidos para la fecha especial.' };
    }
  } else if (horaInicio || horaFinal) {
    return { ok: false, status: 400, message: 'Datos inválidos para la fecha especial.' };
  }

  return {
    ok: true,
    data: {
      fecha,
      tipo,
      descripcion,
      cerrado,
      hora_inicio: cerrado ? null : horaInicio,
      hora_final: cerrado ? null : horaFinal,
      estado
    }
  };
};

const validateHorario = ({ horaInicio, horaFinal }) => {
  if ((horaInicio && !horaFinal) || (!horaInicio && horaFinal)) {
    return 'Hora inicio y hora final deben enviarse juntas.';
  }
  if (horaInicio && horaFinal && horaFinal <= horaInicio) {
    return 'Hora final debe ser mayor que hora inicio.';
  }
  return null;
};

async function crearSucursalCompleta(datos, db = pool) {
  const query = 'SELECT public.fn_crear_sucursal_completa($1::jsonb) AS id_sucursal';
  const { rows } = await db.query(query, [datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

async function actualizarSucursalCompleta(idSucursal, datos, db = pool) {
  const query = 'SELECT public.fn_actualizar_sucursal_completa($1::int, $2::jsonb) AS id_sucursal';
  const { rows } = await db.query(query, [idSucursal, datos]);
  return rows?.[0]?.id_sucursal ?? null;
}

const upsertSucursalExtras = async ({ idSucursal, horaInicio, horaFinal, idArchivoImagen }, db = pool) => {
  await db.query(
    `
      UPDATE public.sucursales
      SET hora_inicio = $1,
          hora_final = $2,
          id_archivo_imagen = $3
      WHERE id_sucursal = $4
    `,
    [horaInicio, horaFinal, idArchivoImagen, idSucursal]
  );
};

const isSucursalStoragePath = (value) => {
  const path = String(value || '').trim();
  return path.startsWith(`${SUPABASE_ASSETS_BUCKET}/${SUCURSALES_UPLOADS_SUBDIR}/`);
};

const parseStoragePath = (value) => {
  const path = String(value || '').trim();
  if (!path || /^https?:\/\//i.test(path)) return null;
  const [bucket, ...rest] = path.split('/').filter(Boolean);
  if (!bucket || rest.length === 0) return null;
  return { bucket, filePath: rest.join('/') };
};

const ensureValidSucursalImageArchivo = async (idArchivo, db = pool) => {
  if (!idArchivo) return null;
  const result = await db.query(
    `
      SELECT id_archivo, url_publica, tipo_archivo, COALESCE(estado, true) AS estado
      FROM public.archivos
      WHERE id_archivo = $1
      LIMIT 1
    `,
    [idArchivo]
  );

  if (result.rowCount === 0) {
    return { ok: false, message: 'No se pudo actualizar la imagen de la sucursal.' };
  }

  const row = result.rows[0];
  if (!VALID_SUCURSAL_IMAGE_MIME_TYPES.has(String(row.tipo_archivo || '').toLowerCase())) {
    return { ok: false, message: 'No se pudo actualizar la imagen de la sucursal.' };
  }

  if (!isSucursalStoragePath(row.url_publica) || row.estado !== true) {
    return { ok: false, message: 'No se pudo actualizar la imagen de la sucursal.' };
  }

  return { ok: true, data: row };
};

const disableOldSucursalImageIfUnused = async ({ oldArchivoId, newArchivoId }, db = pool) => {
  if (!oldArchivoId || oldArchivoId === newArchivoId) {
    return { disabled: false, oldArchivoPath: null };
  }

  const refCount = await db.query(
    `
      SELECT COUNT(*)::int AS total
      FROM public.sucursales
      WHERE id_archivo_imagen = $1
    `,
    [oldArchivoId]
  );

  if (Number(refCount.rows?.[0]?.total || 0) > 0) {
    return { disabled: false, oldArchivoPath: null };
  }

  const oldResult = await db.query(
    `
      SELECT id_archivo, url_publica
      FROM public.archivos
      WHERE id_archivo = $1
      LIMIT 1
      FOR UPDATE
    `,
    [oldArchivoId]
  );

  if (oldResult.rowCount === 0) {
    return { disabled: false, oldArchivoPath: null };
  }

  await db.query(
    `
      UPDATE public.archivos
      SET estado = false
      WHERE id_archivo = $1
    `,
    [oldArchivoId]
  );

  return {
    disabled: true,
    oldArchivoPath: oldResult.rows[0].url_publica || null
  };
};

const tryDeleteOldStorageObject = async (storedPath) => {
  const parsed = parseStoragePath(storedPath);
  if (!parsed || parsed.bucket !== SUPABASE_ASSETS_BUCKET) return { attempted: false, removed: false };
  const { error } = await supabase.storage.from(parsed.bucket).remove([parsed.filePath]);
  if (error) {
    console.warn('[sucursales] storage cleanup warning:', error.message);
    return { attempted: true, removed: false };
  }
  return { attempted: true, removed: true };
};

router.get(
  '/sucursales/:idSucursal/facturacion-config',
  checkPermission(SUCURSALES_FACTURACION_VIEW_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await obtenerConfiguracionPorSucursal(req.params?.idSucursal);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (err instanceof FacturacionConfigSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos inválidos para la configuración de facturación.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar la configuración de facturación.'
        });
      }
      console.error('[sucursales] facturacion-config get error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar la configuración de facturación.'
      });
    }
  }
);

router.put(
  '/sucursales/:idSucursal/facturacion-config',
  checkPermission(SUCURSALES_FACTURACION_EDIT_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await actualizarConfiguracionSucursal(req.params?.idSucursal, req.body || {});
      return res.status(200).json({
        success: true,
        message: 'Configuración de facturación actualizada correctamente.',
        data
      });
    } catch (err) {
      if (err instanceof FacturacionConfigSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos inválidos para la configuración de facturación.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar la configuración de facturación.'
        });
      }
      console.error('[sucursales] facturacion-config put error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar la configuración de facturación.'
      });
    }
  }
);

router.get(
  '/sucursales/:idSucursal/facturacion-preview',
  checkPermission(SUCURSALES_FACTURACION_PREVIEW_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await obtenerPreviewFacturacionSucursal(req.params?.idSucursal);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (err instanceof FacturacionConfigSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos inválidos para la configuración de facturación.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar la configuración de facturación.'
        });
      }
      console.error('[sucursales] facturacion-preview get error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar la configuración de facturación.'
      });
    }
  }
);

router.get(
  '/sucursales/:idSucursal/facturacion-rangos-cai',
  checkPermission(SUCURSALES_FACTURACION_CAI_VIEW_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await listarRangosCaiPorSucursal(req.params?.idSucursal);
      return res.status(200).json({ success: true, data });
    } catch (err) {
      if (err instanceof FacturacionCaiSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos invalidos para la gestion de rangos CAI.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar los rangos CAI.'
        });
      }
      console.error('[sucursales] facturacion-rangos-cai list error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar los rangos CAI.'
      });
    }
  }
);

router.post(
  '/sucursales/:idSucursal/facturacion-rangos-cai',
  checkPermission(SUCURSALES_FACTURACION_CAI_MANAGE_PERMISSIONS),
  async (req, res) => {
    try {
      const actorUserId = Number.parseInt(String(req?.user?.id_usuario ?? ''), 10);
      const data = await crearRangoCaiSucursal(req.params?.idSucursal, req.body || {}, actorUserId);
      return res.status(201).json({
        success: true,
        message: 'Rango CAI creado correctamente.',
        data
      });
    } catch (err) {
      if (err instanceof FacturacionCaiSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos invalidos para la gestion de rangos CAI.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        if (err.status === 409) {
          return res.status(409).json({ success: false, message: err.message || 'El rango CAI ya existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar los rangos CAI.'
        });
      }
      console.error('[sucursales] facturacion-rangos-cai create error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar los rangos CAI.'
      });
    }
  }
);

router.patch(
  '/sucursales/:idSucursal/facturacion-rangos-cai/:idRango/activar',
  checkPermission(SUCURSALES_FACTURACION_CAI_MANAGE_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await activarRangoCaiSucursal(req.params?.idSucursal, req.params?.idRango);
      return res.status(200).json({
        success: true,
        message: 'Rango CAI activado correctamente.',
        data
      });
    } catch (err) {
      if (err instanceof FacturacionCaiSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos invalidos para la gestion de rangos CAI.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          if (String(err.message || '').toLowerCase().includes('rango cai')) {
            return res.status(404).json({ success: false, message: 'El rango CAI no existe para la sucursal indicada.' });
          }
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar los rangos CAI.'
        });
      }
      console.error('[sucursales] facturacion-rangos-cai activar error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar los rangos CAI.'
      });
    }
  }
);

router.patch(
  '/sucursales/:idSucursal/facturacion-rangos-cai/:idRango/desactivar',
  checkPermission(SUCURSALES_FACTURACION_CAI_MANAGE_PERMISSIONS),
  async (req, res) => {
    try {
      const data = await desactivarRangoCaiSucursal(req.params?.idSucursal, req.params?.idRango);
      return res.status(200).json({
        success: true,
        message: 'Rango CAI desactivado correctamente.',
        data
      });
    } catch (err) {
      if (err instanceof FacturacionCaiSucursalService.ServiceError) {
        if (err.status === 400) {
          return res.status(400).json({
            success: false,
            message: 'Datos invalidos para la gestion de rangos CAI.',
            errors: Array.isArray(err.details) ? err.details : []
          });
        }
        if (err.status === 404) {
          if (String(err.message || '').toLowerCase().includes('rango cai')) {
            return res.status(404).json({ success: false, message: 'El rango CAI no existe para la sucursal indicada.' });
          }
          return res.status(404).json({ success: false, message: 'La sucursal indicada no existe.' });
        }
        return res.status(err.status || 500).json({
          success: false,
          message: 'No fue posible procesar los rangos CAI.'
        });
      }
      console.error('[sucursales] facturacion-rangos-cai desactivar error:', err?.message || err);
      return res.status(500).json({
        success: false,
        message: 'No fue posible procesar los rangos CAI.'
      });
    }
  }
);

router.get('/sucursales', checkPermission(SUCURSALES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const tabla = 'v_sucursales_info';
    const columnas =
      'id_sucursal, nombre_sucursal, fecha_inauguracion, estado, texto_direccion, texto_telefono, texto_correo';

    const query = 'SELECT function_select($1, $2) as resultado';
    const result = await pool.query(query, [tabla, columnas]);
    const datos = Array.isArray(result.rows?.[0]?.resultado) ? result.rows[0].resultado : [];

    const ids = datos
      .map((row) => normalizePositiveInt(row?.id_sucursal))
      .filter((value) => value !== null);

    const complementById = new Map();
    if (ids.length > 0) {
      const extras = await pool.query(
        `
          SELECT
            s.id_sucursal,
            s.hora_inicio,
            s.hora_final,
            s.id_archivo_imagen,
            a.url_publica AS imagen_url_publica
          FROM public.sucursales s
          LEFT JOIN public.archivos a ON a.id_archivo = s.id_archivo_imagen
          WHERE s.id_sucursal = ANY($1::int[])
        `,
        [ids]
      );
      for (const row of extras.rows) {
        complementById.set(normalizePositiveInt(row.id_sucursal), row);
      }
    }

    const payload = datos.map((sucursal) => {
      const id = normalizePositiveInt(sucursal?.id_sucursal);
      const extra = complementById.get(id) || {};
      const imagenUrlPublica = buildAbsolutePublicUrl(req, extra.imagen_url_publica || null);
      return {
        ...sucursal,
        antiguedad_calculada: calcularAntiguedad(sucursal.fecha_inauguracion),
        hora_inicio: extra.hora_inicio || null,
        hora_final: extra.hora_final || null,
        id_archivo_imagen: extra.id_archivo_imagen || null,
        imagen_url_publica: imagenUrlPublica || null
      };
    });

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[sucursales] list error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo obtener sucursales.' });
  }
});

router.post('/sucursales', checkPermission(SUCURSALES_CREATE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txOpen = false;
  try {
    const prepared = buildSucursalNormalizedPayload(req.body || {}, { requireNombre: true });
    if (!prepared.ok) {
      return res.status(400).json({ ok: false, message: 'Datos inválidos.', errors: prepared.errors });
    }
    const datos = prepared.data;

    const horaInicio = normalizeHour(datos.hora_inicio);
    const horaFinal = normalizeHour(datos.hora_final);
    const idArchivoImagen = normalizePositiveInt(datos.id_archivo_imagen);
    const horarioError = validateHorario({ horaInicio, horaFinal });
    if (horarioError) {
      return res.status(400).json({ error: true, message: horarioError });
    }

    if (idArchivoImagen) {
      const imageValidation = await ensureValidSucursalImageArchivo(idArchivoImagen, client);
      if (!imageValidation.ok) {
        return res.status(400).json({ ok: false, message: imageValidation.message });
      }
    }

    await client.query('BEGIN');
    txOpen = true;

    const id = await crearSucursalCompleta(datos, client);
    if (id) {
      await upsertSucursalExtras({
        idSucursal: id,
        horaInicio,
        horaFinal,
        idArchivoImagen
      }, client);
    }

    await client.query('COMMIT');
    txOpen = false;

    return res.status(201).json({
      ok: true,
      message: 'Sucursal creada exitosamente.',
      id_sucursal: id
    });
  } catch (err) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('[sucursales] create error:', err.message);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo guardar la sucursal. Verifica los datos ingresados.'
    });
  } finally {
    client.release();
  }
});

router.put('/sucursales/:id', checkPermission(SUCURSALES_EDIT_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txOpen = false;
  let oldArchivoPathForCleanup = null;
  let cleanupWarning = false;
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) {
      return res.status(400).json({ error: true, message: 'ID de sucursal invalido.' });
    }

    const prepared = buildSucursalNormalizedPayload(req.body || {}, { requireNombre: true });
    if (!prepared.ok) {
      return res.status(400).json({ ok: false, message: 'Datos inválidos.', errors: prepared.errors });
    }
    const datos = prepared.data;
    const horaInicio = normalizeHour(datos.hora_inicio);
    const horaFinal = normalizeHour(datos.hora_final);
    const idArchivoImagen = normalizePositiveInt(datos.id_archivo_imagen);
    const horarioError = validateHorario({ horaInicio, horaFinal });
    if (horarioError) {
      return res.status(400).json({ error: true, message: horarioError });
    }

    if (idArchivoImagen) {
      const imageValidation = await ensureValidSucursalImageArchivo(idArchivoImagen, client);
      if (!imageValidation.ok) {
        return res.status(400).json({ ok: false, message: imageValidation.message });
      }
    }

    await client.query('BEGIN');
    txOpen = true;

    const currentSucursal = await client.query(
      `
        SELECT id_archivo_imagen
        FROM public.sucursales
        WHERE id_sucursal = $1
        LIMIT 1
        FOR UPDATE
      `,
      [id]
    );

    if (currentSucursal.rowCount === 0) {
      await client.query('ROLLBACK');
      txOpen = false;
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const oldArchivoId = normalizePositiveInt(currentSucursal.rows[0]?.id_archivo_imagen);

    const updatedId = await actualizarSucursalCompleta(id, datos, client);
    await upsertSucursalExtras({
      idSucursal: id,
      horaInicio,
      horaFinal,
      idArchivoImagen
    }, client);

    const cleanupStep = await disableOldSucursalImageIfUnused(
      { oldArchivoId, newArchivoId: idArchivoImagen },
      client
    );
    oldArchivoPathForCleanup = cleanupStep.oldArchivoPath || null;

    await client.query('COMMIT');
    txOpen = false;

    if (oldArchivoPathForCleanup) {
      const cleanupResult = await tryDeleteOldStorageObject(oldArchivoPathForCleanup);
      if (cleanupResult.attempted && !cleanupResult.removed) {
        cleanupWarning = true;
      }
    }

    return res.status(200).json({
      ok: true,
      message: 'Sucursal actualizada correctamente.',
      id_sucursal: updatedId,
      image_cleanup_warning: cleanupWarning
    });
  } catch (err) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('[sucursales] update full error:', err.message);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo guardar la sucursal. Verifica los datos ingresados.'
    });
  } finally {
    client.release();
  }
});

router.put('/sucursales', async (req, res) => {
  try {
    const { campo, valor, id_campo, id_valor } = req.body;

    if (!campo || valor === undefined || !id_campo || id_valor === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Faltan campos obligatorios para la actualizacion.'
      });
    }

    const normalizedCampo = String(campo || '').trim();
    if (normalizedCampo === 'estado') {
      const parsedEstado = parseStrictBoolean(valor);
      if (!parsedEstado.ok) {
        return res.status(400).json({
          ok: false,
          message: 'Datos inválidos.',
          errors: { estado: 'El estado de la sucursal es inválido.' }
        });
      }
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_update($1, $2, $3, $4, $5)';
    await pool.query(query, [tabla, normalizedCampo, String(valor), id_campo, String(id_valor)]);

    return res.status(200).json({ message: 'Sucursal actualizada correctamente.' });
  } catch (err) {
    console.error('[sucursales] update compat error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo actualizar la sucursal.' });
  }
});

router.delete('/sucursales', async (req, res) => {
  try {
    const { columna_id, valor_id } = req.body;

    if (!columna_id || valor_id === undefined) {
      return res.status(400).json({ error: true, message: 'Faltan datos para eliminar.' });
    }

    const tabla = 'sucursales';
    const query = 'CALL pa_delete($1, $2, $3)';
    await pool.query(query, [tabla, columna_id, String(valor_id)]);

    return res.status(200).json({ message: 'Sucursal eliminada.' });
  } catch (err) {
    console.error('[sucursales] delete error:', err.message);
    return res.status(500).json({ error: true, message: 'No se pudo eliminar la sucursal.' });
  }
});

router.get('/sucursales/:id/horarios', checkPermission(SUCURSALES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'ID de sucursal inválido.' });
    }

    const exists = await ensureSucursalExists(idSucursal);
    if (!exists) {
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const result = await pool.query(
      `
        SELECT
          id_horario,
          id_sucursal,
          dia_semana,
          hora_inicio,
          hora_final,
          cerrado,
          estado
        FROM public.sucursales_horarios
        WHERE id_sucursal = $1
        ORDER BY dia_semana ASC
      `,
      [idSucursal]
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[sucursales] horarios list error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo obtener la configuración de horarios.' });
  }
});

router.put('/sucursales/:id/horarios', checkPermission(SUCURSALES_HORARIOS_MANAGE_PERMISSIONS), async (req, res) => {
  const client = await pool.connect();
  let txOpen = false;
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'ID de sucursal inválido.' });
    }

    const horariosRaw = req.body?.horarios;
    if (!Array.isArray(horariosRaw) || horariosRaw.length > 7) {
      return res.status(400).json({ ok: false, message: 'Datos inválidos para el horario.' });
    }

    const normalized = [];
    const seenDays = new Set();
    for (const item of horariosRaw) {
      const parsed = validateHorarioItem(item);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, message: parsed.message });
      }
      if (seenDays.has(parsed.data.dia_semana)) {
        return res.status(400).json({ ok: false, message: 'Datos inválidos para el horario.' });
      }
      seenDays.add(parsed.data.dia_semana);
      normalized.push(parsed.data);
    }

    await client.query('BEGIN');
    txOpen = true;

    const exists = await ensureSucursalExists(idSucursal, client);
    if (!exists) {
      await client.query('ROLLBACK');
      txOpen = false;
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    if (normalized.length > 0) {
      for (const item of normalized) {
        await client.query(
          `
            INSERT INTO public.sucursales_horarios (
              id_sucursal,
              dia_semana,
              hora_inicio,
              hora_final,
              cerrado,
              estado
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id_sucursal, dia_semana)
            DO UPDATE SET
              hora_inicio = EXCLUDED.hora_inicio,
              hora_final = EXCLUDED.hora_final,
              cerrado = EXCLUDED.cerrado,
              estado = EXCLUDED.estado
          `,
          [
            idSucursal,
            item.dia_semana,
            item.hora_inicio,
            item.hora_final,
            item.cerrado,
            item.estado
          ]
        );
      }
    }

    await client.query(
      `
        UPDATE public.sucursales_horarios
        SET estado = false
        WHERE id_sucursal = $1
          AND ($2::int[] IS NULL OR dia_semana <> ALL($2::int[]))
      `,
      [idSucursal, normalized.length > 0 ? normalized.map((item) => item.dia_semana) : null]
    );

    const result = await client.query(
      `
        SELECT
          id_horario,
          id_sucursal,
          dia_semana,
          hora_inicio,
          hora_final,
          cerrado,
          estado
        FROM public.sucursales_horarios
        WHERE id_sucursal = $1
        ORDER BY dia_semana ASC
      `,
      [idSucursal]
    );

    await client.query('COMMIT');
    txOpen = false;

    return res.status(200).json({
      ok: true,
      message: 'Horarios actualizados correctamente.',
      data: result.rows
    });
  } catch (err) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    console.error('[sucursales] horarios upsert error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar la configuración de horarios.' });
  } finally {
    client.release();
  }
});

router.get('/sucursales/:id/fechas-especiales', checkPermission(SUCURSALES_VIEW_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'ID de sucursal inválido.' });
    }

    const exists = await ensureSucursalExists(idSucursal);
    if (!exists) {
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const desde = req.query?.desde ? String(req.query.desde).trim() : '';
    const hasta = req.query?.hasta ? String(req.query.hasta).trim() : '';
    const tipo = req.query?.tipo ? String(req.query.tipo).trim().toUpperCase() : '';
    const estadoParam = req.query?.estado;

    if ((desde && !isValidDate(desde)) || (hasta && !isValidDate(hasta))) {
      return res.status(400).json({ ok: false, message: 'Parámetros de fecha inválidos.' });
    }
    if (tipo && !VALID_FECHA_ESPECIAL_TYPES.has(tipo)) {
      return res.status(400).json({ ok: false, message: 'Parámetros de filtro inválidos.' });
    }

    const filters = ['id_sucursal = $1'];
    const params = [idSucursal];

    if (desde) {
      params.push(desde);
      filters.push(`fecha >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      filters.push(`fecha <= $${params.length}`);
    }
    if (tipo) {
      params.push(tipo);
      filters.push(`tipo = $${params.length}`);
    }
    if (estadoParam !== undefined) {
      const estado = parseBooleanValue(estadoParam, null);
      if (typeof estado !== 'boolean') {
        return res.status(400).json({ ok: false, message: 'Parámetros de filtro inválidos.' });
      }
      params.push(estado);
      filters.push(`estado = $${params.length}`);
    }

    const result = await pool.query(
      `
        SELECT
          id_fecha_especial,
          id_sucursal,
          fecha,
          tipo,
          descripcion,
          cerrado,
          hora_inicio,
          hora_final,
          estado
        FROM public.sucursales_fechas_especiales
        WHERE ${filters.join(' AND ')}
        ORDER BY fecha ASC, id_fecha_especial ASC
      `,
      params
    );

    return res.status(200).json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[sucursales] fechas especiales list error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo obtener la configuración de fechas especiales.' });
  }
});

router.post('/sucursales/:id/fechas-especiales', checkPermission(SUCURSALES_HORARIOS_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    if (!idSucursal) {
      return res.status(400).json({ ok: false, message: 'ID de sucursal inválido.' });
    }

    const exists = await ensureSucursalExists(idSucursal);
    if (!exists) {
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const validation = validateFechaEspecialPayload(req.body || {});
    if (!validation.ok) {
      return res.status(validation.status).json({ ok: false, message: validation.message });
    }

    const payload = validation.data;
    const result = await pool.query(
      `
        INSERT INTO public.sucursales_fechas_especiales (
          id_sucursal,
          fecha,
          tipo,
          descripcion,
          cerrado,
          hora_inicio,
          hora_final,
          estado
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id_fecha_especial,
          id_sucursal,
          fecha,
          tipo,
          descripcion,
          cerrado,
          hora_inicio,
          hora_final,
          estado
      `,
      [
        idSucursal,
        payload.fecha,
        payload.tipo,
        payload.descripcion,
        payload.cerrado,
        payload.hora_inicio,
        payload.hora_final,
        payload.estado
      ]
    );

    return res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    if (err?.code === SQLSTATE_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe una configuración especial para esa fecha.' });
    }
    console.error('[sucursales] fechas especiales create error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar la configuración de fecha especial.' });
  }
});

router.put('/sucursales/:id/fechas-especiales/:id_fecha_especial', checkPermission(SUCURSALES_HORARIOS_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    const idFechaEspecial = parsePositiveInt(req.params?.id_fecha_especial);
    if (!idSucursal || !idFechaEspecial) {
      return res.status(400).json({ ok: false, message: 'Parámetros inválidos.' });
    }

    const exists = await ensureSucursalExists(idSucursal);
    if (!exists) {
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const validation = validateFechaEspecialPayload(req.body || {});
    if (!validation.ok) {
      return res.status(validation.status).json({ ok: false, message: validation.message });
    }

    const payload = validation.data;
    const result = await pool.query(
      `
        UPDATE public.sucursales_fechas_especiales
        SET
          fecha = $1,
          tipo = $2,
          descripcion = $3,
          cerrado = $4,
          hora_inicio = $5,
          hora_final = $6,
          estado = $7
        WHERE id_fecha_especial = $8
          AND id_sucursal = $9
        RETURNING
          id_fecha_especial,
          id_sucursal,
          fecha,
          tipo,
          descripcion,
          cerrado,
          hora_inicio,
          hora_final,
          estado
      `,
      [
        payload.fecha,
        payload.tipo,
        payload.descripcion,
        payload.cerrado,
        payload.hora_inicio,
        payload.hora_final,
        payload.estado,
        idFechaEspecial,
        idSucursal
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: 'Fecha especial no encontrada para la sucursal indicada.' });
    }

    return res.status(200).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    if (err?.code === SQLSTATE_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe una configuración especial para esa fecha.' });
    }
    console.error('[sucursales] fechas especiales update error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar la fecha especial.' });
  }
});

router.delete('/sucursales/:id/fechas-especiales/:id_fecha_especial', checkPermission(SUCURSALES_HORARIOS_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const idSucursal = parsePositiveInt(req.params?.id);
    const idFechaEspecial = parsePositiveInt(req.params?.id_fecha_especial);
    if (!idSucursal || !idFechaEspecial) {
      return res.status(400).json({ ok: false, message: 'Parámetros inválidos.' });
    }

    const exists = await ensureSucursalExists(idSucursal);
    if (!exists) {
      return res.status(404).json({ ok: false, message: 'Sucursal no encontrada.' });
    }

    const result = await pool.query(
      `
        UPDATE public.sucursales_fechas_especiales
        SET estado = false
        WHERE id_fecha_especial = $1
          AND id_sucursal = $2
        RETURNING id_fecha_especial
      `,
      [idFechaEspecial, idSucursal]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, message: 'Fecha especial no encontrada para la sucursal indicada.' });
    }

    return res.status(200).json({ ok: true, message: 'Fecha especial desactivada correctamente.' });
  } catch (err) {
    console.error('[sucursales] fechas especiales delete error:', err.message);
    return res.status(500).json({ ok: false, message: 'No se pudo desactivar la fecha especial.' });
  }
});

export default router;
