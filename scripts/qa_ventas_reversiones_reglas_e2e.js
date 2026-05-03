import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../config/db-connection.js';
import { createVentaReversion } from '../services/ventasReversionService.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const q1 = async (client, sql, params = []) => {
  const r = await client.query(sql, params);
  return r.rows[0] || null;
};
const qv = async (client, sql, params = [], field = 'value') => {
  const row = await q1(client, sql, params);
  return row ? row[field] : null;
};
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

const makeResult = () => ({
  parcial_bloqueada_una_linea_qty1: 'FAIL',
  total_permitida_una_linea_qty1: 'FAIL',
  parcial_permitida_qty_mayor_1: 'FAIL',
  parcial_permitida_varias_lineas: 'FAIL',
  total_permitida_varias_lineas: 'FAIL',
  mensaje_fuera_ventana_utf8: 'FAIL',
  rollback: 'FAIL'
});

const sanitizeDiagOrigin = (code) => {
  if (code === 'VENTAS_REVERSION_FUERA_VENTANA') return 'ventana';
  if (code === 'VENTAS_REVERSION_CAJA_ACTUAL_REQUERIDA') return 'caja';
  if (code === 'VENTAS_REVERSION_LINEA_AGOTADA') return 'linea_agotada';
  if (code === 'VENTAS_REVERSION_PARCIAL_NO_APLICA') return 'parcial_no_aplica';
  if (String(code || '').includes('SCOPE') || String(code || '').includes('FORBIDDEN')) return 'sucursal';
  if (String(code || '').includes('PERM')) return 'permiso';
  return 'otra_validacion';
};

const run = async () => {
  const output = makeResult();
  const evidence = { diagnostics: {}, cases: {}, fixtures: {}, rollback: {} };
  const created = {
    facturas: [], detalles: [], reversiones: [], cajas: [], sesiones: [], participantes: [], productos: [], clientes: []
  };

  const originalConnect = pool.connect.bind(pool);
  const tx = await originalConnect();
  const txQuery = async (query, params) => {
    const sql = typeof query === 'string' ? query : String(query?.text || '');
    if (/^\s*BEGIN\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*COMMIT\b/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*ROLLBACK\b/i.test(sql)) return { rows: [], rowCount: 0 };
    return tx.query(query, params);
  };
  const wrappedClient = { ...tx, query: txQuery, release: () => {} };

  try {
    await tx.query('BEGIN');
    pool.connect = async () => wrappedClient;

    const before = {
      facturas: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas')),
      detalle_facturas: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.detalle_facturas')),
      reversiones: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones')),
      reversiones_det: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_detalle')),
      caja_movs: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.cajas_movimientos')),
      inv_movs: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.movimientos_inventario'))
    };

    const user = await q1(tx, `
      SELECT u.id_usuario, u.nombre_usuario, e.id_sucursal,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre))), NULL) AS roles
      FROM public.usuarios u
      JOIN public.roles_usuarios ru ON ru.id_usuario=u.id_usuario
      JOIN public.roles r ON r.id_rol=ru.id_rol
      JOIN public.roles_permisos rp ON rp.id_rol=ru.id_rol
      JOIN public.permisos p ON p.id_permiso=rp.id_permiso
      LEFT JOIN public.empleados e ON e.id_empleado=u.id_empleado
      WHERE COALESCE(u.estado,true)=true
        AND UPPER(TRIM(p.nombre_permiso))='VENTAS_REVERSION_CREAR'
        AND e.id_sucursal IS NOT NULL
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
      ORDER BY u.id_usuario
      LIMIT 1
    `);
    ok(user, 'No hay usuario con VENTAS_REVERSION_CREAR');
    const idUsuario = Number(user.id_usuario);
    const idSucursal = Number(user.id_sucursal);

    const openState = await q1(tx, `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='ABIERTA' LIMIT 1`);
    const closedState = await q1(tx, `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='CERRADA' LIMIT 1`);
    const roleCaja = await q1(tx, `SELECT id_rol_participacion_caja FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado,true)=true ORDER BY id_rol_participacion_caja LIMIT 1`);
    const metodoPago = await q1(tx, `SELECT id_metodo_pago FROM public.cat_metodos_pago WHERE COALESCE(estado,true)=true ORDER BY id_metodo_pago LIMIT 1`);
    const almacen = await q1(tx, `SELECT id_almacen FROM public.almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen LIMIT 1`, [idSucursal]);
    ok(openState && closedState && roleCaja && metodoPago && almacen, 'Catalogos requeridos no disponibles');

    const cajaOriginal = await q1(tx, `INSERT INTO public.cajas (id_sucursal,id_usuario,estado,nombre_caja,codigo_caja,fecha_actualizacion) VALUES ($1,$2,true,$3,$4,NOW()) RETURNING id_caja`, [idSucursal, idUsuario, `QA ORIG ${Date.now()}`, `QAO-${Date.now()}`]);
    const cajaActual = await q1(tx, `INSERT INTO public.cajas (id_sucursal,id_usuario,estado,nombre_caja,codigo_caja,fecha_actualizacion) VALUES ($1,$2,true,$3,$4,NOW()) RETURNING id_caja`, [idSucursal, idUsuario, `QA ACT ${Date.now()}`, `QAA-${Date.now()}`]);
    created.cajas.push(Number(cajaOriginal.id_caja), Number(cajaActual.id_caja));

    const sesionOriginal = await q1(tx, `
      INSERT INTO public.cajas_sesiones (id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,id_usuario_apertura,monto_apertura,fecha_apertura,fecha_cierre,fecha_creacion,fecha_actualizacion)
      VALUES ($1,$2,$3,$4,$3,1000,NOW(),NOW(),NOW(),NOW()) RETURNING id_sesion_caja
    `, [Number(cajaOriginal.id_caja), idSucursal, idUsuario, Number(closedState.id_estado_sesion_caja)]);
    const sesionActual = await q1(tx, `
      INSERT INTO public.cajas_sesiones (id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,id_usuario_apertura,monto_apertura,fecha_apertura,fecha_creacion,fecha_actualizacion)
      VALUES ($1,$2,$3,$4,$3,1000,NOW(),NOW(),NOW()) RETURNING id_sesion_caja
    `, [Number(cajaActual.id_caja), idSucursal, idUsuario, Number(openState.id_estado_sesion_caja)]);
    created.sesiones.push(Number(sesionOriginal.id_sesion_caja), Number(sesionActual.id_sesion_caja));

    await tx.query(`
      INSERT INTO public.cajas_sesiones_participantes (id_sesion_caja,id_usuario,id_rol_participacion_caja,fecha_inicio,activo,fecha_creacion,fecha_actualizacion)
      VALUES ($1,$2,$3,NOW(),true,NOW(),NOW())
    `, [Number(sesionActual.id_sesion_caja), idUsuario, Number(roleCaja.id_rol_participacion_caja)]);

    const p1 = await q1(tx, `INSERT INTO public.productos (nombre_producto,precio,cantidad,descripcion_producto,id_almacen,stock_minimo,estado) VALUES ($1,25,300,$2,$3,0,true) RETURNING id_producto`, [`QA PROD A ${Date.now()}`, 'QA reversion A', Number(almacen.id_almacen)]);
    const p2 = await q1(tx, `INSERT INTO public.productos (nombre_producto,precio,cantidad,descripcion_producto,id_almacen,stock_minimo,estado) VALUES ($1,30,300,$2,$3,0,true) RETURNING id_producto`, [`QA PROD B ${Date.now()}`, 'QA reversion B', Number(almacen.id_almacen)]);
    created.productos.push(Number(p1.id_producto), Number(p2.id_producto));

    const mkCliente = async () => {
      const c = await q1(tx, `INSERT INTO public.clientes (fecha_ingreso,puntos,estado) VALUES (CURRENT_DATE,0,true) RETURNING id_cliente`);
      created.clientes.push(Number(c.id_cliente));
      return Number(c.id_cliente);
    };

    const mkFactura = async ({ code, hoursAgo = 0, lines }) => {
      const idCliente = await mkCliente();
      const fechaExpr = hoursAgo > 0 ? `NOW() - INTERVAL '${Number(hoursAgo)} hours'` : 'NOW()';
      const total = lines.reduce((a, b) => a + Number(b.cantidad) * Number(b.precio), 0);
      const f = await q1(tx, `
        INSERT INTO public.facturas (id_caja,id_pedido,id_sucursal,id_usuario,id_cliente,efectivo_entregado,cambio,fecha_hora_facturacion,isv_15,isv_18,id_sesion_caja,codigo_venta,fecha_operacion)
        VALUES ($1,NULL,$2,$3,$4,$5,0,${fechaExpr},0,0,$6,$7,(NOW() AT TIME ZONE 'America/Tegucigalpa')::date)
        RETURNING id_factura,codigo_venta,fecha_hora_facturacion,id_caja,id_sesion_caja,id_sucursal
      `, [Number(cajaOriginal.id_caja), idSucursal, idUsuario, idCliente, total, Number(sesionOriginal.id_sesion_caja), code]);
      const idFactura = Number(f.id_factura);
      created.facturas.push(idFactura);

      const insertedLines = [];
      for (const ln of lines) {
        const d = await q1(tx, `
          INSERT INTO public.detalle_facturas (id_factura,id_producto,id_descuento,cantidad,precio_unitario,sub_total,total_detalle,id_pedido)
          VALUES ($1,$2,NULL,$3,$4,$5,$6,NULL)
          RETURNING id_detalle_factura,cantidad,id_producto
        `, [idFactura, Number(ln.id_producto), Number(ln.cantidad), Number(ln.precio), Number(ln.cantidad) * Number(ln.precio), Number(ln.cantidad) * Number(ln.precio)]);
        created.detalles.push(Number(d.id_detalle_factura));
        insertedLines.push(d);
      }

      await tx.query(`
        INSERT INTO public.facturas_cobros (id_factura,id_sesion_caja,id_caja,id_sucursal,id_usuario_ejecutor,id_metodo_pago,monto,referencia,fecha_cobro,fecha_creacion)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
      `, [idFactura, Number(sesionOriginal.id_sesion_caja), Number(cajaOriginal.id_caja), idSucursal, idUsuario, Number(metodoPago.id_metodo_pago), total, `${code}-COBRO`]);

      return { ...f, id_factura: idFactura, lines: insertedLines, total };
    };

    const fxA = await mkFactura({ code: `QA-A-${Date.now()}`, lines: [{ id_producto: p1.id_producto, cantidad: 1, precio: 25 }] });
    const fxB = await mkFactura({ code: `QA-B-${Date.now()}`, lines: [{ id_producto: p1.id_producto, cantidad: 5, precio: 25 }] });
    const fxC = await mkFactura({ code: `QA-C-${Date.now()}`, lines: [{ id_producto: p1.id_producto, cantidad: 1, precio: 25 }, { id_producto: p2.id_producto, cantidad: 1, precio: 30 }] });
    const fxC2 = await mkFactura({ code: `QA-C2-${Date.now()}`, lines: [{ id_producto: p1.id_producto, cantidad: 2, precio: 25 }, { id_producto: p2.id_producto, cantidad: 1, precio: 30 }] });
    const fxD = await mkFactura({ code: `QA-D-${Date.now()}`, hoursAgo: 2, lines: [{ id_producto: p1.id_producto, cantidad: 1, precio: 25 }] });

    evidence.fixtures = {
      user: { id_usuario: idUsuario, nombre_usuario: user.nombre_usuario, id_sucursal: idSucursal },
      cajas: { id_caja_original: Number(cajaOriginal.id_caja), id_caja_actual: Number(cajaActual.id_caja), id_sesion_original: Number(sesionOriginal.id_sesion_caja), id_sesion_actual: Number(sesionActual.id_sesion_caja) },
      facturas: {
        A_qty1: { id_factura: fxA.id_factura, codigo_venta: fxA.codigo_venta },
        B_qty5: { id_factura: fxB.id_factura, codigo_venta: fxB.codigo_venta },
        C_multi: { id_factura: fxC.id_factura, codigo_venta: fxC.codigo_venta },
        C2_multi_total: { id_factura: fxC2.id_factura, codigo_venta: fxC2.codigo_venta },
        D_old: { id_factura: fxD.id_factura, codigo_venta: fxD.codigo_venta }
      }
    };

    const reqStub = { headers: { 'user-agent': 'qa-reversion-reglas-e2e/5.5.6' }, ip: '127.0.0.1' };

    // Paso 0 diagnóstico sobre TOTAL qty1
    let diagStatus = 201;
    let diagPayload = null;
    try {
      const data = await createVentaReversion({ idFactura: fxA.id_factura, idUsuario, req: reqStub, body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'diag total qty1' } });
      created.reversiones.push(Number(data.id_reversion));
      diagPayload = { success: true, data };
    } catch (e) {
      diagStatus = Number(e?.httpStatus || 500);
      diagPayload = { error: true, code: e?.code || 'UNEXPECTED', message: e?.publicMessage || e?.message || 'No se pudo completar la operación.' };
    }

    const inWindowA = await q1(tx, `SELECT CASE WHEN $1::timestamp >= (NOW() - INTERVAL '1 hour') THEN true ELSE false END AS in_window`, [fxA.fecha_hora_facturacion]);
    const prevRevA = Number(await qv(tx, `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_factura_original=$1`, [fxA.id_factura]));
    const pendingA = await tx.query(`
      SELECT df.id_detalle_factura, df.cantidad AS cantidad_vendida,
             COALESCE((SELECT SUM(rd.cantidad_revertida) FROM public.facturas_reversiones fr INNER JOIN public.facturas_reversiones_detalle rd ON rd.id_reversion=fr.id_reversion WHERE fr.id_factura_original=df.id_factura AND rd.id_detalle_factura=df.id_detalle_factura),0)::int AS cantidad_revertida,
             (df.cantidad - COALESCE((SELECT SUM(rd.cantidad_revertida) FROM public.facturas_reversiones fr INNER JOIN public.facturas_reversiones_detalle rd ON rd.id_reversion=fr.id_reversion WHERE fr.id_factura_original=df.id_factura AND rd.id_detalle_factura=df.id_detalle_factura),0)::int) AS cantidad_pendiente
      FROM public.detalle_facturas df WHERE df.id_factura=$1 ORDER BY df.id_detalle_factura
    `, [fxA.id_factura]);
    const openCajaActual = await q1(tx, `
      SELECT cs.id_sesion_caja, cs.id_caja
      FROM public.cajas_sesiones cs
      INNER JOIN public.cat_cajas_sesiones_estados cse ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
      INNER JOIN public.cajas_sesiones_participantes csp ON csp.id_sesion_caja = cs.id_sesion_caja AND csp.id_usuario = $2 AND COALESCE(csp.activo,true)=true
      WHERE cs.id_sucursal=$1 AND UPPER(TRIM(cse.codigo))='ABIERTA'
      ORDER BY cs.id_sesion_caja DESC LIMIT 1
    `, [idSucursal, idUsuario]);

    evidence.diagnostics.total_una_linea_qty1 = {
      status_http: diagStatus,
      error_code: diagPayload?.code || null,
      error_message: diagPayload?.message || null,
      id_factura: fxA.id_factura,
      codigo_venta: fxA.codigo_venta,
      fecha_hora_facturacion: fxA.fecha_hora_facturacion,
      dentro_ventana_1h: Boolean(inWindowA?.in_window),
      tiene_caja_original: Boolean(fxA.id_caja),
      existe_caja_actual_abierta: Boolean(openCajaActual?.id_sesion_caja),
      factura_tenia_reversion_previa: prevRevA > 0,
      cantidades_pendientes_por_linea: pendingA.rows,
      origen_error: sanitizeDiagOrigin(diagPayload?.code || null)
    };

    // Caso 1 (se crea factura limpia qty1 para parcial)
    const fxApartial = await mkFactura({ code: `QA-A2-${Date.now()}`, lines: [{ id_producto: p1.id_producto, cantidad: 1, precio: 25 }] });
    try {
      await createVentaReversion({
        idFactura: fxApartial.id_factura,
        idUsuario,
        req: reqStub,
        body: {
          tipo_reversion: 'PARCIAL',
          motivo: 'OTRO',
          observacion: 'parcial no aplica',
          lineas: [{ id_detalle_factura: Number(fxApartial.lines[0].id_detalle_factura), cantidad: 1 }]
        }
      });
    } catch (e) {
      evidence.cases.caso1 = { status: Number(e?.httpStatus || 500), code: e?.code, message: e?.publicMessage || e?.message, id_factura: fxApartial.id_factura, codigo_venta: fxApartial.codigo_venta };
      if (Number(e?.httpStatus) === 409 && e?.code === 'VENTAS_REVERSION_PARCIAL_NO_APLICA') output.parcial_bloqueada_una_linea_qty1 = 'OK';
    }

    // Caso 2 resultado usa diagnóstico previo (TOTAL qty1)
    evidence.cases.caso2 = {
      status: diagStatus,
      code: diagPayload?.code || null,
      message: diagPayload?.message || null,
      id_factura: fxA.id_factura,
      codigo_venta: fxA.codigo_venta,
      codigo_reversion: diagPayload?.data?.codigo_reversion || null
    };
    if (diagStatus === 201) output.total_permitida_una_linea_qty1 = 'OK';

    // Caso 3 parcial qty>1
    let partialB = null;
    try {
      partialB = await createVentaReversion({
        idFactura: fxB.id_factura,
        idUsuario,
        req: reqStub,
        body: {
          tipo_reversion: 'PARCIAL',
          motivo: 'OTRO',
          observacion: 'parcial qty>1',
          lineas: [{ id_detalle_factura: Number(fxB.lines[0].id_detalle_factura), cantidad: 2 }]
        }
      });
      created.reversiones.push(Number(partialB.id_reversion));
      const qtyRev = Number(partialB?.lineas?.[0]?.cantidad_revertida || 0);
      if (qtyRev === 2) output.parcial_permitida_qty_mayor_1 = 'OK';
    } catch (e) {
      partialB = { error: true, status: Number(e?.httpStatus || 500), code: e?.code, message: e?.publicMessage || e?.message };
    }
    evidence.cases.caso3 = { id_factura: fxB.id_factura, codigo_venta: fxB.codigo_venta, result: partialB };

    // Caso 4 parcial varias líneas
    let partialC = null;
    try {
      partialC = await createVentaReversion({
        idFactura: fxC.id_factura,
        idUsuario,
        req: reqStub,
        body: {
          tipo_reversion: 'PARCIAL',
          motivo: 'OTRO',
          observacion: 'parcial varias lineas',
          lineas: [{ id_detalle_factura: Number(fxC.lines[0].id_detalle_factura), cantidad: 1 }]
        }
      });
      created.reversiones.push(Number(partialC.id_reversion));
      if (Number(partialC?.id_reversion) > 0) output.parcial_permitida_varias_lineas = 'OK';
    } catch (e) {
      partialC = { error: true, status: Number(e?.httpStatus || 500), code: e?.code, message: e?.publicMessage || e?.message };
    }
    evidence.cases.caso4 = { id_factura: fxC.id_factura, codigo_venta: fxC.codigo_venta, result: partialC };

    // Caso 5 total varias líneas
    let totalC2 = null;
    try {
      totalC2 = await createVentaReversion({
        idFactura: fxC2.id_factura,
        idUsuario,
        req: reqStub,
        body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'total varias lineas' }
      });
      created.reversiones.push(Number(totalC2.id_reversion));
      if (Number(totalC2?.id_reversion) > 0) output.total_permitida_varias_lineas = 'OK';
    } catch (e) {
      totalC2 = { error: true, status: Number(e?.httpStatus || 500), code: e?.code, message: e?.publicMessage || e?.message };
    }
    evidence.cases.caso5 = { id_factura: fxC2.id_factura, codigo_venta: fxC2.codigo_venta, result: totalC2 };

    // Caso 6 fuera de ventana UTF-8
    let oldResp = null;
    try {
      await createVentaReversion({ idFactura: fxD.id_factura, idUsuario, req: reqStub, body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'fuera ventana' } });
      oldResp = { unexpected_success: true };
    } catch (e) {
      oldResp = { status: Number(e?.httpStatus || 500), code: e?.code, message: e?.publicMessage || e?.message };
      const msg = String(oldResp.message || '');
      const hasMojibake = /mÃ|Ã³|Ã¡|reversiÃ|mÃƒ/.test(msg);
      if (
        oldResp.status === 409 &&
        oldResp.code === 'VENTAS_REVERSION_FUERA_VENTANA' &&
        msg === 'La venta excede la ventana máxima de 1 hora para reversión.' &&
        !hasMojibake
      ) {
        output.mensaje_fuera_ventana_utf8 = 'OK';
      }
    }
    evidence.cases.caso6 = { id_factura: fxD.id_factura, codigo_venta: fxD.codigo_venta, result: oldResp };

    const afterInTx = {
      facturas: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas')),
      detalle_facturas: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.detalle_facturas')),
      reversiones: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones')),
      reversiones_det: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_detalle')),
      caja_movs: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.cajas_movimientos')),
      inv_movs: Number(await qv(tx, 'SELECT COUNT(*)::int AS value FROM public.movimientos_inventario'))
    };

    await tx.query('ROLLBACK');
    pool.connect = originalConnect;
    tx.release();

    const verify = await originalConnect();
    try {
      const remFact = Number(await qv(verify, `SELECT COUNT(*)::int AS value FROM public.facturas WHERE id_factura = ANY($1::int[])`, [created.facturas]));
      const remDet = Number(await qv(verify, `SELECT COUNT(*)::int AS value FROM public.detalle_facturas WHERE id_detalle_factura = ANY($1::int[])`, [created.detalles]));
      const remRev = created.reversiones.length
        ? Number(await qv(verify, `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_reversion = ANY($1::int[])`, [created.reversiones]))
        : 0;
      if (remFact === 0 && remDet === 0 && remRev === 0) output.rollback = 'OK';

      evidence.rollback = {
        created_ids: created,
        rows_remaining_after_rollback: { facturas: remFact, detalles: remDet, reversiones: remRev },
        snapshot_before: before,
        snapshot_after_in_tx: afterInTx
      };
    } finally {
      verify.release();
    }

    console.log('QA_REGLAS_RESULT_START');
    console.log(JSON.stringify(output, null, 2));
    console.log('QA_REGLAS_RESULT_END');

    console.log('QA_REGLAS_EVIDENCE_START');
    console.log(JSON.stringify(evidence, null, 2));
    console.log('QA_REGLAS_EVIDENCE_END');

    const hasFail = Object.values(output).some((s) => s !== 'OK');
    process.exitCode = hasFail ? 1 : 0;
  } catch (e) {
    try { await tx.query('ROLLBACK'); } catch {}
    pool.connect = originalConnect;
    tx.release();
    console.error('QA_REGLAS_FATAL', { message: e?.message, stack: e?.stack });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
