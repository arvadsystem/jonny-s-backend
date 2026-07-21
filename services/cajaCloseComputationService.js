const METHOD_CODES = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeMethodCode = (value) => String(value || '').trim().toUpperCase();
const normalizeText = (value, maxLength = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const createCajaError = (httpStatus, code, publicMessage, details = null) => {
  const error = new Error(publicMessage);
  error.httpStatus = httpStatus;
  error.code = code;
  error.publicMessage = publicMessage;
  if (details && typeof details === 'object') error.details = details;
  return error;
};

const parseNullableNonNegativeAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : null;
};

const resolveArqueoResultado = (diferencia) => {
  const normalized = roundMoney(diferencia);
  if (normalized === 0) return 'CUADRADO';
  return normalized < 0 ? 'FALTANTE' : 'SOBRANTE';
};

export const BIGINT_FINGERPRINT_KEYS = new Set([
  'max_id_factura_cobro',
  'max_id_reversion',
  'max_id_movimiento_caja'
]);

export const INTEGER_FINGERPRINT_KEYS = new Set([
  'cantidad_cobros',
  'cantidad_reversiones',
  'cantidad_movimientos'
]);

export const MONEY_FINGERPRINT_KEYS = new Set([
  'total_cobros',
  'total_reversado',
  'total_ingresos_manuales',
  'total_egresos_manuales',
  'ventas_efectivo_netas',
  'ventas_no_efectivo_netas',
  'efectivo_teorico',
  'tarjeta_teorico',
  'transferencia_teorico',
  'total_teorico'
]);

const canonicalBigIntText = (value) => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '0';
  return BigInt(text).toString();
};

export const fingerprintValuesEqual = (key, left, right) => {
  if (BIGINT_FINGERPRINT_KEYS.has(key)) {
    return canonicalBigIntText(left) === canonicalBigIntText(right);
  }
  if (INTEGER_FINGERPRINT_KEYS.has(key)) {
    return Number.parseInt(String(left ?? 0), 10) === Number.parseInt(String(right ?? 0), 10);
  }
  if (MONEY_FINGERPRINT_KEYS.has(key)) {
    return roundMoney(left) === roundMoney(right);
  }
  return String(left ?? '') === String(right ?? '');
};

export const buildSegmentedArqueoComputation = ({
  snapshot,
  payloadRows,
  threshold,
  requireObservacionOnDifference = true
}) => {
  const methodCatalog = Array.isArray(snapshot?.metodos) ? snapshot.metodos : [];
  const methodCodes = new Set(methodCatalog.map((row) => normalizeMethodCode(row.codigo)));
  for (const requiredCode of METHOD_CODES) {
    if (!methodCodes.has(requiredCode)) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_METODO_CATALOGO_INCOMPLETO',
        `No se encontro el metodo de pago requerido: ${requiredCode}.`
      );
    }
  }

  const declaredByCode = new Map();
  for (const row of Array.isArray(payloadRows) ? payloadRows : []) {
    const code = normalizeMethodCode(row?.metodo_pago_codigo);
    if (!code || !methodCodes.has(code)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_INVALID', 'El metodo_pago_codigo del arqueo es invalido.');
    }
    if (declaredByCode.has(code)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_DUPLICATE', `No se permite repetir arqueos para ${code}.`);
    }
    const montoDeclarado = parseNullableNonNegativeAmount(row?.monto_declarado);
    if (montoDeclarado === null) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_AMOUNT_INVALID', `monto_declarado es obligatorio para ${code}.`);
    }
    const cantidadReferencias = row?.cantidad_referencias === null || row?.cantidad_referencias === undefined || row?.cantidad_referencias === ''
      ? null
      : Number.parseInt(String(row.cantidad_referencias), 10);
    if (cantidadReferencias !== null && (!Number.isInteger(cantidadReferencias) || cantidadReferencias < 0)) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_REFERENCIAS_INVALID', `cantidad_referencias invalida para ${code}.`);
    }
    declaredByCode.set(code, {
      monto_declarado: Number(montoDeclarado),
      cantidad_referencias: cantidadReferencias,
      observacion: normalizeText(row?.observacion, 500)
    });
  }

  const normalizedThreshold = Number.isFinite(Number(threshold)) && Number(threshold) >= 0
    ? Number(threshold)
    : 0;

  let totalTeoricoSegmentado = 0;
  let totalDeclaradoSegmentado = 0;
  const rows = [];
  for (const method of methodCatalog) {
    const code = normalizeMethodCode(method.codigo);
    const salesGross = roundMoney(method.ventas_brutas);
    const montoTeoricoMetodo = roundMoney(method.monto_teorico);
    const declaredEntry = declaredByCode.get(code);
    const autoComplete = !declaredEntry && montoTeoricoMetodo === 0;
    if (!declaredEntry && !autoComplete) {
      throw createCajaError(400, 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED', `Debe declarar arqueo para ${code}.`);
    }

    const montoDeclaradoMetodo = autoComplete ? 0 : Number(declaredEntry.monto_declarado);
    const diferenciaMetodo = roundMoney(montoDeclaradoMetodo - montoTeoricoMetodo);
    const requiereRevision = Math.abs(diferenciaMetodo) > normalizedThreshold;
    const observacionMetodo = autoComplete ? null : declaredEntry.observacion;
    const cantidadReferenciasMetodo = autoComplete ? null : declaredEntry.cantidad_referencias;

    if ((code === 'TARJETA' || code === 'TRANSFERENCIA') && salesGross > 0 && cantidadReferenciasMetodo === null) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ARQUEO_REFERENCIAS_REQUIRED',
        `Debe indicar cantidad_referencias para ${code} cuando existen ventas del metodo.`
      );
    }
    if (requireObservacionOnDifference && requiereRevision && !observacionMetodo) {
      throw createCajaError(
        400,
        'VENTAS_CAJAS_ARQUEO_OBSERVACION_REQUIRED',
        `Debe indicar observacion para ${code} cuando existe diferencia.`,
        {
          metodo_pago_codigo: code,
          field: 'observacion',
          focus_target: `arqueos.${code}.observacion`,
          step: code
        }
      );
    }

    totalTeoricoSegmentado = roundMoney(totalTeoricoSegmentado + montoTeoricoMetodo);
    totalDeclaradoSegmentado = roundMoney(totalDeclaradoSegmentado + montoDeclaradoMetodo);
    rows.push({
      id_metodo_pago: Number(method.id_metodo_pago),
      metodo_pago_codigo: code,
      monto_teorico: montoTeoricoMetodo,
      monto_declarado: montoDeclaradoMetodo,
      diferencia: diferenciaMetodo,
      cantidad_referencias: cantidadReferenciasMetodo,
      observacion: observacionMetodo,
      requiere_revision: requiereRevision,
      observacion_requerida: requireObservacionOnDifference && requiereRevision,
      observacion_presente: Boolean(observacionMetodo),
      resultado: resolveArqueoResultado(diferenciaMetodo),
      completado_automaticamente: autoComplete
    });
  }

  const totalTeorico = snapshot?.totalTeorico === null || snapshot?.totalTeorico === undefined
    ? totalTeoricoSegmentado
    : roundMoney(snapshot.totalTeorico);
  const totalNoSegmentado = roundMoney(totalTeorico - totalTeoricoSegmentado);
  const totalDeclarado = roundMoney(totalDeclaradoSegmentado + totalNoSegmentado);

  return {
    rows,
    monto_teorico_total: totalTeorico,
    monto_declarado_total: totalDeclarado,
    diferencia_total: roundMoney(totalDeclarado - totalTeorico),
    snapshot,
    financialSummary: snapshot
  };
};
