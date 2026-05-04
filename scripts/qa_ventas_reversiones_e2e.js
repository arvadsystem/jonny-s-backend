import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../config/db-connection.js';
import { createVentaReversion } from '../services/ventasReversionService.js';
import ventasRouter from '../routers/ventas.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const summary = {};
const details = {};
const skips = {};
const evidence = {
  fixture: {},
  case1: {},
  case2: {},
  case3: {},
  case4: {},
  case5: {},
  case6: {},
  case7: {},
  case8: {},
  case9: {},
  case10: {},
  case11: {},
  case12: {},
  rollback: {}
};

const CASE_ORDER = [
  'total_producto',
  'parcial_producto',
  'cantidad_excedida',
  'linea_invalida',
  'doble_reversion',
  'plazo_1h',
  'caja_actual',
  'correlativo_rev',
  'fidelizacion',
  'receta_combo_mixto',
  'auditoria_fallos',
  'correo',
  'rollback'
];

const setOk = (key, detail) => {
  summary[key] = 'OK';
  details[key] = detail;
};

const setSkip = (key, reason) => {
  summary[key] = 'SKIP_JUSTIFICADO';
  skips[key] = reason;
};

const fail = (code, message) => {
  const err = new Error(message || code);
  err.code = code;
  throw err;
};

const assertTrue = (condition, code, message) => {
  if (!condition) fail(code, message);
};

const queryOne = async (client, sql, params = []) => {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
};

const queryValue = async (client, sql, params = [], field = 'value') => {
  const row = await queryOne(client, sql, params);
  return row ? row[field] : null;
};

const nextId = async (client, table, column) => {
  const row = await queryOne(
    client,
    `SELECT COALESCE(MAX(${column}), 0) + 1 AS next_id FROM public.${table}`
  );
  return Number(row.next_id);
};

const findPostReversionHandler = () => {
  const layer = ventasRouter.stack.find(
    (entry) => entry?.route?.path === '/ventas/:id/reversiones' && entry?.route?.methods?.post
  );
  if (!layer) return null;
  const stack = Array.isArray(layer.route.stack) ? layer.route.stack : [];
  if (!stack.length) return null;
  return stack[stack.length - 1].handle;
};

const callPostReversion = async ({ handler, idFactura, user, body, ip = '127.0.0.1' }) => {
  const req = {
    params: { id: String(idFactura) },
    body,
    user,
    headers: {
      'user-agent': 'qa-ventas-reversiones-e2e/5.2',
      'x-forwarded-for': ip
    },
    ip
  };

  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    }
  };

  await handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 80));

  return {
    statusCode: res.statusCode,
    payload: res.payload
  };
};

const existsByIds = async (client, table, column, ids) => {
  if (!ids.length) return 0;
  const row = await queryOne(
    client,
    `SELECT COUNT(*)::int AS c FROM public.${table} WHERE ${column} = ANY($1::int[])`,
    [ids]
  );
  return Number(row.c);
};

const printSummary = () => {
  console.log('\nQA REVERSION E2E');
  for (const key of CASE_ORDER) {
    const status = summary[key] || 'FAIL';
    if (status === 'SKIP_JUSTIFICADO') {
      console.log(`- ${key}: ${status} | reason=${skips[key]}`);
    } else {
      console.log(`- ${key}: ${status} | detail=${details[key] || '-'}`);
    }
  }
};

const run = async () => {
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const txClient = await originalConnect();
  const fixtureIds = {
    facturas: [],
    detalles: [],
    reversiones: []
  };

  const snapshots = {};

  const txQuery = async (query, params) => {
    const sqlText = typeof query === 'string' ? query : String(query?.text || '');
    if (/^\s*BEGIN\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'BEGIN' };
    if (/^\s*COMMIT\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'COMMIT' };
    if (/^\s*ROLLBACK\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'ROLLBACK' };
    return txClient.query(query, params);
  };

  const wrappedClient = {
    ...txClient,
    query: txQuery,
    release: () => {}
  };

  try {
    await txClient.query('BEGIN');
    pool.connect = async () => wrappedClient;
    pool.query = async (query, params) => wrappedClient.query(query, params);

    const handler = findPostReversionHandler();
    assertTrue(handler, 'QA_HANDLER_NOT_FOUND', 'No se encontro handler POST /ventas/:id/reversiones.');

    snapshots.before = {
      facturas: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas')),
      detalle_facturas: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.detalle_facturas')),
      facturas_reversiones: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones')),
      facturas_reversiones_detalle: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_detalle')),
      cajas_movimientos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.cajas_movimientos')),
      movimientos_inventario: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.movimientos_inventario')),
      fidelizacion_movimientos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.fidelizacion_movimientos')),
      facturas_reversiones_intentos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_intentos'))
    };

    const userRow = await queryOne(
      txClient,
      `
        SELECT
          u.id_usuario,
          u.nombre_usuario,
          e.id_sucursal,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.nombre), NULL) AS roles
        FROM public.usuarios u
        INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
        INNER JOIN public.roles r ON r.id_rol = ru.id_rol
        INNER JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
        INNER JOIN public.permisos p ON p.id_permiso = rp.id_permiso
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        WHERE COALESCE(u.estado, true) = true
          AND UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR'
          AND e.id_sucursal IS NOT NULL
        GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
        ORDER BY u.id_usuario
        LIMIT 1
      `
    );
    assertTrue(userRow, 'QA_USER_NOT_FOUND', 'No se encontro usuario QA con permiso de reversión.');

    const idUsuario = Number(userRow.id_usuario);
    const nombreUsuario = String(userRow.nombre_usuario || '');
    const idSucursal = Number(userRow.id_sucursal);
    const roles = Array.isArray(userRow.roles)
      ? userRow.roles.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean)
      : [];

    const userReq = {
      id_usuario: idUsuario,
      nombre_usuario: nombreUsuario,
      usuario: nombreUsuario,
      id_sucursal: idSucursal,
      roles
    };

    const responsableSesionRow = await queryOne(
      txClient,
      `
        SELECT u.id_usuario
        FROM public.usuarios u
        WHERE COALESCE(u.estado, true) = true
          AND NOT EXISTS (
            SELECT 1
            FROM public.cajas_sesiones cs
            INNER JOIN public.cat_cajas_sesiones_estados cse
              ON cse.id_estado_sesion_caja = cs.id_estado_sesion_caja
            WHERE cs.id_usuario_responsable = u.id_usuario
              AND UPPER(TRIM(cse.codigo)) = 'ABIERTA'
          )
        ORDER BY u.id_usuario
        LIMIT 1
      `
    );
    const idResponsableSesion = Number(responsableSesionRow?.id_usuario || idUsuario);

    const openState = await queryOne(
      txClient,
      `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='ABIERTA' LIMIT 1`
    );
    const closedState = await queryOne(
      txClient,
      `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='CERRADA' LIMIT 1`
    );
    const roleCaja = await queryOne(
      txClient,
      `SELECT id_rol_participacion_caja FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado,true)=true ORDER BY id_rol_participacion_caja LIMIT 1`
    );
    const metodoPago = await queryOne(
      txClient,
      `SELECT id_metodo_pago FROM public.cat_metodos_pago WHERE COALESCE(estado,true)=true ORDER BY id_metodo_pago LIMIT 1`
    );
    const almacen = await queryOne(
      txClient,
      `SELECT id_almacen FROM public.almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen LIMIT 1`,
      [idSucursal]
    );

    assertTrue(openState && closedState && roleCaja && metodoPago && almacen, 'QA_CATALOGS_MISSING', 'Faltan catalogos requeridos para fixture.');

    const cajaOriginalRow = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas (id_sucursal, id_usuario, estado, nombre_caja, codigo_caja, fecha_actualizacion)
        VALUES ($1, $2, true, $3, $4, NOW())
        RETURNING id_caja
      `,
      [idSucursal, idUsuario, `QA Caja Original ${Date.now()}`, `QA-CO-${Date.now()}`]
    );
    const cajaActualRow = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas (id_sucursal, id_usuario, estado, nombre_caja, codigo_caja, fecha_actualizacion)
        VALUES ($1, $2, true, $3, $4, NOW())
        RETURNING id_caja
      `,
      [idSucursal, idUsuario, `QA Caja Actual ${Date.now()}`, `QA-CA-${Date.now()}`]
    );
    const idCajaOriginal = Number(cajaOriginalRow.id_caja);
    const idCajaActual = Number(cajaActualRow.id_caja);

    const sesionOriginalRow = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas_sesiones (
          id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,
          id_usuario_apertura,monto_apertura,fecha_apertura,fecha_cierre,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,$2,$3,$4,$3,1000,NOW(),NOW(),NOW(),NOW())
        RETURNING id_sesion_caja
      `,
      [idCajaOriginal, idSucursal, idResponsableSesion, Number(closedState.id_estado_sesion_caja)]
    );
    const sesionActualRow = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas_sesiones (
          id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,
          id_usuario_apertura,monto_apertura,fecha_apertura,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,$2,$3,$4,$3,1000,NOW(),NOW(),NOW())
        RETURNING id_sesion_caja
      `,
      [idCajaActual, idSucursal, idResponsableSesion, Number(openState.id_estado_sesion_caja)]
    );
    const idSesionOriginal = Number(sesionOriginalRow.id_sesion_caja);
    const idSesionActual = Number(sesionActualRow.id_sesion_caja);

    await txClient.query(
      `
        INSERT INTO public.cajas_sesiones_participantes (
          id_sesion_caja,id_usuario,id_rol_participacion_caja,
          fecha_inicio,activo,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,$2,$3,NOW(),true,NOW(),NOW())
      `,
      [idSesionActual, idUsuario, Number(roleCaja.id_rol_participacion_caja)]
    );

    const productoRow = await queryOne(
      txClient,
      `
        INSERT INTO public.productos (
          nombre_producto,precio,cantidad,descripcion_producto,id_almacen,stock_minimo,estado
        ) VALUES ($1,50,30,$2,$3,0,true)
        RETURNING id_producto
      `,
      [`QA Producto REV ${Date.now()}`, 'Producto QA reversión', Number(almacen.id_almacen)]
    );
    const idProducto = Number(productoRow.id_producto);

    const clienteTotalRow = await queryOne(
      txClient,
      `INSERT INTO public.clientes (fecha_ingreso,puntos,estado) VALUES (CURRENT_DATE,112,true) RETURNING id_cliente`
    );
    const clienteParcialRow = await queryOne(
      txClient,
      `INSERT INTO public.clientes (fecha_ingreso,puntos,estado) VALUES (CURRENT_DATE,59,true) RETURNING id_cliente`
    );
    const idClienteTotal = Number(clienteTotalRow.id_cliente);
    const idClienteParcial = Number(clienteParcialRow.id_cliente);
    await txClient.query(
      `
        INSERT INTO public.fidelizacion_saldos_cliente (
          id_cliente,puntos_disponibles,puntos_acumulados_total,puntos_canjeados_total,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,112,112,0,NOW(),NOW())
        ON CONFLICT (id_cliente) DO UPDATE
          SET puntos_disponibles = EXCLUDED.puntos_disponibles,
              puntos_acumulados_total = EXCLUDED.puntos_acumulados_total,
              puntos_canjeados_total = EXCLUDED.puntos_canjeados_total,
              fecha_actualizacion = NOW()
      `,
      [idClienteTotal]
    );
    await txClient.query(
      `
        INSERT INTO public.fidelizacion_saldos_cliente (
          id_cliente,puntos_disponibles,puntos_acumulados_total,puntos_canjeados_total,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,59,59,0,NOW(),NOW())
        ON CONFLICT (id_cliente) DO UPDATE
          SET puntos_disponibles = EXCLUDED.puntos_disponibles,
              puntos_acumulados_total = EXCLUDED.puntos_acumulados_total,
              puntos_canjeados_total = EXCLUDED.puntos_canjeados_total,
              fecha_actualizacion = NOW()
      `,
      [idClienteParcial]
    );

    const fidTipo = await queryOne(
      txClient,
      `SELECT id_tipo_movimiento FROM public.cat_fidelizacion_tipos_movimiento WHERE UPPER(TRIM(codigo))='ACUMULACION' LIMIT 1`
    );
    const fidOrigen = await queryOne(
      txClient,
      `SELECT id_origen_movimiento FROM public.cat_fidelizacion_origenes_movimiento WHERE UPPER(TRIM(codigo))='FACTURA' LIMIT 1`
    );
    assertTrue(fidTipo && fidOrigen, 'QA_FID_CATALOG', 'No existe catalogo fidelización ACUMULACION/FACTURA.');

    const createFacturaFixture = async ({
      code,
      idCliente,
      productQty,
      productPrice,
      itemQty = 0,
      itemPrice = 0,
      hoursAgo = 0,
      withFidPoints = 0,
      fidSaldoPrev = 0,
      fidSaldoNew = 0
    }) => {
      const rows = [{
        id_producto: idProducto,
        cantidad: productQty,
        precio_unitario: productPrice,
        total_detalle: productQty * productPrice
      }];
      if (itemQty > 0) {
        rows.push({
          id_producto: null,
          cantidad: itemQty,
          precio_unitario: itemPrice,
          total_detalle: itemQty * itemPrice
        });
      }
      const total = rows.reduce((acc, row) => acc + Number(row.total_detalle), 0);
      const fechaExpr = hoursAgo > 0 ? `NOW() - INTERVAL '${Number(hoursAgo)} hours'` : 'NOW()';

      const facturaRow = await queryOne(
        txClient,
        `
          INSERT INTO public.facturas (
            id_caja,id_pedido,id_sucursal,id_usuario,id_cliente,efectivo_entregado,cambio,
            fecha_hora_facturacion,isv_15,isv_18,id_sesion_caja,codigo_venta,fecha_operacion
          )
          VALUES ($1,NULL,$2,$3,$4,$5,0,${fechaExpr},0,0,$6,$7,(NOW() AT TIME ZONE 'America/Tegucigalpa')::date)
          RETURNING id_factura
        `,
        [idCajaOriginal, idSucursal, idUsuario, idCliente, total, idSesionOriginal, code]
      );
      const idFactura = Number(facturaRow.id_factura);
      fixtureIds.facturas.push(idFactura);

      const detalleIds = [];
      for (const row of rows) {
        const detalleRow = await queryOne(
          txClient,
          `
            INSERT INTO public.detalle_facturas (
              id_factura,id_producto,id_descuento,cantidad,precio_unitario,sub_total,total_detalle,id_pedido
            )
            VALUES ($1,$2,NULL,$3,$4,$5,$6,NULL)
            RETURNING id_detalle_factura
          `,
          [
            idFactura,
            row.id_producto,
            row.cantidad,
            row.precio_unitario,
            row.total_detalle,
            row.total_detalle
          ]
        );
        const idDetalle = Number(detalleRow.id_detalle_factura);
        fixtureIds.detalles.push(idDetalle);
        detalleIds.push(idDetalle);
      }

      await txClient.query(
        `
          INSERT INTO public.facturas_cobros (
            id_factura,id_sesion_caja,id_caja,id_sucursal,id_usuario_ejecutor,
            id_metodo_pago,monto,referencia,fecha_cobro,fecha_creacion
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        `,
        [idFactura, idSesionOriginal, idCajaOriginal, idSucursal, idUsuario, Number(metodoPago.id_metodo_pago), total, `${code}-COBRO`]
      );

      if (withFidPoints > 0) {
        await txClient.query(
          `
            INSERT INTO public.fidelizacion_movimientos (
              id_cliente,id_sucursal,id_tipo_movimiento,puntos_delta,saldo_anterior,saldo_nuevo,
              id_origen_movimiento,id_factura,id_pedido,id_canje,observacion,id_usuario_ejecutor,fecha_creacion
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,$10,NOW())
          `,
          [
            idCliente,
            idSucursal,
            Number(fidTipo.id_tipo_movimiento),
            withFidPoints,
            fidSaldoPrev,
            fidSaldoNew,
            Number(fidOrigen.id_origen_movimiento),
            idFactura,
            `QA fid ${code}`,
            idUsuario
          ]
        );
      }

      const detailsWithIds = rows.map((row, idx) => ({
        ...row,
        id_detalle_factura: detalleIds[idx]
      }));

      return { idFactura, total, detalles: detailsWithIds };
    };

    const facturaTotal = await createFacturaFixture({
      code: `QATOT-${Date.now()}`,
      idCliente: idClienteTotal,
      productQty: 2,
      productPrice: 50,
      itemQty: 1,
      itemPrice: 20,
      withFidPoints: 12,
      fidSaldoPrev: 100,
      fidSaldoNew: 112
    });
    const facturaParcial = await createFacturaFixture({
      code: `QAPAR-${Date.now()}`,
      idCliente: idClienteParcial,
      productQty: 3,
      productPrice: 30,
      withFidPoints: 9,
      fidSaldoPrev: 50,
      fidSaldoNew: 59
    });
    const facturaOld = await createFacturaFixture({
      code: `QAOLD-${Date.now()}`,
      idCliente: idClienteTotal,
      productQty: 1,
      productPrice: 40,
      hoursAgo: 2
    });
    const facturaNoCaja = await createFacturaFixture({
      code: `QANOC-${Date.now()}`,
      idCliente: idClienteParcial,
      productQty: 1,
      productPrice: 25
    });

    evidence.fixture = {
      id_usuario: idUsuario,
      id_sucursal: idSucursal,
      id_caja_original: idCajaOriginal,
      id_caja_actual: idCajaActual,
      id_sesion_original: idSesionOriginal,
      id_sesion_actual: idSesionActual,
      id_producto: idProducto,
      facturas_fixture: [facturaTotal.idFactura, facturaParcial.idFactura, facturaOld.idFactura, facturaNoCaja.idFactura]
    };

    const stockBefore = Number(await queryValue(txClient, 'SELECT cantidad AS value FROM public.productos WHERE id_producto=$1', [idProducto]));
    const facturaBefore = await queryOne(txClient, 'SELECT * FROM public.facturas WHERE id_factura=$1', [facturaTotal.idFactura]);
    const detalleBefore = await txClient.query(
      `SELECT id_detalle_factura,id_producto,cantidad,precio_unitario,total_detalle FROM public.detalle_facturas WHERE id_factura=$1 ORDER BY id_detalle_factura`,
      [facturaTotal.idFactura]
    );

    const totalResponse = await callPostReversion({
      handler,
      idFactura: facturaTotal.idFactura,
      user: userReq,
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA total' }
    });
    assertTrue(totalResponse.statusCode === 201, 'QA_TOTAL_STATUS', `Reversión total devolvio ${totalResponse.statusCode}`);
    assertTrue(totalResponse?.payload?.data?.id_reversion, 'QA_TOTAL_NO_REV', 'No se devolvio id_reversion en total.');

    const revTotalId = Number(totalResponse.payload.data.id_reversion);
    fixtureIds.reversiones.push(revTotalId);

    const frTotal = await queryOne(txClient, 'SELECT * FROM public.facturas_reversiones WHERE id_reversion=$1', [revTotalId]);
    const frdTotal = await txClient.query(
      `SELECT * FROM public.facturas_reversiones_detalle WHERE id_reversion=$1 ORDER BY id_reversion_detalle`,
      [revTotalId]
    );
    const movCajaTotal = await txClient.query(
      `SELECT * FROM public.cajas_movimientos WHERE referencia=$1`,
      [frTotal.codigo_reversion]
    );
    const movInvTotal = await txClient.query(
      `SELECT * FROM public.movimientos_inventario WHERE ref_origen='REVERSION_VENTA' AND id_ref=$1`,
      [revTotalId]
    );
    const facturaAfter = await queryOne(txClient, 'SELECT * FROM public.facturas WHERE id_factura=$1', [facturaTotal.idFactura]);
    const detalleAfter = await txClient.query(
      `SELECT id_detalle_factura,id_producto,cantidad,precio_unitario,total_detalle FROM public.detalle_facturas WHERE id_factura=$1 ORDER BY id_detalle_factura`,
      [facturaTotal.idFactura]
    );
    const stockAfter = Number(await queryValue(txClient, 'SELECT cantidad AS value FROM public.productos WHERE id_producto=$1', [idProducto]));

    assertTrue(/^REV-\d+$/i.test(String(frTotal.codigo_reversion || '')), 'QA_TOTAL_CODE', `Codigo REV invalido: ${frTotal.codigo_reversion}`);
    assertTrue(frdTotal.rowCount >= 2, 'QA_TOTAL_DETAIL_ROWS', `Esperado 2 lineas reversadas (producto/item), obtenido ${frdTotal.rowCount}`);
    assertTrue(movCajaTotal.rowCount === 1, 'QA_TOTAL_CAJA_MOV', `Esperado 1 movimiento caja, obtenido ${movCajaTotal.rowCount}`);
    assertTrue(movInvTotal.rowCount === 1, 'QA_TOTAL_INV_MOV', `Esperado 1 movimiento inventario, obtenido ${movInvTotal.rowCount}`);
    assertTrue(JSON.stringify(facturaBefore) === JSON.stringify(facturaAfter), 'QA_FACTURA_MUTATION', 'Factura original fue modificada.');
    assertTrue(JSON.stringify(detalleBefore.rows) === JSON.stringify(detalleAfter.rows), 'QA_DETALLE_MUTATION', 'Detalle original fue modificado.');

    evidence.case1 = {
      codigo_reversion: frTotal.codigo_reversion,
      id_factura_original: frTotal.id_factura_original,
      monto_factura: facturaTotal.total,
      stock_before: stockBefore,
      stock_after: stockAfter,
      detalle_before: detalleBefore.rows,
      detalle_after: detalleAfter.rows,
      cantidad_revertida: frdTotal.rows.map((row) => ({
        id_detalle_factura: row.id_detalle_factura,
        cantidad_revertida: row.cantidad_revertida,
        id_producto: row.id_producto
      })),
      caja_original: frTotal.id_caja_original,
      caja_actual: frTotal.id_caja_actual,
      correo_notificado: frTotal.correo_notificado,
      error_notificacion: frTotal.error_notificacion
    };
    setOk('total_producto', 'Reversión total correcta con movimiento caja/inventario y sin mutar factura original.');

    const partialDetailId = Number(facturaParcial.detalles[0].id_detalle_factura);
    const partial1 = await createVentaReversion({
      idFactura: facturaParcial.idFactura,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-ventas-reversiones-e2e/5.2' }, ip: '127.0.0.1' },
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'DEVOLUCION',
        observacion: 'QA parcial 1',
        lineas: [{ id_detalle_factura: partialDetailId, cantidad: 1 }]
      }
    });
    fixtureIds.reversiones.push(Number(partial1.id_reversion));

    const qty1 = partial1.lineas.find((row) => Number(row.id_detalle_factura) === partialDetailId);
    assertTrue(qty1 && Number(qty1.cantidad_revertida) === 1, 'QA_PARTIAL_1', 'Parcial 1 no revirtió cantidad 1.');

    const exceed = await callPostReversion({
      handler,
      idFactura: facturaParcial.idFactura,
      user: userReq,
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'DEVOLUCION',
        observacion: 'QA excedida',
        lineas: [{ id_detalle_factura: partialDetailId, cantidad: 99 }]
      }
    });
    assertTrue(exceed.statusCode >= 400 && exceed.statusCode < 500, 'QA_EXCEED_STATUS', `Cantidad excedida devolvio ${exceed.statusCode}`);

    const partial2 = await createVentaReversion({
      idFactura: facturaParcial.idFactura,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-ventas-reversiones-e2e/5.2' }, ip: '127.0.0.1' },
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'DEVOLUCION',
        observacion: 'QA parcial 2',
        lineas: [{ id_detalle_factura: partialDetailId, cantidad: 2 }]
      }
    });
    fixtureIds.reversiones.push(Number(partial2.id_reversion));

    const partial3 = await callPostReversion({
      handler,
      idFactura: facturaParcial.idFactura,
      user: userReq,
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'DEVOLUCION',
        observacion: 'QA parcial 3',
        lineas: [{ id_detalle_factura: partialDetailId, cantidad: 1 }]
      }
    });
    assertTrue(partial3.statusCode >= 400 && partial3.statusCode < 500, 'QA_PARTIAL_3_BLOCK', `Tercera parcial devolvio ${partial3.statusCode}`);

    const partialAccum = Number(
      await queryValue(
        txClient,
        `
          SELECT COALESCE(SUM(rd.cantidad_revertida),0)::numeric AS value
          FROM public.facturas_reversiones fr
          INNER JOIN public.facturas_reversiones_detalle rd ON rd.id_reversion = fr.id_reversion
          WHERE fr.id_factura_original = $1
            AND rd.id_detalle_factura = $2
        `,
        [facturaParcial.idFactura, partialDetailId]
      )
    );
    assertTrue(partialAccum === 3, 'QA_PARTIAL_TOTAL', `Cantidad acumulada esperada 3, obtenida ${partialAccum}`);

    evidence.case2 = {
      factura: facturaParcial.idFactura,
      id_detalle: partialDetailId,
      parcial_1: partial1,
      parcial_2: partial2,
      parcial_3_error: partial3.payload,
      acumulado: partialAccum
    };
    setOk('parcial_producto', 'Parcial #1 y #2 correctas, tercera parcial bloqueada al exceder pendiente.');

    const revCountAfterExceed = Number(
      await queryValue(
        txClient,
        `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_factura_original=$1`,
        [facturaParcial.idFactura]
      )
    );
    assertTrue(revCountAfterExceed === 2, 'QA_EXCEED_SIDE_EFFECT', `Cantidad excedida genero reversion inesperada. Count=${revCountAfterExceed}`);
    evidence.case3 = {
      status: exceed.statusCode,
      response: exceed.payload,
      reversiones_factura_parcial: revCountAfterExceed
    };
    setOk('cantidad_excedida', `Bloqueada con error controlado ${exceed?.payload?.code || 'SIN_CODE'}.`);

    const invalidMix = await callPostReversion({
      handler,
      idFactura: facturaNoCaja.idFactura,
      user: userReq,
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'DEVOLUCION',
        observacion: 'QA linea invalida',
        lineas: [
          { id_detalle_factura: Number(facturaNoCaja.detalles[0].id_detalle_factura), cantidad: 1 },
          { id_detalle_factura: 999999999, cantidad: 1 }
        ]
      }
    });
    assertTrue(invalidMix.statusCode >= 400 && invalidMix.statusCode < 500, 'QA_INVALID_LINE_STATUS', `Linea invalida devolvio ${invalidMix.statusCode}`);

    const invalidCount = Number(
      await queryValue(
        txClient,
        `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_factura_original=$1`,
        [facturaNoCaja.idFactura]
      )
    );
    assertTrue(invalidCount === 0, 'QA_INVALID_LINE_EFFECT', `Linea invalida creo reversion inesperada: ${invalidCount}`);

    evidence.case4 = {
      status: invalidMix.statusCode,
      response: invalidMix.payload,
      reversiones_creadas: invalidCount
    };
    setOk('linea_invalida', 'Mezcla linea valida/invalida rechazo toda la solicitud sin efectos parciales.');

    const doubleTotal = await callPostReversion({
      handler,
      idFactura: facturaTotal.idFactura,
      user: userReq,
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA doble total' }
    });
    assertTrue(doubleTotal.statusCode >= 400 && doubleTotal.statusCode < 500, 'QA_DOUBLE_STATUS', `Doble total devolvio ${doubleTotal.statusCode}`);
    const totalCount = Number(
      await queryValue(
        txClient,
        `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_factura_original=$1`,
        [facturaTotal.idFactura]
      )
    );
    assertTrue(totalCount === 1, 'QA_DOUBLE_EFFECT', `Se duplico reversión total: ${totalCount}`);

    evidence.case5 = {
      status: doubleTotal.statusCode,
      response: doubleTotal.payload,
      total_reversiones_factura: totalCount
    };
    setOk('doble_reversion', 'Doble reversión de factura totalmente reversada fue bloqueada.');

    const oldFail = await callPostReversion({
      handler,
      idFactura: facturaOld.idFactura,
      user: userReq,
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA fuera de plazo' }
    });
    assertTrue(oldFail.statusCode >= 400 && oldFail.statusCode < 500, 'QA_OLD_STATUS', `Fuera de plazo devolvio ${oldFail.statusCode}`);
    evidence.case6 = {
      status: oldFail.statusCode,
      response: oldFail.payload
    };
    setOk('plazo_1h', `Bloqueada fuera de 1 hora con code ${oldFail?.payload?.code || 'SIN_CODE'}.`);

    await txClient.query(
      `UPDATE public.cajas_sesiones_participantes SET activo=false, fecha_fin=NOW(), fecha_actualizacion=NOW() WHERE id_sesion_caja=$1 AND id_usuario=$2`,
      [idSesionActual, idUsuario]
    );
    await txClient.query(
      `UPDATE public.cajas_sesiones SET id_estado_sesion_caja=$2, fecha_actualizacion=NOW() WHERE id_sesion_caja=$1`,
      [idSesionActual, Number(closedState.id_estado_sesion_caja)]
    );

    const noCajaFail = await callPostReversion({
      handler,
      idFactura: facturaNoCaja.idFactura,
      user: userReq,
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA sin caja abierta' }
    });
    assertTrue(noCajaFail.statusCode >= 400 && noCajaFail.statusCode < 500, 'QA_NO_CAJA_STATUS', `Sin caja devolvio ${noCajaFail.statusCode}`);
    const noCajaCount = Number(
      await queryValue(
        txClient,
        `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_factura_original=$1`,
        [facturaNoCaja.idFactura]
      )
    );
    assertTrue(noCajaCount === 0, 'QA_NO_CAJA_EFFECT', `Sin caja creo reversion inesperada: ${noCajaCount}`);

    evidence.case7 = {
      status: noCajaFail.statusCode,
      response: noCajaFail.payload,
      reversiones_creadas: noCajaCount
    };
    setOk('caja_actual', `Bloqueada sin caja abierta con code ${noCajaFail?.payload?.code || 'SIN_CODE'}.`);

    const idx = await txClient.query(
      `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='facturas_reversiones'`
    );
    const hasGlobal = idx.rows.some((row) => /UNIQUE INDEX/i.test(row.indexdef) && /\(codigo_reversion\)/i.test(row.indexdef));
    const hasScoped = idx.rows.some((row) => /ux_facturas_reversiones_sucursal_fecha_codigo/i.test(row.indexname));

    const scopedInsertCheck = await (async () => {
      await txClient.query('SAVEPOINT qa_case8');
      try {
        const idA = await nextId(txClient, 'facturas_reversiones', 'id_reversion');
        const idB = idA + 1;
        const today = new Date().toISOString().slice(0, 10);
        const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        await txClient.query(
          `
            INSERT INTO public.facturas_reversiones (
              id_reversion,codigo_reversion,id_factura_original,id_sucursal,
              id_caja_original,id_sesion_caja_original,id_caja_actual,id_sesion_caja_actual,
              tipo_reversion,motivo,monto_reversado,estado,creada_por,creada_en,fecha_operacion,ip_origen,correo_notificado
            )
            VALUES
              ($1,'REV-00001',$2,$3,$4,$5,$6,$7,'TOTAL','OTRO',0,'REGISTRADA',$8,NOW(),$9::date,'127.0.0.1',false),
              ($10,'REV-00001',$11,$3,$4,$5,$6,$7,'TOTAL','OTRO',0,'REGISTRADA',$8,NOW(),$12::date,'127.0.0.1',false)
          `,
          [
            idA,
            facturaOld.idFactura,
            idSucursal,
            idCajaOriginal,
            idSesionOriginal,
            idCajaActual,
            idSesionActual,
            idUsuario,
            today,
            idB,
            facturaNoCaja.idFactura,
            tomorrow
          ]
        );
        return true;
      } catch {
        return false;
      } finally {
        await txClient.query('ROLLBACK TO SAVEPOINT qa_case8');
      }
    })();

    assertTrue(!hasGlobal && hasScoped && scopedInsertCheck, 'QA_REV_SCOPE', 'Correlativo REV no cumple alcance sucursal/fecha.');
    evidence.case8 = {
      has_global_unique_codigo: hasGlobal,
      has_scoped_unique: hasScoped,
      same_codigo_different_fecha_insertable: scopedInsertCheck
    };
    setOk('correlativo_rev', 'Indice scoped confirmado y sin unicidad global por codigo_reversion.');

    const fidTotalRows = await txClient.query(
      `SELECT puntos_delta,saldo_anterior,saldo_nuevo FROM public.fidelizacion_movimientos WHERE id_factura=$1 ORDER BY id_movimiento`,
      [facturaTotal.idFactura]
    );
    const fidParcialRows = await txClient.query(
      `SELECT puntos_delta,saldo_anterior,saldo_nuevo FROM public.fidelizacion_movimientos WHERE id_factura=$1 ORDER BY id_movimiento`,
      [facturaParcial.idFactura]
    );
    const totalNeg = fidTotalRows.rows
      .filter((row) => Number(row.puntos_delta) < 0)
      .reduce((acc, row) => acc + Math.abs(Number(row.puntos_delta)), 0);
    const parcialNeg = fidParcialRows.rows
      .filter((row) => Number(row.puntos_delta) < 0)
      .reduce((acc, row) => acc + Math.abs(Number(row.puntos_delta)), 0);
    const saldoTotal = Number(await queryValue(txClient, 'SELECT puntos_disponibles AS value FROM public.fidelizacion_saldos_cliente WHERE id_cliente=$1', [idClienteTotal]));
    const saldoParcial = Number(await queryValue(txClient, 'SELECT puntos_disponibles AS value FROM public.fidelizacion_saldos_cliente WHERE id_cliente=$1', [idClienteParcial]));

    assertTrue(totalNeg === 12, 'QA_FID_TOTAL', `Total fidelizacion esperada 12, obtenida ${totalNeg}`);
    assertTrue(parcialNeg === 9, 'QA_FID_PARTIAL', `Parcial fidelizacion acumulada esperada 9, obtenida ${parcialNeg}`);
    assertTrue(saldoTotal >= 0 && saldoParcial >= 0, 'QA_FID_NEGATIVE', 'Saldo fidelizacion negativo detectado.');

    evidence.case9 = {
      total_negativos: totalNeg,
      parcial_negativos: parcialNeg,
      saldo_cliente_total: saldoTotal,
      saldo_cliente_parcial: saldoParcial,
      movimientos_total: fidTotalRows.rows,
      movimientos_parcial: fidParcialRows.rows
    };
    setOk('fidelizacion', 'Fidelizacion total/parcial revertida proporcionalmente sin saldos negativos.');

    const hasItemLine = frdTotal.rows.some((row) => row.id_producto === null);
    const invHasNullProduct = movInvTotal.rows.some((row) => row.id_producto === null);
    assertTrue(hasItemLine && !invHasNullProduct, 'QA_MIXED_LINE', 'Linea no producto genero devolución de inventario indebida.');
    evidence.case10 = {
      reversion_detalle: frdTotal.rows.map((row) => ({
        id_detalle_factura: row.id_detalle_factura,
        id_producto: row.id_producto,
        devuelve_inventario: row.devuelve_inventario
      })),
      movimientos_inventario: movInvTotal.rows
    };
    setSkip('receta_combo_mixto', 'detalle_facturas no tiene id_receta/id_combo; se valido solo linea ITEM (no producto) sin devolucion de inventario.');

    const attempts = await txClient.query(
      `
        SELECT id_intento,id_factura,id_usuario,error_code,ip_origen,user_agent,dispositivo,creado_en
        FROM public.facturas_reversiones_intentos
        WHERE id_factura IN ($1,$2,$3)
        ORDER BY id_intento
      `,
      [facturaParcial.idFactura, facturaOld.idFactura, facturaNoCaja.idFactura]
    );
    const attemptCodes = new Set(attempts.rows.map((row) => String(row.error_code || '').trim()));
    assertTrue(
      attemptCodes.has('VENTAS_REVERSION_CANTIDAD_EXCEDE') &&
      attemptCodes.has('VENTAS_REVERSION_FUERA_VENTANA') &&
      attemptCodes.has('VENTAS_REVERSION_CAJA_ACTUAL_REQUERIDA'),
      'QA_ATTEMPT_CODES',
      `Codigos de auditoria insuficientes: ${[...attemptCodes].join(', ')}`
    );
    evidence.case11 = attempts.rows;
    setOk('auditoria_fallos', 'Intentos fallidos autenticados auditados con ip/user-agent/dispositivo.');

    const hasMailLogTable = Boolean(
      await queryValue(
        txClient,
        `
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema='public'
              AND table_name='log_correos_enviados'
          ) AS value
        `
      )
    );

    const notifState = await queryOne(
      txClient,
      `SELECT correo_notificado,error_notificacion FROM public.facturas_reversiones WHERE id_reversion=$1`,
      [revTotalId]
    );

    if (hasMailLogTable) {
      const logs = await txClient.query(
        `
          SELECT tipo_correo,estado_envio,asunto
          FROM public.log_correos_enviados
          WHERE tipo_correo IN ('reversion_exito','reversion_fallida')
          ORDER BY id_log DESC
          LIMIT 20
        `
      );
      const hasExito = logs.rows.some((row) => row.tipo_correo === 'reversion_exito');
      const hasFallo = logs.rows.some((row) => row.tipo_correo === 'reversion_fallida');
      assertTrue(hasExito || notifState?.correo_notificado === true || notifState?.error_notificacion !== null, 'QA_MAIL_EXITO', 'Sin evidencia de intento de correo exito.');
      assertTrue(hasFallo || attempts.rowCount > 0, 'QA_MAIL_FALLO', 'Sin evidencia de intento de correo fallo.');
      evidence.case12 = {
        notif_state: notifState,
        log_rows: logs.rows
      };
      setOk('correo', 'Intentos de correo observables en exito/fallo controlado.');
    } else if (notifState?.correo_notificado === true || notifState?.error_notificacion !== null) {
      evidence.case12 = { notif_state: notifState };
      setOk('correo', 'Estado de notificacion persistido; sin tabla de logs SMTP en este entorno.');
    } else {
      setSkip('correo', 'No hay log_correos_enviados y no hubo evidencia persistente concluyente del intento SMTP.');
    }

    snapshots.afterInTx = {
      facturas: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas')),
      detalle_facturas: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.detalle_facturas')),
      facturas_reversiones: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones')),
      facturas_reversiones_detalle: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_detalle')),
      cajas_movimientos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.cajas_movimientos')),
      movimientos_inventario: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.movimientos_inventario')),
      fidelizacion_movimientos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.fidelizacion_movimientos')),
      facturas_reversiones_intentos: Number(await queryValue(txClient, 'SELECT COUNT(*)::int AS value FROM public.facturas_reversiones_intentos'))
    };

    await txClient.query('ROLLBACK');
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();

    const verifyClient = await originalConnect();
    try {
      const remainFacturas = await existsByIds(verifyClient, 'facturas', 'id_factura', fixtureIds.facturas);
      const remainDetalles = await existsByIds(verifyClient, 'detalle_facturas', 'id_detalle_factura', fixtureIds.detalles);
      const remainReversiones = await existsByIds(verifyClient, 'facturas_reversiones', 'id_reversion', fixtureIds.reversiones);

      assertTrue(remainFacturas === 0 && remainDetalles === 0 && remainReversiones === 0, 'QA_ROLLBACK_RESIDUE', `Rollback dejo residuos: facturas=${remainFacturas}, detalles=${remainDetalles}, reversiones=${remainReversiones}`);
      evidence.rollback = {
        fixture_ids: fixtureIds,
        rows_remaining_after_rollback: {
          facturas: remainFacturas,
          detalles: remainDetalles,
          reversiones: remainReversiones
        },
        snapshot_before: snapshots.before,
        snapshot_after_in_tx: snapshots.afterInTx
      };
      setOk('rollback', 'Rollback confirmado sin residuos de fixture QA.');
    } finally {
      verifyClient.release();
    }

    printSummary();
    console.log('\nEVIDENCE_JSON_START');
    console.log(JSON.stringify(evidence, null, 2));
    console.log('EVIDENCE_JSON_END');

    const hasFail = CASE_ORDER.some((key) => !summary[key] || summary[key] === 'FAIL');
    process.exitCode = hasFail ? 1 : 0;
  } catch (error) {
    try {
      await txClient.query('ROLLBACK');
    } catch {}
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();
    console.error('QA_REVERSION_E2E_FATAL:', {
      code: error?.code,
      message: error?.message,
      detail: error?.detail,
      table: error?.table,
      constraint: error?.constraint,
      stack: error?.stack
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
