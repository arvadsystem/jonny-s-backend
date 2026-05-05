import pool from '../config/db-connection.js';

class ServiceError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.details = details;
  }
}

const ESTADO_ACTIVO = 'ACTIVO';
const ESTADO_INACTIVO = 'INACTIVO';

const asPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toDateStringTegucigalpa = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Tegucigalpa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
};

const isValidIsoDate = (value) => {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const dt = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === raw;
};

const sanitizeRango = (row) => ({
  id_rango_cai: Number(row?.id_rango_cai ?? 0) || null,
  id_sucursal: Number(row?.id_sucursal ?? 0) || null,
  cai: row?.cai ?? null,
  numero_desde: Number(row?.numero_desde ?? 0) || 0,
  numero_hasta: Number(row?.numero_hasta ?? 0) || 0,
  numero_actual: Number(row?.numero_actual ?? 0) || 0,
  fecha_limite_emision: row?.fecha_limite_emision ?? null,
  estado: row?.estado ?? ESTADO_INACTIVO,
  observacion: row?.observacion ?? null,
  creado_por: row?.creado_por ?? null,
  creado_en: row?.creado_en ?? null,
  actualizado_en: row?.actualizado_en ?? null
});

const ensureSucursalExists = async (idSucursal, db = pool) => {
  const result = await db.query(
    'SELECT 1 FROM public.sucursales WHERE id_sucursal = $1 LIMIT 1',
    [idSucursal]
  );
  if (result.rowCount === 0) {
    throw new ServiceError('La sucursal indicada no existe.', 404);
  }
};

const ensureRangoBelongsToSucursal = async (idSucursal, idRango, db = pool) => {
  const result = await db.query(
    `
      SELECT
        id_rango_cai,
        id_sucursal,
        cai,
        numero_desde,
        numero_hasta,
        numero_actual,
        fecha_limite_emision,
        estado,
        observacion,
        creado_por,
        creado_en,
        actualizado_en
      FROM public.facturacion_rangos_cai
      WHERE id_rango_cai = $1
        AND id_sucursal = $2
      LIMIT 1
    `,
    [idRango, idSucursal]
  );
  if (result.rowCount === 0) {
    throw new ServiceError('El rango CAI no existe para la sucursal indicada.', 404);
  }
  return result.rows[0];
};

export const listarRangosCaiPorSucursal = async (idSucursal) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) throw new ServiceError('ID de sucursal invalido.', 400);

  await ensureSucursalExists(idSucursalNum);
  const result = await pool.query(
    `
      SELECT
        id_rango_cai,
        id_sucursal,
        cai,
        numero_desde,
        numero_hasta,
        numero_actual,
        fecha_limite_emision,
        estado,
        observacion,
        creado_por,
        creado_en,
        actualizado_en
      FROM public.facturacion_rangos_cai
      WHERE id_sucursal = $1
      ORDER BY creado_en DESC, id_rango_cai DESC
    `,
    [idSucursalNum]
  );

  return result.rows.map(sanitizeRango);
};

export const crearRangoCaiSucursal = async (idSucursal, payload = {}, actorUserId = null) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  if (!idSucursalNum) throw new ServiceError('ID de sucursal invalido.', 400);

  const cai = trimOrNull(payload?.cai);
  const numeroDesde = Number.parseInt(String(payload?.numero_desde ?? ''), 10);
  const numeroHasta = Number.parseInt(String(payload?.numero_hasta ?? ''), 10);
  const fechaLimite = trimOrNull(payload?.fecha_limite_emision);
  const observacion = trimOrNull(payload?.observacion);

  const errors = [];
  if (!cai) errors.push({ field: 'cai', message: 'El CAI es requerido.' });
  if (!Number.isInteger(numeroDesde) || numeroDesde <= 0) {
    errors.push({ field: 'numero_desde', message: 'numero_desde debe ser un entero positivo.' });
  }
  if (!Number.isInteger(numeroHasta) || numeroHasta <= 0) {
    errors.push({ field: 'numero_hasta', message: 'numero_hasta debe ser un entero positivo.' });
  }
  if (Number.isInteger(numeroDesde) && Number.isInteger(numeroHasta) && numeroHasta < numeroDesde) {
    errors.push({ field: 'numero_hasta', message: 'numero_hasta debe ser mayor o igual a numero_desde.' });
  }
  if (!fechaLimite || !isValidIsoDate(fechaLimite)) {
    errors.push({ field: 'fecha_limite_emision', message: 'fecha_limite_emision es requerida y debe tener formato YYYY-MM-DD.' });
  } else if (fechaLimite < toDateStringTegucigalpa()) {
    errors.push({ field: 'fecha_limite_emision', message: 'fecha_limite_emision no puede estar vencida.' });
  }
  if (observacion && observacion.length > 250) {
    errors.push({ field: 'observacion', message: 'observacion excede 250 caracteres.' });
  }
  if (errors.length > 0) throw new ServiceError('Datos invalidos para el rango CAI.', 400, errors);

  const createdBy = asPositiveInt(actorUserId);
  await ensureSucursalExists(idSucursalNum);

  const duplicate = await pool.query(
    `
      SELECT 1
      FROM public.facturacion_rangos_cai
      WHERE id_sucursal = $1
        AND cai = $2
        AND numero_desde = $3
        AND numero_hasta = $4
      LIMIT 1
    `,
    [idSucursalNum, cai, numeroDesde, numeroHasta]
  );
  if (duplicate.rowCount > 0) {
    throw new ServiceError('Ya existe un rango CAI con los mismos datos para esta sucursal.', 409);
  }

  const result = await pool.query(
    `
      INSERT INTO public.facturacion_rangos_cai (
        id_sucursal,
        cai,
        numero_desde,
        numero_hasta,
        numero_actual,
        fecha_limite_emision,
        estado,
        observacion,
        creado_por
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING
        id_rango_cai,
        id_sucursal,
        cai,
        numero_desde,
        numero_hasta,
        numero_actual,
        fecha_limite_emision,
        estado,
        observacion,
        creado_por,
        creado_en,
        actualizado_en
    `,
    [
      idSucursalNum,
      cai,
      numeroDesde,
      numeroHasta,
      numeroDesde - 1,
      fechaLimite,
      ESTADO_INACTIVO,
      observacion,
      createdBy
    ]
  );

  return sanitizeRango(result.rows[0]);
};

export const activarRangoCaiSucursal = async (idSucursal, idRango) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  const idRangoNum = asPositiveInt(idRango);
  if (!idSucursalNum || !idRangoNum) throw new ServiceError('Parametros invalidos.', 400);

  const client = await pool.connect();
  let txOpen = false;
  try {
    await client.query('BEGIN');
    txOpen = true;

    await ensureSucursalExists(idSucursalNum, client);
    const target = await ensureRangoBelongsToSucursal(idSucursalNum, idRangoNum, client);
    const fechaLimite = String(target?.fecha_limite_emision || '');
    if (!fechaLimite || !isValidIsoDate(fechaLimite) || fechaLimite < toDateStringTegucigalpa()) {
      throw new ServiceError('No se puede activar un rango CAI vencido.', 400);
    }

    const numeroActual = Number(target?.numero_actual ?? target?.numero_desde ?? 0);
    const numeroHasta = Number(target?.numero_hasta ?? 0);
    if (!Number.isFinite(numeroActual) || !Number.isFinite(numeroHasta) || numeroActual >= numeroHasta) {
      throw new ServiceError('No se puede activar un rango CAI agotado.', 400);
    }

    await client.query(
      `
        UPDATE public.facturacion_rangos_cai
        SET
          estado = $1,
          actualizado_en = timezone('America/Tegucigalpa', now())
        WHERE id_sucursal = $2
          AND estado = $3
      `,
      [ESTADO_INACTIVO, idSucursalNum, ESTADO_ACTIVO]
    );

    const updated = await client.query(
      `
        UPDATE public.facturacion_rangos_cai
        SET
          estado = $1,
          actualizado_en = timezone('America/Tegucigalpa', now())
        WHERE id_rango_cai = $2
          AND id_sucursal = $3
        RETURNING
          id_rango_cai,
          id_sucursal,
          cai,
          numero_desde,
          numero_hasta,
          numero_actual,
          fecha_limite_emision,
          estado,
          observacion,
          creado_por,
          creado_en,
          actualizado_en
      `,
      [ESTADO_ACTIVO, idRangoNum, idSucursalNum]
    );

    await client.query('COMMIT');
    txOpen = false;
    return sanitizeRango(updated.rows[0]);
  } catch (err) {
    if (txOpen) {
      try { await client.query('ROLLBACK'); } catch {}
    }
    throw err;
  } finally {
    client.release();
  }
};

export const desactivarRangoCaiSucursal = async (idSucursal, idRango) => {
  const idSucursalNum = asPositiveInt(idSucursal);
  const idRangoNum = asPositiveInt(idRango);
  if (!idSucursalNum || !idRangoNum) throw new ServiceError('Parametros invalidos.', 400);

  await ensureSucursalExists(idSucursalNum);
  await ensureRangoBelongsToSucursal(idSucursalNum, idRangoNum);

  const result = await pool.query(
    `
      UPDATE public.facturacion_rangos_cai
      SET
        estado = $1,
        actualizado_en = timezone('America/Tegucigalpa', now())
      WHERE id_rango_cai = $2
        AND id_sucursal = $3
      RETURNING
        id_rango_cai,
        id_sucursal,
        cai,
        numero_desde,
        numero_hasta,
        numero_actual,
        fecha_limite_emision,
        estado,
        observacion,
        creado_por,
        creado_en,
        actualizado_en
    `,
    [ESTADO_INACTIVO, idRangoNum, idSucursalNum]
  );

  return sanitizeRango(result.rows[0]);
};

export const FacturacionCaiSucursalService = Object.freeze({
  ServiceError,
  listarRangosCaiPorSucursal,
  crearRangoCaiSucursal,
  activarRangoCaiSucursal,
  desactivarRangoCaiSucursal
});
