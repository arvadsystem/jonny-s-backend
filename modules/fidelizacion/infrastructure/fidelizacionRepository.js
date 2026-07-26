import { fidelizacionPool } from './fidelizacionPool.js';
import { registerFacturaLoyaltyAccumulation } from '../../../services/fidelizacionService.js';
import { normalizePhoneHN } from '../../../utils/security/personasHardening.js';
import { PEDIDO_ORIGIN, resolvePedidoOrigin } from '../../../utils/pedidoOrigen.js';
import {
  ACCUMULATION_STATE,
  ACCUMULATION_TRIGGER,
  ACCUMULATION_CONTEXT_MISMATCH,
  LEGACY_ELIGIBILITY_UNVERIFIABLE,
  RETRYABLE_ACCUMULATION_STATES
} from '../domain/accumulationState.js';
import { resolveEffectiveAccumulationContext } from '../domain/resolveEffectiveAccumulationContext.js';

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
//
// Precedencia de cliente: COALESCE(f.id_cliente, p.id_cliente) -la factura
// gana, el dueno del pedido es solo el fallback-. En una cuenta dividida la
// factura puede facturarse a un cliente distinto de quien hizo el pedido;
// fidelizacion es por factura, asi que el cliente de la FACTURA es siempre
// el efectivo. (id_sucursal/id_usuario si usan pedido primero: son contexto
// operativo, no el cliente facturado, y no forman parte de este bug.)
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
        COALESCE(f.id_cliente, p.id_cliente) AS id_cliente,
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

// ---------------------------------------------------------------------------
// Snapshot historico de elegibilidad
// ---------------------------------------------------------------------------
// Solo LECTURA. Nunca escribe en telefonos/personas/empresas: el perfil
// maestro es intocable desde el camino de acumulacion (una escritura fallida
// -p.ej. el UNIQUE de telefonos.telefono- abortaria toda la transaccion en
// PostgreSQL, y ningun try/catch de JS la rescata).
//
// Devuelve las columnas crudas necesarias para decidir la elegibilidad; la
// precedencia (contacto del pedido vs perfil maestro) se resuelve en
// buildAccumulationSnapshot, en JS, reutilizando resolvePedidoOrigin
// (utils/pedidoOrigen.js) y normalizePhoneHN.
const fetchAccumulationSnapshotSources = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT
        f.id_factura,
        f.id_pedido,
        COALESCE(f.id_cliente, p.id_cliente) AS id_cliente,
        COALESCE(p.id_sucursal, f.id_sucursal) AS id_sucursal,
        COALESCE(upc.fecha_pago_confirmado, f.fecha_hora_facturacion) AS fecha_referencia,
        p.origen_pedido,
        p.id_cliente AS pedido_id_cliente,
        pc.nombre_contacto,
        pc.telefono_normalizado,
        COALESCE(c.estado, true) AS cliente_estado,
        CASE WHEN c.id_persona IS NOT NULL THEN per.nombre ELSE emp.nombre_empresa END AS nombre_maestro,
        CASE WHEN c.id_persona IS NOT NULL THEN telp.telefono ELSE tele.telefono END AS telefono_maestro
      FROM public.facturas f
      LEFT JOIN public.pedidos p ON p.id_pedido = f.id_pedido
      LEFT JOIN LATERAL (
        SELECT ppc.fecha_pago_confirmado
        FROM public.pedidos_pago_control ppc
        WHERE ppc.id_pedido = f.id_pedido
        ORDER BY ppc.id_pedido_pago_control DESC
        LIMIT 1
      ) upc ON TRUE
      LEFT JOIN LATERAL (
        SELECT pci.nombre_contacto, pci.telefono_normalizado
        FROM public.pedidos_contacto pci
        WHERE pci.id_pedido = f.id_pedido
        ORDER BY pci.id_pedido_contacto DESC
        LIMIT 1
      ) pc ON TRUE
      LEFT JOIN public.clientes c ON c.id_cliente = COALESCE(f.id_cliente, p.id_cliente)
      LEFT JOIN public.personas per ON per.id_persona = c.id_persona
      LEFT JOIN public.telefonos telp ON telp.id_telefono = per.id_telefono
      LEFT JOIN public.empresas emp ON emp.id_empresa = c.id_empresa
      LEFT JOIN public.telefonos tele ON tele.id_telefono = emp.id_telefono
      WHERE f.id_factura = $1
      LIMIT 1
    `,
    [idFactura]
  );

  return result.rows[0] || null;
};

const normalizeSnapshotText = (value) => String(value ?? '').trim();

// Regla de precedencia acordada:
// - origen PUBLIC_MENU + el pedido pertenece al MISMO cliente de la factura
//   -> el contacto capturado en el pedido ES la evidencia historica.
// - origen UNKNOWN (incluye NULL, filas legadas) -> solo cuenta como menu
//   publico si hay evidencia COMPLETA del flujo publico: pedido con cliente
//   valido, fila de contacto existente, nombre y telefono validos, y el
//   dueno del pedido coincide con el cliente de la factura. Sin eso, no se
//   asume nada.
// - cualquier otro caso -> perfil maestro vigente EN ESE MOMENTO (en la
//   reserva pre-COMMIT el perfil maestro es, por definicion, el historico).
//
// El contacto de un pedido NUNCA se aplica a un cliente distinto de su dueno:
// eso es lo que impide que en una cuenta dividida el telefono de quien pidio
// se le atribuya a un acompanante.
const resolveSnapshotFromSources = (sources) => {
  const idCliente = parsePositiveInt(sources?.id_cliente);
  const pedidoIdCliente = parsePositiveInt(sources?.pedido_id_cliente);
  const origen = resolvePedidoOrigin({ origen_pedido: sources?.origen_pedido });

  const contactoNombre = normalizeSnapshotText(sources?.nombre_contacto);
  const contactoTelefono = normalizePhoneHN(sources?.telefono_normalizado);
  const contactoEsDelMismoCliente = Boolean(idCliente && pedidoIdCliente && idCliente === pedidoIdCliente);
  const contactoUtilizable = Boolean(contactoEsDelMismoCliente && contactoNombre && contactoTelefono);

  const esMenuPublico = origen === PEDIDO_ORIGIN.PUBLIC_MENU
    || (origen === PEDIDO_ORIGIN.UNKNOWN && contactoUtilizable);

  if (esMenuPublico && contactoEsDelMismoCliente && (contactoNombre || contactoTelefono)) {
    return {
      nombre: contactoNombre || null,
      telefono: contactoTelefono || null,
      fuente: 'PEDIDO_CONTACTO'
    };
  }

  return {
    nombre: normalizeSnapshotText(sources?.nombre_maestro) || null,
    telefono: normalizePhoneHN(sources?.telefono_maestro),
    fuente: 'PERFIL_MAESTRO'
  };
};

// Snapshot completo listo para persistir. clienteActivo + nombre no vacio +
// telefono valido (normalizePhoneHN). Solo `nombre`, nunca apellido: mismo
// criterio exacto que isClienteProfileComplete.
export const buildAccumulationSnapshot = async (client, { idFactura } = {}) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const sources = await fetchAccumulationSnapshotSources(client, facturaId);
  if (!sources) return null;

  const perfil = resolveSnapshotFromSources(sources);
  const clienteActivo = Boolean(sources.cliente_estado);
  const perfilCompleto = Boolean(clienteActivo && perfil.nombre && perfil.telefono);

  return {
    idFactura: facturaId,
    idPedido: parsePositiveInt(sources.id_pedido),
    idCliente: parsePositiveInt(sources.id_cliente),
    idSucursal: parsePositiveInt(sources.id_sucursal),
    fechaReferencia: sources.fecha_referencia ?? null,
    origenPedido: sources.origen_pedido ?? null,
    nombreSnapshot: perfil.nombre,
    telefonoSnapshot: perfil.telefono,
    perfilCompletoSnapshot: perfilCompleto,
    fuenteSnapshot: perfil.fuente
  };
};

// Reconstruye el snapshot de una fila durable ya persistida. Si la fila no
// trae snapshot (perfil_completo_snapshot NULL: fila legada creada antes de
// esta migracion), devuelve null -> no hay evidencia confiable.
export const snapshotFromStateRow = (row) => {
  if (!row || row.perfil_completo_snapshot === null || row.perfil_completo_snapshot === undefined) return null;
  return {
    idFactura: parsePositiveInt(row.id_factura),
    idPedido: parsePositiveInt(row.id_pedido),
    idCliente: parsePositiveInt(row.id_cliente),
    idSucursal: parsePositiveInt(row.id_sucursal),
    fechaReferencia: row.fecha_referencia ?? null,
    origenPedido: row.origen_pedido ?? null,
    nombreSnapshot: row.nombre_snapshot ?? null,
    telefonoSnapshot: row.telefono_snapshot ?? null,
    perfilCompletoSnapshot: Boolean(row.perfil_completo_snapshot),
    fuenteSnapshot: 'RESERVA_DURABLE'
  };
};

// Bloqueante: evitar acumulacion retroactiva cuando no existe estado previo.
// Reserva la fila PENDING para una factura que se sabe recien pagada, ANTES
// de evaluar perfil/switch/tasa/puntos (camino LIVE unicamente -- ver
// persistAccumulation). intentos arranca en 0: esta reserva no es todavia un
// intento real de evaluacion; el primer intento real (mas abajo, via
// upsertAccumulationState) lo sube a 1.
// Acepta un snapshot opcional (buildAccumulationSnapshot). Cuando viene, la
// fila PENDING queda con la evidencia historica ya congelada: es lo que
// permite decidir despues sin volver a mirar el perfil actual del cliente.
//
// ON CONFLICT DO UPDATE con COALESCE(columna_existente, EXCLUDED.columna):
// una fila PENDING/RETRYABLE_ERROR sin snapshot (creada antes de tener
// evidencia, o legada) puede COMPLETARSE mas tarde si aparece evidencia
// historica confiable -sin esto, esa fila queda huerfana para siempre
// (Bloqueante: RECONCILE no podia reconstruir perfiles en estados sin
// snapshot). COALESCE nunca pisa un valor ya grabado: si la columna ya tiene
// dato, se conserva tal cual. El WHERE excluye estados terminales
// (PROCESSED/SKIPPED_TERMINAL) -esta funcion jamas los toca- e intentos/
// estado no se tocan en el UPDATE: completar el snapshot no es un intento de
// evaluacion.
export const ensurePendingAccumulationState = async (client, idFactura, fechaReferencia = null, snapshot = null) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_acumulacion_facturas_estado (
        id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia,
        fecha_creacion, fecha_actualizacion, intentos, ultimo_error,
        id_pedido, id_cliente, id_sucursal, origen_pedido,
        nombre_snapshot, telefono_snapshot, perfil_completo_snapshot
      )
      VALUES ($1, 'PENDING', NULL, NULL, $2, NOW(), NOW(), 0, NULL, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id_factura) DO UPDATE SET
        id_pedido = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_pedido, EXCLUDED.id_pedido),
        id_cliente = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_cliente, EXCLUDED.id_cliente),
        id_sucursal = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_sucursal, EXCLUDED.id_sucursal),
        origen_pedido = COALESCE(public.fidelizacion_acumulacion_facturas_estado.origen_pedido, EXCLUDED.origen_pedido),
        nombre_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.nombre_snapshot, EXCLUDED.nombre_snapshot),
        telefono_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.telefono_snapshot, EXCLUDED.telefono_snapshot),
        perfil_completo_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.perfil_completo_snapshot, EXCLUDED.perfil_completo_snapshot),
        fecha_referencia = COALESCE(public.fidelizacion_acumulacion_facturas_estado.fecha_referencia, EXCLUDED.fecha_referencia),
        fecha_actualizacion = NOW()
      WHERE public.fidelizacion_acumulacion_facturas_estado.estado IN ('PENDING', 'RETRYABLE_ERROR')
      RETURNING id_factura, estado, motivo, elegibilidad_determinada, intentos,
        id_pedido, id_cliente, id_sucursal, origen_pedido,
        nombre_snapshot, telefono_snapshot, perfil_completo_snapshot
    `,
    [
      facturaId,
      fechaReferencia ?? snapshot?.fechaReferencia ?? null,
      snapshot?.idPedido ?? null,
      snapshot?.idCliente ?? null,
      snapshot?.idSucursal ?? null,
      snapshot?.origenPedido ?? null,
      snapshot?.nombreSnapshot ?? null,
      snapshot?.telefonoSnapshot ?? null,
      snapshot ? Boolean(snapshot.perfilCompletoSnapshot) : null
    ]
  );

  return result.rows[0] || null;
};

export const getAccumulationState = async (client, idFactura) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      SELECT
        id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia, intentos,
        id_pedido, id_cliente, id_sucursal, origen_pedido,
        nombre_snapshot, telefono_snapshot, perfil_completo_snapshot
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
//
// snapshot es opcional: cuando se conoce (p.ej. un RETRYABLE_ERROR tecnico
// que fallo DESPUES de resolver el snapshot), sus columnas se preservan con
// el mismo COALESCE que ensurePendingAccumulationState -nunca pisa un valor
// ya grabado. Sin esto, un reintento perderia la evidencia historica ya
// resuelta y RECONCILE volveria a exigir evidencia desde cero.
export const upsertAccumulationState = async (client, {
  idFactura,
  estado,
  motivo = null,
  elegibilidadDeterminada = null,
  fechaReferencia = null,
  ultimoError = null,
  snapshot = null
}) => {
  const facturaId = parsePositiveInt(idFactura);
  if (!facturaId) return null;

  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_acumulacion_facturas_estado (
        id_factura, estado, motivo, elegibilidad_determinada, fecha_referencia,
        fecha_creacion, fecha_actualizacion, intentos, ultimo_error,
        id_pedido, id_cliente, id_sucursal, origen_pedido,
        nombre_snapshot, telefono_snapshot, perfil_completo_snapshot
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 1, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id_factura) DO UPDATE SET
        estado = EXCLUDED.estado,
        motivo = EXCLUDED.motivo,
        elegibilidad_determinada = EXCLUDED.elegibilidad_determinada,
        fecha_referencia = COALESCE(public.fidelizacion_acumulacion_facturas_estado.fecha_referencia, EXCLUDED.fecha_referencia),
        fecha_actualizacion = NOW(),
        intentos = public.fidelizacion_acumulacion_facturas_estado.intentos + 1,
        ultimo_error = EXCLUDED.ultimo_error,
        id_pedido = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_pedido, EXCLUDED.id_pedido),
        id_cliente = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_cliente, EXCLUDED.id_cliente),
        id_sucursal = COALESCE(public.fidelizacion_acumulacion_facturas_estado.id_sucursal, EXCLUDED.id_sucursal),
        origen_pedido = COALESCE(public.fidelizacion_acumulacion_facturas_estado.origen_pedido, EXCLUDED.origen_pedido),
        nombre_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.nombre_snapshot, EXCLUDED.nombre_snapshot),
        telefono_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.telefono_snapshot, EXCLUDED.telefono_snapshot),
        perfil_completo_snapshot = COALESCE(public.fidelizacion_acumulacion_facturas_estado.perfil_completo_snapshot, EXCLUDED.perfil_completo_snapshot)
      WHERE public.fidelizacion_acumulacion_facturas_estado.estado IN ('PENDING', 'RETRYABLE_ERROR')
      RETURNING id_factura, estado, motivo, elegibilidad_determinada, intentos,
        id_pedido, id_cliente, id_sucursal, origen_pedido,
        nombre_snapshot, telefono_snapshot, perfil_completo_snapshot
    `,
    [
      facturaId, estado, motivo, elegibilidadDeterminada, fechaReferencia, ultimoError,
      snapshot?.idPedido ?? null,
      snapshot?.idCliente ?? null,
      snapshot?.idSucursal ?? null,
      snapshot?.origenPedido ?? null,
      snapshot?.nombreSnapshot ?? null,
      snapshot?.telefonoSnapshot ?? null,
      snapshot ? Boolean(snapshot.perfilCompletoSnapshot) : null
    ]
  );

  return result.rows[0] || null;
};

// Best-effort: se llama desde el catch() de accumulateInvoicePoints, despues
// de que su propia transaccion ya hizo ROLLBACK. Nunca lanza -una falla
// guardando el estado de fidelizacion no debe alterar el resultado ya
// decidido ({created:false, reason:'ERROR'}), y muchisimo menos el 201 de la
// venta, que ya se respondio antes de que cualquiera de esto se ejecute-.
//
// snapshot opcional: si persistAccumulation ya habia resuelto la evidencia
// historica ANTES de que fallara registerFacturaLoyaltyAccumulation, se
// preserva aqui (el ROLLBACK deshizo cualquier escritura en transaccion, asi
// que esta es la unica oportunidad de no perderla). Si no se conoce -la
// falla ocurrio antes de resolver el snapshot-, la fila queda sin el y la
// regla estricta de RECONCILE aplicara despues.
export const recordAccumulationRetryableError = async (client, idFactura, { fechaReferencia = null, error = null, snapshot = null } = {}) => {
  try {
    await upsertAccumulationState(client, {
      idFactura,
      estado: ACCUMULATION_STATE.RETRYABLE_ERROR,
      motivo: null,
      elegibilidadDeterminada: null,
      fechaReferencia,
      ultimoError: String(error?.message || error || 'FIDELIZACION_ACCUMULATE_ERROR').slice(0, 500),
      snapshot
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
// venta) del de reconciliacion (RECONCILE, asincrono). Solo afecta el MOTIVO
// persistido cuando el rechazo es por perfil incompleto: el resto de motivos
// (config/tasa/redondeo) ya son time-accurate porque
// getActiveFidelizacionConfig siempre usa la referenceDate historica de la
// factura, nunca "ahora".
//
// ELEGIBILIDAD: siempre se decide con un snapshot historico, nunca con el
// perfil actual del cliente:
// - fila durable PENDING/RETRYABLE_ERROR con snapshot -> ese snapshot (la vía
//   principal: lo escribio reservePaidInvoiceAccumulation dentro de la
//   transaccion financiera).
// - sin fila + LIVE -> se construye ahora (recuperacion secundaria: la reserva
//   pre-COMMIT fallo o la factura es anterior a esta funcionalidad). Sigue
//   siendo contemporaneo al pago porque LIVE corre inmediatamente despues.
// - sin fila + RECONCILE -> solo se acepta evidencia historica de
//   pedidos_contacto (menu publico); si no la hay, terminal
//   LEGACY_ELIGIBILITY_UNVERIFIABLE. Jamas el perfil actual.
//
// CONTEXTO: cuando hay snapshot, sus 4 campos (cliente/sucursal/pedido/
// fecha) son AUTORITATIVOS -ver resolveEffectiveAccumulationContext-, nunca
// se combinan con el contexto actual de la factura. Si contradicen al
// contexto actual, es terminal (ACCUMULATION_CONTEXT_MISMATCH): no se
// acredita a ninguno de los dos clientes. El snapshot tambien rellena
// cliente/sucursal cuando el contexto ACTUAL los trae NULL (ver
// accumulateInvoicePoints.js, que ya no corta antes de llegar aqui por esa
// razon).
//
// PRESERVACION DEL SNAPSHOT ANTE ERRORES: una vez que eligibilitySnapshot
// pudo quedar resuelto, TODO lo que se ejecuta despues (completar PENDING,
// resolver el contexto efectivo, registrar puntos, persistir el estado
// final) vive dentro de un unico try/catch. Cualquier excepcion en ese tramo
// adjunta el snapshot ya conocido al error (sin pisar uno que ya viniera
// adjunto) antes de relanzarlo, para que accumulateInvoicePoints.js pueda
// reenviarlo a recordAccumulationRetryableError DESPUES del ROLLBACK -que
// deshace cualquier escritura de este intento, incluida la propia reserva
// PENDING-. Antes, solo el fallo puntual de registerFacturaLoyaltyAccumulation
// transportaba el snapshot; un fallo en ensurePendingAccumulationState o en
// cualquiera de los upsert finales lo perdia.
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
  let eligibilitySnapshot = null;

  try {
    const existingState = await getAccumulationState(client, idFactura);

    if (existingState && !RETRYABLE_ACCUMULATION_STATES.includes(existingState.estado)) {
      // PROCESSED o SKIPPED_TERMINAL: ya fue determinado, nunca se vuelve a
      // mirar el perfil/config/tasa.
      return existingState.estado === ACCUMULATION_STATE.PROCESSED
        ? { created: false, reason: 'ALREADY_REGISTERED' }
        : { created: false, reason: existingState.motivo };
    }

    eligibilitySnapshot = existingState ? snapshotFromStateRow(existingState) : null;

    if (!eligibilitySnapshot) {
      const rebuilt = await buildAccumulationSnapshot(client, { idFactura });

      if (trigger === ACCUMULATION_TRIGGER.RECONCILE) {
        // Sin snapshot -exista o no una fila previa- reconciliacion solo puede
        // confiar en evidencia historica del pedido (pedidos_contacto del menu
        // publico). El perfil maestro de HOY no prueba nada sobre el momento
        // de la compra: una fila RETRYABLE_ERROR/PENDING legada sin snapshot
        // JAMAS se completa con el perfil actual, exista o no la fila (antes
        // el `&& !existingState` dejaba pasar exactamente ese caso).
        const evidenciaHistorica = rebuilt && rebuilt.fuenteSnapshot === 'PEDIDO_CONTACTO' && rebuilt.perfilCompletoSnapshot
          ? rebuilt
          : null;

        if (!evidenciaHistorica) {
          await upsertAccumulationState(client, {
            idFactura,
            estado: ACCUMULATION_STATE.SKIPPED_TERMINAL,
            motivo: LEGACY_ELIGIBILITY_UNVERIFIABLE,
            elegibilidadDeterminada: false,
            fechaReferencia: referenceDate
          });
          return { created: false, reason: LEGACY_ELIGIBILITY_UNVERIFIABLE };
        }

        eligibilitySnapshot = evidenciaHistorica;
      } else {
        eligibilitySnapshot = rebuilt;
      }

      // Reserva/completa la fila con el snapshot recien resuelto. Si ya existia
      // sin snapshot (reintentable), ensurePendingAccumulationState ahora la
      // COMPLETA (COALESCE) en vez de no-opear; nunca pisa un snapshot ya
      // grabado ni toca un estado terminal.
      await ensurePendingAccumulationState(client, idFactura, referenceDate, eligibilitySnapshot);
    }

    // El snapshot, cuando existe, es el contexto AUTORITATIVO completo -nunca
    // se combina con el contexto actual de la factura-: evita que la
    // elegibilidad historica de un cliente se acredite al saldo de otro, y
    // permite que rellene cliente/sucursal/pedido/fecha ausentes en el
    // contexto actual. El contexto actual solo sigue usandose para el monto
    // (montoFactura, siempre por-factura, jamas del snapshot) y para
    // detectar inconsistencias.
    const { effective, mismatch } = resolveEffectiveAccumulationContext({
      currentContext: { idCliente, idSucursal, idPedido, referenceDate },
      eligibilitySnapshot
    });

    if (mismatch) {
      // Contradiccion real entre el snapshot durable y el contexto actual de
      // la factura. No se reintenta indefinidamente una inconsistencia
      // persistente: es terminal. Nunca se loguea nombre ni telefono (dato
      // personal) -solo identificadores y fechas.
      console.error('[fidelizacion:accumulate] contexto del snapshot inconsistente con el contexto actual de la factura:', {
        id_factura: idFactura || null,
        snapshot_id_cliente: eligibilitySnapshot?.idCliente ?? null,
        current_id_cliente: idCliente ?? null,
        snapshot_id_sucursal: eligibilitySnapshot?.idSucursal ?? null,
        current_id_sucursal: idSucursal ?? null,
        snapshot_id_pedido: eligibilitySnapshot?.idPedido ?? null,
        current_id_pedido: idPedido ?? null,
        snapshot_fecha_referencia: eligibilitySnapshot?.fechaReferencia ?? null,
        current_fecha_referencia: referenceDate ?? null
      });

      await upsertAccumulationState(client, {
        idFactura,
        estado: ACCUMULATION_STATE.SKIPPED_TERMINAL,
        motivo: ACCUMULATION_CONTEXT_MISMATCH,
        elegibilidadDeterminada: false,
        fechaReferencia: referenceDate,
        snapshot: eligibilitySnapshot
      });

      return { created: false, reason: ACCUMULATION_CONTEXT_MISMATCH };
    }

    const result = await registerFacturaLoyaltyAccumulation({
      client,
      idFactura,
      idPedido: effective.idPedido,
      idCliente: effective.idCliente,
      idSucursal: effective.idSucursal,
      idUsuarioEjecutor,
      montoFactura,
      referenceDate: effective.referenceDate,
      eligibilitySnapshot
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
      // El rechazo por perfil incompleto solo se relabela como "no verificable"
      // cuando de verdad NO hay evidencia historica que lo respalde: es decir,
      // cuando reconciliacion trabaja sobre una fila legada sin snapshot. Si
      // hay snapshot (la via normal desde la reserva pre-COMMIT), el motivo es
      // verificable y se conserva tal cual.
      const sinEvidenciaHistorica = !eligibilitySnapshot;
      const persistedMotivo = trigger === ACCUMULATION_TRIGGER.RECONCILE
        && result.reason === 'CLIENT_PROFILE_INCOMPLETE'
        && sinEvidenciaHistorica
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

    if (result.reason === 'MISSING_REQUIRED_DATA') {
      // Ni el snapshot durable ni el contexto actual pudieron resolver
      // cliente o sucursal: es un vacio ESTRUCTURAL de datos, no una falla
      // tecnica transitoria (esas se manejan en el catch de abajo, via
      // RETRYABLE_ERROR). Dejarlo en un estado reintentable haria que la
      // fila PENDING reapareciera indefinidamente en cada tick de
      // reconciliacion sin ninguna posibilidad real de resolverse sola.
      await upsertAccumulationState(client, {
        idFactura,
        estado: ACCUMULATION_STATE.SKIPPED_TERMINAL,
        motivo: 'MISSING_REQUIRED_DATA',
        elegibilidadDeterminada: false,
        fechaReferencia: referenceDate,
        snapshot: eligibilitySnapshot
      });
      return result;
    }

    // Cualquier otro motivo no mapeado: no se toca la tabla de estado (misma
    // precondicion que INVOICE_NOT_FULLY_PAID, resuelta antes de llegar
    // aqui; puede cambiar, no es una regla de negocio terminal).
    return result;
  } catch (error) {
    if (error && typeof error === 'object' && eligibilitySnapshot) {
      error.eligibilitySnapshot ??= eligibilitySnapshot;
    }
    throw error;
  }
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
        AND COALESCE(f.id_cliente, p.id_cliente) IS NOT NULL
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
