import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../config/db-connection.js';
import ventasRouter from '../routers/ventas.js';
import { createVentaReversion } from '../services/ventasReversionService.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
const results = {};
const evidence = {};

const ok = (key, detail) => {
  results[key] = { status: 'OK', detail };
};

const skip = (key, detail) => {
  results[key] = { status: 'SKIP_JUSTIFICADO', detail };
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

const findRouteHandler = (pathName, method) => {
  const layer = ventasRouter.stack.find(
    (entry) => entry?.route?.path === pathName && entry?.route?.methods?.[method]
  );
  const stack = Array.isArray(layer?.route?.stack) ? layer.route.stack : [];
  return stack.length ? stack[stack.length - 1].handle : null;
};

const callRoute = async ({ handler, params = {}, body = {}, user, ip = '127.0.0.1' }) => {
  const req = {
    params,
    body,
    user,
    ip,
    headers: {
      'x-forwarded-for': ip,
      'user-agent': 'qa-detalle-facturas-origen-e2e/5.3'
    }
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
  return { statusCode: res.statusCode, payload: res.payload };
};

const run = async () => {
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const txClient = await originalConnect();
  const fixture = { facturas: [], reversiones: [], productos: [], recetas: [], combos: [], pedidos: [] };

  const txQuery = async (query, params) => {
    const sqlText = typeof query === 'string' ? query : String(query?.text || '');
    if (/^\s*BEGIN\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'BEGIN' };
    if (/^\s*COMMIT\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'COMMIT' };
    if (/^\s*ROLLBACK\b/i.test(sqlText)) return { rows: [], rowCount: null, command: 'ROLLBACK' };
    return txClient.query(query, params);
  };
  const wrappedClient = { ...txClient, query: txQuery, release: () => {} };

  try {
    await txClient.query('BEGIN');
    pool.connect = async () => wrappedClient;
    pool.query = async (query, params) => wrappedClient.query(query, params);

    const ventaHandler = findRouteHandler('/ventas', 'post');
    assertTrue(ventaHandler, 'QA_HANDLER_VENTAS_MISSING', 'No se encontro handler POST /ventas.');

    const userRow = await queryOne(
      txClient,
      `
        SELECT
          u.id_usuario,
          u.nombre_usuario,
          e.id_sucursal,
          ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre))), NULL) AS roles
        FROM public.usuarios u
        INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
        INNER JOIN public.roles r ON r.id_rol = ru.id_rol
        INNER JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
        INNER JOIN public.permisos p ON p.id_permiso = rp.id_permiso
        LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
        WHERE COALESCE(u.estado, true) = true
          AND UPPER(TRIM(p.nombre_permiso)) IN ('VENTAS_CREAR', 'VENTAS_REVERSION_CREAR')
          AND e.id_sucursal IS NOT NULL
        GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
        HAVING COUNT(DISTINCT UPPER(TRIM(p.nombre_permiso))) >= 2
        ORDER BY u.id_usuario
        LIMIT 1
      `
    );
    assertTrue(userRow, 'QA_USER_MISSING', 'No hay usuario con permisos VENTAS_CREAR y VENTAS_REVERSION_CREAR.');

    const idUsuario = Number(userRow.id_usuario);
    const idSucursal = Number(userRow.id_sucursal);
    const user = {
      id_usuario: idUsuario,
      nombre_usuario: String(userRow.nombre_usuario || ''),
      usuario: String(userRow.nombre_usuario || ''),
      roles: (userRow.roles || []).map((r) => String(r || '').trim()),
      id_sucursal: idSucursal
    };

    const openState = await queryOne(
      txClient,
      `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='ABIERTA' LIMIT 1`
    );
    const roleCaja = await queryOne(
      txClient,
      `
        SELECT id_rol_participacion_caja, UPPER(TRIM(codigo)) AS codigo
        FROM public.cat_cajas_roles_participacion
        WHERE COALESCE(estado,true)=true
        ORDER BY CASE UPPER(TRIM(codigo))
          WHEN 'RESPONSABLE' THEN 1
          WHEN 'AUXILIAR' THEN 2
          ELSE 99
        END, id_rol_participacion_caja
        LIMIT 1
      `
    );
    const almacen = await queryOne(
      txClient,
      `SELECT id_almacen FROM public.almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen LIMIT 1`,
      [idSucursal]
    );
    const metodoPago = await queryOne(
      txClient,
      `SELECT codigo FROM public.cat_metodos_pago WHERE COALESCE(estado,true)=true ORDER BY id_metodo_pago LIMIT 1`
    );
    assertTrue(openState && roleCaja && almacen && metodoPago, 'QA_FIXTURE_CATALOGS', 'Catalogos base faltantes para fixture QA.');

    const caja = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas (id_sucursal,id_usuario,estado,nombre_caja,codigo_caja,fecha_actualizacion)
        VALUES ($1,$2,true,$3,$4,NOW())
        RETURNING id_caja
      `,
      [idSucursal, idUsuario, `QA Caja 5.3 ${Date.now()}`, `QA53-${Date.now()}`]
    );
    const sesion = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas_sesiones (
          id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,
          id_usuario_apertura,monto_apertura,fecha_apertura,fecha_creacion,fecha_actualizacion
        ) VALUES ($1,$2,$3,$4,$3,500,NOW(),NOW(),NOW())
        RETURNING id_sesion_caja
      `,
      [Number(caja.id_caja), idSucursal, idUsuario, Number(openState.id_estado_sesion_caja)]
    );
    await txClient.query(
      `
        INSERT INTO public.cajas_sesiones_participantes (
          id_sesion_caja,id_usuario,id_rol_participacion_caja,fecha_inicio,activo,fecha_creacion,fecha_actualizacion
        ) VALUES ($1,$2,$3,NOW(),true,NOW(),NOW())
      `,
      [Number(sesion.id_sesion_caja), idUsuario, Number(roleCaja.id_rol_participacion_caja)]
    );
    const roleCode = String(roleCaja.codigo || '');
    const puedeResponsable = roleCode === 'RESPONSABLE' || (roleCode !== 'RESPONSABLE' && roleCode !== 'AUXILIAR');
    const puedeAuxiliar = roleCode === 'AUXILIAR' || (roleCode !== 'RESPONSABLE' && roleCode !== 'AUXILIAR');
    await txClient.query(
      `
        INSERT INTO public.cajas_usuarios_autorizados (
          id_caja,id_sucursal,id_usuario,
          puede_responsable,puede_auxiliar,estado,observacion,fecha_creacion,fecha_actualizacion
        ) VALUES ($1,$2,$3,$4,$5,true,$6,NOW(),NOW())
      `,
      [
        Number(caja.id_caja),
        idSucursal,
        idUsuario,
        puedeResponsable,
        puedeAuxiliar,
        'QA autorización caja F5.3'
      ]
    );

    const producto = await queryOne(
      txClient,
      `
        INSERT INTO public.productos (
          nombre_producto,precio,cantidad,descripcion_producto,id_almacen,stock_minimo,estado
        ) VALUES ($1,45,20,$2,$3,0,true)
        RETURNING id_producto
      `,
      [`QA Producto Origen ${Date.now()}`, 'Producto QA trazabilidad', Number(almacen.id_almacen)]
    );
    fixture.productos.push(Number(producto.id_producto));

    const menu = await queryOne(txClient, `SELECT id_menu FROM public.menu ORDER BY id_menu LIMIT 1`);
    const picante = await queryOne(txClient, `SELECT id_nivel_picante FROM public.nivel_picante ORDER BY id_nivel_picante LIMIT 1`);
    let receta = await queryOne(
      txClient,
      `SELECT id_receta, precio FROM public.recetas WHERE COALESCE(estado,true)=true ORDER BY id_receta LIMIT 1`
    );
    if (!receta && menu && picante) {
      receta = await queryOne(
        txClient,
        `
          INSERT INTO public.recetas (
            id_receta,nombre_receta,descripcion,id_menu,id_nivel_picante,id_usuario,estado,precio
          ) VALUES (
            (SELECT COALESCE(MAX(id_receta),0)+1 FROM public.recetas),
            $1,$2,$3,$4,$5,true,55
          )
          RETURNING id_receta,precio
        `,
        [`QA Receta ${Date.now()}`, 'Receta QA', Number(menu.id_menu), Number(picante.id_nivel_picante), idUsuario]
      );
      fixture.recetas.push(Number(receta.id_receta));
    }

    let combo = await queryOne(
      txClient,
      `SELECT id_combo, precio FROM public.combos WHERE COALESCE(estado,true)=true ORDER BY id_combo LIMIT 1`
    );
    if (!combo && menu) {
      combo = await queryOne(
        txClient,
        `
          INSERT INTO public.combos (
            id_menu,descripcion,cant_personas,estado,precio,nombre_combo,id_usuario
          ) VALUES ($1,$2,1,true,70,$3,$4)
          RETURNING id_combo,precio
        `,
        [Number(menu.id_menu), 'Combo QA', `QA Combo ${Date.now()}`, idUsuario]
      );
      fixture.combos.push(Number(combo.id_combo));
    }

    const cliente = await queryOne(
      txClient,
      `INSERT INTO public.clientes (fecha_ingreso,puntos,estado) VALUES (CURRENT_DATE,0,true) RETURNING id_cliente`
    );

    const createVenta = async (items, label) => {
      const response = await callRoute({
        handler: ventaHandler,
        user,
        body: {
          id_sucursal: idSucursal,
          id_sesion_caja: Number(sesion.id_sesion_caja),
          id_cliente: Number(cliente.id_cliente),
          metodo_pago: String(metodoPago.codigo),
          items
        }
      });
      assertTrue(
        response.statusCode === 201,
        `QA_VENTA_${label}_STATUS`,
        `Venta ${label} fallo con ${response.statusCode}: ${JSON.stringify(response.payload)}`
      );
      const idFactura = Number(response.payload?.id_factura);
      assertTrue(idFactura > 0, `QA_VENTA_${label}_ID`, `Venta ${label} no devolvio id_factura.`);
      fixture.facturas.push(idFactura);
      return idFactura;
    };

    const idFacturaProducto = await createVenta(
      [{ id_producto: Number(producto.id_producto), cantidad: 2 }],
      'PRODUCTO'
    );
    assertTrue(receta, 'QA_RECETA_MISSING', 'No existe receta disponible ni fue posible crear fixture.');
    const idFacturaReceta = await createVenta(
      [{ id_receta: Number(receta.id_receta), cantidad: 1 }],
      'RECETA'
    );
    assertTrue(combo, 'QA_COMBO_MISSING', 'No existe combo disponible ni fue posible crear fixture.');
    const idFacturaCombo = await createVenta(
      [{ id_combo: Number(combo.id_combo), cantidad: 1 }],
      'COMBO'
    );
    const idFacturaMixto = await createVenta(
      [
        { id_producto: Number(producto.id_producto), cantidad: 1 },
        { id_receta: Number(receta.id_receta), cantidad: 1 },
        { id_combo: Number(combo.id_combo), cantidad: 1 }
      ],
      'MIXTO'
    );

    const readDetalle = async (idFactura) =>
      txClient.query(
        `
          SELECT
            df.id_detalle_factura,df.id_producto,df.id_receta,df.id_combo,df.id_detalle_pedido,
            df.tipo_item,df.origen_snapshot,df.cantidad,df.total_detalle,dp.id_pedido
          FROM public.detalle_facturas df
          LEFT JOIN public.detalle_pedido dp ON dp.id_detalle_pedido=df.id_detalle_pedido
          WHERE df.id_factura=$1
          ORDER BY df.id_detalle_factura
        `,
        [idFactura]
      );

    const productoDetalle = await readDetalle(idFacturaProducto);
    assertTrue(productoDetalle.rowCount === 1, 'QA_PRODUCTO_LINES', 'Venta producto no genero 1 linea esperada.');
    assertTrue(productoDetalle.rows[0].tipo_item === 'PRODUCTO', 'QA_PRODUCTO_TIPO', 'tipo_item producto incorrecto.');
    assertTrue(Number(productoDetalle.rows[0].id_producto) === Number(producto.id_producto), 'QA_PRODUCTO_ID', 'id_producto no coincide.');
    assertTrue(Number(productoDetalle.rows[0].id_detalle_pedido) > 0, 'QA_PRODUCTO_DP', 'id_detalle_pedido no persistido.');
    ok('producto', 'Traza PRODUCTO persistida en detalle_facturas.');

    const recetaDetalle = await readDetalle(idFacturaReceta);
    assertTrue(recetaDetalle.rows[0].tipo_item === 'RECETA', 'QA_RECETA_TIPO', 'tipo_item receta incorrecto.');
    assertTrue(Number(recetaDetalle.rows[0].id_receta) === Number(receta.id_receta), 'QA_RECETA_ID', 'id_receta no coincide.');
    ok('receta', 'Traza RECETA persistida en detalle_facturas.');

    const comboDetalle = await readDetalle(idFacturaCombo);
    assertTrue(comboDetalle.rows[0].tipo_item === 'COMBO', 'QA_COMBO_TIPO', 'tipo_item combo incorrecto.');
    assertTrue(Number(comboDetalle.rows[0].id_combo) === Number(combo.id_combo), 'QA_COMBO_ID', 'id_combo no coincide.');
    ok('combo', 'Traza COMBO persistida en detalle_facturas.');

    const mixtoDetalle = await readDetalle(idFacturaMixto);
    const mixtoTipos = new Set(mixtoDetalle.rows.map((r) => String(r.tipo_item || '').toUpperCase()));
    assertTrue(mixtoDetalle.rowCount === 3, 'QA_MIXTO_COUNT', 'Venta mixta no genero 3 lineas.');
    assertTrue(mixtoTipos.has('PRODUCTO') && mixtoTipos.has('RECETA') && mixtoTipos.has('COMBO'), 'QA_MIXTO_TIPOS', 'Venta mixta no preservo tipos por linea.');
    assertTrue(mixtoDetalle.rows.every((r) => Number(r.id_detalle_pedido) > 0), 'QA_MIXTO_DP', 'Venta mixta no persistio id_detalle_pedido por linea.');
    ok('mixto', 'Traza MIXTO conservada por lineas individuales.');

    const stockAntesProducto = Number(await queryValue(txClient, `SELECT cantidad AS value FROM public.productos WHERE id_producto=$1`, [Number(producto.id_producto)]));
    const revProd = await createVentaReversion({
      idFactura: idFacturaProducto,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-detalle-facturas-origen-e2e/5.3' }, ip: '127.0.0.1' },
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA rev producto' }
    });
    fixture.reversiones.push(Number(revProd.id_reversion));
    const stockDespuesProducto = Number(await queryValue(txClient, `SELECT cantidad AS value FROM public.productos WHERE id_producto=$1`, [Number(producto.id_producto)]));
    assertTrue(stockDespuesProducto - stockAntesProducto === 2, 'QA_REV_PRODUCTO_STOCK', 'Reversion de producto no devolvio inventario esperado.');
    ok('reversion_producto', 'Reversion de PRODUCTO mantiene devolucion de inventario.');

    const revReceta = await createVentaReversion({
      idFactura: idFacturaReceta,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-detalle-facturas-origen-e2e/5.3' }, ip: '127.0.0.1' },
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA rev receta' }
    });
    fixture.reversiones.push(Number(revReceta.id_reversion));
    const invReceta = await txClient.query(
      `SELECT COUNT(*)::int AS c FROM public.movimientos_inventario WHERE ref_origen='REVERSION_VENTA' AND id_ref=$1`,
      [Number(revReceta.id_reversion)]
    );
    assertTrue(Number(invReceta.rows[0].c) === 0, 'QA_REV_RECETA_INV', 'Reversion de receta devolvio inventario indebido.');

    const revCombo = await createVentaReversion({
      idFactura: idFacturaCombo,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-detalle-facturas-origen-e2e/5.3' }, ip: '127.0.0.1' },
      body: { tipo_reversion: 'TOTAL', motivo: 'DEVOLUCION', observacion: 'QA rev combo' }
    });
    fixture.reversiones.push(Number(revCombo.id_reversion));
    const invCombo = await txClient.query(
      `SELECT COUNT(*)::int AS c FROM public.movimientos_inventario WHERE ref_origen='REVERSION_VENTA' AND id_ref=$1`,
      [Number(revCombo.id_reversion)]
    );
    assertTrue(Number(invCombo.rows[0].c) === 0, 'QA_REV_COMBO_INV', 'Reversion de combo devolvio inventario indebido.');
    ok('reversion_receta_combo', 'RECETA/COMBO no devuelven insumos automaticamente.');

    const legacyFactura = await queryOne(
      txClient,
      `
        INSERT INTO public.facturas (
          id_caja,id_pedido,id_sucursal,id_usuario,id_cliente,codigo_venta,fecha_operacion,
          efectivo_entregado,cambio,fecha_hora_facturacion,isv_15,isv_18,id_sesion_caja
        )
        VALUES ($1,NULL,$2,$3,$4,$5,(NOW() AT TIME ZONE 'America/Tegucigalpa')::date,50,0,NOW(),0,0,$6)
        RETURNING id_factura
      `,
      [Number(caja.id_caja), idSucursal, idUsuario, Number(cliente.id_cliente), `QAL-${Date.now()}`, Number(sesion.id_sesion_caja)]
    );
    fixture.facturas.push(Number(legacyFactura.id_factura));
    await txClient.query(
      `
        INSERT INTO public.detalle_facturas (
          id_factura,id_producto,id_descuento,cantidad,precio_unitario,sub_total,total_detalle,id_pedido,tipo_item
        )
        VALUES ($1,NULL,NULL,1,10,10,10,NULL,NULL)
      `,
      [Number(legacyFactura.id_factura)]
    );
    const revLegacy = await createVentaReversion({
      idFactura: Number(legacyFactura.id_factura),
      idUsuario,
      req: { headers: { 'user-agent': 'qa-detalle-facturas-origen-e2e/5.3' }, ip: '127.0.0.1' },
      body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'QA legacy' }
    });
    fixture.reversiones.push(Number(revLegacy.id_reversion));
    const invLegacy = await txClient.query(
      `SELECT COUNT(*)::int AS c FROM public.movimientos_inventario WHERE ref_origen='REVERSION_VENTA' AND id_ref=$1`,
      [Number(revLegacy.id_reversion)]
    );
    assertTrue(Number(invLegacy.rows[0].c) === 0, 'QA_LEGACY_INV', 'Venta legacy NULL devolvio inventario sin id_producto claro.');
    ok('legacy_null', 'Linea historica tipo_item NULL conserva comportamiento conservador.');

    evidence.detalle_producto = productoDetalle.rows;
    evidence.detalle_receta = recetaDetalle.rows;
    evidence.detalle_combo = comboDetalle.rows;
    evidence.detalle_mixto = mixtoDetalle.rows;
    evidence.reversion_producto = { stock_antes: stockAntesProducto, stock_despues: stockDespuesProducto, response: revProd };
    evidence.reversion_receta = revReceta;
    evidence.reversion_combo = revCombo;
    evidence.reversion_legacy = revLegacy;

    await txClient.query('ROLLBACK');
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();

    const verifyClient = await originalConnect();
    try {
      const leftFacturas = Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.facturas WHERE id_factura = ANY($1::int[])`, [fixture.facturas]));
      const leftReversiones = Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_reversion = ANY($1::bigint[])`, [fixture.reversiones]));
      const leftProductos = fixture.productos.length
        ? Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.productos WHERE id_producto = ANY($1::int[])`, [fixture.productos]))
        : 0;
      assertTrue(leftFacturas === 0 && leftReversiones === 0 && leftProductos === 0, 'QA_ROLLBACK_RESIDUE', 'Rollback dejo residuos QA.');
      ok('rollback', 'Rollback confirmado sin residuos.');
      evidence.rollback = { leftFacturas, leftReversiones, leftProductos };
    } finally {
      verifyClient.release();
    }

    console.log('\nQA DETALLE_FACTURAS ORIGEN E2E');
    for (const [k, v] of Object.entries(results)) {
      console.log(`- ${k}: ${v.status} | ${v.detail}`);
    }
    console.log('\nEVIDENCE_JSON_START');
    console.log(JSON.stringify(evidence, null, 2));
    console.log('EVIDENCE_JSON_END');
  } catch (error) {
    try { await txClient.query('ROLLBACK'); } catch {}
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();
    console.error('QA_DETALLE_FACTURAS_ORIGEN_E2E_FATAL', {
      code: error?.code,
      message: error?.message,
      detail: error?.detail,
      stack: error?.stack
    });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
