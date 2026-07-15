export const IDEMPOTENCY_MODE = Object.freeze({
  RPC: 'rpc',
  EXTERNAL: 'external',
  DISABLED: 'disabled'
});

export const hasCuentaDivididaPayload = (body) => Array.isArray(body?.cuenta_dividida);

export const resolvePedidoPendienteIdempotencyMode = ({
  pedidoPendienteRpcV2Enabled = false,
  cuentaDivididaSolicitada = false,
  idempotencyKey = null
} = {}) => {
  if (!idempotencyKey) return IDEMPOTENCY_MODE.DISABLED;
  return pedidoPendienteRpcV2Enabled && !cuentaDivididaSolicitada
    ? IDEMPOTENCY_MODE.RPC
    : IDEMPOTENCY_MODE.EXTERNAL;
};

export const resolveVentaIdempotencyMode = ({
  ventasRpcV3Enabled = false,
  idempotencyKey = null
} = {}) => {
  if (!idempotencyKey) return IDEMPOTENCY_MODE.DISABLED;
  return ventasRpcV3Enabled ? IDEMPOTENCY_MODE.RPC : IDEMPOTENCY_MODE.EXTERNAL;
};

export const buildRpcManagedIdempotencyReservation = (idempotencyKey = null) => ({
  enabled: Boolean(idempotencyKey),
  rpcManaged: true
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
