import { parsePositiveBigIntId } from './cajaFinancialLockService.js';

const METHOD_CODES = Object.freeze(['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']);

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const normalizeMethodCode = (value) => String(value || '').trim().toUpperCase();

const toBigIntText = (value) => parsePositiveBigIntId(value) || '0';

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
      payment_methods AS (
        SELECT
          mp.id_metodo_pago,
          UPPER(TRIM(mp.codigo)) AS codigo
        FROM public.cat_metodos_pago mp
        WHERE COALESCE(mp.estado, true) = true
          AND UPPER(TRIM(mp.codigo)) = ANY(ARRAY['EFECTIVO','TARJETA','TRANSFERENCIA']::text[])
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
      final_snapshot AS (
        SELECT
          sb.id_sesion_caja::text AS id_sesion_caja,
          sb.monto_apertura,
          COALESCE(mm.ingresos_manuales, 0)::numeric(14,2) AS ingresos_manuales,
          COALESCE(mm.egresos_manuales, 0)::numeric(14,2) AS egresos_manuales,
          COALESCE(SUM(CASE WHEN pm.codigo = 'EFECTIVO' THEN pbm.ventas_brutas - rbm.reversiones ELSE 0 END), 0)::numeric(14,2) AS ventas_efectivo_netas,
          COALESCE(SUM(CASE WHEN pm.codigo = 'TARJETA' THEN pbm.ventas_brutas - rbm.reversiones ELSE 0 END), 0)::numeric(14,2) AS ventas_tarjeta_netas,
          COALESCE(SUM(CASE WHEN pm.codigo = 'TRANSFERENCIA' THEN pbm.ventas_brutas - rbm.reversiones ELSE 0 END), 0)::numeric(14,2) AS ventas_transferencia_netas,
          COALESCE(SUM(CASE WHEN pm.codigo <> 'EFECTIVO' THEN pbm.ventas_brutas - rbm.reversiones ELSE 0 END), 0)::numeric(14,2) AS ventas_no_efectivo_netas,
          jsonb_agg(
            jsonb_build_object(
              'id_metodo_pago', pm.id_metodo_pago,
              'codigo', pm.codigo,
              'ventas_brutas', COALESCE(pbm.ventas_brutas, 0),
              'reversiones', COALESCE(rbm.reversiones, 0),
              'ventas_netas', COALESCE(pbm.ventas_brutas, 0) - COALESCE(rbm.reversiones, 0),
              'monto_teorico',
                CASE
                  WHEN pm.codigo = 'EFECTIVO' THEN sb.monto_apertura + COALESCE(pbm.ventas_brutas, 0) - COALESCE(rbm.reversiones, 0) + COALESCE(mm.ingresos_manuales, 0) - COALESCE(mm.egresos_manuales, 0)
                  ELSE COALESCE(pbm.ventas_brutas, 0) - COALESCE(rbm.reversiones, 0)
                END
            )
            ORDER BY pm.id_metodo_pago ASC
          ) AS metodos,
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
            'total_egresos_manuales', COALESCE(mm.egresos_manuales, 0)
          ) AS base_fingerprint
        FROM session_base sb
        CROSS JOIN payment_methods pm
        LEFT JOIN payments_by_method pbm ON pbm.id_metodo_pago = pm.id_metodo_pago
        LEFT JOIN reversions_by_method rbm ON rbm.id_metodo_pago = pm.id_metodo_pago
        CROSS JOIN manual_movements mm
        CROSS JOIN financial_fingerprint ff
        GROUP BY
          sb.id_sesion_caja,
          sb.monto_apertura,
          mm.ingresos_manuales,
          mm.egresos_manuales,
          mm.cantidad_movimientos,
          mm.max_id_movimiento_caja,
          ff.cantidad_cobros,
          ff.max_id_factura_cobro,
          ff.total_cobros,
          ff.cantidad_reversiones,
          ff.max_id_reversion,
          ff.total_reversado
      )
      SELECT
        fs.*,
        (
          fs.monto_apertura + fs.ventas_efectivo_netas + fs.ingresos_manuales - fs.egresos_manuales
        )::numeric(14,2) AS efectivo_teorico,
        fs.ventas_tarjeta_netas::numeric(14,2) AS tarjeta_teorico,
        fs.ventas_transferencia_netas::numeric(14,2) AS transferencia_teorico,
        (
          fs.monto_apertura + fs.ventas_efectivo_netas + fs.ingresos_manuales - fs.egresos_manuales
          + fs.ventas_tarjeta_netas
          + fs.ventas_transferencia_netas
        )::numeric(14,2) AS total_teorico,
        fs.base_fingerprint || jsonb_build_object(
          'efectivo_teorico', fs.monto_apertura + fs.ventas_efectivo_netas + fs.ingresos_manuales - fs.egresos_manuales,
          'tarjeta_teorico', fs.ventas_tarjeta_netas,
          'transferencia_teorico', fs.ventas_transferencia_netas,
          'total_teorico', fs.monto_apertura + fs.ventas_efectivo_netas + fs.ingresos_manuales - fs.egresos_manuales + fs.ventas_tarjeta_netas + fs.ventas_transferencia_netas
        ) AS fingerprint
      FROM final_snapshot fs
    `,
    [sessionId]
  );

  return normalizeSnapshot(result.rows?.[0] || {}, sessionId);
};
