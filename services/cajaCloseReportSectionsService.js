import { parsePositiveBigIntId } from './cajaFinancialLockService.js';

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const cleanText = (value, fallback = 'N/A', maxLength = 300) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, maxLength);
};
const normalizeCode = (value, fallback = 'N/A') =>
  cleanText(value, fallback, 80).toUpperCase();

const emptySections = () => ({
  reversiones: {
    resumen: {
      cantidad_parciales: 0,
      cantidad_totales: 0,
      monto_total_reversado: 0
    },
    items: []
  },
  canjes_fidelizacion: {
    resumen: {
      cantidad_canjes: 0,
      cantidad_anulados: 0,
      total_puntos_canjeados: 0
    },
    items: []
  }
});

export const loadCajaCloseReportSections = async ({ queryRunner, idSesionCaja }) => {
  const sessionId = parsePositiveBigIntId(idSesionCaja);
  if (!queryRunner || typeof queryRunner.query !== 'function') {
    throw new Error('queryRunner requerido para cargar secciones del cierre.');
  }
  if (!sessionId) {
    const error = new Error('id_sesion_caja invalido.');
    error.code = 'VENTAS_CAJAS_SESSION_ID_INVALID';
    error.httpStatus = 400;
    throw error;
  }

  const [reversionsResult, redemptionsResult] = await Promise.all([
    queryRunner.query(
      `
        WITH scoped_reversions AS (
          SELECT
            fr.id_reversion,
            fr.codigo_reversion,
            fr.id_factura_original,
            fr.tipo_reversion,
            fr.motivo,
            fr.observacion,
            fr.monto_reversado,
            fr.creada_en,
            fr.creada_por,
            f.codigo_venta,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', per.nombre, per.apellido)), ''),
              NULLIF(TRIM(u.nombre_usuario), ''),
              CONCAT('Usuario #', fr.creada_por::text)
            ) AS usuario_nombre,
            CASE
              WHEN NOT EXISTS (
                SELECT 1
                FROM public.detalle_facturas df_total
                WHERE df_total.id_factura = fr.id_factura_original
                  AND COALESCE(df_total.cantidad, 1) > COALESCE((
                    SELECT SUM(frd_total.cantidad_revertida)
                    FROM public.facturas_reversiones fr_total
                    INNER JOIN public.facturas_reversiones_detalle frd_total
                      ON frd_total.id_reversion = fr_total.id_reversion
                    WHERE fr_total.id_factura_original = fr.id_factura_original
                      AND frd_total.id_detalle_factura = df_total.id_detalle_factura
                      AND UPPER(TRIM(COALESCE(fr_total.estado, ''))) = 'APLICADA'
                      AND (
                        fr_total.creada_en < fr.creada_en
                        OR (
                          fr_total.creada_en = fr.creada_en
                          AND fr_total.id_reversion <= fr.id_reversion
                        )
                      )
                  ), 0)
              ) THEN 'TOTAL'
              ELSE 'PARCIAL'
            END AS resultado_acumulado
          FROM public.facturas_reversiones fr
          INNER JOIN public.facturas f
            ON f.id_factura = fr.id_factura_original
          LEFT JOIN public.usuarios u
            ON u.id_usuario = fr.creada_por
          LEFT JOIN public.empleados e
            ON e.id_empleado = u.id_empleado
          LEFT JOIN public.personas per
            ON per.id_persona = e.id_persona
          WHERE fr.id_sesion_caja_original = $1::bigint
            AND UPPER(TRIM(COALESCE(fr.estado, ''))) = 'APLICADA'
        ),
        detail_by_reversion AS (
          SELECT
            frd.id_reversion,
            STRING_AGG(
              CONCAT(
                TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM frd.cantidad_revertida::text)),
                ' x ',
                COALESCE(
                  NULLIF(dfo.origen_snapshot->>'nombre_item', ''),
                  NULLIF(df.origen_snapshot->>'nombre_item', ''),
                  NULLIF(p.nombre_producto, ''),
                  NULLIF(r.nombre_receta, ''),
                  'Item'
                )
              ),
              ', ' ORDER BY frd.id_reversion_detalle
            ) AS detalle
          FROM public.facturas_reversiones_detalle frd
          INNER JOIN scoped_reversions sr
            ON sr.id_reversion = frd.id_reversion
          LEFT JOIN public.detalle_facturas df
            ON df.id_detalle_factura = frd.id_detalle_factura
          LEFT JOIN public.detalle_facturas_origen dfo
            ON dfo.id_detalle_factura = frd.id_detalle_factura
          LEFT JOIN public.productos p
            ON p.id_producto = COALESCE(frd.id_producto, dfo.id_producto, df.id_producto)
          LEFT JOIN public.recetas r
            ON r.id_receta = COALESCE(frd.id_receta, dfo.id_receta, df.id_receta::int)
          GROUP BY frd.id_reversion
        )
        SELECT sr.*, COALESCE(dr.detalle, 'Sin detalle') AS detalle
        FROM scoped_reversions sr
        LEFT JOIN detail_by_reversion dr
          ON dr.id_reversion = sr.id_reversion
        ORDER BY sr.creada_en ASC, sr.id_reversion ASC
      `,
      [sessionId]
    ),
    queryRunner.query(
      `
        WITH scoped_redemptions AS (
          SELECT
            fc.id_canje,
            fc.total_puntos,
            fc.fecha_creacion,
            ec.codigo AS estado_codigo,
            COALESCE(
              NULLIF(TRIM(emp.nombre_empresa), ''),
              NULLIF(TRIM(CONCAT_WS(' ', cli_per.nombre, cli_per.apellido)), ''),
              CONCAT('Cliente #', fc.id_cliente::text)
            ) AS cliente_nombre,
            COALESCE(
              NULLIF(TRIM(CONCAT_WS(' ', usr_per.nombre, usr_per.apellido)), ''),
              NULLIF(TRIM(usr.nombre_usuario), ''),
              CONCAT('Usuario #', fc.id_usuario_ejecutor::text)
            ) AS usuario_nombre
          FROM public.fidelizacion_canjes fc
          INNER JOIN public.cat_fidelizacion_estados_canje ec
            ON ec.id_estado_canje = fc.id_estado_canje
          LEFT JOIN public.clientes cli
            ON cli.id_cliente = fc.id_cliente
          LEFT JOIN public.personas cli_per
            ON cli_per.id_persona = cli.id_persona
          LEFT JOIN public.empresas emp
            ON emp.id_empresa = cli.id_empresa
          LEFT JOIN public.usuarios usr
            ON usr.id_usuario = fc.id_usuario_ejecutor
          LEFT JOIN public.empleados usr_emp
            ON usr_emp.id_empleado = usr.id_empleado
          LEFT JOIN public.personas usr_per
            ON usr_per.id_persona = usr_emp.id_persona
          WHERE fc.id_sesion_caja = $1::bigint
        ),
        products_by_redemption AS (
          SELECT
            fcd.id_canje,
            STRING_AGG(
              CONCAT(
                TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM fcd.cantidad::text)),
                ' x ',
                COALESCE(NULLIF(p.nombre_producto, ''), 'Producto')
              ),
              ', ' ORDER BY fcd.id_detalle_canje
            ) AS productos
          FROM public.fidelizacion_canjes_detalle fcd
          INNER JOIN scoped_redemptions sr
            ON sr.id_canje = fcd.id_canje
          LEFT JOIN public.productos p
            ON p.id_producto = fcd.id_producto
          GROUP BY fcd.id_canje
        )
        SELECT sr.*, COALESCE(pr.productos, 'Sin productos') AS productos
        FROM scoped_redemptions sr
        LEFT JOIN products_by_redemption pr
          ON pr.id_canje = sr.id_canje
        ORDER BY sr.fecha_creacion ASC, sr.id_canje ASC
      `,
      [sessionId]
    )
  ]);

  const sections = emptySections();
  sections.reversiones.items = (reversionsResult.rows || []).map((row) => ({
    id_reversion: String(row.id_reversion),
    hora: row.creada_en || null,
    codigo_reversion: cleanText(row.codigo_reversion, `REV-${row.id_reversion}`, 80),
    venta_original: cleanText(row.codigo_venta, `Venta #${row.id_factura_original}`, 80),
    tipo: normalizeCode(row.tipo_reversion),
    resultado_acumulado: normalizeCode(row.resultado_acumulado, 'NO_CONFIRMADO'),
    detalle: cleanText(row.detalle, 'Sin detalle', 500),
    motivo: cleanText(row.motivo, 'N/A', 120),
    observacion: cleanText(row.observacion, '', 240) || null,
    monto: roundMoney(row.monto_reversado),
    usuario: cleanText(row.usuario_nombre, 'No disponible', 160)
  }));
  sections.reversiones.resumen = {
    cantidad_parciales: sections.reversiones.items.filter((item) => item.tipo === 'PARCIAL').length,
    cantidad_totales: sections.reversiones.items.filter((item) => item.tipo === 'TOTAL').length,
    monto_total_reversado: roundMoney(
      sections.reversiones.items.reduce((sum, item) => sum + item.monto, 0)
    )
  };

  sections.canjes_fidelizacion.items = (redemptionsResult.rows || []).map((row) => ({
    id_canje: String(row.id_canje),
    hora: row.fecha_creacion || null,
    codigo_canje: `CAN-${String(row.id_canje).padStart(5, '0')}`,
    cliente: cleanText(row.cliente_nombre, `Cliente #${row.id_canje}`, 180),
    productos: cleanText(row.productos, 'Sin productos', 500),
    puntos: Math.max(0, Number(row.total_puntos || 0)),
    estado: normalizeCode(row.estado_codigo),
    usuario: cleanText(row.usuario_nombre, 'No disponible', 160)
  }));
  sections.canjes_fidelizacion.resumen = {
    cantidad_canjes: sections.canjes_fidelizacion.items.length,
    cantidad_anulados: sections.canjes_fidelizacion.items.filter((item) => item.estado === 'ANULADO').length,
    total_puntos_canjeados: sections.canjes_fidelizacion.items
      .filter((item) => item.estado !== 'ANULADO')
      .reduce((sum, item) => sum + item.puntos, 0)
  };

  return sections;
};
