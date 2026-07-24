const MANUAL_METHOD_ORDER = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeMethodCode = (value) => String(value || '').trim().toUpperCase();
const normalizeText = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};
const normalizeReferences = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};
const parseJsonObject = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const cloneJsonValue = (value) => JSON.parse(JSON.stringify(value));
const canonicalJsonValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])])
  );
};
const canonicalJsonText = (value) => JSON.stringify(canonicalJsonValue(value));
const sortMethods = (rows) => [...rows].sort((left, right) => {
  const leftCode = normalizeMethodCode(left?.metodo_pago_codigo);
  const rightCode = normalizeMethodCode(right?.metodo_pago_codigo);
  const leftOrder = MANUAL_METHOD_ORDER.indexOf(leftCode);
  const rightOrder = MANUAL_METHOD_ORDER.indexOf(rightCode);
  const normalizedLeftOrder = leftOrder >= 0 ? leftOrder : MANUAL_METHOD_ORDER.length;
  const normalizedRightOrder = rightOrder >= 0 ? rightOrder : MANUAL_METHOD_ORDER.length;
  return normalizedLeftOrder - normalizedRightOrder || leftCode.localeCompare(rightCode);
});

export const normalizeCloseValidationPayload = (payload = {}) => ({
  arqueos: sortMethods(Array.isArray(payload?.arqueos) ? payload.arqueos : []).map((row) => ({
    metodo_pago_codigo: normalizeMethodCode(row?.metodo_pago_codigo),
    monto_declarado: roundMoney(row?.monto_declarado),
    cantidad_referencias: normalizeReferences(row?.cantidad_referencias),
    observacion: normalizeText(row?.observacion, 500)
  })),
  observacion_cierre: normalizeText(payload?.observacion_cierre, 500)
});

const buildPersistedMethods = (rows) => sortMethods(rows).map((row) => ({
  id_metodo_pago: Number(row?.id_metodo_pago || 0) || null,
  metodo_pago_codigo: normalizeMethodCode(row?.metodo_pago_codigo),
  monto_teorico: roundMoney(row?.monto_teorico),
  monto_declarado: roundMoney(row?.monto_declarado),
  diferencia: roundMoney(row?.diferencia),
  cantidad_referencias: normalizeReferences(row?.cantidad_referencias),
  resultado: String(row?.resultado || '').trim().toUpperCase(),
  requiere_revision: Boolean(row?.requiere_revision),
  observacion: normalizeText(row?.observacion, 500)
}));

export const buildCloseValidationArtifacts = ({
  computation,
  observacionCierre,
  operationalFingerprint
}) => {
  const computationRows = Array.isArray(computation?.rows) ? computation.rows : [];
  const manualRows = computationRows.filter((row) =>
    MANUAL_METHOD_ORDER.includes(normalizeMethodCode(row?.metodo_pago_codigo))
  );
  const hayDiferencia = computationRows.some((row) => roundMoney(row?.diferencia) !== 0);
  const payloadDeclarado = normalizeCloseValidationPayload({
    arqueos: manualRows,
    observacion_cierre: observacionCierre
  });
  const resultado = {
    resumen: {
      total_teorico: roundMoney(computation?.monto_teorico_total),
      total_declarado: roundMoney(computation?.monto_declarado_total),
      diferencia_total: roundMoney(computation?.diferencia_total),
      hay_diferencia: hayDiferencia
    },
    metodos: cloneJsonValue(sortMethods(computationRows)),
    huella_operacional: cloneJsonValue(operationalFingerprint || {})
  };

  return {
    hayDiferencia,
    payloadDeclarado,
    resultado,
    persistedMethods: buildPersistedMethods(computationRows)
  };
};

export const isReusableCloseValidation = ({
  candidate,
  idSesionCaja,
  idUsuarioValida,
  payloadDeclarado,
  resultado,
  persistedMethods
}) => {
  if (!candidate || (candidate.id_cierre_caja !== null && candidate.id_cierre_caja !== undefined)) return false;
  if (String(candidate.id_sesion_caja || '') !== String(idSesionCaja || '')) return false;
  if (Number(candidate.id_usuario_valida || 0) !== Number(idUsuarioValida || 0)) return false;

  const candidatePayload = normalizeCloseValidationPayload(
    parseJsonObject(candidate.payload_declarado_json) || {}
  );
  const candidateResult = parseJsonObject(candidate.resultado_json);
  if (!candidateResult) return false;

  const candidateMethods = Array.isArray(candidate.metodos_persistidos_json)
    ? buildPersistedMethods(candidate.metodos_persistidos_json)
    : [];
  const expectedResult = {
    resumen: resultado?.resumen || null,
    metodos: sortMethods(Array.isArray(resultado?.metodos) ? resultado.metodos : []),
    huella_operacional: resultado?.huella_operacional || {}
  };
  const normalizedCandidateResult = {
    resumen: candidateResult.resumen || null,
    metodos: sortMethods(Array.isArray(candidateResult.metodos) ? candidateResult.metodos : []),
    huella_operacional: candidateResult.huella_operacional || {}
  };

  return canonicalJsonText(candidatePayload) === canonicalJsonText(normalizeCloseValidationPayload(payloadDeclarado))
    && canonicalJsonText(normalizedCandidateResult.resumen) === canonicalJsonText(expectedResult.resumen)
    && canonicalJsonText(normalizedCandidateResult.metodos) === canonicalJsonText(expectedResult.metodos)
    && canonicalJsonText(normalizedCandidateResult.huella_operacional) === canonicalJsonText(expectedResult.huella_operacional)
    && canonicalJsonText(candidateMethods) === canonicalJsonText(buildPersistedMethods(persistedMethods || []));
};
