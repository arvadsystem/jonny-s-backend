const SQLSTATE_UNDEFINED_TABLE = '42P01';

export const CATALOGO_MAESTRO_VIEW_MISSING_CODE = 'CATALOGO_MAESTRO_VIEW_MISSING';

export const isCatalogoMaestroReadsEnabled = () =>
  String(process.env.CATALOGO_MAESTRO_READS_ENABLED || '')
    .trim()
    .toLowerCase() !== 'false';

export const collapseCatalogoMaestroRows = (
  rows,
  { masterIdField, publicIdField }
) => {
  const grouped = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const masterId = Number.parseInt(String(row?.[masterIdField] ?? ''), 10);
    if (!Number.isSafeInteger(masterId) || masterId <= 0) continue;

    if (!grouped.has(masterId)) {
      grouped.set(masterId, {
        ...row,
        [publicIdField]: masterId,
        [masterIdField]: masterId,
        id_almacenes: []
      });
    }

    const current = grouped.get(masterId);
    const warehouseId = Number.parseInt(String(row?.id_almacen ?? ''), 10);
    if (Number.isSafeInteger(warehouseId) && warehouseId > 0) {
      current.id_almacenes.push(warehouseId);
    }
  }

  return [...grouped.values()].map((row) => ({
    ...row,
    id_almacenes: [...new Set(row.id_almacenes)].sort((a, b) => a - b)
  }));
};

const buildCatalogoMaestroViewMissingError = (viewName, cause) => {
  const error = new Error(`Vista maestra requerida no disponible: ${viewName}`);
  error.code = CATALOGO_MAESTRO_VIEW_MISSING_CODE;
  error.viewName = viewName;
  error.cause = cause;
  return error;
};

export const queryCatalogoMaestroView = async (db, viewName, sql, params = []) => {
  try {
    return await db.query(sql, Array.isArray(params) ? params : []);
  } catch (error) {
    if (error?.code === SQLSTATE_UNDEFINED_TABLE) {
      throw buildCatalogoMaestroViewMissingError(viewName, error);
    }
    throw error;
  }
};

export const isCatalogoMaestroViewMissingError = (error) =>
  error?.code === CATALOGO_MAESTRO_VIEW_MISSING_CODE;

export const logCatalogoMaestroViewMissing = (context, error) => {
  console.error(`${context}: ${CATALOGO_MAESTRO_VIEW_MISSING_CODE}`, {
    view: error?.viewName || null,
    cause: error?.cause?.message || error?.message || null
  });
};

export const sendCatalogoMaestroViewMissingResponse = (res) =>
  res.status(500).json({
    error: true,
    code: CATALOGO_MAESTRO_VIEW_MISSING_CODE,
    message: 'Catalogo maestro no disponible. Verifica que las vistas maestras esten creadas.'
  });
