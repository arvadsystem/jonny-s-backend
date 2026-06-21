import pool from '../config/db-connection.js';

const VALID_TIPOS = ['FACTURA', 'COCINA'];
const VALID_TIPOS_SET = new Set(VALID_TIPOS);
const VALID_WIDTHS = new Set([58, 80]);
const VALID_PRINT_MODES = ['BROWSER', 'QZ_HTML', 'QZ_RAW'];
const VALID_PRINT_MODES_SET = new Set(VALID_PRINT_MODES);
const DEFAULT_PRINT_MODE = 'BROWSER';
const DEFAULT_PRINT_PORT = 9100;
const DEFAULT_LOGICAL_NAMES = Object.freeze({
  FACTURA: 'FACTURA',
  COCINA: 'COCINA'
});

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
  return normalized ? normalized : null;
};

const trimUpperOrNull = (value) => {
  const normalized = trimOrNull(value);
  return normalized ? normalized.toUpperCase() : null;
};

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value ?? '').toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value ?? '').toLowerCase() === 'false') return false;
  return null;
};

const ensureSucursalExists = async (idSucursal, db = pool) => {
  const result = await db.query(
    `
      SELECT id_sucursal
      FROM public.sucursales
      WHERE id_sucursal = $1
      LIMIT 1
    `,
    [idSucursal]
  );

  if (result.rowCount === 0) {
    throw new ServiceError('La sucursal indicada no existe.', 404);
  }
};

const sanitizePrinterRow = (row = {}) => ({
  id_impresora: Number(row?.id_impresora ?? 0) || null,
  id_sucursal: Number(row?.id_sucursal ?? 0) || null,
  id_caja: Number(row?.id_caja ?? 0) || null,
  tipo_impresora: String(row?.tipo_impresora || '').trim().toUpperCase(),
  nombre_logico: String(row?.nombre_logico || '').trim() || null,
  nombre_impresora_sistema: trimOrNull(row?.nombre_impresora_sistema),
  ip_impresora: trimOrNull(row?.ip_impresora),
  puerto_impresora: Number(row?.puerto_impresora ?? 0) || DEFAULT_PRINT_PORT,
  ancho_mm: Number(row?.ancho_mm ?? 0) || 80,
  modo_impresion: VALID_PRINT_MODES_SET.has(String(row?.modo_impresion || '').trim().toUpperCase())
    ? String(row.modo_impresion).trim().toUpperCase()
    : DEFAULT_PRINT_MODE,
  activa: row?.activa !== false,
  updated_at: row?.updated_at || row?.updatedAt || null
});

const buildDefaultPrinter = (idSucursal, tipo) => ({
  id_impresora: null,
  id_sucursal: idSucursal,
  id_caja: null,
  tipo_impresora: tipo,
  nombre_logico: DEFAULT_LOGICAL_NAMES[tipo],
  nombre_impresora_sistema: null,
  ip_impresora: null,
  puerto_impresora: DEFAULT_PRINT_PORT,
  ancho_mm: 80,
  modo_impresion: DEFAULT_PRINT_MODE,
  activa: true,
  updated_at: null
});

const mergePrinterRows = (idSucursal, rows = []) => {
  const byType = new Map(
    rows
      .map((row) => sanitizePrinterRow(row))
      .filter((row) => VALID_TIPOS_SET.has(row.tipo_impresora))
      .map((row) => [row.tipo_impresora, row])
  );

  return VALID_TIPOS.map((tipo) => byType.get(tipo) || buildDefaultPrinter(idSucursal, tipo));
};

const getPrinterRowsBySucursal = async (idSucursal, db = pool) => {
  const result = await db.query(
    `
      SELECT DISTINCT ON (tipo_impresora)
        id_impresora,
        id_sucursal,
        id_caja,
        tipo_impresora,
        nombre_logico,
        nombre_impresora_sistema,
        ip_impresora,
        puerto_impresora,
        ancho_mm,
        modo_impresion,
        activa,
        updated_at
      FROM public.configuracion_impresoras
      WHERE id_sucursal = $1
        AND id_caja IS NULL
        AND tipo_impresora = ANY($2::text[])
      ORDER BY tipo_impresora ASC, activa DESC, updated_at DESC, id_impresora DESC
    `,
    [idSucursal, VALID_TIPOS]
  );

  return mergePrinterRows(idSucursal, result.rows);
};

const validatePayload = (payload = {}) => {
  const incoming = Array.isArray(payload?.impresoras) ? payload.impresoras : [];
  const errors = [];
  const mergedByType = new Map();

  for (const tipo of VALID_TIPOS) {
    mergedByType.set(tipo, {});
  }

  for (const rawItem of incoming) {
    const tipo = String(rawItem?.tipo_impresora || '').trim().toUpperCase();
    if (!VALID_TIPOS_SET.has(tipo)) {
      errors.push({ field: 'tipo_impresora', message: 'tipo_impresora es invalido.' });
      continue;
    }
    if (mergedByType.get(tipo)?.__provided) {
      errors.push({ field: `impresoras.${tipo}`, message: `No repitas la impresora ${tipo}.` });
      continue;
    }

    const ancho = Number.parseInt(String(rawItem?.ancho_mm ?? ''), 10);
    const activa = normalizeBoolean(rawItem?.activa);
    const nombre = trimOrNull(rawItem?.nombre_impresora_sistema);
    const ip = trimOrNull(rawItem?.ip_impresora);
    const puerto = Number.parseInt(String(rawItem?.puerto_impresora ?? DEFAULT_PRINT_PORT), 10);
    const modo = trimUpperOrNull(rawItem?.modo_impresion) || DEFAULT_PRINT_MODE;

    if (!VALID_WIDTHS.has(ancho)) {
      errors.push({ field: `impresoras.${tipo}.ancho_mm`, message: 'ancho_mm debe ser 58 u 80.' });
    }
    if (!VALID_PRINT_MODES_SET.has(modo)) {
      errors.push({
        field: `impresoras.${tipo}.modo_impresion`,
        message: 'modo_impresion debe ser BROWSER, QZ_HTML o QZ_RAW.'
      });
    }
    if (activa === null) {
      errors.push({ field: `impresoras.${tipo}.activa`, message: 'activa debe ser boolean.' });
    }
    if (nombre && nombre.length > 160) {
      errors.push({
        field: `impresoras.${tipo}.nombre_impresora_sistema`,
        message: 'nombre_impresora_sistema excede 160 caracteres.'
      });
    }
    if (ip && ip.length > 120) {
      errors.push({
        field: `impresoras.${tipo}.ip_impresora`,
        message: 'ip_impresora excede 120 caracteres.'
      });
    }
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
      errors.push({
        field: `impresoras.${tipo}.puerto_impresora`,
        message: 'puerto_impresora debe ser un entero entre 1 y 65535.'
      });
    }

    mergedByType.set(tipo, {
      __provided: true,
      tipo_impresora: tipo,
      nombre_impresora_sistema: nombre,
      ip_impresora: ip,
      puerto_impresora: puerto,
      ancho_mm: ancho,
      modo_impresion: modo,
      activa
    });
  }

  if (errors.length > 0) {
    throw new ServiceError('Datos invalidos para la configuracion de impresoras.', 400, errors);
  }

  return VALID_TIPOS.map((tipo) => ({
    tipo_impresora: tipo,
    nombre_impresora_sistema: mergedByType.get(tipo)?.nombre_impresora_sistema ?? null,
    ip_impresora: mergedByType.get(tipo)?.ip_impresora ?? null,
    puerto_impresora: mergedByType.get(tipo)?.puerto_impresora ?? DEFAULT_PRINT_PORT,
    ancho_mm: mergedByType.get(tipo)?.ancho_mm ?? 80,
    modo_impresion: mergedByType.get(tipo)?.modo_impresion ?? DEFAULT_PRINT_MODE,
    activa: mergedByType.get(tipo)?.activa ?? true
  }));
};

export const obtenerConfiguracionImpresorasPorSucursal = async (idSucursal) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es invalido.', 400);
  }

  await ensureSucursalExists(idSucursalNum);
  const impresoras = await getPrinterRowsBySucursal(idSucursalNum);

  return {
    id_sucursal: idSucursalNum,
    impresoras
  };
};

export const obtenerConfiguracionImpresorasRuntime = async ({
  idSucursal,
  idCaja = null,
  db = pool
}) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  const idCajaNum = asPositiveInt(idCaja);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es invalido.', 400);
  }

  await ensureSucursalExists(idSucursalNum, db);

  const result = await db.query(
    `
      SELECT DISTINCT ON (tipo_impresora)
        id_impresora,
        id_sucursal,
        id_caja,
        tipo_impresora,
        nombre_logico,
        nombre_impresora_sistema,
        ip_impresora,
        puerto_impresora,
        ancho_mm,
        modo_impresion,
        activa,
        updated_at
      FROM public.configuracion_impresoras
      WHERE id_sucursal = $1
        AND tipo_impresora = ANY($2::text[])
        AND (
          id_caja IS NULL
          OR ($3::int IS NOT NULL AND id_caja = $3)
        )
      ORDER BY
        tipo_impresora ASC,
        CASE WHEN $3::int IS NOT NULL AND id_caja = $3 THEN 0 ELSE 1 END ASC,
        activa DESC,
        updated_at DESC,
        id_impresora DESC
    `,
    [idSucursalNum, VALID_TIPOS, idCajaNum]
  );

  return {
    id_sucursal: idSucursalNum,
    id_caja: idCajaNum,
    impresoras: mergePrinterRows(idSucursalNum, result.rows)
  };
};

export const actualizarConfiguracionImpresorasPorSucursal = async (idSucursal, payload = {}) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) {
    throw new ServiceError('El idSucursal es invalido.', 400);
  }

  const normalizedPayload = validatePayload(payload);
  const client = await pool.connect();
  let txOpen = false;

  try {
    await client.query('BEGIN');
    txOpen = true;

    await ensureSucursalExists(idSucursalNum, client);

    for (const item of normalizedPayload) {
      const currentResult = await client.query(
        `
          SELECT id_impresora, nombre_logico
          FROM public.configuracion_impresoras
          WHERE id_sucursal = $1
            AND id_caja IS NULL
            AND tipo_impresora = $2
          ORDER BY activa DESC, updated_at DESC, id_impresora DESC
          LIMIT 1
          FOR UPDATE
        `,
        [idSucursalNum, item.tipo_impresora]
      );

      const nombreLogico = currentResult.rows?.[0]?.nombre_logico || DEFAULT_LOGICAL_NAMES[item.tipo_impresora];

      if (currentResult.rowCount > 0) {
        await client.query(
          `
            UPDATE public.configuracion_impresoras
            SET
              nombre_logico = $1,
              nombre_impresora_sistema = $2,
              ip_impresora = $3,
              puerto_impresora = $4,
              ancho_mm = $5,
              modo_impresion = $6,
              activa = $7,
              updated_at = now()
            WHERE id_impresora = $8
          `,
          [
            nombreLogico,
            item.nombre_impresora_sistema,
            item.ip_impresora,
            item.puerto_impresora,
            item.ancho_mm,
            item.modo_impresion,
            item.activa,
            currentResult.rows[0].id_impresora
          ]
        );
      } else {
        await client.query(
          `
            INSERT INTO public.configuracion_impresoras (
              id_sucursal,
              id_caja,
              tipo_impresora,
              nombre_logico,
              nombre_impresora_sistema,
              ip_impresora,
              puerto_impresora,
              ancho_mm,
              modo_impresion,
              activa
            )
            VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            idSucursalNum,
            item.tipo_impresora,
            nombreLogico,
            item.nombre_impresora_sistema,
            item.ip_impresora,
            item.puerto_impresora,
            item.ancho_mm,
            item.modo_impresion,
            item.activa
          ]
        );
      }
    }

    const impresoras = await getPrinterRowsBySucursal(idSucursalNum, client);

    await client.query('COMMIT');
    txOpen = false;

    return {
      id_sucursal: idSucursalNum,
      impresoras
    };
  } catch (error) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    client.release();
  }
};

export const ImpresorasConfigSucursalService = Object.freeze({
  ServiceError,
  obtenerConfiguracionImpresorasPorSucursal,
  obtenerConfiguracionImpresorasRuntime,
  actualizarConfiguracionImpresorasPorSucursal
});
