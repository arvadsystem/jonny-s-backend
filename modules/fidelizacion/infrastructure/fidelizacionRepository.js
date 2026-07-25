import pool from '../../../config/db-connection.js';
import {
  registerFacturaLoyaltyAccumulation,
  getActiveFidelizacionConfig
} from '../../../services/fidelizacionService.js';

// Mismo valor que el antiguo VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS
// (routers/ventas/constants.js) para preservar el mismo namespace de
// advisory lock de Postgres tras mover esta responsabilidad fuera de Ventas.
export const FIDELIZACION_ACCUMULATION_ADVISORY_LOCK_CLASS = 724201;

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const connectClient = () => pool.connect();

export const lockFacturaForAccumulation = async (client, idFactura) => {
  await client.query(
    'SELECT pg_advisory_xact_lock($1::int, $2::int)',
    [FIDELIZACION_ACCUMULATION_ADVISORY_LOCK_CLASS, idFactura]
  );
};

// Fidelizacion ya no recibe cliente/sucursal/usuario/monto desde Ventas:
// los resuelve aqui, a partir de lo que ya quedo persistido por la venta/pago.
export const getFacturaAccumulationContext = async (client, idFactura) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      SELECT
        f.id_factura,
        f.id_pedido,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(p.id_usuario, f.id_usuario) AS id_usuario,
        COALESCE(p.id_cliente, f.id_cliente) AS id_cliente,
        COALESCE(fc.total_cobrado, 0) AS monto_factura
      FROM public.facturas f
      LEFT JOIN public.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN LATERAL (
        SELECT SUM(monto) AS total_cobrado
        FROM public.facturas_cobros
        WHERE id_factura = f.id_factura
      ) fc ON TRUE
      WHERE f.id_factura = $1
      LIMIT 1
    `,
    [facturaId]
  );

  return result.rows[0] || null;
};

// Lectura de idempotencia previa (mismo criterio que registerFacturaLoyaltyAccumulation)
// para poder reportar ALREADY_REGISTERED sin abrir el resto de la logica de escritura.
export const hasExistingAccumulation = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT fm.id_movimiento
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
        ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om
        ON om.id_origen_movimiento = fm.id_origen_movimiento
      WHERE fm.id_factura = $1
        AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
        AND UPPER(TRIM(om.codigo)) = 'FACTURA'
      LIMIT 1
    `,
    [idFactura]
  );

  return result.rowCount > 0 ? Number(result.rows[0].id_movimiento) : null;
};

export const getActiveConfigForSucursal = (client, idSucursal) =>
  getActiveFidelizacionConfig(client, idSucursal);

// Delega la escritura real (chequeo de elegibilidad, saldo y movimiento) al
// servicio ya probado. No se duplica esa logica en esta fase.
export const persistAccumulation = (params) => registerFacturaLoyaltyAccumulation(params);
