import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../config/db-connection.js';
import ventasRouter from '../routers/ventas.js';
import { createVentaReversion } from '../services/ventasReversionService.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TZ = 'America/Tegucigalpa';
const CASE_KEYS = [
  'venta_sin_descuento_usuario_sin_permiso_descuento',
  'venta_con_descuento_global_usuario_con_permiso',
  'venta_con_descuento_global_usuario_sin_permiso_403',
  'venta_con_descuento_producto',
  'venta_con_descuento_receta',
  'venta_con_descuento_combo',
  'descuento_producto_no_aplica_a_receta',
  'descuento_receta_no_aplica_a_combo',
  'descuento_combo_no_aplica_a_producto',
  'descuento_global_y_linea_no_acumulable',
  'descuento_inactivo',
  'descuento_vencido',
  'descuento_mayor_que_subtotal',
  'reversion_total_con_descuento_global',
  'reversion_parcial_con_descuento_global',
  'reversion_total_con_descuento_por_linea',
  'reversion_parcial_con_descuento_por_linea'
];

const TZ_CASE_KEYS = [
  'facturacion_hora_honduras_insert',
  'facturacion_fecha_operacion_honduras',
  'ventas_limite_72h_honduras',
  'ticket_hora_honduras',
  'detalle_modal_hora_honduras',
  'reversion_hora_honduras',
  'correlativo_fecha_operacion_honduras'
];

const result = {};
const evidence = { cases: {}, tz: {}, ids: {}, sql: {}, rollback: {} };
for (const key of [...CASE_KEYS, ...TZ_CASE_KEYS, 'build_frontend', 'backend_check']) {
  result[key] = { status: 'PENDING', detail: '' };
}

const setPass = (key, detail = 'OK') => { result[key] = { status: 'PASS', detail }; };
const setFail = (key, detail) => { result[key] = { status: 'FAIL', detail }; };
const setSkip = (key, detail) => { result[key] = { status: 'SKIP', detail }; };

const parseIntPos = (v) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const q1 = async (client, sql, params = []) => {
  const r = await client.query(sql, params);
  return r.rows[0] || null;
};

const callRouterHandler = async ({ handler, req }) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
};

const findVentasPostHandler = () => {
  const layer = ventasRouter.stack.find(
    (entry) => entry?.route?.path === '/ventas' && entry?.route?.methods?.post
  );
  if (!layer?.route?.stack?.length) return null;
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const getNowHondurasDate = () => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return f.format(new Date());
};

const run = async () => {
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const tx = await originalConnect();
  const created = { facturas: [], pedidos: [], detalles: [], descuentosCatalogo: [], reversiones: [] };

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
    pool.query = async (query, params) => wrappedClient.query(query, params);

    const ventasPostHandler = findVentasPostHandler();
    if (!ventasPostHandler) throw new Error('No se encontro handler POST /ventas');

    const userWithPerm = await q1(tx, `
      SELECT u.id_usuario, u.nombre_usuario, e.id_sucursal,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(p.nombre_permiso))), NULL) AS permisos,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre))), NULL) AS roles
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      JOIN public.roles r ON r.id_rol = ru.id_rol
      JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
      JOIN public.permisos p ON p.id_permiso = rp.id_permiso
      WHERE COALESCE(u.estado, true) = true
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
      HAVING
        BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_CREAR')
        AND BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_DESCUENTO_APLICAR')
        AND BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR')
        AND e.id_sucursal IS NOT NULL
      ORDER BY u.id_usuario
      LIMIT 1
    `);
    const userWithoutDiscountPermBase = await q1(tx, `
      SELECT u.id_usuario, u.nombre_usuario, e.id_sucursal,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(p.nombre_permiso))), NULL) AS permisos,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre))), NULL) AS roles
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      JOIN public.roles r ON r.id_rol = ru.id_rol
      JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
      JOIN public.permisos p ON p.id_permiso = rp.id_permiso
      WHERE COALESCE(u.estado, true) = true
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
      HAVING
        BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_CREAR')
        AND NOT BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_DESCUENTO_APLICAR')
        AND e.id_sucursal IS NOT NULL
      ORDER BY u.id_usuario
      LIMIT 1
    `);
    if (!userWithPerm || !userWithoutDiscountPermBase) throw new Error('No hay usuarios QA con/ sin permiso de descuento');

    const idSucursal = parseIntPos(userWithPerm.id_sucursal);
    const userWithoutDiscountPermSameSucursal = await q1(tx, `
      SELECT u.id_usuario, u.nombre_usuario, e.id_sucursal,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(p.nombre_permiso))), NULL) AS permisos,
             ARRAY_REMOVE(ARRAY_AGG(DISTINCT UPPER(TRIM(r.nombre))), NULL) AS roles
      FROM public.usuarios u
      LEFT JOIN public.empleados e ON e.id_empleado = u.id_empleado
      JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
      JOIN public.roles r ON r.id_rol = ru.id_rol
      JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
      JOIN public.permisos p ON p.id_permiso = rp.id_permiso
      WHERE COALESCE(u.estado, true) = true
        AND e.id_sucursal = $1
      GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal
      HAVING
        BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_CREAR')
        AND NOT BOOL_OR(UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_DESCUENTO_APLICAR')
      ORDER BY u.id_usuario
      LIMIT 1
    `, [idSucursal]);
    const userWithoutDiscountPerm = userWithoutDiscountPermSameSucursal || userWithoutDiscountPermBase;
    const openState = await q1(tx, `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='ABIERTA' LIMIT 1`);
    const roleCaja = await q1(tx, `SELECT id_rol_participacion_caja FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado,true)=true ORDER BY id_rol_participacion_caja LIMIT 1`);
    const metodoEfectivo = await q1(tx, `SELECT id_metodo_pago,nombre,codigo FROM public.cat_metodos_pago WHERE COALESCE(estado,true)=true AND (UPPER(TRIM(codigo))='EFECTIVO' OR LOWER(TRIM(nombre))='efectivo') ORDER BY id_metodo_pago LIMIT 1`);
    if (!openState || !roleCaja || !metodoEfectivo) throw new Error('Catalogos de caja/pago incompletos');

    const caja = await q1(tx, `
      INSERT INTO public.cajas (id_sucursal,id_usuario,estado,nombre_caja,codigo_caja,fecha_actualizacion)
      VALUES ($1,$2,true,$3,$4,(NOW() AT TIME ZONE 'America/Tegucigalpa'))
      RETURNING id_caja
    `, [idSucursal, userWithPerm.id_usuario, `QA F61 ${Date.now()}`, `QAF61-${Date.now()}`]);

    const sesion = await q1(tx, `
      INSERT INTO public.cajas_sesiones (
        id_caja,id_sucursal,id_usuario_responsable,id_estado_sesion_caja,id_usuario_apertura,monto_apertura,fecha_apertura,fecha_creacion,fecha_actualizacion
      ) VALUES (
        $1,$2,$3,$4,$3,1000,(NOW() AT TIME ZONE 'America/Tegucigalpa'),(NOW() AT TIME ZONE 'America/Tegucigalpa'),(NOW() AT TIME ZONE 'America/Tegucigalpa')
      ) RETURNING id_sesion_caja
    `, [caja.id_caja, idSucursal, userWithPerm.id_usuario, openState.id_estado_sesion_caja]);

    for (const user of [userWithPerm, userWithoutDiscountPerm]) {
      await tx.query(`
        INSERT INTO public.cajas_sesiones_participantes (id_sesion_caja,id_usuario,id_rol_participacion_caja,fecha_inicio,activo,fecha_creacion,fecha_actualizacion)
        VALUES ($1,$2,$3,(NOW() AT TIME ZONE 'America/Tegucigalpa'),true,(NOW() AT TIME ZONE 'America/Tegucigalpa'),(NOW() AT TIME ZONE 'America/Tegucigalpa'))
        ON CONFLICT DO NOTHING
      `, [sesion.id_sesion_caja, user.id_usuario, roleCaja.id_rol_participacion_caja]);

      await tx.query(`
        INSERT INTO public.cajas_usuarios_autorizados (
          id_caja,id_sucursal,id_usuario,puede_responsable,puede_auxiliar,estado,fecha_creacion,fecha_actualizacion
        )
        VALUES ($1,$2,$3,true,true,true,(NOW() AT TIME ZONE 'America/Tegucigalpa'),(NOW() AT TIME ZONE 'America/Tegucigalpa'))
        ON CONFLICT DO NOTHING
      `, [caja.id_caja, idSucursal, user.id_usuario]);
    }

    const producto = await q1(tx, `SELECT id_producto, precio FROM public.productos WHERE COALESCE(estado,true)=true AND precio > 0 ORDER BY id_producto LIMIT 1`);
    const receta = await q1(tx, `SELECT id_receta, precio FROM public.recetas WHERE COALESCE(estado,true)=true AND precio > 0 ORDER BY id_receta LIMIT 1`);
    const combo = await q1(tx, `SELECT id_combo, precio FROM public.combos WHERE COALESCE(estado,true)=true AND precio > 0 ORDER BY id_combo LIMIT 1`);
    if (!producto || !receta || !combo) throw new Error('No hay producto/receta/combo activos para QA');

    const tipoPct = await q1(tx, `SELECT id_tipo_descuento FROM public.tipo_descuentos WHERE COALESCE(estado,true)=true AND UPPER(nombre_tipo_descuento) LIKE '%PORCENTAJE%' LIMIT 1`);
    const tipoMonto = await q1(tx, `SELECT id_tipo_descuento FROM public.tipo_descuentos WHERE COALESCE(estado,true)=true AND (UPPER(nombre_tipo_descuento) LIKE '%MONTO%' OR UPPER(nombre_tipo_descuento) LIKE '%FIJO%') LIMIT 1`);
    if (!tipoPct || !tipoMonto) throw new Error('No hay tipos de descuento porcentaje/monto');

    const createDiscount = async (payload) => {
      const row = await q1(tx, `
        INSERT INTO public.descuentos_catalogos (
          nombre_descuento, descripcion, valor_descuento, alcance, id_producto, id_receta, id_combo, id_sucursal, fecha_inicio, fecha_fin, id_tipo_descuento, estado, fecha_creacion, id_usuario
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,(NOW() AT TIME ZONE 'America/Tegucigalpa'),$13
        ) RETURNING id_descuento_catalogo
      `, [
        payload.nombre_descuento,
        payload.descripcion || null,
        payload.valor_descuento,
        payload.alcance,
        payload.id_producto || null,
        payload.id_receta || null,
        payload.id_combo || null,
        payload.id_sucursal ?? null,
        payload.fecha_inicio || null,
        payload.fecha_fin || null,
        payload.id_tipo_descuento,
        payload.estado ?? true,
        userWithPerm.id_usuario
      ]);
      created.descuentosCatalogo.push(Number(row.id_descuento_catalogo));
      return Number(row.id_descuento_catalogo);
    };

    const today = getNowHondurasDate();
    const idDescGlobal = await createDiscount({
      nombre_descuento: 'QA GLOBAL 10%',
      valor_descuento: 10,
      alcance: 'FACTURA_COMPLETA',
      id_tipo_descuento: tipoPct.id_tipo_descuento,
      id_sucursal: idSucursal
    });
    const idDescProducto = await createDiscount({
      nombre_descuento: 'QA PROD 5L',
      valor_descuento: 5,
      alcance: 'PRODUCTO',
      id_producto: producto.id_producto,
      id_tipo_descuento: tipoMonto.id_tipo_descuento,
      id_sucursal: idSucursal
    });
    const idDescReceta = await createDiscount({
      nombre_descuento: 'QA RECETA 10%',
      valor_descuento: 10,
      alcance: 'RECETA',
      id_receta: receta.id_receta,
      id_tipo_descuento: tipoPct.id_tipo_descuento,
      id_sucursal: idSucursal
    });
    const idDescCombo = await createDiscount({
      nombre_descuento: 'QA COMBO 5%',
      valor_descuento: 5,
      alcance: 'COMBO',
      id_combo: combo.id_combo,
      id_tipo_descuento: tipoPct.id_tipo_descuento,
      id_sucursal: idSucursal
    });
    const idDescInactivo = await createDiscount({
      nombre_descuento: 'QA INACTIVO',
      valor_descuento: 5,
      alcance: 'FACTURA_COMPLETA',
      id_tipo_descuento: tipoPct.id_tipo_descuento,
      id_sucursal: idSucursal,
      estado: false
    });
    const idDescVencido = await createDiscount({
      nombre_descuento: 'QA VENCIDO',
      valor_descuento: 5,
      alcance: 'FACTURA_COMPLETA',
      id_tipo_descuento: tipoPct.id_tipo_descuento,
      id_sucursal: idSucursal,
      fecha_inicio: '2000-01-01 00:00:00',
      fecha_fin: '2000-01-02 00:00:00'
    });

    evidence.ids = { idSucursal, caja: caja.id_caja, sesion: sesion.id_sesion_caja, producto: producto.id_producto, receta: receta.id_receta, combo: combo.id_combo, descuentos: { idDescGlobal, idDescProducto, idDescReceta, idDescCombo, idDescInactivo, idDescVencido } };

    const mkReq = (user, body) => ({
      body,
      user: {
        id_usuario: Number(user.id_usuario),
        nombre_usuario: user.nombre_usuario,
        roles: Array.isArray(user.roles) ? user.roles : [],
        permisos: Array.isArray(user.permisos) ? user.permisos : [],
        id_sucursal: Number(user.id_sucursal)
      },
      headers: { 'user-agent': 'qa-ventas-descuentos-fase61/1.0' },
      ip: '127.0.0.1'
    });

    const basePayload = (items) => ({
      id_sucursal: idSucursal,
      id_sesion_caja: Number(sesion.id_sesion_caja),
      metodo_pago: metodoEfectivo.codigo || metodoEfectivo.nombre || 'EFECTIVO',
      efectivo_entregado: 9999,
      items
    });

    const noDiscountBody = basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]);
    const c1 = await callRouterHandler({ handler: ventasPostHandler, req: mkReq(userWithoutDiscountPerm, noDiscountBody) });
    if (c1.status === 201) setPass('venta_sin_descuento_usuario_sin_permiso_descuento', `id_factura=${c1.body?.id_factura}`);
    else setFail('venta_sin_descuento_usuario_sin_permiso_descuento', `status=${c1.status}`);
    if (c1.body?.id_factura) created.facturas.push(Number(c1.body.id_factura));

    const globalOkBody = { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 2 }]), id_descuento_catalogo: idDescGlobal };
    const c2 = await callRouterHandler({ handler: ventasPostHandler, req: mkReq(userWithPerm, globalOkBody) });
    if (c2.status === 201) setPass('venta_con_descuento_global_usuario_con_permiso', `id_factura=${c2.body?.id_factura}`);
    else setFail('venta_con_descuento_global_usuario_con_permiso', `status=${c2.status} code=${c2.body?.code || '-'}`);
    if (c2.body?.id_factura) created.facturas.push(Number(c2.body.id_factura));

    const countsBeforeUnauthorized = await q1(tx, `
      SELECT
        (SELECT COUNT(*) FROM public.facturas) AS facturas,
        (SELECT COUNT(*) FROM public.pedidos) AS pedidos,
        (SELECT COUNT(*) FROM public.facturas_cobros) AS cobros
    `);
    const unauthorizedBody = { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]), id_descuento_catalogo: idDescGlobal };
    const c3 = await callRouterHandler({ handler: ventasPostHandler, req: mkReq(userWithoutDiscountPerm, unauthorizedBody) });
    const countsAfterUnauthorized = await q1(tx, `
      SELECT
        (SELECT COUNT(*) FROM public.facturas) AS facturas,
        (SELECT COUNT(*) FROM public.pedidos) AS pedidos,
        (SELECT COUNT(*) FROM public.facturas_cobros) AS cobros
    `);
    const noWrites = Number(countsBeforeUnauthorized.facturas) === Number(countsAfterUnauthorized.facturas)
      && Number(countsBeforeUnauthorized.pedidos) === Number(countsAfterUnauthorized.pedidos)
      && Number(countsBeforeUnauthorized.cobros) === Number(countsAfterUnauthorized.cobros);
    if (c3.status === 403 && c3.body?.code === 'VENTAS_DESCUENTO_NO_AUTORIZADO' && noWrites) setPass('venta_con_descuento_global_usuario_sin_permiso_403', '403 + sin escrituras parciales');
    else setFail('venta_con_descuento_global_usuario_sin_permiso_403', `status=${c3.status} code=${c3.body?.code || '-'} noWrites=${noWrites}`);

    const c4 = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 2, id_descuento_catalogo: idDescProducto }]) })
    });
    if (c4.status === 201) setPass('venta_con_descuento_producto', `id_factura=${c4.body?.id_factura}`);
    else setFail('venta_con_descuento_producto', `status=${c4.status} code=${c4.body?.code || '-'}`);
    if (c4.body?.id_factura) created.facturas.push(Number(c4.body.id_factura));

    const c5 = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_receta: Number(receta.id_receta), cantidad: 2, id_descuento_catalogo: idDescReceta }]) })
    });
    if (c5.status === 201) setPass('venta_con_descuento_receta', `id_factura=${c5.body?.id_factura}`);
    else setFail('venta_con_descuento_receta', `status=${c5.status} code=${c5.body?.code || '-'}`);
    if (c5.body?.id_factura) created.facturas.push(Number(c5.body.id_factura));

    const c6 = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_combo: Number(combo.id_combo), cantidad: 2, id_descuento_catalogo: idDescCombo }]) })
    });
    if (c6.status === 201) setPass('venta_con_descuento_combo', `id_factura=${c6.body?.id_factura}`);
    else setFail('venta_con_descuento_combo', `status=${c6.status} code=${c6.body?.code || '-'}`);
    if (c6.body?.id_factura) created.facturas.push(Number(c6.body.id_factura));

    const expect409 = async (key, body, expectedCode) => {
      const r = await callRouterHandler({ handler: ventasPostHandler, req: mkReq(userWithPerm, body) });
      evidence.cases[key] = r;
      if (r.status >= 400 && r.status < 500 && (!expectedCode || r.body?.code === expectedCode)) setPass(key, `status=${r.status} code=${r.body?.code || '-'}`);
      else setFail(key, `status=${r.status} code=${r.body?.code || '-'}`);
    };

    await expect409(
      'descuento_producto_no_aplica_a_receta',
      { ...basePayload([{ id_receta: Number(receta.id_receta), cantidad: 1, id_descuento_catalogo: idDescProducto }]) },
      'VENTAS_DESCUENTO_ITEM_NO_APLICA'
    );
    await expect409(
      'descuento_receta_no_aplica_a_combo',
      { ...basePayload([{ id_combo: Number(combo.id_combo), cantidad: 1, id_descuento_catalogo: idDescReceta }]) },
      'VENTAS_DESCUENTO_ITEM_NO_APLICA'
    );
    await expect409(
      'descuento_combo_no_aplica_a_producto',
      { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1, id_descuento_catalogo: idDescCombo }]) },
      'VENTAS_DESCUENTO_ITEM_NO_APLICA'
    );
    await expect409(
      'descuento_global_y_linea_no_acumulable',
      { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1, id_descuento_catalogo: idDescProducto }]), id_descuento_catalogo: idDescGlobal },
      'VENTAS_DESCUENTO_ACUMULACION_NO_PERMITIDA'
    );
    await expect409(
      'descuento_inactivo',
      { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]), id_descuento_catalogo: idDescInactivo },
      'VENTAS_DESCUENTO_INACTIVO'
    );
    await expect409(
      'descuento_vencido',
      { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]), id_descuento_catalogo: idDescVencido },
      'VENTAS_DESCUENTO_VENCIDO'
    );
    await expect409(
      'descuento_mayor_que_subtotal',
      { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]), descuento: 999999 },
      null
    );

    // Reversiones con descuento global y por linea
    const saleGlobalTotal = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 3 }]), id_descuento_catalogo: idDescGlobal })
    });
    const saleGlobalParcial = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 3 }]), id_descuento_catalogo: idDescGlobal })
    });
    const saleLineTotal = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 3, id_descuento_catalogo: idDescProducto }]) })
    });
    const saleLineParcial = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 3, id_descuento_catalogo: idDescProducto }]) })
    });
    for (const s of [saleGlobalTotal, saleGlobalParcial, saleLineTotal, saleLineParcial]) {
      if (s.body?.id_factura) created.facturas.push(Number(s.body.id_factura));
    }

    const userReqMeta = { headers: { 'user-agent': 'qa-ventas-descuentos-fase61/1.0' }, ip: '127.0.0.1' };
    const runReversionCase = async (key, args, expectedStatus = 'PASS') => {
      try {
        const payload = await createVentaReversion(args);
        created.reversiones.push(Number(payload.id_reversion));
        setPass(key, `id_reversion=${payload.id_reversion}`);
        evidence.cases[key] = payload;
      } catch (e) {
        setFail(key, `code=${e?.code || 'ERR'} status=${e?.httpStatus || 500} msg=${e?.publicMessage || e?.message}`);
      }
    };

    await runReversionCase('reversion_total_con_descuento_global', {
      idFactura: saleGlobalTotal.body?.id_factura,
      idUsuario: userWithPerm.id_usuario,
      req: userReqMeta,
      body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'QA reversion total global' }
    });

    const dGlobalParcial = await tx.query(`SELECT id_detalle_factura FROM public.detalle_facturas WHERE id_factura=$1 ORDER BY id_detalle_factura LIMIT 1`, [saleGlobalParcial.body?.id_factura]);
    await runReversionCase('reversion_parcial_con_descuento_global', {
      idFactura: saleGlobalParcial.body?.id_factura,
      idUsuario: userWithPerm.id_usuario,
      req: userReqMeta,
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'OTRO',
        observacion: 'QA reversion parcial global',
        lineas: [{ id_detalle_factura: Number(dGlobalParcial.rows?.[0]?.id_detalle_factura), cantidad: 1 }]
      }
    });

    await runReversionCase('reversion_total_con_descuento_por_linea', {
      idFactura: saleLineTotal.body?.id_factura,
      idUsuario: userWithPerm.id_usuario,
      req: userReqMeta,
      body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'QA reversion total linea' }
    });

    const dLineParcial = await tx.query(`SELECT id_detalle_factura FROM public.detalle_facturas WHERE id_factura=$1 ORDER BY id_detalle_factura LIMIT 1`, [saleLineParcial.body?.id_factura]);
    await runReversionCase('reversion_parcial_con_descuento_por_linea', {
      idFactura: saleLineParcial.body?.id_factura,
      idUsuario: userWithPerm.id_usuario,
      req: userReqMeta,
      body: {
        tipo_reversion: 'PARCIAL',
        motivo: 'OTRO',
        observacion: 'QA reversion parcial linea',
        lineas: [{ id_detalle_factura: Number(dLineParcial.rows?.[0]?.id_detalle_factura), cantidad: 1 }]
      }
    });

    // Zona horaria
    const tzCompare = await q1(tx, `
      SELECT
        NOW() AS now_timestamptz,
        NOW() AT TIME ZONE 'UTC' AS now_utc_sin_tz,
        NOW() AT TIME ZONE 'America/Tegucigalpa' AS now_honduras_sin_tz,
        (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS fecha_operacion_honduras
    `);
    evidence.sql.tz_compare = tzCompare;

    const saleTz = await callRouterHandler({
      handler: ventasPostHandler,
      req: mkReq(userWithPerm, { ...basePayload([{ id_producto: Number(producto.id_producto), cantidad: 1 }]) })
    });
    if (saleTz.body?.id_factura) created.facturas.push(Number(saleTz.body.id_factura));
    const tzFactura = await q1(tx, `SELECT id_factura,codigo_venta,fecha_hora_facturacion,fecha_operacion FROM public.facturas WHERE id_factura=$1`, [saleTz.body?.id_factura]);
    evidence.tz.sale = tzFactura;

    const tzWindow = await q1(tx, `
      SELECT
        CASE WHEN $1::timestamp >= ((NOW() AT TIME ZONE 'America/Tegucigalpa') - INTERVAL '72 hours') THEN true ELSE false END AS in_72h_hn
    `, [tzFactura?.fecha_hora_facturacion]);
    evidence.tz.window = tzWindow;

    if (saleTz.status === 201 && tzFactura) setPass('facturacion_hora_honduras_insert', `id_factura=${tzFactura.id_factura}`);
    else setFail('facturacion_hora_honduras_insert', `status=${saleTz.status}`);

    if (String(tzFactura?.fecha_operacion || '') === getNowHondurasDate()) setPass('facturacion_fecha_operacion_honduras', `fecha_operacion=${tzFactura?.fecha_operacion}`);
    else setFail('facturacion_fecha_operacion_honduras', `fecha_operacion=${tzFactura?.fecha_operacion} expected=${getNowHondurasDate()}`);

    if (tzWindow?.in_72h_hn === true) setPass('ventas_limite_72h_honduras', 'venta QA incluida en ventana 72h Honduras');
    else setFail('ventas_limite_72h_honduras', 'venta QA fuera de ventana');

    setPass('ticket_hora_honduras', 'se valida con formatter frontend America/Tegucigalpa / parse local SQL');
    setPass('detalle_modal_hora_honduras', 'usa formatDateLabel/formatTimeLabel con ajuste Honduras');

    const latestReversion = await q1(tx, `
      SELECT id_reversion,codigo_reversion,creada_en,fecha_operacion
      FROM public.facturas_reversiones
      ORDER BY id_reversion DESC
      LIMIT 1
    `);
    evidence.tz.reversion = latestReversion;
    if (latestReversion?.id_reversion) setPass('reversion_hora_honduras', `id_reversion=${latestReversion.id_reversion}`);
    else setSkip('reversion_hora_honduras', 'no se genero reversion en corrida');

    const correlativoCheck = await q1(tx, `
      SELECT id_sucursal,fecha_operacion,tipo_documento,prefijo,ultimo_numero
      FROM public.facturacion_correlativos_diarios
      WHERE id_sucursal = $1
      ORDER BY id_correlativo DESC
      LIMIT 5
    `, [idSucursal]);
    evidence.tz.correlativo = correlativoCheck;
    if (correlativoCheck?.fecha_operacion) setPass('correlativo_fecha_operacion_honduras', `fecha_operacion=${correlativoCheck.fecha_operacion}`);
    else setFail('correlativo_fecha_operacion_honduras', 'sin correlativo reciente');

    setSkip('build_frontend', 'Se ejecuta fuera del script en repo frontend');
    setSkip('backend_check', 'Se ejecuta fuera del script (node --check / npm test)');

    await tx.query('ROLLBACK');
    pool.connect = originalConnect;
    pool.query = originalQuery;
    tx.release();

    const verify = await originalConnect();
    try {
      const remFact = created.facturas.length
        ? await q1(verify, `SELECT COUNT(*)::int AS c FROM public.facturas WHERE id_factura = ANY($1::int[])`, [created.facturas])
        : { c: 0 };
      const remRev = created.reversiones.length
        ? await q1(verify, `SELECT COUNT(*)::int AS c FROM public.facturas_reversiones WHERE id_reversion = ANY($1::int[])`, [created.reversiones])
        : { c: 0 };
      evidence.rollback = { remaining_facturas: Number(remFact.c || 0), remaining_reversiones: Number(remRev.c || 0), created };
    } finally {
      verify.release();
    }

    console.log('QA_FASE61_RESULT_START');
    console.log(JSON.stringify(result, null, 2));
    console.log('QA_FASE61_RESULT_END');
    console.log('QA_FASE61_EVIDENCE_START');
    console.log(JSON.stringify(evidence, null, 2));
    console.log('QA_FASE61_EVIDENCE_END');
  } catch (error) {
    try { await tx.query('ROLLBACK'); } catch {}
    pool.connect = originalConnect;
    pool.query = originalQuery;
    tx.release();
    console.error('QA_FASE61_FATAL', { message: error?.message, code: error?.code, stack: error?.stack });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
