import pool from '../config/db-connection.js';
import { validarYDescontarPedido } from '../services/inventarioPedidoService.js';

const ROLLBACK_BY_DEFAULT = process.env.QA_COMMIT === 'true' ? false : true;

const roundMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const nowTag = () => new Date().toISOString().replace(/[.:TZ-]/g, '').slice(0, 14);

const normalizeCode = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '_');

const getEstadoIdByCode = async (client, code) => {
  const aliases = {
    EN_COCINA: new Set(['en_cocina']),
    LISTO_PARA_ENTREGA: new Set(['listo_para_entrega'])
  };
  const rs = await client.query('SELECT id_estado_pedido, descripcion FROM estados_pedido');
  for (const row of rs.rows) {
    if (aliases[code]?.has(normalizeCode(row.descripcion))) return Number(row.id_estado_pedido);
  }
  return null;
};

const pickBaseContext = async (client) => {
  const rs = await client.query(`
    SELECT f.id_sucursal, f.id_usuario, f.id_cliente, f.id_caja, f.id_sesion_caja,
           COALESCE(fc.id_metodo_pago, 1) AS id_metodo_pago
    FROM facturas f
    LEFT JOIN facturas_cobros fc ON fc.id_factura = f.id_factura
    WHERE f.id_pedido IS NOT NULL
      AND f.id_sucursal IS NOT NULL
      AND f.id_usuario IS NOT NULL
      AND f.id_caja IS NOT NULL
      AND f.id_sesion_caja IS NOT NULL
    ORDER BY f.id_factura DESC
    LIMIT 1
  `);
  if (!rs.rows.length) throw new Error('No hay contexto base de factura con pedido para QA.');
  return rs.rows[0];
};

const pickFixtureTemplate = async (client, idSucursal, idUsuarioFallback) => {
  const almacenRs = await client.query(
    `SELECT id_almacen FROM almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen DESC LIMIT 1`,
    [idSucursal]
  );
  if (!almacenRs.rows.length) throw new Error(`No hay almacen activo para sucursal ${idSucursal}.`);

  const insumoTemplateRs = await client.query(
    `SELECT id_unidad_medida, COALESCE(id_categoria_insumo,1) AS id_categoria_insumo
     FROM insumos
     WHERE id_almacen=$1 AND COALESCE(estado,true)=true AND id_unidad_medida IS NOT NULL
     ORDER BY id_insumo DESC LIMIT 1`,
    [Number(almacenRs.rows[0].id_almacen)]
  );
  if (!insumoTemplateRs.rows.length) throw new Error('No hay insumo plantilla con unidad de medida.');

  const recetaTemplateRs = await client.query(
    `SELECT id_menu, id_nivel_picante, COALESCE(id_usuario, $1::int) AS id_usuario,
            COALESCE(id_tipo_departamento,1) AS id_tipo_departamento
     FROM recetas
     WHERE COALESCE(estado,true)=true
     ORDER BY id_receta DESC
      LIMIT 1`,
    [idUsuarioFallback]
  );
  if (!recetaTemplateRs.rows.length) throw new Error('No hay receta plantilla para crear fixture QA.');

  const comboTemplateRs = await client.query(
    `SELECT id_menu, COALESCE(id_usuario, $1::int) AS id_usuario,
            COALESCE(id_tipo_departamento,1) AS id_tipo_departamento
     FROM combos
     WHERE COALESCE(estado,true)=true
     ORDER BY id_combo DESC
     LIMIT 1`,
    [idUsuarioFallback]
  );
  if (!comboTemplateRs.rows.length) throw new Error('No hay combo plantilla para crear fixture QA.');

  return {
    id_almacen: Number(almacenRs.rows[0].id_almacen),
    id_unidad_medida: Number(insumoTemplateRs.rows[0].id_unidad_medida),
    id_categoria_insumo: Number(insumoTemplateRs.rows[0].id_categoria_insumo),
    receta_template: recetaTemplateRs.rows[0],
    combo_template: comboTemplateRs.rows[0]
  };
};

const createQaFixture = async ({ client, idSucursal, idUsuario }) => {
  const tag = nowTag();
  const tpl = await pickFixtureTemplate(client, idSucursal, idUsuario);

  const productoRs = await client.query(
    `
      INSERT INTO productos (
        nombre_producto, precio, cantidad, descripcion_producto,
        fecha_ingreso_producto, id_almacen, stock_minimo, estado
      ) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,true)
      RETURNING id_producto
    `,
    [`QA_PRODUCTO_E2E_COCINA_${tag}`, 12.5, 5000, 'QA fixture producto', tpl.id_almacen, 0]
  );
  const idProducto = Number(productoRs.rows[0].id_producto);

  const insumoRs = await client.query(
    `
      INSERT INTO insumos (
        nombre_insumo, precio, cantidad, fecha_ingreso_insumo, id_almacen,
        descripcion, stock_minimo, estado, id_categoria_insumo, id_unidad_medida
      ) VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,true,$7,$8)
      RETURNING id_insumo
    `,
    [
      `QA_INSUMO_E2E_COCINA_${tag}`,
      3.25,
      7000,
      tpl.id_almacen,
      'QA fixture insumo',
      0,
      tpl.id_categoria_insumo,
      tpl.id_unidad_medida
    ]
  );
  const idInsumo = Number(insumoRs.rows[0].id_insumo);

  const recetaRs = await client.query(
    `
      INSERT INTO recetas (
        nombre_receta, descripcion, fecha_modificacion,
        id_menu, id_nivel_picante, fecha_creacion,
        id_usuario, estado, id_tipo_departamento, precio
      ) VALUES ($1,$2,CURRENT_DATE,$3,$4,CURRENT_TIMESTAMP,$5,true,$6,$7)
      RETURNING id_receta
    `,
    [
      `QA_RECETA_E2E_COCINA_${tag}`,
      'QA receta valida',
      Number(tpl.receta_template.id_menu),
      Number(tpl.receta_template.id_nivel_picante),
      Number(tpl.receta_template.id_usuario || idUsuario),
      Number(tpl.receta_template.id_tipo_departamento || 1),
      25
    ]
  );
  const idReceta = Number(recetaRs.rows[0].id_receta);

  await client.query(
    `
      INSERT INTO detalle_recetas (id_receta, id_insumo, cant, estado, id_unidad_medida)
      VALUES ($1,$2,$3,true,$4)
    `,
    [idReceta, idInsumo, 2, tpl.id_unidad_medida]
  );

  const comboRs = await client.query(
    `
      INSERT INTO combos (
        id_menu, descripcion, cant_personas, estado, fecha_creacion,
        id_usuario, precio, id_tipo_departamento, nombre_combo
      ) VALUES ($1,$2,$3,true,CURRENT_TIMESTAMP,$4,$5,$6,$7)
      RETURNING id_combo
    `,
    [
      Number(tpl.combo_template.id_menu),
      'QA combo valido',
      1,
      Number(tpl.combo_template.id_usuario || idUsuario),
      40,
      Number(tpl.combo_template.id_tipo_departamento || 1),
      `QA_COMBO_E2E_COCINA_${tag}`
    ]
  );
  const idCombo = Number(comboRs.rows[0].id_combo);

  await client.query(
    `INSERT INTO detalle_combo (id_combo, id_receta, cantidad, orden, estado, fecha_creacion)
     VALUES ($1,$2,$3,$4,true,CURRENT_TIMESTAMP)`,
    [idCombo, idReceta, 1, 1]
  );

  const recetaRotaRs = await client.query(
    `
      INSERT INTO recetas (
        nombre_receta, descripcion, fecha_modificacion,
        id_menu, id_nivel_picante, fecha_creacion,
        id_usuario, estado, id_tipo_departamento, precio
      ) VALUES ($1,$2,CURRENT_DATE,$3,$4,CURRENT_TIMESTAMP,$5,true,$6,$7)
      RETURNING id_receta
    `,
    [
      `QA_RECETA_ROTA_E2E_COCINA_${tag}`,
      'QA receta sin componentes',
      Number(tpl.receta_template.id_menu),
      Number(tpl.receta_template.id_nivel_picante),
      Number(tpl.receta_template.id_usuario || idUsuario),
      Number(tpl.receta_template.id_tipo_departamento || 1),
      19
    ]
  );

  return {
    tag,
    id_almacen: tpl.id_almacen,
    id_producto: idProducto,
    id_insumo: idInsumo,
    id_receta: idReceta,
    id_combo: idCombo,
    id_receta_rota: Number(recetaRotaRs.rows[0].id_receta)
  };
};

const createVentaArtifacts = async ({ client, ctx, estadoEnCocinaId, lines, tag }) => {
  const subtotal = roundMoney(lines.reduce((acc, it) => acc + Number(it.precio) * Number(it.cantidad), 0));
  const isv = roundMoney(subtotal * 0.15);
  const total = roundMoney(subtotal + isv);

  const pedidoInsert = await client.query(
    `
      INSERT INTO pedidos (
        descripcion_pedido, descripcion_envio, fecha_hora_pedido,
        sub_total, isv, total,
        id_estado_pedido, id_sucursal, id_cliente, id_usuario, origen_pedido
      ) VALUES ($1, NULL, CURRENT_TIMESTAMP, $2, $3, $4, $5, $6, $7, $8, 'QA_E2E')
      RETURNING id_pedido
    `,
    [`QA ${tag}`, subtotal, isv, total, estadoEnCocinaId, Number(ctx.id_sucursal), ctx.id_cliente ? Number(ctx.id_cliente) : null, Number(ctx.id_usuario)]
  );

  const idPedido = Number(pedidoInsert.rows[0].id_pedido);

  for (const line of lines) {
    const sub = roundMoney(Number(line.precio) * Number(line.cantidad));
    await client.query(
      `
        INSERT INTO detalle_pedido (
          sub_total_pedido, total_pedido, id_producto, id_pedido,
          id_descuento, estado, id_combo, id_receta, observacion
        ) VALUES ($1,$2,$3,$4,NULL,true,$5,$6,$7)
      `,
      [sub, sub, line.id_producto, idPedido, line.id_combo, line.id_receta, `QA-LINE-${tag}`]
    );
  }

  const codigoVenta = `QA-${idPedido}`;
  const facturaInsert = await client.query(
    `
      INSERT INTO facturas (
        id_caja, id_pedido, id_sucursal, id_usuario, id_cliente,
        codigo_venta, fecha_operacion, efectivo_entregado, cambio,
        fecha_hora_facturacion, isv_15, isv_18, id_sesion_caja
      ) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,CURRENT_TIMESTAMP,$9,0,$10)
      RETURNING id_factura
    `,
    [Number(ctx.id_caja), idPedido, Number(ctx.id_sucursal), Number(ctx.id_usuario), ctx.id_cliente ? Number(ctx.id_cliente) : null, codigoVenta, total, 0, isv, Number(ctx.id_sesion_caja)]
  );

  const idFactura = Number(facturaInsert.rows[0].id_factura);

  await client.query(
    `
      INSERT INTO facturas_cobros (
        id_factura, id_sesion_caja, id_caja, id_sucursal,
        id_usuario_ejecutor, id_metodo_pago, monto, fecha_cobro, fecha_creacion
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    `,
    [idFactura, Number(ctx.id_sesion_caja), Number(ctx.id_caja), Number(ctx.id_sucursal), Number(ctx.id_usuario), Number(ctx.id_metodo_pago || 1), total]
  );

  for (const line of lines) {
    const sub = roundMoney(Number(line.precio) * Number(line.cantidad));
    await client.query(
      `
        INSERT INTO detalle_facturas (
          id_factura, id_producto, id_descuento, cantidad,
          precio_unitario, sub_total, total_detalle, id_pedido
        ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)
      `,
      [idFactura, line.id_producto, Number(line.cantidad), Number(line.precio), sub, sub, idPedido]
    );
  }

  return { idPedido, idFactura, codigoVenta, total };
};

const buildConsumoPayloadFromLines = ({ idPedido, idSucursal, lines }) => ({
  id_pedido: idPedido,
  id_sucursal: idSucursal,
  items: lines.map((line) => ({
    tipo_item: line.id_combo ? 'COMBO' : line.id_receta ? 'RECETA' : 'PRODUCTO',
    id_item: Number(line.id_combo || line.id_receta || line.id_producto),
    cantidad: Number(line.cantidad || 1)
  }))
});

const verifyNoVentaMovement = async (client, idFactura) => {
  const rs = await client.query('SELECT COUNT(*) AS total FROM movimientos_inventario WHERE ref_origen = $1 AND id_ref = $2', ['VENTA', idFactura]);
  return Number(rs.rows[0].total) === 0;
};

const verifyPedidoMovements = async (client, idPedido) => {
  const rs = await client.query(
    `SELECT ref_origen, COUNT(*) AS total
     FROM movimientos_inventario
     WHERE id_ref = $1 AND ref_origen = ANY($2::text[])
     GROUP BY ref_origen
     ORDER BY ref_origen`,
    [idPedido, ['PEDIDO', 'FALTANTE_COCINA']]
  );
  return rs.rows;
};

const runCase = async ({ client, ctx, estadoEnCocinaId, estadoListoId, lines, tag, allowNegativeStock = false, applyListo = true }) => {
  const created = await createVentaArtifacts({ client, ctx, estadoEnCocinaId, lines, tag });
  const detailCountRs = await client.query('SELECT COUNT(*) AS total FROM detalle_pedido WHERE id_pedido = $1', [created.idPedido]);
  const noVentaMovement = await verifyNoVentaMovement(client, created.idFactura);

  const consumoPayload = buildConsumoPayloadFromLines({ idPedido: created.idPedido, idSucursal: Number(ctx.id_sucursal), lines });
  const beforeMovements = await verifyPedidoMovements(client, created.idPedido);

  const discountResult = await validarYDescontarPedido(consumoPayload, {
    dbClient: client,
    id_usuario: Number(ctx.id_usuario),
    allowNegativeStock,
    shortageMode: 'FALTANTE_COCINA'
  });

  if (!discountResult.ok) {
    return {
      tag,
      ok: false,
      stage: 'descuento',
      created,
      noVentaMovement,
      detailCount: Number(detailCountRs.rows[0].total),
      beforeMovements,
      discountResult
    };
  }

  if (applyListo) {
    await client.query('UPDATE pedidos SET id_estado_pedido = $2 WHERE id_pedido = $1', [created.idPedido, estadoListoId]);
  }

  const afterMovements = await verifyPedidoMovements(client, created.idPedido);

  let secondAttempt;
  try {
    await validarYDescontarPedido(consumoPayload, {
      dbClient: client,
      id_usuario: Number(ctx.id_usuario),
      allowNegativeStock,
      shortageMode: 'FALTANTE_COCINA'
    });
    secondAttempt = { ok: false, code: 'SEGUNDA_EJECUCION_PERMITIDA' };
  } catch (error) {
    secondAttempt = { ok: true, code: error.code || 'ERROR', message: error.message };
  }

  return {
    tag,
    ok: true,
    created,
    noVentaMovement,
    detailCount: Number(detailCountRs.rows[0].total),
    beforeMovements,
    discountResult,
    afterMovements,
    secondAttempt
  };
};

const collectSqlChecks = async (client, qaPrefix) => {
  const checks = {};

  const ventaRs = await client.query(
    `SELECT COUNT(*) AS total
     FROM movimientos_inventario mi
     JOIN facturas f ON f.id_factura = mi.id_ref
     WHERE f.codigo_venta LIKE $1
       AND mi.ref_origen = 'VENTA'`,
    [`${qaPrefix}%`]
  );
  checks.movimientos_venta_qa = Number(ventaRs.rows[0].total);

  const qaPedidoRs = await client.query(
    `SELECT f.id_pedido
     FROM facturas f
     WHERE f.codigo_venta LIKE $1
       AND f.id_pedido IS NOT NULL`,
    [`${qaPrefix}%`]
  );
  const qaPedidoIds = qaPedidoRs.rows.map((r) => Number(r.id_pedido));

  if (qaPedidoIds.length > 0) {
    const refsRs = await client.query(
      `SELECT ref_origen, COUNT(*) AS total
       FROM movimientos_inventario
       WHERE id_ref = ANY($1::int[])
         AND ref_origen = ANY($2::text[])
       GROUP BY ref_origen
       ORDER BY ref_origen`,
      [qaPedidoIds, ['PEDIDO', 'FALTANTE_COCINA']]
    );
    checks.movimientos_qa_por_origen = refsRs.rows;

    const dupRs = await client.query(
      `SELECT id_ref, ref_origen, COUNT(*) AS total
       FROM movimientos_inventario
       WHERE id_ref = ANY($1::int[])
         AND ref_origen = ANY($2::text[])
       GROUP BY id_ref, ref_origen
       HAVING COUNT(*) > 1
       ORDER BY total DESC`,
      [qaPedidoIds, ['PEDIDO', 'FALTANTE_COCINA']]
    );
    checks.duplicados_qa = dupRs.rows;

    const detailRs = await client.query(
      `SELECT id_pedido,
              COUNT(*) FILTER (WHERE id_producto IS NOT NULL) AS lineas_producto,
              COUNT(*) FILTER (WHERE id_receta IS NOT NULL) AS lineas_receta,
              COUNT(*) FILTER (WHERE id_combo IS NOT NULL) AS lineas_combo,
              COUNT(*) AS total
       FROM detalle_pedido
       WHERE id_pedido = ANY($1::int[])
       GROUP BY id_pedido
       ORDER BY id_pedido`,
      [qaPedidoIds]
    );
    checks.detalle_pedido_qa = detailRs.rows;
  } else {
    checks.movimientos_qa_por_origen = [];
    checks.duplicados_qa = [];
    checks.detalle_pedido_qa = [];
  }

  return checks;
};

const main = async () => {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    console.error(JSON.stringify({
      ok: false,
      code: 'QA_SCRIPT_BLOCKED_IN_PRODUCTION',
      message: 'Script QA bloqueado en NODE_ENV=production.'
    }, null, 2));
    process.exit(1);
  }

  const client = await pool.connect();
  const summary = {
    rollback_mode: ROLLBACK_BY_DEFAULT,
    qa_commit_enabled: process.env.QA_COMMIT === 'true',
    generated_at: new Date().toISOString(),
    cases: {},
    checks: {}
  };

  try {
    await client.query('BEGIN');

    const ctx = await pickBaseContext(client);
    const estadoEnCocinaId = await getEstadoIdByCode(client, 'EN_COCINA');
    const estadoListoId = await getEstadoIdByCode(client, 'LISTO_PARA_ENTREGA');
    if (!estadoEnCocinaId || !estadoListoId) {
      throw new Error('No se encontraron estados EN_COCINA / LISTO_PARA_ENTREGA.');
    }

    const fixture = await createQaFixture({
      client,
      idSucursal: Number(ctx.id_sucursal),
      idUsuario: Number(ctx.id_usuario)
    });

    summary.checks.context = { ...ctx, estadoEnCocinaId, estadoListoId, fixture };

    const precioProducto = 12.5;
    const precioReceta = 25;
    const precioCombo = 40;

    summary.cases.producto = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'PRODUCTO',
      lines: [{ id_producto: fixture.id_producto, id_receta: null, id_combo: null, cantidad: 1, precio: precioProducto }]
    });

    summary.cases.receta = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'RECETA',
      lines: [{ id_producto: null, id_receta: fixture.id_receta, id_combo: null, cantidad: 1, precio: precioReceta }]
    });

    summary.cases.combo = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'COMBO',
      lines: [{ id_producto: null, id_receta: null, id_combo: fixture.id_combo, cantidad: 1, precio: precioCombo }]
    });

    summary.cases.mixto = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'MIXTO',
      lines: [
        { id_producto: fixture.id_producto, id_receta: null, id_combo: null, cantidad: 1, precio: precioProducto },
        { id_producto: null, id_receta: fixture.id_receta, id_combo: null, cantidad: 1, precio: precioReceta },
        { id_producto: null, id_receta: null, id_combo: fixture.id_combo, cantidad: 1, precio: precioCombo }
      ]
    });

    summary.cases.stock_insuficiente = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'STOCK_INSUFICIENTE',
      allowNegativeStock: true,
      lines: [{ id_producto: fixture.id_producto, id_receta: null, id_combo: null, cantidad: 999999, precio: precioProducto }]
    });

    const configCase = await runCase({
      client,
      ctx,
      estadoEnCocinaId,
      estadoListoId,
      tag: 'CONFIG_ROTA',
      applyListo: false,
      lines: [{ id_producto: null, id_receta: fixture.id_receta_rota, id_combo: null, cantidad: 1, precio: 19 }]
    });
    summary.cases.configuracion_rota = configCase;

    summary.checks.sql = await collectSqlChecks(client, 'QA-');

    if (ROLLBACK_BY_DEFAULT) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({
      ok: false,
      code: error.code || 'QA_SCRIPT_ERROR',
      message: error.message,
      stack: process.env.QA_DEBUG_STACK === 'true' ? error.stack : undefined
    }, null, 2));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

main();
