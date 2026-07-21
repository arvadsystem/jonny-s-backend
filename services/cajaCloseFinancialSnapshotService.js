import { parsePositiveBigIntId } from './cajaFinancialLockService.js';

const METHOD_CODES = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeMethodCode = (value) => String(value || '').trim().toUpperCase();

const toBigIntText = (value) => parsePositiveBigIntId(value) || '0';

const createUnaccountablePaymentMethodError = (methods = []) => {
  const error = new Error('La sesion contiene cobros con un metodo de pago no contabilizable.');
  error.code = 'VENTAS_CAJAS_METODO_PAGO_NO_CONTABILIZABLE';
  error.httpStatus = 409;
  error.publicMessage = 'La sesion contiene cobros con un metodo de pago inactivo o sin clasificacion contable.';
  error.details = {
    metodos: methods.map((method) => ({
      id_metodo_pago: Number(method?.id_metodo_pago || 0) || null,
      codigo: normalizeMethodCode(method?.codigo) || null,
      motivo: String(method?.motivo || 'NO_CONTABILIZABLE')
    }))
  };
  return error;
};

const normalizeMethod = (row = {}) => ({
  id_metodo_pago: Number(row.id_metodo_pago || 0) || null,
  codigo: normalizeMethodCode(row.codigo),
  ventas_brutas: roundMoney(row.ventas_brutas),
  reversiones: roundMoney(row.reversiones),
  ventas_netas: roundMoney(row.ventas_netas),
  monto_teorico: roundMoney(row.monto_teorico)
});

const normalizeSnapshot = (row = {}, idSesionCaja) => {
  const metodos = (Array.isArray(row.metodos) ? row.metodos : [])
    .map(normalizeMethod)
    .filter((method) => METHOD_CODES.includes(method.codigo));
  const byCode = new Map(metodos.map((method) => [method.codigo, method]));

  for (const code of METHOD_CODES) {
    if (!byCode.has(code)) {
      const empty = normalizeMethod({ codigo: code });
      metodos.push(empty);
      byCode.set(code, empty);
    }
  }

  const orderedMethods = METHOD_CODES.map((code) => byCode.get(code));
  const fingerprint = row.fingerprint || {};

  const snapshot = {
    id_sesion_caja: toBigIntText(row.id_sesion_caja || idSesionCaja),
    monto_apertura: roundMoney(row.monto_apertura),
    metodos: orderedMethods,
    ventas_efectivo_netas: roundMoney(row.ventas_efectivo_netas),
    ventas_tarjeta_netas: roundMoney(row.ventas_tarjeta_netas),
    ventas_transferencia_netas: roundMoney(row.ventas_transferencia_netas),
    ventas_no_efectivo_netas: roundMoney(row.ventas_no_efectivo_netas),
    ingresos_manuales: roundMoney(row.ingresos_manuales),
    egresos_manuales: roundMoney(row.egresos_manuales),
    efectivo_teorico: roundMoney(row.efectivo_teorico),
    tarjeta_teorico: roundMoney(row.tarjeta_teorico),
    transferencia_teorico: roundMoney(row.transferencia_teorico),
    total_teorico: roundMoney(row.total_teorico),
    fingerprint: {
      cantidad_cobros: Number(fingerprint.cantidad_cobros || 0),
      max_id_factura_cobro: toBigIntText(fingerprint.max_id_factura_cobro),
      total_cobros: roundMoney(fingerprint.total_cobros),
      cantidad_reversiones: Number(fingerprint.cantidad_reversiones || 0),
      max_id_reversion: toBigIntText(fingerprint.max_id_reversion),
      total_reversado: roundMoney(fingerprint.total_reversado),
      cantidad_movimientos: Number(fingerprint.cantidad_movimientos || 0),
      max_id_movimiento_caja: toBigIntText(fingerprint.max_id_movimiento_caja),
      total_ingresos_manuales: roundMoney(fingerprint.total_ingresos_manuales),
      total_egresos_manuales: roundMoney(fingerprint.total_egresos_manuales),
      ventas_efectivo_netas: roundMoney(fingerprint.ventas_efectivo_netas),
      ventas_no_efectivo_netas: roundMoney(fingerprint.ventas_no_efectivo_netas),
      efectivo_teorico: roundMoney(fingerprint.efectivo_teorico),
      tarjeta_teorico: roundMoney(fingerprint.tarjeta_teorico),
      transferencia_teorico: roundMoney(fingerprint.transferencia_teorico),
      total_teorico: roundMoney(fingerprint.total_teorico)
    }
  };

  snapshot.montoApertura = snapshot.monto_apertura;
  snapshot.ventasEfectivoNetas = snapshot.ventas_efectivo_netas;
  snapshot.ventasTarjetaNetas = snapshot.ventas_tarjeta_netas;
  snapshot.ventasTransferenciaNetas = snapshot.ventas_transferencia_netas;
  snapshot.ventasNoEfectivoNetas = snapshot.ventas_no_efectivo_netas;
  snapshot.ingresosManuales = snapshot.ingresos_manuales;
  snapshot.egresosManuales = snapshot.egresos_manuales;
  snapshot.efectivoTeorico = snapshot.efectivo_teorico;
  snapshot.tarjetaTeorico = snapshot.tarjeta_teorico;
  snapshot.transferenciaTeorico = snapshot.transferencia_teorico;
  snapshot.totalTeorico = snapshot.total_teorico;
  snapshot.salesByCode = new Map(snapshot.metodos.map((method) => [method.codigo, method.ventas_brutas]));
  snapshot.reversionsByCode = new Map(snapshot.metodos.map((method) => [method.codigo, method.reversiones]));
  snapshot.salesNetByCode = new Map(snapshot.metodos.map((method) => [method.codigo, method.ventas_netas]));

  const catalogoRequerido = row.catalogo_requerido && typeof row.catalogo_requerido === 'object'
    ? row.catalogo_requerido
    : {};
  const buildCatalogValidation = (codigo, expectedAfectaEfectivo) => {
    const entry = catalogoRequerido[codigo] || {};
    const idMetodoPago = Number.isFinite(Number(entry.id_metodo_pago)) && Number(entry.id_metodo_pago) > 0
      ? Number(entry.id_metodo_pago)
      : null;
    const activo = entry.activo === true;
    const afectaEfectivo = entry.afecta_efectivo === true
      ? true
      : entry.afecta_efectivo === false ? false : null;

    let motivo = null;
    if (!idMetodoPago) motivo = 'NO_EXISTE';
    else if (!activo) motivo = 'INACTIVO';
    else if (afectaEfectivo !== expectedAfectaEfectivo) motivo = 'AFECTA_EFECTIVO_INCORRECTO';

    return {
      codigo,
      id_metodo_pago: idMetodoPago,
      activo,
      afecta_efectivo: afectaEfectivo,
      valido: motivo === null,
      motivo
    };
  };

  // Fuente de verdad para saber si EFECTIVO/TARJETA/TRANSFERENCIA/OTRO tienen
  // exactamente una configuracion valida en el catalogo. Reemplaza la
  // fabricacion silenciosa de filas con id_metodo_pago=null: el consumidor
  // (buildSegmentedArqueoComputation) debe consultar esto antes de confiar en
  // snapshot.metodos o en el bucket agrupado.
  snapshot.catalogValidation = {
    EFECTIVO: buildCatalogValidation('EFECTIVO', true),
    TARJETA: buildCatalogValidation('TARJETA', false),
    TRANSFERENCIA: buildCatalogValidation('TRANSFERENCIA', false),
    OTRO: buildCatalogValidation('OTRO', false)
  };

  const metodosAgrupados = Array.isArray(row.otros_no_efectivo_metodos_agrupados)
    ? row.otros_no_efectivo_metodos_agrupados.map((item) => ({
        codigo: normalizeMethodCode(item?.codigo),
        ventas_brutas: roundMoney(item?.ventas_brutas),
        reversiones: roundMoney(item?.reversiones),
        ventas_netas: roundMoney(item?.ventas_netas)
      }))
    : [];

  // Detalle de auditoria del bucket "otros no efectivo" (TARJETA/TRANSFERENCIA
  // excluidas). ventas_netas puede ser negativo (reversiones superiores a las
  // ventas del grupo); eso se resuelve en la capa de computo (5.4), no aqui.
  snapshot.otrosNoEfectivo = {
    ventas_brutas: roundMoney(row.otros_no_efectivo_ventas_brutas),
    reversiones: roundMoney(row.otros_no_efectivo_reversiones),
    ventas_netas: roundMoney(row.otros_no_efectivo_ventas_netas),
    metodos_agrupados: metodosAgrupados
  };

  return snapshot;
};

export const loadCajaCloseFinancialSnapshot = async ({ queryRunner, idSesionCaja }) => {
  const sessionId = parsePositiveBigIntId(idSesionCaja);
  if (!queryRunner || typeof queryRunner.query !== 'function') {
    throw new Error('queryRunner requerido para cargar snapshot financiero.');
  }
  if (!sessionId) {
    const error = new Error('id_sesion_caja invalido.');
    error.code = 'VENTAS_CAJAS_SESSION_ID_INVALID';
    error.httpStatus = 400;
    error.publicMessage = 'El id de sesion es invalido.';
    throw error;
  }

  const result = await queryRunner.query(
    `
      WITH session_base AS (
        SELECT
          cs.id_sesion_caja,
          COALESCE(cs.monto_apertura, 0)::numeric(14,2) AS monto_apertura
        FROM public.cajas_sesiones cs
        WHERE cs.id_sesion_caja = $1::bigint
        LIMIT 1
      ),
      payment_method_catalog AS (
        SELECT
          mp.id_metodo_pago,
          UPPER(TRIM(mp.codigo)) AS codigo,
          COALESCE(mp.estado, true) AS activo,
          mp.afecta_efectivo
        FROM public.cat_metodos_pago mp
      ),
      payment_methods AS (
        SELECT id_metodo_pago, codigo, afecta_efectivo
        FROM payment_method_catalog
        WHERE activo = true
          AND afecta_efectivo IS NOT NULL
      ),
      payments AS (
        SELECT
          fc.id_factura_cobro,
          fc.id_factura,
          fc.id_metodo_pago,
          COALESCE(fc.monto, 0)::numeric(14,2) AS monto
        FROM public.facturas_cobros fc
        WHERE fc.id_sesion_caja = $1::bigint
      ),
      invalid_payment_methods AS (
        SELECT DISTINCT
          p.id_metodo_pago,
          pmc.codigo,
          CASE
            WHEN pmc.id_metodo_pago IS NULL THEN 'NO_EXISTE'
            WHEN pmc.activo IS NOT TRUE THEN 'INACTIVO'
            ELSE 'SIN_CLASIFICACION_EFECTIVO'
          END AS motivo
        FROM payments p
        LEFT JOIN payment_method_catalog pmc
          ON pmc.id_metodo_pago = p.id_metodo_pago
        WHERE pmc.id_metodo_pago IS NULL
           OR pmc.activo IS NOT TRUE
           OR pmc.afecta_efectivo IS NULL
      ),
      invalid_payment_summary AS (
        SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id_metodo_pago', ipm.id_metodo_pago,
              'codigo', ipm.codigo,
              'motivo', ipm.motivo
            )
            ORDER BY ipm.id_metodo_pago
          ),
          '[]'::jsonb
        ) AS metodos_pago_invalidos
        FROM invalid_payment_methods ipm
      ),
      payments_by_method AS (
        SELECT
          pm.id_metodo_pago,
          COALESCE(SUM(p.monto), 0)::numeric(14,2) AS ventas_brutas
        FROM payment_methods pm
        LEFT JOIN payments p
          ON p.id_metodo_pago = pm.id_metodo_pago
        GROUP BY pm.id_metodo_pago
      ),
      reversion_source AS (
        SELECT
          fr.id_reversion,
          fr.id_factura_original,
          COALESCE(fr.monto_reversado, 0)::numeric(14,2) AS monto_reversado
        FROM public.facturas_reversiones fr
        WHERE UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
          AND (
            fr.id_sesion_caja_original = $1::bigint
            OR (
              fr.id_sesion_caja_original IS NULL
              AND EXISTS (
                SELECT 1
                FROM public.facturas_cobros fc_scope
                WHERE fc_scope.id_factura = fr.id_factura_original
                  AND fc_scope.id_sesion_caja = $1::bigint
              )
            )
          )
      ),
      reversion_lines AS (
        SELECT
          rs.id_reversion,
          rs.monto_reversado,
          fc.id_factura_cobro,
          fc.id_metodo_pago,
          COALESCE(fc.monto, 0)::numeric(14,2) AS monto_cobro,
          SUM(COALESCE(fc.monto, 0)) OVER (PARTITION BY rs.id_reversion)::numeric(14,2) AS total_cobrado,
          ROW_NUMBER() OVER (PARTITION BY rs.id_reversion ORDER BY fc.id_factura_cobro ASC) AS rn,
          COUNT(*) OVER (PARTITION BY rs.id_reversion) AS line_count
        FROM reversion_source rs
        INNER JOIN public.facturas_cobros fc
          ON fc.id_factura = rs.id_factura_original
      ),
      reversion_allocations AS (
        SELECT
          rl.id_reversion,
          rl.id_factura_cobro,
          rl.id_metodo_pago,
          CASE
            WHEN rl.total_cobrado <= 0 THEN 0::numeric(14,2)
            WHEN rl.rn = rl.line_count THEN
              (
                rl.monto_reversado
                - COALESCE(
                    SUM(ROUND((rl.monto_cobro / NULLIF(rl.total_cobrado, 0)) * rl.monto_reversado, 2))
                      OVER (
                        PARTITION BY rl.id_reversion
                        ORDER BY rl.id_factura_cobro ASC
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                      ),
                    0
                  )
              )::numeric(14,2)
            ELSE ROUND((rl.monto_cobro / NULLIF(rl.total_cobrado, 0)) * rl.monto_reversado, 2)::numeric(14,2)
          END AS monto_asignado
        FROM reversion_lines rl
      ),
      reversions_by_method AS (
        SELECT
          pm.id_metodo_pago,
          COALESCE(SUM(ra.monto_asignado), 0)::numeric(14,2) AS reversiones
        FROM payment_methods pm
        LEFT JOIN reversion_allocations ra
          ON ra.id_metodo_pago = pm.id_metodo_pago
        GROUP BY pm.id_metodo_pago
      ),
      manual_movements AS (
        SELECT
          COALESCE(SUM(
            CASE
              WHEN mt.signo = 1
                AND UPPER(TRIM(mt.codigo)) <> 'APERTURA'
                AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
              THEN cm.monto
              ELSE 0
            END
          ), 0)::numeric(14,2) AS ingresos_manuales,
          COALESCE(SUM(
            CASE
              WHEN mt.signo = -1
                AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
              THEN cm.monto
              ELSE 0
            END
          ), 0)::numeric(14,2) AS egresos_manuales,
          COUNT(*) FILTER (
            WHERE UPPER(TRIM(mt.codigo)) <> 'APERTURA'
              AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
          )::int AS cantidad_movimientos,
          COALESCE(MAX(cm.id_movimiento_caja) FILTER (
            WHERE UPPER(TRIM(mt.codigo)) <> 'APERTURA'
              AND UPPER(TRIM(mt.codigo)) NOT LIKE '%REVERSION%'
          ), 0)::text AS max_id_movimiento_caja
        FROM public.cajas_movimientos cm
        INNER JOIN public.cat_cajas_movimientos_tipos mt
          ON mt.id_tipo_movimiento_caja = cm.id_tipo_movimiento_caja
        WHERE cm.id_sesion_caja = $1::bigint
      ),
      financial_fingerprint AS (
        SELECT
          (SELECT COUNT(*)::int FROM payments) AS cantidad_cobros,
          (SELECT COALESCE(MAX(id_factura_cobro), 0)::text FROM payments) AS max_id_factura_cobro,
          (SELECT COALESCE(SUM(monto), 0)::numeric(14,2) FROM payments) AS total_cobros,
          (SELECT COUNT(*)::int FROM reversion_source) AS cantidad_reversiones,
          (SELECT COALESCE(MAX(id_reversion), 0)::text FROM reversion_source) AS max_id_reversion,
          (SELECT COALESCE(SUM(monto_reversado), 0)::numeric(14,2) FROM reversion_source) AS total_reversado
      ),
      method_totals AS (
        SELECT
          pm.id_metodo_pago,
          pm.codigo,
          pm.afecta_efectivo,
          COALESCE(pbm.ventas_brutas, 0)::numeric(14,2) AS ventas_brutas,
          COALESCE(rbm.reversiones, 0)::numeric(14,2) AS reversiones,
          (
            COALESCE(pbm.ventas_brutas, 0) - COALESCE(rbm.reversiones, 0)
          )::numeric(14,2) AS ventas_netas
        FROM payment_methods pm
        LEFT JOIN payments_by_method pbm
          ON pbm.id_metodo_pago = pm.id_metodo_pago
        LEFT JOIN reversions_by_method rbm
          ON rbm.id_metodo_pago = pm.id_metodo_pago
      ),
      aggregate_totals AS (
        SELECT
          COALESCE(SUM(CASE WHEN mt.afecta_efectivo IS TRUE THEN mt.ventas_netas ELSE 0 END), 0)::numeric(14,2) AS ventas_efectivo_netas,
          COALESCE(SUM(CASE WHEN mt.afecta_efectivo IS FALSE THEN mt.ventas_netas ELSE 0 END), 0)::numeric(14,2) AS ventas_no_efectivo_netas,
          COALESCE(SUM(CASE WHEN mt.codigo = 'TARJETA' THEN mt.ventas_netas ELSE 0 END), 0)::numeric(14,2) AS ventas_tarjeta_netas,
          COALESCE(SUM(CASE WHEN mt.codigo = 'TRANSFERENCIA' THEN mt.ventas_netas ELSE 0 END), 0)::numeric(14,2) AS ventas_transferencia_netas
        FROM method_totals mt
      ),
      required_codes AS (
        SELECT * FROM (VALUES ('EFECTIVO'), ('TARJETA'), ('TRANSFERENCIA'), ('OTRO')) AS v(codigo)
      ),
      -- Estado crudo del catalogo (exista o no, activo o no) para los 4 codigos
      -- que el cierre siempre necesita evaluar. Resuelve el id de OTRO por
      -- codigo exacto (no por MIN(id) arbitrario): el id_metodo_pago persistido
      -- y el metodo_pago_codigo persistido siempre corresponden a la misma fila
      -- del catalogo.
      required_catalog_state AS (
        SELECT
          rc.codigo AS codigo_requerido,
          pmc.id_metodo_pago,
          pmc.activo,
          pmc.afecta_efectivo
        FROM required_codes rc
        LEFT JOIN payment_method_catalog pmc ON pmc.codigo = rc.codigo
      ),
      required_catalog_json AS (
        SELECT jsonb_object_agg(
          codigo_requerido,
          jsonb_build_object(
            'id_metodo_pago', id_metodo_pago,
            'activo', activo,
            'afecta_efectivo', afecta_efectivo
          )
        ) AS catalogo_requerido
        FROM required_catalog_state
      ),
      -- Bucket "otros no efectivo": todo metodo activo con afecta_efectivo =
      -- false que no sea TARJETA/TRANSFERENCIA (OTRO y billeteras/enlaces de
      -- pago futuros). Calculado de forma explicita (no por resta del total)
      -- para poder exponer el detalle agrupado como informacion de auditoria.
      grouped_other_methods AS (
        SELECT mt.id_metodo_pago, mt.codigo, mt.ventas_brutas, mt.reversiones, mt.ventas_netas
        FROM method_totals mt
        WHERE mt.afecta_efectivo = false
          AND mt.codigo <> ALL(ARRAY['TARJETA','TRANSFERENCIA']::text[])
      ),
      grouped_other_summary AS (
        SELECT
          COALESCE(SUM(ventas_brutas), 0)::numeric(14,2) AS ventas_brutas,
          COALESCE(SUM(reversiones), 0)::numeric(14,2) AS reversiones,
          COALESCE(SUM(ventas_netas), 0)::numeric(14,2) AS ventas_netas,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'codigo', codigo,
                'ventas_brutas', ventas_brutas,
                'reversiones', reversiones,
                'ventas_netas', ventas_netas
              ) ORDER BY codigo
            ) FILTER (WHERE ventas_brutas <> 0 OR reversiones <> 0),
            '[]'::jsonb
          ) AS metodos_agrupados
        FROM grouped_other_methods
      ),
      segmented_methods AS (
        SELECT
          mt.id_metodo_pago,
          mt.codigo,
          mt.ventas_brutas,
          mt.reversiones,
          mt.ventas_netas,
          CASE
            WHEN mt.codigo = 'EFECTIVO' THEN
              sb.monto_apertura
              + at.ventas_efectivo_netas
              + COALESCE(mm.ingresos_manuales, 0)
              - COALESCE(mm.egresos_manuales, 0)
            ELSE mt.ventas_netas
          END::numeric(14,2) AS monto_teorico
        FROM method_totals mt
        CROSS JOIN session_base sb
        CROSS JOIN manual_movements mm
        CROSS JOIN aggregate_totals at
        WHERE mt.codigo = ANY(ARRAY['EFECTIVO','TARJETA','TRANSFERENCIA']::text[])
      ),
      final_snapshot AS (
        SELECT
          sb.id_sesion_caja::text AS id_sesion_caja,
          sb.monto_apertura,
          COALESCE(mm.ingresos_manuales, 0)::numeric(14,2) AS ingresos_manuales,
          COALESCE(mm.egresos_manuales, 0)::numeric(14,2) AS egresos_manuales,
          at.ventas_efectivo_netas,
          at.ventas_tarjeta_netas,
          at.ventas_transferencia_netas,
          at.ventas_no_efectivo_netas,
          (
            sb.monto_apertura
            + at.ventas_efectivo_netas
            + COALESCE(mm.ingresos_manuales, 0)
            - COALESCE(mm.egresos_manuales, 0)
          )::numeric(14,2) AS efectivo_teorico,
          at.ventas_tarjeta_netas::numeric(14,2) AS tarjeta_teorico,
          at.ventas_transferencia_netas::numeric(14,2) AS transferencia_teorico,
          (
            sb.monto_apertura
            + at.ventas_efectivo_netas
            + COALESCE(mm.ingresos_manuales, 0)
            - COALESCE(mm.egresos_manuales, 0)
            + at.ventas_no_efectivo_netas
          )::numeric(14,2) AS total_teorico,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id_metodo_pago', sm.id_metodo_pago,
                'codigo', sm.codigo,
                'ventas_brutas', sm.ventas_brutas,
                'reversiones', sm.reversiones,
                'ventas_netas', sm.ventas_netas,
                'monto_teorico', sm.monto_teorico
              )
              ORDER BY sm.id_metodo_pago ASC
            )
            FROM segmented_methods sm
          ), '[]'::jsonb) AS metodos,
          rcj.catalogo_requerido,
          gos.ventas_brutas AS otros_no_efectivo_ventas_brutas,
          gos.reversiones AS otros_no_efectivo_reversiones,
          gos.ventas_netas AS otros_no_efectivo_ventas_netas,
          gos.metodos_agrupados AS otros_no_efectivo_metodos_agrupados,
          ips.metodos_pago_invalidos,
          jsonb_build_object(
            'cantidad_cobros', COALESCE(ff.cantidad_cobros, 0),
            'max_id_factura_cobro', COALESCE(ff.max_id_factura_cobro, '0'),
            'total_cobros', COALESCE(ff.total_cobros, 0),
            'cantidad_reversiones', COALESCE(ff.cantidad_reversiones, 0),
            'max_id_reversion', COALESCE(ff.max_id_reversion, '0'),
            'total_reversado', COALESCE(ff.total_reversado, 0),
            'cantidad_movimientos', COALESCE(mm.cantidad_movimientos, 0),
            'max_id_movimiento_caja', COALESCE(mm.max_id_movimiento_caja, '0'),
            'total_ingresos_manuales', COALESCE(mm.ingresos_manuales, 0),
            'total_egresos_manuales', COALESCE(mm.egresos_manuales, 0),
            'ventas_efectivo_netas', at.ventas_efectivo_netas,
            'ventas_no_efectivo_netas', at.ventas_no_efectivo_netas,
            'efectivo_teorico',
              sb.monto_apertura + at.ventas_efectivo_netas + COALESCE(mm.ingresos_manuales, 0) - COALESCE(mm.egresos_manuales, 0),
            'tarjeta_teorico', at.ventas_tarjeta_netas,
            'transferencia_teorico', at.ventas_transferencia_netas,
            'total_teorico',
              sb.monto_apertura + at.ventas_efectivo_netas + COALESCE(mm.ingresos_manuales, 0) - COALESCE(mm.egresos_manuales, 0) + at.ventas_no_efectivo_netas
          ) AS fingerprint
        FROM session_base sb
        CROSS JOIN manual_movements mm
        CROSS JOIN financial_fingerprint ff
        CROSS JOIN aggregate_totals at
        CROSS JOIN invalid_payment_summary ips
        CROSS JOIN required_catalog_json rcj
        CROSS JOIN grouped_other_summary gos
      )
      SELECT fs.*
      FROM final_snapshot fs
    `,
    [sessionId]
  );

  const row = result.rows?.[0] || {};
  const invalidMethods = Array.isArray(row.metodos_pago_invalidos)
    ? row.metodos_pago_invalidos
    : [];
  if (invalidMethods.length > 0) {
    throw createUnaccountablePaymentMethodError(invalidMethods);
  }

  return normalizeSnapshot(row, sessionId);
};
