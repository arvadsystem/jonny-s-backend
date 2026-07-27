import {
  buildAccumulationSnapshot,
  ensurePendingAccumulationState
} from '../infrastructure/fidelizacionRepository.js';

// Reserva DURABLE de acumulacion, ejecutada DENTRO de la transaccion
// financiera que confirma el pago, justo antes de su COMMIT.
//
// Por que existe: la cola de fidelizacion vive en memoria
// (infrastructure/fidelizacionQueue.js) y ademas rechaza trabajo cuando se
// llena. Si el proceso se reinicia entre el COMMIT financiero y el drenado de
// la cola, sin esta fila no queda ninguna evidencia de que la factura debia
// acumular: la reconciliacion la encontraria sin estado y -por la regla de
// elegibilidad historica- la marcaria LEGACY_ELIGIBILITY_UNVERIFIABLE,
// perdiendo puntos legitimos. Esta fila es esa evidencia.
//
// Contrato estricto:
// - Usa EXCLUSIVAMENTE el client de la transaccion financiera que recibe.
//   Nunca abre fidelizacionPool ni el pool compartido.
// - No calcula puntos, no toca saldos, movimientos ni configuracion.
//   Solo lecturas + un INSERT ... ON CONFLICT DO NOTHING (idempotente por
//   id_factura).
// - NUNCA lanza y NUNCA aborta la transaccion financiera: todo el trabajo va
//   dentro de un SAVEPOINT propio, siguiendo la convencion ya existente en el
//   repositorio (runRecoverableDbStep, routers/personas_atomic.js). Si algo
//   falla -incluso si la tabla todavia no existe porque la migracion no se
//   aplico- se hace ROLLBACK TO SAVEPOINT y la venta/pago continua intacta.
//
// El SAVEPOINT es imprescindible: en PostgreSQL un statement fallido aborta
// TODA la transaccion (25P02) y ningun try/catch de JavaScript la recupera;
// solo un rollback a un savepoint previo la devuelve a un estado usable.

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

// Identificador de savepoint: no admite bind params, se interpola. Se genera
// internamente (nunca desde entrada externa) y se limita a [a-z0-9_].
const buildSavepointName = () =>
  `fidelizacion_reserva_pago_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const logReservationFailure = (idFactura, stage, err) => {
  console.error('[fidelizacion:reserva] no se pudo reservar la acumulacion (el pago continua normalmente):', {
    id_factura: idFactura ?? null,
    stage,
    code: err?.code || err?.name || 'FIDELIZACION_RESERVA_ERROR',
    message: String(err?.message || err || '').slice(0, 200)
  });
};

export const reservePaidInvoiceAccumulation = async ({ client, idFactura } = {}) => {
  const facturaId = parsePositiveInt(idFactura);
  // Sin factura utilizable no hay nada que reservar (p.ej. RPC v3 puede
  // devolver id_factura null). No se toca la transaccion en absoluto.
  if (!client || !facturaId) {
    return { reserved: false, reason: 'INVALID_INVOICE_ID' };
  }

  const savepoint = buildSavepointName();

  try {
    await client.query(`SAVEPOINT ${savepoint}`);
  } catch (err) {
    // Ni siquiera se pudo abrir el savepoint: no hay forma segura de intentar
    // la reserva sin arriesgar la transaccion financiera, asi que no se
    // intenta. El pago sigue su curso.
    logReservationFailure(facturaId, 'SAVEPOINT', err);
    return { reserved: false, reason: 'SAVEPOINT_ERROR' };
  }

  try {
    const snapshot = await buildAccumulationSnapshot(client, { idFactura: facturaId });
    if (!snapshot) {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { reserved: false, reason: 'INVOICE_NOT_FOUND' };
    }

    await ensurePendingAccumulationState(
      client,
      facturaId,
      snapshot.fechaReferencia,
      snapshot
    );

    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return { reserved: true, reason: null, snapshot };
  } catch (err) {
    // Devuelve la transaccion financiera al punto anterior a la reserva. Cada
    // limpieza va en su propio try/catch vacio para no enmascarar el error
    // original (misma convencion que runRecoverableDbStep).
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    } catch {
      // noop: preserva el error original
    }
    try {
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // noop: preserva el error original
    }
    logReservationFailure(facturaId, 'RESERVA', err);
    return { reserved: false, reason: 'ERROR' };
  }
};
