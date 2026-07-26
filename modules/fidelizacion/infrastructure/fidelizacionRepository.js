import { fidelizacionPool } from './fidelizacionPool.js';
import { registerFacturaLoyaltyAccumulation } from '../../../services/fidelizacionService.js';
import {
  ACCUMULATION_STATE,
  ACCUMULATION_TRIGGER,
  LEGACY_ELIGIBILITY_UNVERIFIABLE,
  RETRYABLE_ACCUMULATION_STATES
} from '../domain/accumulationState.js';

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

// Periodo de gracia para RECONCILE: evita la carrera entre el camino LIVE
// (que crea PENDING justo tras el COMMIT de la venta) y la reconciliacion
// (que corre en un tick aparte). Sin esto, reconciliacion podria encontrar
// una factura recien pagada ANTES de que LIVE alcance a crear su fila
// PENDING, y -sin fila- la marcaria terminal (LEGACY_ELIGIBILITY_UNVERIFIABLE)
// de inmediato, perdiendo puntos de una compra legitima y reciente. Mismo
// patron de validacion que jobs/fidelizacionReconciliationScheduler.js
// (parsePositiveIntEnv), pero 0 es un valor valido explicito aqui (grace
// deshabilitada), asi que se usa una variante propia. Se lee en cada
// llamada (nunca cacheado), igual que el resto de la configuracion del
// scheduler.
const DEFAULT_RECONCILE_GRACE_MS = 300000;
const MIN_RECONCILE_GRACE_MS = 0;
const MAX_RECONCILE_GRACE_MS = 3600000;

const parseNonNegativeIntEnv = (value, fallback, min, max) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

export const getFidelizacionReconcileGraceMs = () =>
  parseNonNegativeIntEnv(
    process.env.FIDELIZACION_RECONCILE_GRACE_MS,
    DEFAULT_RECONCILE_GRACE_MS,
    MIN_RECONCILE_GRACE_MS,
    MAX_RECONCILE_GRACE_MS
  );

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
//
// Regla de cuentas divididas: monto_factura es SIEMPRE
// SUM(facturas_cobros.monto) filtrado por ESTA id_factura unicamente. Un
// pedido con cuenta dividida puede tener varias facturas asociadas; cada una
// se resuelve y acumula por separado con su propio monto -nunca se agrega el
// total del pedido completo-, y cada id_factura solo puede generar un
// movimiento (ver el chequeo de idempotencia en registerFacturaLoyaltyAccumulation).
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

// Motivos de negocio (no tecnicos) que puede devolver
// registerFacturaLoyaltyAccumulation cuando NO otorga puntos. Cualquiera de
// estos, la primera vez que se determina, queda grabado como SKIPPED_TERMINAL
// -no existe snapshot historico del perfil del cliente al momento de la
// compra (se reviso facturas/pedidos/tablas de fidelizacion: no hay tal
// columna), asi que esta tabla es el sustituto que impide volver a mirar el
// perfil ACTUAL de un cliente sobre una factura ya resuelta-.
const BUSINESS_SKIP_REASONS = new Set([
  'CLIENT_PROFILE_INCOMPLETE',
  'CONFIG_NOT_FOUND',
  'ACCUMULATION_DISABLED',
  'ACCUMULATION_RULE_NOT_CONFIGURED',
  'POINTS_ROUND_DOWN_TO_ZERO'
]);

// Bloqueante: evitar acumulacion retroactiva cuando no existe estado previo.
// Reserva la fila PENDING para una factura que se sabe recien pagada, ANTES
// de evaluar perfil/switch/tasa/puntos (camino LIVE unicamente -- ver
// persistAccumulation). intentos arranca en 0: esta reserva no es todavia un
// intento real de evaluacion; el primer intento real (mas abajo, via
// upsertAccumulationState) lo sube a 1. ON CONFLICT DO NOTHING: si ya existe
// cualquier fila (de un intento anterior, o de una carrera con otro
// disparador bajo el mismo advisory lock), esta reserva no la toca.
export const ensurePendingAccumulationState = async (client, idFactura, fechaReferencia = null) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_acumulacion_facturas_estado (
        id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia,
        fecha_creacion, fecha_actualizacion, intentos, ultimo_error
      )
      VALUES ($1, 'PENDING', NULL, NULL, $2, NOW(), NOW(), 0, NULL)
      ON CONFLICT (id_factura) DO NOTHING
      RETURNING id_factura, estado, motivo, elegibilidad_determinada, intentos
    `,
    [facturaId, fechaReferencia]
  );

  return result.rows[0] || null;
};

export const getAccumulationState = async (client, idFactura) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      SELECT id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia, intentos
      FROM public.fidelizacion_acumulacion_facturas_estado
      WHERE id_factura = $1
      LIMIT 1
    `,
    [facturaId]
  );

  return result.rows[0] || null;
};

// Un solo upsert para las 3 escrituras posibles (primera determinacion,
// marca de legado sin evaluar perfil, reintento). El WHERE del DO UPDATE
// nunca degrada un estado terminal ya grabado (PROCESSED/SKIPPED_TERMINAL):
// es cinturon-y-tirantes, porque el advisory lock por factura (tomado antes,
// en accumulateInvoicePoints.js) ya serializa a los workers concurrentes
// sobre la misma factura.
export const upsertAccumulationState = async (client, {
  idFactura,
  estado,
  motivo = null,
  elegibilidadDeterminada = null,
  fechaReferencia = null,
  ultimoError = null
}) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_acumulacion_facturas_estado (
        id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia,
        fecha_creacion, fecha_actualizacion, intentos, ultimo_error
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 1, $6)
      ON CONFLICT (id_factura) DO UPDATE SET
        estado = EXCLUDED.estado,
        motivo = EXCLUDED.motivo,
        elegibilidad_determinada = EXCLUDED.elegibilidad_determinada,
        fecha_referencia = COALESCE(EXCLUDED.fecha_referencia, public.fidelizacion_acumulacion_facturas_estado.fecha_referencia),
        fecha_actualizacion = NOW(),
        intentos = public.fidelizacion_acumulacion_facturas_estado.intentos + 1,
        ultimo_error = EXCLUDED.ultimo_error
      WHERE public.fidelizacion_acumulacion_facturas_estado.estado IN ('PENDING', 'RETRYABLE_ERROR')
      RETURNING id_factura, estado, motivo, elegibilidad_determinada, intentos
    `,
    [facturaId, estado, motivo, elegibilidadDeterminada, fechaReferencia, ultimoError]
  );

  return result.rows[0] || null;
};

// Best-effort: se llama desde el catch() de accumulateInvoicePoints, despues
// de que su propia transaccion ya hizo ROLLBACK. Nunca lanza -una falla
// guardando el estado de fidelizacion no debe alterar el resultado ya
// decidido ({created:false, reason:'ERROR'}), y muchisimo menos el 201 de la
// venta, que ya se respondio antes de que cualquiera de esto se ejecute-.
export const recordAccumulationRetryableError = async (client, idFactura, { fechaReferencia = null, error = null } = {}) => {
  try {
    await upsertAccumulationState(client, {
      idFactura,
      estado: ACCUMULATION_STATE.RETRYABLE_ERROR,
      motivo: null,
      elegibilidadDeterminada: null,
      fechaReferencia,
      ultimoError: String(error?.message || error || 'FIDELIZACION_ACCUMULATE_ERROR').slice(0, 500)
    });
  } catch (recordErr) {
    console.error('[fidelizacion:accumulate] error al registrar estado reintentable:', {
      id_factura: idFactura || null,
      code: recordErr?.code || recordErr?.name || 'FIDELIZACION_STATE_RECORD_ERROR'
    });
  }
};

// Unica capa que decide (elegibilidad, config vigente EN LA FECHA, calculo de
// puntos) y persiste (saldo + movimiento). No se duplica ese calculo ni la
// consulta de idempotencia en modules/fidelizacion; ambos viven una sola vez
// dentro de este servicio ya probado.
//
// Gate de idempotencia por estado (ver domain/accumulationState.js): la
// PRIMERA vez que CUALQUIER disparador determina la elegibilidad de una
// factura, el resultado queda grabado y es definitivo para razones de
// negocio (SKIPPED_TERMINAL); solo los errores tecnicos se reintentan. Esto
// es lo que impide que completar el perfil del cliente reabra una factura
// antigua que ya fue evaluada y rechazada.
//
// trigger distingue el camino inmediato (LIVE, justo tras el COMMIT de la
// venta -perfil actual = perfil al momento de la compra, confiable-) del de
// reconciliacion (RECONCILE, asincrono -no puede garantizar que el perfil
// actual sea el de la compra-). Solo afecta el MOTIVO persistido cuando el
// rechazo es por perfil incompleto: el resto de motivos (config/tasa/redondeo)
// ya son time-accurate porque getActiveFidelizacionConfig siempre usa la
// referenceDate historica de la factura, nunca "ahora".
export const persistAccumulation = async ({
  client,
  idFactura,
  idPedido,
  idCliente,
  idSucursal,
  idUsuarioEjecutor,
  montoFactura,
  referenceDate,
  trigger = ACCUMULATION_TRIGGER.LIVE
}) => {
  const existingState = await getAccumulationState(client, idFactura);

  if (existingState && !RETRYABLE_ACCUMULATION_STATES.includes(existingState.estado)) {
    // PROCESSED o SKIPPED_TERMINAL: ya fue determinado, nunca se vuelve a
    // mirar el perfil/config/tasa.
    return existingState.estado === ACCUMULATION_STATE.PROCESSED
      ? { created: false, reason: 'ALREADY_REGISTERED' }
      : { created: false, reason: existingState.motivo };
  }

  if (!existingState) {
    if (trigger === ACCUMULATION_TRIGGER.RECONCILE) {
      // Reconciliacion nunca es la primera en evaluar una factura: si no
      // existe fila, no se consulta perfil actual, ni config, ni puntos --
      // se registra terminal de inmediato como no verificable (no se puede
      // garantizar que el perfil actual sea el de la compra).
      await upsertAccumulationState(client, {
        idFactura,
        estado: ACCUMULATION_STATE.SKIPPED_TERMINAL,
        motivo: LEGACY_ELIGIBILITY_UNVERIFIABLE,
        elegibilidadDeterminada: false,
        fechaReferencia: referenceDate
      });
      return { created: false, reason: LEGACY_ELIGIBILITY_UNVERIFIABLE };
    }

    // Camino LIVE: reserva PENDING antes de evaluar perfil/switch/tasa/puntos.
    await ensurePendingAccumulationState(client, idFactura, referenceDate);
  }

  const result = await registerFacturaLoyaltyAccumulation({
    client,
    idFactura,
    idPedido,
    idCliente,
    idSucursal,
    idUsuarioEjecutor,
    montoFactura,
    referenceDate
  });

  if (result.created || result.reason === 'ALREADY_REGISTERED') {
    await upsertAccumulationState(client, {
      idFactura,
      estado: ACCUMULATION_STATE.PROCESSED,
      motivo: result.created ? null : 'ALREADY_REGISTERED',
      elegibilidadDeterminada: Boolean(result.created),
      fechaReferencia: referenceDate
    });
    return result;
  }

  if (BUSINESS_SKIP_REASONS.has(result.reason)) {
    const persistedMotivo = trigger === ACCUMULATION_TRIGGER.RECONCILE && result.reason === 'CLIENT_PROFILE_INCOMPLETE'
      ? LEGACY_ELIGIBILITY_UNVERIFIABLE
      : result.reason;

    await upsertAccumulationState(client, {
      idFactura,
      estado: ACCUMULATION_STATE.SKIPPED_TERMINAL,
      motivo: persistedMotivo,
      elegibilidadDeterminada: false,
      fechaReferencia: referenceDate
    });

    return { ...result, reason: persistedMotivo };
  }

  // MISSING_REQUIRED_DATA u otro motivo no mapeado: no se toca la tabla de
  // estado (misma precondicion que INVOICE_NOT_FULLY_PAID, resuelta antes de
  // llegar aqui; puede cambiar, no es una regla de negocio terminal).
  return result;
};

// Para el worker de reconciliacion: facturas que ya quedaron completamente
// pagadas pero que no tienen (todavia) un movimiento de acumulacion. La
// idempotencia real sigue viviendo en persistAccumulation; esto solo detecta
// candidatos para volver a intentar via notifyPaidInvoice.
//
// Paginacion por keyset (id_factura > cursor) para que un backlog grande no
// haga que cada tick vea siempre las mismas primeras facturas.
//
// Ya NO filtra por perfil de cliente actual ni por configuracion vigente:
// esos dos filtros (antes en esta misma consulta) eran la causa raiz de la
// acumulacion retroactiva -evaluaban el perfil/config ACTUAL en vez del
// vigente al momento de la compra-. La prevencion de inanicion (que una
// factura permanentemente no procesable no reaparezca en cada lote para
// siempre) ahora la hace la tabla de estado: persistAccumulation evalua cada
// candidato UNA sola vez con la logica real (registerFacturaLoyaltyAccumulation,
// que si usa la config vigente EN LA FECHA de la factura) y graba el
// resultado como terminal; esta consulta excluye lo que ya quedo terminal.
export const listPaidInvoicesMissingAccumulation = async (client, { cursor = 0, limit = 25 } = {}) => {
  const boundedLimit = Math.min(Math.max(parsePositiveInt(limit) || 25, 1), 200);
  const boundedCursor = Number.isFinite(Number(cursor)) && Number(cursor) >= 0 ? Number(cursor) : 0;
  const graceMs = getFidelizacionReconcileGraceMs();

  const result = await client.query(
    `
      SELECT
        f.id_factura,
        COALESCE(upc.fecha_pago_confirmado, f.fecha_hora_facturacion) AS fecha_referencia_config,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal
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
      LEFT JOIN public.fidelizacion_acumulacion_facturas_estado est
        ON est.id_factura = f.id_factura
      WHERE f.id_factura > $1
        AND COALESCE(p.id_cliente, f.id_cliente) IS NOT NULL
        AND (
          upc.id_pedido_pago_control IS NULL
          OR (
            UPPER(TRIM(cep.codigo)) = $3
            AND COALESCE(upc.monto_pendiente, 0) = 0
          )
        )
        -- Nunca reintentar un estado terminal (PROCESSED/SKIPPED_TERMINAL):
        -- solo candidatos nuevos (sin fila) o en estado reintentable.
        AND (est.id_factura IS NULL OR est.estado IN ('PENDING', 'RETRYABLE_ERROR'))
        -- Periodo de gracia: solo facturas cuya fecha de pago/facturacion ya
        -- paso hace al menos $4 ms. Evita la carrera con el camino LIVE, que
        -- todavia no tuvo tiempo de crear su fila PENDING para una factura
        -- pagada hace unos instantes.
        AND COALESCE(upc.fecha_pago_confirmado, f.fecha_hora_facturacion)
          <= NOW() - make_interval(secs => $4::double precision / 1000)
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
      LIMIT $2
    `,
    [boundedCursor, boundedLimit, PAGADO_CONFIRMADO_CODIGO, graceMs]
  );

  const ids = result.rows.map((row) => Number(row.id_factura));
  return {
    ids,
    nextCursor: ids.length > 0 ? ids[ids.length - 1] : boundedCursor
  };
};
