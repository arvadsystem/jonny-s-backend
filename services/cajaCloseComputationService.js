const METHOD_CODES = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);
// Codigo tecnico persistido para la fila agrupada automatica. Debe coincidir
// exactamente con cat_metodos_pago.codigo = 'OTRO' (fk_ccam_metodo /
// fk_ccvm_metodo apuntan al mismo id que este codigo). "Otros no efectivo" es
// unicamente una etiqueta de presentacion (display_name / frontend), nunca el
// valor persistido de metodo_pago_codigo.
export const OTHER_NON_CASH_METHOD_CODE = 'OTRO';
export const OTHER_NON_CASH_DISPLAY_NAME = 'Otros no efectivo';
const OTHER_NON_CASH_AUTO_OBSERVATION =
  'Conciliación automática: el saldo neto de otros métodos no efectivo es negativo por reversiones o ajustes.';

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

const describeCatalogState = (entry) => {
  if (!entry?.id_metodo_pago) return 'NO_EXISTE';
  return entry.activo ? 'ACTIVO' : 'INACTIVO';
};

// 5.1: EFECTIVO/TARJETA/TRANSFERENCIA deben tener exactamente una
// configuracion valida (id positivo, activo, afecta_efectivo correcto) antes
// de escribir nada. snapshot.catalogValidation viene de una resolucion por
// codigo exacto (ver cajaCloseFinancialSnapshotService); ya no se fabrican
// filas con id_metodo_pago=null que pasen esta validacion por "tener codigo".
const assertCoreCatalogValid = (catalogValidation) => {
  for (const codigo of METHOD_CODES) {
    const entry = catalogValidation?.[codigo];
    if (!entry || !entry.valido) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_METODO_CATALOGO_INCOMPLETO',
        `El catalogo de metodos de pago no tiene una configuracion valida para ${codigo}.`,
        {
          codigo,
          estado_encontrado: describeCatalogState(entry),
          afecta_efectivo_encontrado: entry?.afecta_efectivo ?? null,
          motivo: entry?.motivo || 'NO_EXISTE'
        }
      );
    }
  }
};

export const buildSegmentedArqueoComputation = ({
  snapshot,
  payloadRows,
  threshold,
  requireObservacionOnDifference = true
}) => {
  const catalogValidation = snapshot?.catalogValidation || {};
  assertCoreCatalogValid(catalogValidation);

  const methodCatalog = Array.isArray(snapshot?.metodos) ? snapshot.metodos : [];
  const methodCodes = new Set(methodCatalog.map((row) => normalizeMethodCode(row.codigo)));

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

  // 5.2/5.4: fila automatica y no editable "OTRO". Agrupa todo metodo activo
  // con afecta_efectivo=false que no sea TARJETA/TRANSFERENCIA (OTRO y
  // billeteras/enlaces de pago futuros). Solo se genera cuando existe
  // actividad bruta o reversiones en ese grupo (5.2 "cuando generar la
  // fila"); si el grupo esta completamente inactivo se omite, preservando el
  // comportamiento de 3 filas para sesiones sin esa actividad.
  const otrosNoEfectivo = snapshot?.otrosNoEfectivo || {
    ventas_brutas: 0,
    reversiones: 0,
    ventas_netas: 0,
    metodos_agrupados: []
  };
  const otrosVentasBrutas = roundMoney(otrosNoEfectivo.ventas_brutas);
  const otrosReversionesAgrupadas = roundMoney(otrosNoEfectivo.reversiones);
  const hasGroupedOtherActivity = otrosVentasBrutas !== 0 || otrosReversionesAgrupadas !== 0;

  if (hasGroupedOtherActivity) {
    const otroValidation = catalogValidation.OTRO;
    if (!otroValidation || !otroValidation.valido) {
      throw createCajaError(
        409,
        'VENTAS_CAJAS_OTROS_NO_EFECTIVO_CONFIG_INVALID',
        'Existen ventas o reversiones en metodos no efectivo agrupados, pero el metodo OTRO no tiene una configuracion valida en el catalogo.',
        {
          codigo: 'OTRO',
          estado_encontrado: describeCatalogState(otroValidation),
          afecta_efectivo_encontrado: otroValidation?.afecta_efectivo ?? null,
          motivo: otroValidation?.motivo || 'NO_EXISTE'
        }
      );
    }

    // monto_teorico conserva el valor real (puede ser negativo, p. ej.
    // reversiones superiores a las ventas del grupo). monto_declarado se
    // ancla en 0 como piso porque la columna persistida no admite valores
    // negativos (ck_ccam/ck_ccvm monto_declarado >= 0). Cuando eso ocurre la
    // diferencia queda visible y requiere_revision=true (5.4): nunca se
    // marca una fila con diferencia distinta de cero como revisada.
    const otrosMontoTeorico = roundMoney(otrosNoEfectivo.ventas_netas);
    const otrosMontoDeclarado = otrosMontoTeorico >= 0 ? otrosMontoTeorico : 0;
    const otrosDiferencia = roundMoney(otrosMontoDeclarado - otrosMontoTeorico);
    const otrosRequiereRevision = otrosDiferencia !== 0;

    totalTeoricoSegmentado = roundMoney(totalTeoricoSegmentado + otrosMontoTeorico);
    totalDeclaradoSegmentado = roundMoney(totalDeclaradoSegmentado + otrosMontoDeclarado);
    rows.push({
      id_metodo_pago: otroValidation.id_metodo_pago,
      metodo_pago_codigo: OTHER_NON_CASH_METHOD_CODE,
      display_name: OTHER_NON_CASH_DISPLAY_NAME,
      monto_teorico: otrosMontoTeorico,
      monto_declarado: otrosMontoDeclarado,
      diferencia: otrosDiferencia,
      cantidad_referencias: null,
      observacion: otrosRequiereRevision ? OTHER_NON_CASH_AUTO_OBSERVATION : null,
      requiere_revision: otrosRequiereRevision,
      observacion_requerida: false,
      observacion_presente: otrosRequiereRevision,
      resultado: resolveArqueoResultado(otrosDiferencia),
      completado_automaticamente: true,
      editable: false,
      ventas_brutas_agrupadas: otrosVentasBrutas,
      reversiones_agrupadas: otrosReversionesAgrupadas,
      metodos_agrupados: Array.isArray(otrosNoEfectivo.metodos_agrupados)
        ? otrosNoEfectivo.metodos_agrupados
        : []
    });
  }

  // 5.5: los totales se calculan EXCLUSIVAMENTE a partir de las filas finales
  // (incluida OTRO cuando aplica), nunca desde un total independiente. Esto
  // garantiza por construccion que sum(rows.monto_teorico) === total y
  // sum(rows.monto_declarado) === total, sin sumar ningun grupo dos veces.
  const totalTeorico = totalTeoricoSegmentado;
  const totalDeclarado = totalDeclaradoSegmentado;

  return {
    rows,
    monto_teorico_total: totalTeorico,
    monto_declarado_total: totalDeclarado,
    diferencia_total: roundMoney(totalDeclarado - totalTeorico),
    snapshot,
    financialSummary: snapshot
  };
};
