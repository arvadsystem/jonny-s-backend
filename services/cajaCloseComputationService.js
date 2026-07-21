const METHOD_CODES = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
export const OTHER_NON_CASH_METHOD_CODE = 'OTROS_NO_EFECTIVO';

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

  // Fila automatica y no editable: agrupa TODO metodo activo con afecta_efectivo
  // = false que no sea TARJETA/TRANSFERENCIA (OTRO y cualquier metodo futuro),
  // para que el detalle visible nunca deje dinero fuera de una fila (evita que
  // el residual se sume "en silencio" al total declarado, como ocurria antes).
  // monto_teorico conserva el valor real (puede ser negativo, p. ej. una
  // reversion de sesion cruzada); monto_declarado se ancla en 0 como piso
  // porque la columna persistida no admite valores negativos (ck_ccam/ck_ccvm
  // monto_declarado >= 0, fuera del alcance de este cambio). Por eso
  // completado_automaticamente/requiere_revision son fijos: nunca depende de
  // un ingreso manual ni bloquea el cierre.
  const otrosMontoTeorico = roundMoney(totalTeorico - totalTeoricoSegmentado);
  const otrosMontoDeclarado = Math.max(0, otrosMontoTeorico);
  const otrosDiferencia = roundMoney(otrosMontoDeclarado - otrosMontoTeorico);
  // cajas_cierres_arqueos_metodos.id_metodo_pago es NOT NULL con FK real a
  // cat_metodos_pago (fk_ccam_metodo): no admite NULL ni un sentinel
  // inexistente. El snapshot resuelve un id real (cualquier metodo activo o
  // no que no sea EFECTIVO/TARJETA/TRANSFERENCIA) como ancla de la fila
  // agrupada; metodo_pago_codigo sigue siendo la fuente de verdad semantica.
  const otrosIdMetodoPago = Number.isFinite(Number(snapshot?.otrosNoEfectivoIdMetodoPago))
    ? Number(snapshot.otrosNoEfectivoIdMetodoPago)
    : null;
  rows.push({
    id_metodo_pago: otrosIdMetodoPago,
    metodo_pago_codigo: OTHER_NON_CASH_METHOD_CODE,
    monto_teorico: otrosMontoTeorico,
    monto_declarado: otrosMontoDeclarado,
    diferencia: otrosDiferencia,
    cantidad_referencias: null,
    observacion: null,
    requiere_revision: false,
    observacion_requerida: false,
    observacion_presente: false,
    resultado: resolveArqueoResultado(otrosDiferencia),
    completado_automaticamente: true
  });

  // Construidos a partir de las filas (incluida OTROS_NO_EFECTIVO) para que la
  // suma del detalle visible coincida siempre, exactamente, con estos totales.
  const totalDeclarado = roundMoney(totalDeclaradoSegmentado + otrosMontoDeclarado);

  return {
    rows,
    monto_teorico_total: totalTeorico,
    monto_declarado_total: totalDeclarado,
    diferencia_total: roundMoney(totalDeclarado - totalTeorico),
    snapshot,
    financialSummary: snapshot
  };
};
