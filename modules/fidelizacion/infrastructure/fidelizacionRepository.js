import { fidelizacionPool } from './fidelizacionPool.js';
import { registerFacturaLoyaltyAccumulation } from '../../../services/fidelizacionService.js';

// Mismo valor que el antiguo VENTAS_FIDELIZACION_ADVISORY_LOCK_CLASS
// (routers/ventas/constants.js) para preservar el mismo namespace de
// advisory lock de Postgres tras mover esta responsabilidad fuera de Ventas.
export const FIDELIZACION_ACCUMULATION_ADVISORY_LOCK_CLASS = 724201;

// Mismo codigo que PEDIDO_PAGADO_CONFIRMADO_ESTADO_PAGO (routers/ventas/constants.js).
// Duplicado deliberadamente: Fidelizacion no debe depender de constantes internas de Ventas.
const PAGADO_CONFIRMADO_CODIGO = 'PAGADO_CONFIRMADO';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Pool dedicado (max 1), nunca el pool financiero compartido de Ventas/Caja.
export const connectClient = () => fidelizacionPool.connect();

export const lockFacturaForAccumulation = async (client, idFactura) => {
  await client.query(
    'SELECT pg_advisory_xact_lock($1::int, $2::int)',
    [FIDELIZACION_ACCUMULATION_ADVISORY_LOCK_CLASS, idFactura]
  );
};

// Fidelizacion ya no recibe cliente/sucursal/usuario/monto/fecha desde Ventas:
// resuelve todo aqui, a partir de lo que ya quedo persistido por la venta/pago.
// Incluye el estado de pago (para confirmar que la factura esta completamente
// pagada antes de acumular) y la fecha de referencia para la configuracion
// vigente (fecha de pago/facturacion, nunca NOW()).
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
        COALESCE(fc.total_cobrado, 0) AS monto_factura,
        COALESCE(upc.fecha_pago_confirmado, f.fecha_hora_facturacion) AS fecha_referencia_config,
        (upc.id_pedido_pago_control IS NOT NULL) AS tiene_pago_control,
        upc.monto_pendiente AS pago_control_monto_pendiente,
        cep.codigo AS pago_control_estado_codigo
      FROM public.facturas f
      LEFT JOIN public.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN LATERAL (
        SELECT ppc.*
        FROM public.pedidos_pago_control ppc
        WHERE ppc.id_pedido = f.id_pedido
        ORDER BY ppc.id_pedido_pago_control DESC
        LIMIT 1
      ) upc ON TRUE
      LEFT JOIN public.cat_pedidos_estados_pago cep
        ON cep.id_estado_pago_pedido = upc.id_estado_pago_pedido
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

// Regla del requisito 3: antes de acumular hay que confirmar, con datos
// persistidos, que la factura esta completamente pagada.
// - Si el pedido tiene control de pago (flujo de pedido pendiente / pago
//   dividido), exige estado PAGADO_CONFIRMADO y monto_pendiente = 0.
// - Si no tiene control de pago (venta directa), esta pagada por
//   construccion: la transaccion de venta la crea y cobra atomicamente.
export const isFacturaFullyPaid = (context) => {
  if (!context) return false;
  if (!context.tiene_pago_control) return true;

  const estadoCodigo = String(context.pago_control_estado_codigo || '').trim().toUpperCase();
  const montoPendiente = Number(context.pago_control_monto_pendiente ?? NaN);

  return estadoCodigo === PAGADO_CONFIRMADO_CODIGO && montoPendiente === 0;
};

// Unica capa que decide (elegibilidad, config vigente EN LA FECHA, calculo de
// puntos) y persiste (saldo + movimiento). No se duplica ese calculo ni la
// consulta de idempotencia en modules/fidelizacion; ambos viven una sola vez
// dentro de este servicio ya probado.
export const persistAccumulation = ({
  client,
  idFactura,
  idPedido,
  idCliente,
  idSucursal,
  idUsuarioEjecutor,
  montoFactura,
  referenceDate
}) => registerFacturaLoyaltyAccumulation({
  client,
  idFactura,
  idPedido,
  idCliente,
  idSucursal,
  idUsuarioEjecutor,
  montoFactura,
  referenceDate
});

// Para el worker de reconciliacion: facturas que ya quedaron completamente
// pagadas pero que no tienen (todavia) un movimiento de acumulacion. La
// idempotencia real sigue viviendo en persistAccumulation; esto solo detecta
// candidatos para volver a intentar via notifyPaidInvoice.
export const listPaidInvoicesMissingAccumulation = async (client, { limit = 25 } = {}) => {
  const boundedLimit = Math.min(Math.max(parsePositiveInt(limit) || 25, 1), 200);

  const result = await client.query(
    `
      SELECT f.id_factura
      FROM public.facturas f
      LEFT JOIN public.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN LATERAL (
        SELECT ppc.*
        FROM public.pedidos_pago_control ppc
        WHERE ppc.id_pedido = f.id_pedido
        ORDER BY ppc.id_pedido_pago_control DESC
        LIMIT 1
      ) upc ON TRUE
      LEFT JOIN public.cat_pedidos_estados_pago cep
        ON cep.id_estado_pago_pedido = upc.id_estado_pago_pedido
      WHERE COALESCE(p.id_cliente, f.id_cliente) IS NOT NULL
        AND (
          upc.id_pedido_pago_control IS NULL
          OR (
            UPPER(TRIM(cep.codigo)) = $2
            AND COALESCE(upc.monto_pendiente, 0) = 0
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.fidelizacion_movimientos fm
          INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
            ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
          INNER JOIN public.cat_fidelizacion_origenes_movimiento om
            ON om.id_origen_movimiento = fm.id_origen_movimiento
          WHERE fm.id_factura = f.id_factura
            AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
            AND UPPER(TRIM(om.codigo)) = 'FACTURA'
        )
      ORDER BY f.id_factura ASC
      LIMIT $1
    `,
    [boundedLimit, PAGADO_CONFIRMADO_CODIGO]
  );

  return result.rows.map((row) => Number(row.id_factura));
};
