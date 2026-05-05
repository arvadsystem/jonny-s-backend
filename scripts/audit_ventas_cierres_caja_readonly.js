import pool from '../config/db-connection.js';

async function runAudit() {
  const client = await pool.connect();
  console.log('--- INICIANDO AUDITORIA READ-ONLY: VENTAS, CIERRES Y CAJAS ---\n');

  try {
    // 1. facturas sin id_caja
    const fSinCaja = await client.query(`
      SELECT id_factura, codigo_venta, fecha_operacion 
      FROM facturas 
      WHERE id_caja IS NULL
    `);
    console.log(`Facturas sin id_caja: ${fSinCaja.rowCount}`);

    // 2. facturas sin id_sesion_caja
    const fSinSesion = await client.query(`
      SELECT id_factura, codigo_venta, fecha_operacion 
      FROM facturas 
      WHERE id_sesion_caja IS NULL
    `);
    console.log(`Facturas sin id_sesion_caja: ${fSinSesion.rowCount}`);

    // 3. facturas_cobros sin id_caja (si la columna existe)
    try {
      const fcSinCaja = await client.query(`
        SELECT id_factura_cobro, id_factura 
        FROM facturas_cobros 
        WHERE id_caja IS NULL
      `);
      console.log(`Cobros sin id_caja: ${fcSinCaja.rowCount}`);
    } catch (e) {
      console.log(`Cobros sin id_caja: Columna id_caja no existe en facturas_cobros`);
    }

    // 4. facturas_cobros sin id_sesion_caja (si la columna existe)
    try {
      const fcSinSesion = await client.query(`
        SELECT id_factura_cobro, id_factura 
        FROM facturas_cobros 
        WHERE id_sesion_caja IS NULL
      `);
      console.log(`Cobros sin id_sesion_caja: ${fcSinSesion.rowCount}`);
    } catch (e) {
      console.log(`Cobros sin id_sesion_caja: Columna id_sesion_caja no existe en facturas_cobros`);
    }

    // 5. facturas sin cobros
    const fSinCobros = await client.query(`
      WITH facturas_totales AS (
        SELECT f.id_factura, f.codigo_venta, SUM(COALESCE(df.total_detalle, 0)) as total_calculado
        FROM facturas f
        LEFT JOIN detalle_facturas df ON df.id_factura = f.id_factura
        GROUP BY f.id_factura, f.codigo_venta
      )
      SELECT f.id_factura, f.codigo_venta 
      FROM facturas_totales f
      LEFT JOIN facturas_cobros fc ON fc.id_factura = f.id_factura
      WHERE fc.id_factura_cobro IS NULL
        AND (f.total_calculado IS NOT NULL AND f.total_calculado > 0)
    `);
    console.log(`Facturas (total > 0) sin cobros registrados: ${fSinCobros.rowCount}`);

    // 6. facturas cuya suma de cobros no coincide con total
    const fDiferenciaCobro = await client.query(`
      WITH facturas_totales AS (
        SELECT 
          f.id_factura, 
          f.codigo_venta, 
          ROUND(SUM(COALESCE(df.total_detalle, 0)) + COALESCE(f.isv_15, 0) + COALESCE(f.isv_18, 0), 2) as total_calculado
        FROM facturas f
        LEFT JOIN detalle_facturas df ON df.id_factura = f.id_factura
        GROUP BY f.id_factura, f.codigo_venta, f.isv_15, f.isv_18
      )
      SELECT f.id_factura, f.codigo_venta, f.total_calculado, SUM(fc.monto) as suma_cobros
      FROM facturas_totales f
      INNER JOIN facturas_cobros fc ON fc.id_factura = f.id_factura
      GROUP BY f.id_factura, f.codigo_venta, f.total_calculado
      HAVING f.total_calculado <> SUM(fc.monto)
    `);
    console.log(`Facturas con diferencia entre total y suma de cobros: ${fDiferenciaCobro.rowCount}`);
    if (fDiferenciaCobro.rowCount > 0) {
      console.log(fDiferenciaCobro.rows);
    }

    // 7. cobros con método inexistente
    const fcMetodoInvalido = await client.query(`
      SELECT fc.id_factura_cobro, fc.id_metodo_pago
      FROM facturas_cobros fc
      LEFT JOIN cat_metodos_pago cmp ON cmp.id_metodo_pago = fc.id_metodo_pago
      WHERE cmp.id_metodo_pago IS NULL
    `);
    console.log(`Cobros con metodo de pago inexistente: ${fcMetodoInvalido.rowCount}`);

    // 8. métodos de pago sin configuración afecta_efectivo
    try {
      const cmpSinConfig = await client.query(`
        SELECT id_metodo_pago, nombre 
        FROM cat_metodos_pago 
        WHERE afecta_efectivo IS NULL
      `);
      console.log(`Metodos de pago sin config afecta_efectivo: ${cmpSinConfig.rowCount}`);
    } catch (e) {
      console.log(`Metodos de pago sin config afecta_efectivo: Columna afecta_efectivo no existe en cat_metodos_pago`);
    }

    // 9. sesiones abiertas duplicadas por caja
    const sesAbiertasCaja = await client.query(`
      SELECT cs.id_caja, COUNT(*) as abiertas
      FROM cajas_sesiones cs
      INNER JOIN cat_cajas_sesiones_estados ce ON ce.id_estado_sesion_caja = cs.id_estado_sesion_caja
      WHERE ce.codigo = 'ABIERTA'
      GROUP BY cs.id_caja
      HAVING COUNT(*) > 1
    `);
    console.log(`Cajas con multiples sesiones abiertas: ${sesAbiertasCaja.rowCount}`);

    // 10. sesiones abiertas duplicadas por responsable
    const sesAbiertasResp = await client.query(`
      SELECT cs.id_usuario_responsable, COUNT(*) as abiertas
      FROM cajas_sesiones cs
      INNER JOIN cat_cajas_sesiones_estados ce ON ce.id_estado_sesion_caja = cs.id_estado_sesion_caja
      WHERE ce.codigo = 'ABIERTA'
      GROUP BY cs.id_usuario_responsable
      HAVING COUNT(*) > 1
    `);
    console.log(`Responsables con multiples sesiones abiertas simultaneas: ${sesAbiertasResp.rowCount}`);

    // 11. cierres duplicados por id_sesion_caja
    const cierresDuplicados = await client.query(`
      SELECT id_sesion_caja, COUNT(*) as cierres
      FROM cajas_cierres
      GROUP BY id_sesion_caja
      HAVING COUNT(*) > 1
    `);
    console.log(`Sesiones con multiples cierres registrados: ${cierresDuplicados.rowCount}`);

    // 12. ventas asociadas a sesiones cerradas con fecha posterior al cierre
    const ventasPosteriores = await client.query(`
      SELECT f.id_factura, f.fecha_hora_facturacion, cc.fecha_cierre
      FROM facturas f
      INNER JOIN cajas_cierres cc ON cc.id_sesion_caja = f.id_sesion_caja
      WHERE f.fecha_hora_facturacion > cc.fecha_cierre
    `);
    console.log(`Ventas registradas despues del cierre de la sesion: ${ventasPosteriores.rowCount}`);

    // 13. reversiones sin detalle
    const revSinDetalle = await client.query(`
      SELECT fr.id_reversion
      FROM facturas_reversiones fr
      LEFT JOIN facturas_reversiones_detalle dfr ON dfr.id_reversion = fr.id_reversion
      WHERE dfr.id_detalle_factura IS NULL
    `);
    console.log(`Reversiones sin detalle: ${revSinDetalle.rowCount}`);

    // 14. movimientos de reversión inconsistentes
    const revInconsistentes = await client.query(`
      SELECT fr.id_reversion, fr.monto_reversado, SUM(dfr.total_revertido) as suma_lineas
      FROM facturas_reversiones fr
      INNER JOIN facturas_reversiones_detalle dfr ON dfr.id_reversion = fr.id_reversion
      GROUP BY fr.id_reversion, fr.monto_reversado
      HAVING fr.monto_reversado <> SUM(dfr.total_revertido)
    `);
    console.log(`Reversiones con monto no coincidente con lineas: ${revInconsistentes.rowCount}`);

  } catch (err) {
    console.error('Error durante la auditoria:', err);
  } finally {
    client.release();
    pool.end();
    console.log('\n--- FIN DE AUDITORIA ---');
  }
}

runAudit();
