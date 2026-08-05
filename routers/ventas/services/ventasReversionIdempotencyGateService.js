/**
 * Consulta/reserva la idempotencia con el scope financiero ya resuelto y
 * valida el estado actual de la sesion solo para una operacion nueva.
 * Un replay SUCCESS representa una escritura ya confirmada y no debe quedar
 * condicionado por un cierre de caja posterior.
 */
export const resolveReversionIdempotencyGate = async ({
  client,
  idempotency,
  idFactura,
  idSucursal,
  idSesionCaja,
  validateSession
}) => {
  let reservation = null;
  if (typeof idempotency?.reserve === 'function') {
    reservation = await idempotency.reserve(client, {
      idFactura,
      idSucursal,
      idSesionCaja
    });
    if (reservation?.replay || reservation?.conflict) {
      return { reservation, terminal: true, sessionContext: null };
    }
  }

  const sessionContext = await validateSession({
    client,
    idSesionCaja,
    idSucursal
  });

  return { reservation, terminal: false, sessionContext };
};
