import { parsePositiveBigIntId } from './cajaFinancialLockService.js';

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const createCajaSessionWriteError = (httpStatus, code, message) => {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = message;
  return error;
};

export const validateCajaSessionOpenForFinancialWrite = async ({
  client,
  idSesionCaja,
  idCaja,
  idSucursal,
  idUsuario
}) => {
  const sessionId = parsePositiveBigIntId(idSesionCaja);
  const cajaId = parsePositiveInt(idCaja);
  const sucursalId = parsePositiveInt(idSucursal);
  const userId = parsePositiveInt(idUsuario);

  if (!sessionId || !cajaId || !sucursalId || !userId) {
    throw createCajaSessionWriteError(
      400,
      'VENTAS_CAJA_SESSION_CONTEXT_INVALID',
      'No se pudo validar la sesion de caja para registrar la operacion.'
    );
  }

  try {
    await client.query(
      `
        SELECT public.fn_ventas_assert_caja_session_write_open(
          $1::bigint,
          $2::bigint,
          $3::bigint,
          $4::bigint
        )
      `,
      [sessionId, cajaId, sucursalId, userId]
    );
    return {
      id_sesion_caja: sessionId,
      id_caja: cajaId,
      id_sucursal: sucursalId
    };
  } catch (err) {
    const code = String(err?.message || err?.code || '').trim();
    const mapped = {
      VENTAS_CAJA_SESSION_CONTEXT_INVALID: [400, 'No se pudo validar la sesion de caja para registrar la operacion.'],
      VENTAS_CAJA_SESSION_NOT_FOUND: [404, 'La sesion de caja seleccionada no existe.'],
      VENTAS_CAJA_SESSION_SCOPE_MISMATCH: [409, 'La sesion de caja no pertenece a la sucursal de la operacion.'],
      VENTAS_CAJA_SESSION_CLOSED: [409, 'La sesion de caja fue cerrada antes de registrar la operacion.'],
      VENTAS_CAJA_NOT_ACTIVE: [409, 'La caja de la sesion no esta activa.'],
      VENTAS_CAJA_SESSION_PARTICIPATION_REQUIRED: [403, 'El usuario no participa activamente en la sesion de caja seleccionada.'],
      VENTAS_CAJA_FINANCIAL_LOCK_TIMEOUT: [409, 'Otra operacion financiera de caja esta en curso. Intente nuevamente.']
    };
    if (mapped[code]) {
      throw createCajaSessionWriteError(mapped[code][0], code, mapped[code][1]);
    }
    throw err;
  }
};
