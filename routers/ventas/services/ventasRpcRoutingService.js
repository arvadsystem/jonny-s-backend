export const IDEMPOTENCY_MODE = Object.freeze({
  RPC: 'rpc',
  EXTERNAL: 'external',
  DISABLED: 'disabled'
});

export const PEDIDO_PENDIENTE_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export const validatePedidoPendienteIdempotencyKeyHeader = (rawValue) => {
  if (rawValue === undefined || rawValue === null) {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_REQUERIDA',
      message: 'Idempotency-Key es requerido para crear el pedido.'
    };
  }
  if (Array.isArray(rawValue) || typeof rawValue !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_INVALIDA',
      message: 'Idempotency-Key debe ser una cadena unica de hasta 200 caracteres.'
    };
  }
  const value = rawValue.trim();
  if (!value) {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_REQUERIDA',
      message: 'Idempotency-Key es requerido para crear el pedido.'
    };
  }
  if (value.includes(',') || value.length > PEDIDO_PENDIENTE_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: 'VENTAS_PEDIDO_IDEMPOTENCY_KEY_INVALIDA',
      message: 'Idempotency-Key debe ser una cadena unica de hasta 200 caracteres.'
    };
  }
  return { ok: true, value };
};

export const hasCuentaDivididaPayload = (body) => Array.isArray(body?.cuenta_dividida);

export const resolvePedidoPendienteIdempotencyMode = ({ idempotencyKey = null } = {}) => {
  if (!idempotencyKey) return IDEMPOTENCY_MODE.DISABLED;
  // La RPC v2 desplegada aun no recibe id_sesion_caja en sus helpers de
  // reserva/finalizacion. Hasta que exista ese contrato SQL, Node conserva la
  // reserva y su scope; la persistencia puede seguir usando la RPC v1.
  return IDEMPOTENCY_MODE.EXTERNAL;
};

export const resolveVentaIdempotencyMode = ({ idempotencyKey = null } = {}) => {
  if (!idempotencyKey) return IDEMPOTENCY_MODE.DISABLED;
  // La RPC v3 desplegada reserva antes de validar la sesion y omite
  // id_sesion_caja. Mantener el scope en Node evita reservas financieras NULL.
  return IDEMPOTENCY_MODE.EXTERNAL;
};

export const buildRpcManagedIdempotencyReservation = (idempotencyKey = null) => ({
  enabled: Boolean(idempotencyKey),
  rpcManaged: true,
  idempotencyKey
});

export const shouldUseExternalIdempotency = (reservation) =>
  Boolean(reservation) && !reservation.rpcManaged;

export const shouldRunRpcPostCommitSideEffects = (response) =>
  !Boolean(response?.idempotent_replay);

export const shouldUsePedidoPendienteRpcV2 = ({
  pedidoPendienteRpcV2Enabled = false,
  cuentaDivisionPlan = null,
  pedidoLines = []
} = {}) => (
  pedidoPendienteRpcV2Enabled
  && !cuentaDivisionPlan
  && Array.isArray(pedidoLines)
  && pedidoLines.length > 0
);

export const resolvePedidoPendienteRpcSkipReason = ({
  cuentaDivisionPlan = null,
  pedidoPendienteRpcV2Enabled = false,
  pedidoPendienteHasSalsasInventario = false,
  pedidoPendienteRpcEnabled = false,
  pedidoLines = []
} = {}) => {
  if (cuentaDivisionPlan) {
    return pedidoPendienteRpcV2Enabled
      ? 'CUENTA_DIVIDIDA_NO_SOPORTADA_RPC_V2'
      : 'cuenta_dividida';
  }
  if (pedidoPendienteHasSalsasInventario) {
    return pedidoPendienteRpcV2Enabled ? null : 'salsas_inventario';
  }
  if (!pedidoPendienteRpcEnabled) return 'flag_disabled';
  if (!Array.isArray(pedidoLines) || pedidoLines.length === 0) return 'no_lines';
  return null;
};

export const reserveIdempotencyForMode = async ({
  mode,
  idempotencyKey = null,
  reserveExternal,
  reserveArgs
} = {}) => {
  if (mode === IDEMPOTENCY_MODE.RPC) {
    return buildRpcManagedIdempotencyReservation(idempotencyKey);
  }
  if (mode === IDEMPOTENCY_MODE.EXTERNAL) {
    return reserveExternal(reserveArgs);
  }
  return { enabled: false };
};

export const saveExternalIdempotencySuccessIfNeeded = async ({
  reservation,
  saveSuccess,
  args
} = {}) => {
  if (!shouldUseExternalIdempotency(reservation)) return false;
  await saveSuccess(args);
  return true;
};

export const saveExternalIdempotencyFailureIfNeeded = async ({
  reservation,
  saveFailure,
  args
} = {}) => {
  if (!shouldUseExternalIdempotency(reservation)) return false;
  await saveFailure(args);
  return true;
};
