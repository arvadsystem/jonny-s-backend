import {
  ESTADO_PEDIDO_CODES
} from '../constants.js';
import {
  normalizeTextKey,
  parseOptionalPositiveInt
} from '../utils/parseUtils.js';

export const resolveSucursalId = async (client, requestedId) => {
  if (!requestedId) return null;

  const result = await client.query(
    'SELECT id_sucursal FROM sucursales WHERE id_sucursal = $1 AND COALESCE(estado, true) = true LIMIT 1',
    [requestedId]
  );
  return result.rowCount > 0 ? requestedId : null;
};

export const resolveMetodoPago = async (client, metodoPagoRaw) => {
  const normalizedInput = String(metodoPagoRaw ?? '').trim();
  if (!normalizedInput) return null;

  const result = await client.query(
    `
      SELECT
        id_metodo_pago,
        codigo,
        nombre,
        COALESCE(afecta_efectivo, false) AS afecta_efectivo
      FROM cat_metodos_pago
      WHERE COALESCE(estado, true) = true
        AND (
          UPPER(TRIM(codigo)) = UPPER($1)
          OR LOWER(TRIM(nombre)) = LOWER($1)
        )
      LIMIT 1
    `,
    [normalizedInput]
  );

  return result.rows[0] || null;
};

export const fetchEstadoPedidoRows = async (client) => {
  const result = await client.query(
    'SELECT id_estado_pedido, descripcion FROM estados_pedido ORDER BY id_estado_pedido'
  );
  return result.rows;
};

export const resolveEstadoPedidoIdByCode = async (client, code) => {
  const aliases = ESTADO_PEDIDO_CODES[code];
  if (!aliases || aliases.size === 0) return null;

  const rows = await fetchEstadoPedidoRows(client);
  const match = rows.find((row) => aliases.has(normalizeTextKey(row.descripcion)));
  return match?.id_estado_pedido ?? null;
};

export const resolveRequestedEstadoPedidoId = async (client, requestedId) => {
  if (!requestedId) return null;

  const result = await client.query(
    'SELECT id_estado_pedido FROM estados_pedido WHERE id_estado_pedido = $1 LIMIT 1',
    [requestedId]
  );

  return result.rowCount > 0 ? requestedId : null;
};

export const resolveActiveCatalogCode = async ({ client, tableName, idColumn, code }) => {
  const result = await client.query(
    '\n      SELECT ' + idColumn + ' AS id, codigo\n      FROM public.' + tableName + '\n      WHERE UPPER(TRIM(codigo)) = $1\n        AND COALESCE(estado, true) = true\n      LIMIT 1\n    ',
    [code]
  );
  const row = result.rows?.[0];
  return row ? { id: Number(row.id), codigo: String(row.codigo || code).trim().toUpperCase() } : null;
};

export const resolveMetodoPagoRegistroPedido = async (client, { idMetodoPago, metodoPagoRaw }) => {
  const parsedId = parseOptionalPositiveInt(idMetodoPago);
  if (idMetodoPago !== undefined && idMetodoPago !== null && !parsedId) return null;

  if (parsedId) {
    const result = await client.query(
      `
        SELECT
          id_metodo_pago,
          codigo,
          nombre,
          COALESCE(afecta_efectivo, false) AS afecta_efectivo
        FROM cat_metodos_pago
        WHERE id_metodo_pago = $1
          AND COALESCE(estado, true) = true
        LIMIT 1
      `,
      [parsedId]
    );
    return result.rows?.[0] || null;
  }

  return resolveMetodoPago(client, metodoPagoRaw);
};
