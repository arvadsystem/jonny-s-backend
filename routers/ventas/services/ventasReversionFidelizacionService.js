// Reversion de puntos de fidelizacion por reversion de venta (Fase 4).
//
// Reemplaza services/ventasReversionService.js:revertLoyaltyForFactura
// (eliminada). Diferencias clave respecto al comportamiento anterior:
//
//  1) Ambiguedad de fuente (seccion 3.1): el movimiento ORIGINAL de
//     acumulacion (ACUMULACION/FACTURA, puntos_delta>0) se busca sin
//     LIMIT 1 -- si existe mas de uno, se aborta con
//     VENTAS_REVERSION_FIDELIZACION_AMBIGUA en vez de tomar arbitrariamente
//     el primero por id_movimiento.
//  2) Calculo del objetivo (seccion 3.2): usa el RESULTADO ACUMULADO REAL
//     (facturaTotalmenteReversada, calculado por
//     computeAccumulatedResult en ventasReversionCalculationService.js)
//     para decidir si absorber el residuo completo, en vez de depender de
//     si el usuario solicito tipo_reversion=TOTAL (una reversion PARCIAL
//     que agota la ultima unidad pendiente debe comportarse igual que una
//     TOTAL).
//  3) Deuda de puntos (secciones 3.3/3.4): si el saldo disponible no
//     alcanza el objetivo, el remanente se registra de forma durable en
//     public.fidelizacion_ajustes_pendientes (nunca se descarta en
//     silencio). Si esa tabla no existe (migracion 20260728 no aplicada
//     todavia), aborta con FIDELIZACION_SCHEMA_PENDIENTE -- rollback
//     completo de la reversion, nunca confirma un estado inconsistente.
//  4) Trazabilidad por reversion (seccion 3.5): si
//     fidelizacion_movimientos.id_reversion existe (migracion 20260729),
//     crea un movimiento REVERSO INDEPENDIENTE por cada reversion en vez de
//     actualizar un unico movimiento mutable por factura. Si la columna no
//     existe todavia, conserva el comportamiento anterior (un unico
//     movimiento REVERSO por factura, actualizado en cada reversion
//     parcial subsiguiente) como respaldo seguro y equivalente.
import { parsePositiveInt } from '../utils/parseUtils.js';
import { getClienteSaldoForUpdate } from '../../../services/fidelizacionService.js';

export const createFidelizacionReversionError = (status, code, message) => {
  const error = new Error(message);
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = message;
  return error;
};

const schemaProbeCache = new Map();

const hasColumn = async (client, tableName, columnName) => {
  const key = `column:${tableName}.${columnName}`;
  if (schemaProbeCache.has(key)) return schemaProbeCache.get(key);
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName]
  );
  const exists = result.rowCount > 0;
  schemaProbeCache.set(key, exists);
  return exists;
};

const hasTable = async (client, tableName) => {
  const key = `table:${tableName}`;
  if (schemaProbeCache.has(key)) return schemaProbeCache.get(key);
  const result = await client.query('SELECT to_regclass($1) AS reg', [`public.${tableName}`]);
  const exists = Boolean(result.rows?.[0]?.reg);
  schemaProbeCache.set(key, exists);
  return exists;
};

// Exportado UNICAMENTE para pruebas -- ver el mismo mecanismo y
// justificacion en services/fidelizacionService.js:__resetFidelizacionSchemaProbeCachesForTests.
export const __resetVentasReversionFidelizacionSchemaProbeCacheForTests = () => {
  schemaProbeCache.clear();
};

/**
 * Localiza el UNICO movimiento fuente de acumulacion (ACUMULACION/FACTURA,
 * puntos_delta>0) de una factura, bloqueado FOR UPDATE. Nunca usa LIMIT 1
 * para descartar ambiguedad en silencio: 0 filas -> null (la factura no
 * genero puntos); 1 fila -> esa fila; 2+ filas ->
 * VENTAS_REVERSION_FIDELIZACION_AMBIGUA.
 */
export const resolveLoyaltySourceMovement = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT
        fm.id_movimiento,
        fm.id_cliente,
        fm.puntos_delta
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om ON om.id_origen_movimiento = fm.id_origen_movimiento
      WHERE fm.id_factura = $1
        AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
        AND UPPER(TRIM(om.codigo)) = 'FACTURA'
        AND fm.puntos_delta > 0
      ORDER BY fm.id_movimiento ASC
      FOR UPDATE OF fm
    `,
    [idFactura]
  );

  if (result.rowCount === 0) return null;
  if (result.rowCount > 1) {
    throw createFidelizacionReversionError(
      409,
      'VENTAS_REVERSION_FIDELIZACION_AMBIGUA',
      'Existen varios movimientos de acumulacion de puntos para esta factura; no se puede determinar cual reversar de forma segura.'
    );
  }
  return result.rows[0];
};

const resolveReverseCatalog = async (client) => {
  const result = await client.query(
    `
      SELECT
        tm.id_tipo_movimiento AS id_tipo_movimiento_reverso,
        om.id_origen_movimiento AS id_origen_movimiento_reverso
      FROM public.cat_fidelizacion_tipos_movimiento tm
      CROSS JOIN public.cat_fidelizacion_origenes_movimiento om
      WHERE UPPER(TRIM(tm.codigo)) = 'REVERSO'
        AND UPPER(TRIM(om.codigo)) = 'REVERSO_FACTURA'
        AND COALESCE(tm.estado, true) = true
        AND COALESCE(om.estado, true) = true
      LIMIT 1
    `
  );
  if (!result.rowCount) return null;
  return {
    reverseTypeId: Number(result.rows[0].id_tipo_movimiento_reverso),
    reverseOriginId: Number(result.rows[0].id_origen_movimiento_reverso)
  };
};

const sumReversedAmountAcumulado = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT COALESCE(SUM(monto_reversado), 0)::numeric AS monto_reversado_acumulado
      FROM public.facturas_reversiones
      WHERE id_factura_original = $1
        AND UPPER(TRIM(COALESCE(estado, ''))) = 'APLICADA'
    `,
    [idFactura]
  );
  return Number(result.rows?.[0]?.monto_reversado_acumulado || 0);
};

const sumAlreadyReversedPoints = async (client, idFactura) => {
  const result = await client.query(
    `
      SELECT COALESCE(SUM(ABS(puntos_delta)), 0)::int AS puntos_revertidos
      FROM public.fidelizacion_movimientos
      WHERE id_factura = $1
        AND puntos_delta < 0
    `,
    [idFactura]
  );
  return Number(result.rows?.[0]?.puntos_revertidos || 0);
};

/**
 * Objetivo acumulado de puntos a revertir (seccion 3.2 del ticket).
 * Cuando la reversion actual COMPLETA la factura (facturaTotalmenteReversada,
 * el resultado ACUMULADO real, no tipo_reversion), el objetivo es
 * exactamente el remanente de puntos originales (absorbe cualquier residuo
 * de redondeo de las proporciones anteriores). En caso contrario, es la
 * proporcion del monto reversado acumulado sobre el total original,
 * redondeada hacia abajo, menos lo ya revertido.
 */
export const computeLoyaltyReversalTarget = ({
  puntosOriginales,
  montoReversadoAcumulado,
  totalOriginalFactura,
  puntosRevertidosAnteriores,
  facturaTotalmenteReversada
}) => {
  const originales = Number(puntosOriginales || 0);
  const anteriores = Number(puntosRevertidosAnteriores || 0);
  if (originales <= 0) return 0;

  if (facturaTotalmenteReversada) {
    return Math.max(0, originales - anteriores);
  }

  const total = Number(totalOriginalFactura || 0);
  if (!(total > 0)) return 0;

  const objetivoAcumulado = Math.floor((originales * Number(montoReversadoAcumulado || 0)) / total);
  const objetivoClamped = Math.min(Math.max(0, objetivoAcumulado), originales);
  return Math.max(0, objetivoClamped - anteriores);
};

const insertLoyaltyReversalMovement = async ({
  client,
  idFactura,
  idSucursal,
  idCliente,
  idUsuario,
  tipoReversion,
  idReversion,
  codigoReversion,
  puntosAplicables,
  saldoAnterior,
  saldoNuevo,
  reverseTypeId,
  reverseOriginId
}) => {
  const observacion = `Reversión ${tipoReversion} de puntos por reversión de venta ${codigoReversion || ''}.`.trim();
  const canUseIdReversion = await hasColumn(client, 'fidelizacion_movimientos', 'id_reversion');

  if (canUseIdReversion) {
    // Fase 4: un movimiento REVERSO independiente por cada id_reversion.
    // Nunca se reutiliza/actualiza un movimiento existente de otra
    // reversion.
    const result = await client.query(
      `
        INSERT INTO public.fidelizacion_movimientos (
          id_cliente, id_sucursal, id_tipo_movimiento, puntos_delta,
          saldo_anterior, saldo_nuevo, id_origen_movimiento, id_factura,
          id_reversion, observacion, id_usuario_ejecutor, fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (id_reversion) DO NOTHING
        RETURNING id_movimiento
      `,
      [
        idCliente,
        idSucursal,
        reverseTypeId,
        puntosAplicables * -1,
        saldoAnterior,
        saldoNuevo,
        reverseOriginId,
        idFactura,
        idReversion,
        observacion,
        idUsuario
      ]
    );
    return Number(result.rows?.[0]?.id_movimiento || 0);
  }

  // Respaldo (columna aun no aplicada): comportamiento equivalente al
  // anterior a Fase 4 -- un unico movimiento REVERSO mutable por factura.
  const existingResult = await client.query(
    `
      SELECT id_movimiento, puntos_delta
      FROM public.fidelizacion_movimientos
      WHERE id_factura = $1
        AND id_tipo_movimiento = $2
        AND id_origen_movimiento = $3
      LIMIT 1
      FOR UPDATE
    `,
    [idFactura, reverseTypeId, reverseOriginId]
  );

  if (existingResult.rowCount) {
    const existing = existingResult.rows[0];
    const nuevoDelta = Number(existing.puntos_delta || 0) - puntosAplicables;
    await client.query(
      `
        UPDATE public.fidelizacion_movimientos
        SET puntos_delta = $1, saldo_nuevo = $2, observacion = $3, id_usuario_ejecutor = $4
        WHERE id_movimiento = $5
      `,
      [nuevoDelta, saldoNuevo, observacion, idUsuario, Number(existing.id_movimiento)]
    );
    return Number(existing.id_movimiento);
  }

  const inserted = await client.query(
    `
      INSERT INTO public.fidelizacion_movimientos (
        id_cliente, id_sucursal, id_tipo_movimiento, puntos_delta,
        saldo_anterior, saldo_nuevo, id_origen_movimiento, id_factura,
        observacion, id_usuario_ejecutor, fecha_creacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id_movimiento
    `,
    [idCliente, idSucursal, reverseTypeId, puntosAplicables * -1, saldoAnterior, saldoNuevo, reverseOriginId, idFactura, observacion, idUsuario]
  );
  return Number(inserted.rows?.[0]?.id_movimiento || 0);
};

/**
 * Registra (o confirma idempotentemente) la deuda de puntos que esta
 * reversion no pudo retirar de inmediato. UNIQUE(id_reversion) hace que un
 * reintento de la MISMA reversion (mismo id_reversion) sea un no-op
 * seguro via ON CONFLICT DO NOTHING.
 */
const upsertPendingAdjustment = async ({ client, idCliente, idFactura, idReversion, puntosObjetivo, puntosAplicables, idUsuarioEjecutor }) => {
  const puntosRecuperados = Math.max(0, Math.min(puntosAplicables, puntosObjetivo));
  const puntosPendientes = Math.max(0, puntosObjetivo - puntosRecuperados);
  if (puntosPendientes <= 0) return null;

  const estado = puntosRecuperados > 0 ? 'PARCIALMENTE_RECUPERADO' : 'PENDIENTE';
  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_ajustes_pendientes (
        id_cliente, id_factura, id_reversion, puntos_objetivo,
        puntos_recuperados, puntos_pendientes, estado, id_usuario_ejecutor
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id_reversion) DO NOTHING
      RETURNING id_ajuste
    `,
    [idCliente, idFactura, idReversion, puntosObjetivo, puntosRecuperados, puntosPendientes, estado, idUsuarioEjecutor]
  );

  return result.rows?.[0]?.id_ajuste ? Number(result.rows[0].id_ajuste) : null;
};

/**
 * Orquesta la reversion completa de puntos de fidelizacion para una
 * factura, dentro de la transaccion del llamador (nunca abre/cierra su
 * propia transaccion).
 */
export const applyLoyaltyReversalForFactura = async ({
  client,
  idFactura,
  idSucursal,
  idUsuario,
  tipoReversion,
  idReversion,
  codigoReversion,
  totalFactura,
  facturaTotalmenteReversada
}) => {
  const facturaId = parsePositiveInt(idFactura);
  const source = facturaId ? await resolveLoyaltySourceMovement(client, facturaId) : null;
  if (!source) return { applied: false, reason: 'NO_GENERO_PUNTOS' };

  const puntosOriginales = Number(source.puntos_delta || 0);
  if (puntosOriginales <= 0) return { applied: false, reason: 'NO_GENERO_PUNTOS' };

  const reverseCatalog = await resolveReverseCatalog(client);
  if (!reverseCatalog) return { applied: false, reason: 'LOYALTY_REVERSAL_CATALOG_MISSING' };

  const puntosYaRevertidos = await sumAlreadyReversedPoints(client, facturaId);
  const puntosDisponiblesParaReversar = Math.max(0, puntosOriginales - puntosYaRevertidos);
  if (puntosDisponiblesParaReversar <= 0) return { applied: false, reason: 'ALREADY_REVERSED' };

  const montoReversadoAcumulado = await sumReversedAmountAcumulado(client, facturaId);
  const puntosObjetivo = computeLoyaltyReversalTarget({
    puntosOriginales,
    montoReversadoAcumulado,
    totalOriginalFactura: totalFactura,
    puntosRevertidosAnteriores: puntosYaRevertidos,
    facturaTotalmenteReversada
  });
  if (puntosObjetivo <= 0) return { applied: false, reason: 'PARTIAL_WITHOUT_POINTS' };

  const saldo = await getClienteSaldoForUpdate(client, source.id_cliente);
  if (!saldo) return { applied: false, reason: 'NO_LOYALTY_BALANCE' };

  const saldoAnterior = Number(saldo.puntos_disponibles || 0);
  const puntosAplicables = Math.max(0, Math.min(puntosObjetivo, saldoAnterior));
  const puntosPendientesNuevos = Math.max(0, puntosObjetivo - puntosAplicables);

  // Si hara falta deuda pendiente y la tabla no existe, abortar ANTES de
  // tocar saldo/movimiento -- nunca dejar un estado parcial (saldo
  // retirado sin registro de deuda).
  if (puntosPendientesNuevos > 0) {
    const tableExists = await hasTable(client, 'fidelizacion_ajustes_pendientes');
    if (!tableExists) {
      throw createFidelizacionReversionError(
        409,
        'FIDELIZACION_SCHEMA_PENDIENTE',
        'Falta aplicar la migracion de ajustes pendientes de fidelizacion; no se puede completar la reversion de puntos de forma consistente.'
      );
    }
  }

  const nuevoSaldo = Math.max(0, saldoAnterior - puntosAplicables);
  const nuevoAcumulado = Math.max(0, Number(saldo.puntos_acumulados_total || 0) - puntosAplicables);

  let idMovimiento = null;
  if (puntosAplicables > 0) {
    await client.query(
      `
        UPDATE public.fidelizacion_saldos_cliente
        SET puntos_disponibles = $1, puntos_acumulados_total = $2, fecha_actualizacion = NOW()
        WHERE id_cliente = $3
      `,
      [nuevoSaldo, nuevoAcumulado, source.id_cliente]
    );
    await client.query('UPDATE public.clientes SET puntos = $1 WHERE id_cliente = $2', [nuevoSaldo, source.id_cliente]);

    idMovimiento = await insertLoyaltyReversalMovement({
      client,
      idFactura: facturaId,
      idSucursal,
      idCliente: source.id_cliente,
      idUsuario,
      tipoReversion,
      idReversion,
      codigoReversion,
      puntosAplicables,
      saldoAnterior,
      saldoNuevo: nuevoSaldo,
      reverseTypeId: reverseCatalog.reverseTypeId,
      reverseOriginId: reverseCatalog.reverseOriginId
    });
  }

  let idAjustePendiente = null;
  if (puntosPendientesNuevos > 0) {
    idAjustePendiente = await upsertPendingAdjustment({
      client,
      idCliente: source.id_cliente,
      idFactura: facturaId,
      idReversion,
      puntosObjetivo,
      puntosAplicables,
      idUsuarioEjecutor: idUsuario
    });
  }

  return {
    applied: puntosAplicables > 0 || puntosPendientesNuevos > 0,
    id_cliente: Number(source.id_cliente),
    puntos_objetivo: puntosObjetivo,
    puntos_revertidos: puntosAplicables,
    puntos_pendientes: puntosPendientesNuevos,
    saldo_anterior: saldoAnterior,
    saldo_nuevo: nuevoSaldo,
    id_movimiento: idMovimiento,
    id_ajuste_pendiente: idAjustePendiente
  };
};
