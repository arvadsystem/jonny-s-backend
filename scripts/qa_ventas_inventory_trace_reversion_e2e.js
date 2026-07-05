import path from 'node:path';
import dotenv from 'dotenv';
import pool from '../config/db-connection.js';
import { validarYDescontarPedido } from '../services/inventarioPedidoService.js';
import { createVentaReversion } from '../services/ventasReversionService.js';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const fail = (code, message) => {
  const error = new Error(message || code);
  error.code = code;
  throw error;
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

const nextCode = (prefix) => `${prefix}${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 1000)}`;

const normalizeRoles = (roles) => Array.isArray(roles)
  ? roles.map((role) => String(role || '').trim().toUpperCase()).filter(Boolean)
  : [];

const resolveQaUser = async (client) => queryOne(
  client,
  `
    WITH clock AS (
      SELECT
        (NOW() AT TIME ZONE 'America/Tegucigalpa')::date AS fecha_actual,
        (NOW() AT TIME ZONE 'America/Tegucigalpa')::time AS hora_actual,
        EXTRACT(ISODOW FROM (NOW() AT TIME ZONE 'America/Tegucigalpa'))::int AS dia_semana
    )
    SELECT
      u.id_usuario,
      u.nombre_usuario,
      e.id_sucursal,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.nombre), NULL) AS roles,
      CASE
        WHEN s.id_sucursal IS NULL THEN false
        WHEN COALESCE(s.estado, true) = false THEN false
        WHEN fe.id_fecha_especial IS NOT NULL THEN
          CASE
            WHEN COALESCE(fe.cerrado, false) = true THEN false
            WHEN fe.hora_inicio IS NULL OR fe.hora_final IS NULL THEN false
            WHEN fe.hora_final > fe.hora_inicio THEN clock.hora_actual >= fe.hora_inicio AND clock.hora_actual < fe.hora_final
            ELSE clock.hora_actual >= fe.hora_inicio OR clock.hora_actual < fe.hora_final
          END
        WHEN sh.id_horario IS NOT NULL THEN
          CASE
            WHEN COALESCE(sh.cerrado, false) = true THEN false
            WHEN sh.hora_inicio IS NULL OR sh.hora_final IS NULL THEN false
            WHEN sh.hora_final > sh.hora_inicio THEN clock.hora_actual >= sh.hora_inicio AND clock.hora_actual < sh.hora_final
            ELSE clock.hora_actual >= sh.hora_inicio OR clock.hora_actual < sh.hora_final
          END
        WHEN s.hora_inicio IS NOT NULL AND s.hora_final IS NOT NULL THEN
          CASE
            WHEN s.hora_final > s.hora_inicio THEN clock.hora_actual >= s.hora_inicio AND clock.hora_actual < s.hora_final
            ELSE clock.hora_actual >= s.hora_inicio OR clock.hora_actual < s.hora_final
          END
        ELSE true
      END AS sucursal_abierta
    FROM clock
    INNER JOIN public.usuarios u ON COALESCE(u.estado, true) = true
    INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
    INNER JOIN public.roles r ON r.id_rol = ru.id_rol
    INNER JOIN public.roles_permisos rp ON rp.id_rol = ru.id_rol
    INNER JOIN public.permisos p ON p.id_permiso = rp.id_permiso
    INNER JOIN public.empleados e ON e.id_empleado = u.id_empleado
    INNER JOIN public.sucursales s ON s.id_sucursal = e.id_sucursal
    LEFT JOIN LATERAL (
      SELECT id_fecha_especial, cerrado, hora_inicio, hora_final
      FROM public.sucursales_fechas_especiales
      WHERE id_sucursal = s.id_sucursal
        AND fecha = clock.fecha_actual
        AND COALESCE(estado, true) = true
      ORDER BY id_fecha_especial DESC
      LIMIT 1
    ) fe ON true
    LEFT JOIN LATERAL (
      SELECT id_horario, cerrado, hora_inicio, hora_final
      FROM public.sucursales_horarios
      WHERE id_sucursal = s.id_sucursal
        AND dia_semana = clock.dia_semana
        AND COALESCE(estado, true) = true
      LIMIT 1
    ) sh ON true
    WHERE UPPER(TRIM(p.nombre_permiso)) = 'VENTAS_REVERSION_CREAR'
      AND e.id_sucursal IS NOT NULL
    GROUP BY u.id_usuario, u.nombre_usuario, e.id_sucursal, s.id_sucursal, s.estado, s.hora_inicio, s.hora_final,
      fe.id_fecha_especial, fe.cerrado, fe.hora_inicio, fe.hora_final,
      sh.id_horario, sh.cerrado, sh.hora_inicio, sh.hora_final,
      clock.hora_actual
    ORDER BY sucursal_abierta DESC, u.id_usuario
    LIMIT 1
  `
);

const forceBranchOpenInTransaction = async (client, idSucursal) => {
  const existing = await queryOne(
    client,
    `
      SELECT id_fecha_especial
      FROM public.sucursales_fechas_especiales
      WHERE id_sucursal = $1
        AND fecha = (NOW() AT TIME ZONE 'America/Tegucigalpa')::date
      ORDER BY id_fecha_especial DESC
      LIMIT 1
      FOR UPDATE
    `,
    [idSucursal]
  );

  if (existing?.id_fecha_especial) {
    await client.query(
      `
        UPDATE public.sucursales_fechas_especiales
        SET cerrado = false,
            hora_inicio = '00:00'::time,
            hora_final = '23:59'::time,
            estado = true
        WHERE id_fecha_especial = $1
      `,
      [existing.id_fecha_especial]
    );
    return { mode: 'updated_existing_fecha_especial', id_fecha_especial: Number(existing.id_fecha_especial) };
  }

  const inserted = await queryOne(
    client,
    `
      INSERT INTO public.sucursales_fechas_especiales (
        id_sucursal, fecha, cerrado, hora_inicio, hora_final, estado
      )
      VALUES ($1, (NOW() AT TIME ZONE 'America/Tegucigalpa')::date, false, '00:00'::time, '23:59'::time, true)
      RETURNING id_fecha_especial
    `,
    [idSucursal]
  );
  return { mode: 'inserted_fecha_especial', id_fecha_especial: Number(inserted.id_fecha_especial) };
};

const run = async () => {
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const txClient = await originalConnect();
  const fixtureIds = {
    facturas: [],
    detalle_facturas: [],
    pedidos: [],
    detalle_pedido: [],
    reversiones: []
  };

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

    const user = await resolveQaUser(txClient);
    assertTrue(user, 'QA_USER_NOT_FOUND', 'No se encontro usuario QA con permiso VENTAS_REVERSION_CREAR.');

    const idUsuario = Number(user.id_usuario);
    const idSucursal = Number(user.id_sucursal);
    const branchOpenPatch = Boolean(user.sucursal_abierta)
      ? { mode: 'already_open' }
      : await forceBranchOpenInTransaction(txClient, idSucursal);

    const [openState, roleCaja, metodoPago, almacen] = await Promise.all([
      queryOne(txClient, `SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo))='ABIERTA' LIMIT 1`),
      queryOne(txClient, `SELECT id_rol_participacion_caja FROM public.cat_cajas_roles_participacion WHERE COALESCE(estado,true)=true ORDER BY id_rol_participacion_caja LIMIT 1`),
      queryOne(txClient, `SELECT id_metodo_pago FROM public.cat_metodos_pago WHERE COALESCE(estado,true)=true ORDER BY id_metodo_pago LIMIT 1`),
      queryOne(txClient, `SELECT id_almacen FROM public.almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen LIMIT 1`, [idSucursal])
    ]);
    assertTrue(openState && roleCaja && metodoPago && almacen, 'QA_CATALOGS_MISSING', 'Faltan catalogos QA para caja/almacen.');

    const caja = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas (id_sucursal, id_usuario, estado, nombre_caja, codigo_caja, fecha_actualizacion)
        VALUES ($1, $2, true, $3, $4, NOW())
        RETURNING id_caja
      `,
      [idSucursal, idUsuario, `QA Caja Trace ${Date.now()}`, nextCode('QATC')]
    );
    const idCaja = Number(caja.id_caja);
    const responsable = await queryOne(
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
        ORDER BY CASE WHEN u.id_usuario = $1 THEN 0 ELSE 1 END, u.id_usuario
        LIMIT 1
      `,
      [idUsuario]
    );
    const idResponsable = Number(responsable?.id_usuario || idUsuario);

    const sesion = await queryOne(
      txClient,
      `
        INSERT INTO public.cajas_sesiones (
          id_caja, id_sucursal, id_usuario_responsable, id_estado_sesion_caja,
          id_usuario_apertura, monto_apertura, fecha_apertura, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1,$2,$3,$4,$3,100,NOW(),NOW(),NOW())
        RETURNING id_sesion_caja
      `,
      [idCaja, idSucursal, idResponsable, Number(openState.id_estado_sesion_caja)]
    );
    const idSesionCaja = Number(sesion.id_sesion_caja);

    await txClient.query(
      `
        INSERT INTO public.cajas_sesiones_participantes (
          id_sesion_caja, id_usuario, id_rol_participacion_caja,
          fecha_inicio, activo, fecha_creacion, fecha_actualizacion
        )
        VALUES ($1,$2,$3,NOW(),true,NOW(),NOW())
      `,
      [idSesionCaja, idUsuario, Number(roleCaja.id_rol_participacion_caja)]
    );

    const template = await queryOne(
      txClient,
      `
        SELECT
          COALESCE((SELECT id_unidad_medida FROM public.unidades_medida WHERE COALESCE(estado,true)=true ORDER BY id_unidad_medida LIMIT 1), 1) AS id_unidad_medida,
          COALESCE((SELECT id_categoria_insumo FROM public.categorias_insumos WHERE COALESCE(estado,true)=true ORDER BY id_categoria_insumo LIMIT 1), 1) AS id_categoria_insumo,
          r.id_menu,
          r.id_nivel_picante,
          COALESCE(r.id_tipo_departamento, 1) AS id_tipo_departamento
        FROM public.recetas r
        WHERE COALESCE(r.estado, true) = true
        ORDER BY r.id_receta DESC
        LIMIT 1
      `
    );
    assertTrue(template, 'QA_TEMPLATE_MISSING', 'No se resolvieron catalogos para insumo/receta.');

    const insumo = await queryOne(
      txClient,
      `
        INSERT INTO public.insumos (
          nombre_insumo, precio, cantidad, fecha_ingreso_insumo, id_almacen,
          descripcion, stock_minimo, estado, id_categoria_insumo, id_unidad_medida
        )
        VALUES ($1, 3, 100.000000, CURRENT_DATE, $2, $3, 0, true, $4, $5)
        RETURNING id_insumo
      `,
      [
        `QA_INSUMO_TRACE_${Date.now()}`,
        Number(almacen.id_almacen),
        'QA venta trazada con reversa',
        Number(template.id_categoria_insumo),
        Number(template.id_unidad_medida)
      ]
    );
    const idInsumo = Number(insumo.id_insumo);

    await txClient.query(
      `
        INSERT INTO public.insumos_almacenes (
          id_insumo, id_almacen, cantidad, stock_minimo, precio_compra, estado
        )
        VALUES ($1, $2, 100.000000, 0, 3, true)
      `,
      [idInsumo, Number(almacen.id_almacen)]
    );

    const receta = await queryOne(
      txClient,
      `
        INSERT INTO public.recetas (
          nombre_receta, descripcion, fecha_modificacion,
          id_menu, id_nivel_picante, fecha_creacion,
          id_usuario, estado, id_tipo_departamento, precio
        )
        VALUES ($1, $2, CURRENT_DATE, $3, $4, CURRENT_TIMESTAMP, $5, true, $6, 10)
        RETURNING id_receta
      `,
      [
        `QA_RECETA_TRACE_${Date.now()}`,
        'QA receta trazada con reversa',
        template.id_menu ? Number(template.id_menu) : null,
        Number(template.id_nivel_picante),
        idUsuario,
        Number(template.id_tipo_departamento)
      ]
    );
    const idReceta = Number(receta.id_receta);

    await txClient.query(
      `
        INSERT INTO public.detalle_recetas (id_receta, id_insumo, cant, estado, id_unidad_medida)
        VALUES ($1, $2, 1.000000, true, $3)
      `,
      [idReceta, idInsumo, Number(template.id_unidad_medida)]
    );

    const idPedidoFixture = Number(await queryValue(
      txClient,
      `
        SELECT GREATEST(
          COALESCE((SELECT MAX(id_pedido) FROM public.pedidos), 0),
          COALESCE((SELECT MAX(id_ref) FROM public.movimientos_inventario WHERE ref_origen IN ('PEDIDO','FALTANTE_COCINA')), 0)
        ) + 100000 AS value
      `
    ));

    const pedido = await queryOne(
      txClient,
      `
        INSERT INTO public.pedidos (
          id_pedido, descripcion_pedido, fecha_hora_pedido, sub_total, isv, total,
          id_estado_pedido, id_sucursal, id_cliente, id_usuario, origen_pedido
        )
        OVERRIDING SYSTEM VALUE
        VALUES ($1, 'QA venta trazada', CURRENT_TIMESTAMP, 10, 0, 10, NULL, $2, NULL, $3, 'QA_TRACE')
        RETURNING id_pedido
      `,
      [idPedidoFixture, idSucursal, idUsuario]
    );
    const idPedido = Number(pedido.id_pedido);
    fixtureIds.pedidos.push(idPedido);

    const detallePedido = await queryOne(
      txClient,
      `
        INSERT INTO public.detalle_pedido (
          sub_total_pedido, total_pedido, id_producto, id_pedido,
          id_descuento, estado, id_receta, cantidad, observacion
        )
        VALUES (10, 10, NULL, $1, NULL, true, $2, 1, 'QA trace line')
        RETURNING id_detalle_pedido
      `,
      [idPedido, idReceta]
    );
    const idDetallePedido = Number(detallePedido.id_detalle_pedido);
    fixtureIds.detalle_pedido.push(idDetallePedido);

    const descuento = await validarYDescontarPedido({
      id_sucursal: idSucursal,
      id_pedido: idPedido,
      items: [{
        tipo_item: 'RECETA',
        id_receta: idReceta,
        id_detalle_pedido: idDetallePedido,
        cantidad: 1
      }]
    }, {
      dbClient: txClient,
      id_usuario: idUsuario
    });
    assertTrue(descuento.ok === true, 'QA_DESCUENTO_FAIL', JSON.stringify(descuento));

    const factura = await queryOne(
      txClient,
      `
        INSERT INTO public.facturas (
          id_caja, id_pedido, id_sucursal, id_usuario, id_cliente,
          efectivo_entregado, cambio, fecha_hora_facturacion, isv_15, isv_18,
          id_sesion_caja, codigo_venta, fecha_operacion
        )
        VALUES ($1,$2,$3,$4,NULL,10,0,NOW(),0,0,$5,$6,(NOW() AT TIME ZONE 'America/Tegucigalpa')::date)
        RETURNING id_factura
      `,
      [idCaja, idPedido, idSucursal, idUsuario, idSesionCaja, nextCode('QATRV')]
    );
    const idFactura = Number(factura.id_factura);
    fixtureIds.facturas.push(idFactura);

    const detalleFactura = await queryOne(
      txClient,
      `
        INSERT INTO public.detalle_facturas (
          id_factura, id_producto, id_descuento, cantidad,
          precio_unitario, sub_total, total_detalle, id_pedido,
          id_detalle_pedido, tipo_item, id_receta
        )
        VALUES ($1,NULL,NULL,1,10,10,10,$2,$3,'RECETA',$4)
        RETURNING id_detalle_factura
      `,
      [idFactura, idPedido, idDetallePedido, idReceta]
    );
    const idDetalleFactura = Number(detalleFactura.id_detalle_factura);
    fixtureIds.detalle_facturas.push(idDetalleFactura);

    await txClient.query(
      `
        INSERT INTO public.detalle_facturas_origen (
          id_detalle_factura, id_detalle_pedido, tipo_item, id_receta, origen_snapshot
        )
        VALUES ($1,$2,'RECETA',$3,$4::jsonb)
      `,
      [idDetalleFactura, idDetallePedido, idReceta, JSON.stringify({ nombre_item: 'QA trace receta', cantidad: 1 })]
    );

    await txClient.query(
      `
        INSERT INTO public.facturas_cobros (
          id_factura, id_sesion_caja, id_caja, id_sucursal, id_usuario_ejecutor,
          id_metodo_pago, monto, referencia, fecha_cobro, fecha_creacion
        )
        VALUES ($1,$2,$3,$4,$5,$6,10,$7,NOW(),NOW())
      `,
      [idFactura, idSesionCaja, idCaja, idSucursal, idUsuario, Number(metodoPago.id_metodo_pago), nextCode('QATCO')]
    );

    const reversionResult = await createVentaReversion({
      idFactura,
      idUsuario,
      req: { headers: { 'user-agent': 'qa-ventas-inventory-trace-reversion-e2e/1.0' }, ip: '127.0.0.1' },
      body: { tipo_reversion: 'TOTAL', motivo: 'OTRO', observacion: 'QA venta trazada con reversa' }
    });
    const idReversion = Number(reversionResult?.result?.id_reversion || reversionResult?.id_reversion || 0);
    assertTrue(idReversion > 0, 'QA_REVERSION_FAIL', 'No se obtuvo id_reversion.');
    fixtureIds.reversiones.push(idReversion);

    const evidence = await queryOne(
      txClient,
      `
        WITH salidas AS (
          SELECT id_movimiento
          FROM public.movimientos_inventario
          WHERE tipo = 'SALIDA'
            AND ref_origen IN ('PEDIDO','FALTANTE_COCINA')
            AND id_ref = $1
            AND id_detalle_pedido = $2
        ),
        entradas AS (
          SELECT id_movimiento
          FROM public.movimientos_inventario
          WHERE tipo = 'ENTRADA'
            AND ref_origen = 'REVERSION_VENTA_INVENTARIO'
            AND id_ref = $3
            AND id_detalle_pedido = $2
            AND id_movimiento_origen IN (SELECT id_movimiento FROM salidas)
        ),
        fallback AS (
          SELECT id_movimiento
          FROM public.movimientos_inventario
          WHERE ref_origen = 'REVERSION_VENTA'
            AND id_ref = $3
        )
        SELECT
          (SELECT COUNT(*)::int FROM salidas) AS traced_salida_count,
          (SELECT COUNT(*)::int FROM entradas) AS traced_reversion_count,
          (SELECT COUNT(*)::int FROM fallback) AS legacy_fallback_count
      `,
      [idPedido, idDetallePedido, idReversion]
    );

    assertTrue(Number(evidence.traced_salida_count) > 0, 'QA_TRACE_SALIDA_ZERO', 'No se generaron salidas trazadas.');
    assertTrue(Number(evidence.traced_reversion_count) > 0, 'QA_TRACE_REVERSION_ZERO', 'No se generaron entradas de reversion trazadas.');
    assertTrue(Number(evidence.legacy_fallback_count) === 0, 'QA_TRACE_FALLBACK_USED', 'La reversion uso fallback legacy.');

    await txClient.query('ROLLBACK');
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();

    const verifyClient = await originalConnect();
    try {
      const remaining = {
        facturas: Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.facturas WHERE id_factura = ANY($1::int[])`, [fixtureIds.facturas])),
        pedidos: Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.pedidos WHERE id_pedido = ANY($1::int[])`, [fixtureIds.pedidos])),
        reversiones: Number(await queryValue(verifyClient, `SELECT COUNT(*)::int AS value FROM public.facturas_reversiones WHERE id_reversion = ANY($1::int[])`, [fixtureIds.reversiones]))
      };
      assertTrue(remaining.facturas === 0 && remaining.pedidos === 0 && remaining.reversiones === 0, 'QA_ROLLBACK_RESIDUE', JSON.stringify(remaining));

      console.log(JSON.stringify({
        ok: true,
        project_id: 'cluideiojeikzcmmizhe',
        id_factura: idFactura,
        id_pedido: idPedido,
        id_detalle_pedido: idDetallePedido,
        id_reversion: idReversion,
        traced_salida_count: Number(evidence.traced_salida_count),
        traced_reversion_count: Number(evidence.traced_reversion_count),
        legacy_fallback_count: Number(evidence.legacy_fallback_count),
        rollback_remaining: remaining,
        branch_open_patch: branchOpenPatch
      }, null, 2));
    } finally {
      verifyClient.release();
    }
  } catch (error) {
    try { await txClient.query('ROLLBACK'); } catch {}
    pool.connect = originalConnect;
    pool.query = originalQuery;
    txClient.release();
    console.error(JSON.stringify({
      ok: false,
      code: error?.code || 'QA_TRACE_REVERSION_ERROR',
      message: error?.message,
      detail: error?.detail,
      constraint: error?.constraint,
      stack: error?.stack
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

await run();
