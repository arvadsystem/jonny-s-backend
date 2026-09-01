import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

// Mantiene todos los nombres de fixture por debajo del limite varchar(50).
const PREFIX = 'QA_F4_VCI';
const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();
const number = (value) => Number(value);
const equalQty = (left, right) => Math.abs(number(left) - number(right)) < 0.000001;
const money = (value) => Math.round((number(value) + Number.EPSILON) * 100) / 100;
const runTag = () => `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);

const fail = (code, message, details = null) => {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  throw error;
};

const ensure = (condition, code, message, details = null) => {
  if (!condition) fail(code, message, details);
};

const preflight = () => {
  if (text(process.env.QA_COMMIT) || process.argv.some((arg) => lower(arg) === '--commit')) {
    fail('QA_COMMIT_FORBIDDEN', 'Este harness es exclusivamente ROLLBACK ONLY; QA_COMMIT y --commit estan prohibidos.');
  }
  ensure(process.argv.includes('--rollback-only'), 'QA_ROLLBACK_ONLY_REQUIRED', 'Debe ejecutar este harness con --rollback-only.');

  const projectRef = lower(process.env.QA_EXPECTED_PROJECT_REF);
  ensure(
    /^[a-z0-9]{20}$/.test(projectRef),
    'QA_DB_IDENTITY_REQUIRED',
    'Defina QA_EXPECTED_PROJECT_REF con el project ref QA verificado.'
  );

  const configured = {
    host: lower(process.env.DB_HOST),
    database: lower(process.env.DB_NAME || 'postgres'),
    user: lower(process.env.DB_USER),
    supabaseUrl: text(process.env.SUPABASE_URL)
  };
  ensure(configured.database === 'postgres', 'QA_DB_NAME_MISMATCH', 'DB_NAME debe ser postgres para este harness QA.');

  const directHost = `db.${projectRef}.supabase.co`;
  const poolerHostPattern = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
  let connectionMode;
  if (configured.host === directHost) {
    connectionMode = 'direct';
    ensure(configured.user === 'postgres', 'QA_DB_USER_PROJECT_MISMATCH', 'DB_USER no corresponde a la conexion directa del proyecto QA esperado.');
  } else if (poolerHostPattern.test(configured.host)) {
    connectionMode = 'pooler';
    ensure(
      configured.user === `postgres.${projectRef}`,
      'QA_DB_USER_PROJECT_MISMATCH',
      'DB_USER del Pooler no contiene exactamente el project ref QA esperado.'
    );
  } else {
    fail('QA_DB_HOST_NOT_ALLOWED', 'DB_HOST no es el host directo esperado ni un host Pooler valido de Supabase.');
  }

  if (configured.supabaseUrl) {
    let supabaseUrl;
    try {
      supabaseUrl = new URL(configured.supabaseUrl);
    } catch {
      fail('QA_SUPABASE_URL_INVALID', 'SUPABASE_URL no es una URL valida.');
    }
    ensure(
      supabaseUrl.protocol === 'https:' && lower(supabaseUrl.hostname) === `${projectRef}.supabase.co`,
      'QA_SUPABASE_URL_PROJECT_MISMATCH',
      'SUPABASE_URL no corresponde exactamente al project ref QA esperado.'
    );
  }

  const expected = {
    projectRef,
    connectionMode,
    configuredHost: configured.host,
    database: 'postgres',
    runtimeUser: 'postgres'
  };
  ensure(
    configured.host && configured.user,
    'QA_DB_CONFIG_IDENTITY_MISSING',
    'DB_HOST y DB_USER son obligatorios para validar la identidad QA.'
  );
  return expected;
};

const verifyRuntimeIdentity = async (client, expected) => {
  const { rows } = await client.query(`
    SELECT current_database() AS database,
           current_user AS "user",
           inet_server_addr()::text AS server_address,
           pg_is_in_recovery() AS is_replica
  `);
  const runtime = rows[0] || {};
  ensure(
    lower(runtime.database) === expected.database && lower(runtime.user) === expected.runtimeUser,
    'QA_DB_RUNTIME_IDENTITY_MISMATCH',
    'PostgreSQL no reporto la identidad QA esperada.'
  );
  return {
    verified: true,
    project_ref: expected.projectRef,
    connection_mode: expected.connectionMode,
    fingerprint: hash(`${expected.projectRef}|${expected.connectionMode}|${expected.configuredHost}|${runtime.database}|${runtime.user}`),
    server_address_present: Boolean(runtime.server_address),
    is_replica: Boolean(runtime.is_replica)
  };
};

const normalizeCode = (value) => lower(value)
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\w\s-]/g, '')
  .replace(/\s+/g, '_');

const getKitchenState = async (client) => {
  const { rows } = await client.query('SELECT id_estado_pedido, descripcion FROM estados_pedido');
  return number(rows.find((row) => normalizeCode(row.descripcion) === 'en_cocina')?.id_estado_pedido || 0);
};

const pickContext = async (client) => {
  const { rows } = await client.query(`
    WITH metodo_pago AS (
      SELECT id_metodo_pago
      FROM public.cat_metodos_pago
      WHERE COALESCE(estado,true)=true
      ORDER BY id_metodo_pago
      LIMIT 1
    )
    SELECT cs.id_sucursal,
           cs.id_usuario_responsable AS id_usuario,
           NULL::integer AS id_cliente,
           cs.id_caja,
           cs.id_sesion_caja,
           metodo_pago.id_metodo_pago
    FROM public.cajas_sesiones cs
    INNER JOIN public.cat_cajas_sesiones_estados estado
      ON estado.id_estado_sesion_caja=cs.id_estado_sesion_caja
     AND UPPER(TRIM(estado.codigo))='ABIERTA'
    INNER JOIN public.cajas caja
      ON caja.id_caja=cs.id_caja
     AND caja.id_sucursal=cs.id_sucursal
     AND COALESCE(caja.estado,true)=true
    CROSS JOIN metodo_pago
    WHERE cs.fecha_cierre IS NULL
      AND cs.id_usuario_responsable IS NOT NULL
    ORDER BY cs.fecha_apertura DESC, cs.id_sesion_caja DESC
    LIMIT 1
  `);
  ensure(rows.length === 1, 'QA_OPEN_CASH_SESSION_MISSING', 'No hay una sesion de caja QA abierta con responsable y metodo de pago activo.');
  return rows[0];
};

const pickTemplate = async (client, ctx) => {
  const warehouse = await client.query(
    'SELECT id_almacen FROM almacenes WHERE id_sucursal=$1 AND COALESCE(estado,true)=true ORDER BY id_almacen DESC LIMIT 1',
    [ctx.id_sucursal]
  );
  ensure(warehouse.rows.length === 1, 'QA_WAREHOUSE_MISSING', 'No hay almacen activo para la sucursal QA.');
  const idAlmacen = number(warehouse.rows[0].id_almacen);
  const supply = await client.query(
    `SELECT id_insumo, cantidad, id_unidad_medida, COALESCE(id_categoria_insumo,1) AS id_categoria_insumo
     FROM insumos WHERE id_almacen=$1 AND COALESCE(estado,true)=true AND id_unidad_medida IS NOT NULL
     ORDER BY id_insumo DESC LIMIT 1`,
    [idAlmacen]
  );
  const product = await client.query(
    `SELECT id_producto, cantidad FROM productos
     WHERE id_almacen=$1 AND COALESCE(estado,true)=true ORDER BY id_producto DESC LIMIT 1`,
    [idAlmacen]
  );
  const recipe = await client.query(
    `SELECT id_menu, id_nivel_picante, COALESCE(id_usuario,$1::int) AS id_usuario,
            COALESCE(id_tipo_departamento,1) AS id_tipo_departamento
     FROM recetas WHERE COALESCE(estado,true)=true ORDER BY id_receta DESC LIMIT 1`,
    [ctx.id_usuario]
  );
  ensure(supply.rows.length === 1 && product.rows.length === 1 && recipe.rows.length === 1, 'QA_FIXTURE_TEMPLATE_MISSING', 'Falta una plantilla QA de producto, insumo o receta.');
  return {
    idAlmacen,
    supply: supply.rows[0],
    product: product.rows[0],
    recipe: recipe.rows[0]
  };
};

const createFixtures = async (client, ctx, tag) => {
  const template = await pickTemplate(client, ctx);
  const insertProduct = async (suffix, stock) => {
    const { rows } = await client.query(
      `INSERT INTO productos (
         nombre_producto, precio, cantidad, descripcion_producto,
         fecha_ingreso_producto, id_almacen, stock_minimo, estado
       ) VALUES ($1,12.5,$2,'QA rollback-only fixture',CURRENT_DATE,$3,0,true)
       RETURNING id_producto`,
      [`${PREFIX}_${tag}_${suffix}`, stock, template.idAlmacen]
    );
    const idProducto = number(rows[0].id_producto);
    await client.query(
      `INSERT INTO public.productos_almacenes (
         id_producto,id_almacen,cantidad,stock_minimo,estado
       ) VALUES ($1,$2,$3,0,true)`,
      [idProducto, template.idAlmacen, stock]
    );
    await client.query(
      `INSERT INTO public.productos_mapeo_maestro (
         id_producto_legacy,id_producto_maestro,id_almacen_origen,estado_migracion,observacion
       ) VALUES ($1,$1,$2,'VALIDADO',$3)`,
      [idProducto, template.idAlmacen, `${PREFIX} rollback-only`]
    );
    return idProducto;
  };
  const products = {
    stock48: await insertProduct('PRODUCTO_48', 48),
    stock0: await insertProduct('PRODUCTO_0', 0),
    stockNegative: await insertProduct('PRODUCTO_NEG5', -5)
  };
  const supplyResult = await client.query(
    `INSERT INTO insumos (
       nombre_insumo, precio, cantidad, fecha_ingreso_insumo, id_almacen,
       descripcion, stock_minimo, estado, id_categoria_insumo, id_unidad_medida
     ) VALUES ($1,3.25,0,CURRENT_DATE,$2,'QA rollback-only fixture',0,true,$3,$4)
     RETURNING id_insumo`,
    [`${PREFIX}_${tag}_INSUMO_0`, template.idAlmacen, template.supply.id_categoria_insumo, template.supply.id_unidad_medida]
  );
  const idInsumo = number(supplyResult.rows[0].id_insumo);
  await client.query(
    `INSERT INTO public.insumos_almacenes (
       id_insumo,id_almacen,cantidad,stock_minimo,precio_compra,estado
     ) VALUES ($1,$2,0,0,3.25,true)`,
    [idInsumo, template.idAlmacen]
  );
  await client.query(
    `INSERT INTO public.insumos_mapeo_maestro (
       id_insumo_legacy,id_insumo_maestro,id_almacen_origen,estado_migracion,observacion
     ) VALUES ($1,$1,$2,'VALIDADO',$3)`,
    [idInsumo, template.idAlmacen, `${PREFIX} rollback-only`]
  );

  const insertRecipe = async (suffix, description) => {
    const { rows } = await client.query(
      `INSERT INTO recetas (
         nombre_receta, descripcion, fecha_modificacion, id_menu, id_nivel_picante,
         fecha_creacion, id_usuario, estado, id_tipo_departamento, precio
       ) VALUES ($1,$2,CURRENT_DATE,$3,$4,CURRENT_TIMESTAMP,$5,true,$6,25)
       RETURNING id_receta`,
      [
        `${PREFIX}_${tag}_${suffix}`,
        description,
        number(template.recipe.id_menu),
        number(template.recipe.id_nivel_picante),
        number(template.recipe.id_usuario || ctx.id_usuario),
        number(template.recipe.id_tipo_departamento || 1)
      ]
    );
    return number(rows[0].id_receta);
  };
  const idReceta = await insertRecipe('RECETA_VALIDA', 'QA receta con insumo en cero');
  await client.query(
    'INSERT INTO detalle_recetas (id_receta,id_insumo,cant,estado,id_unidad_medida) VALUES ($1,$2,2,true,$3)',
    [idReceta, idInsumo, template.supply.id_unidad_medida]
  );
  const idRecetaRota = await insertRecipe('RECETA_INVALIDA', 'QA receta sin componentes');
  return {
    tag,
    idAlmacen: template.idAlmacen,
    products,
    idInsumo,
    idReceta,
    idRecetaRota,
    originals: {
      product: { id: number(template.product.id_producto), stock: number(template.product.cantidad) },
      supply: { id: number(template.supply.id_insumo), stock: number(template.supply.cantidad) }
    }
  };
};

const createSaleArtifacts = async (client, ctx, kitchenState, tag, code, lines) => {
  const subtotal = money(lines.reduce((sum, line) => sum + number(line.precio) * number(line.cantidad), 0));
  const tax = money(subtotal * 0.15);
  const total = money(subtotal + tax);
  const description = `${PREFIX}_${tag}_${code}`;
  const order = await client.query(
    `INSERT INTO pedidos (
       descripcion_pedido,descripcion_envio,fecha_hora_pedido,sub_total,isv,total,
       id_estado_pedido,id_sucursal,id_cliente,id_usuario,origen_pedido
     ) VALUES ($1,NULL,CURRENT_TIMESTAMP,$2,$3,$4,$5,$6,$7,$8,'QA_E2E') RETURNING id_pedido`,
    [description, subtotal, tax, total, kitchenState, ctx.id_sucursal, ctx.id_cliente || null, ctx.id_usuario]
  );
  const idPedido = number(order.rows[0].id_pedido);
  const invoiceCode = `QAF4-${tag.slice(-8)}-${code[0]}-${idPedido}`;
  const detailIds = [];
  for (const line of lines) {
    const lineTotal = money(number(line.precio) * number(line.cantidad));
    const detail = await client.query(
      `INSERT INTO detalle_pedido (
         sub_total_pedido,total_pedido,id_producto,id_pedido,id_descuento,
         estado,id_receta,observacion
       ) VALUES ($1,$2,$3,$4,NULL,true,$5,$6) RETURNING id_detalle_pedido`,
      [lineTotal, lineTotal, line.id_producto || null, idPedido, line.id_receta || null, `${PREFIX}_${code}`]
    );
    detailIds.push(number(detail.rows[0].id_detalle_pedido));
  }
  const invoice = await client.query(
    `INSERT INTO facturas (
       id_caja,id_pedido,id_sucursal,id_usuario,id_cliente,codigo_venta,fecha_operacion,
       efectivo_entregado,cambio,fecha_hora_facturacion,isv_15,isv_18,id_sesion_caja
     ) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,0,CURRENT_TIMESTAMP,$8,0,$9) RETURNING id_factura`,
    [ctx.id_caja, idPedido, ctx.id_sucursal, ctx.id_usuario, ctx.id_cliente || null, invoiceCode, total, tax, ctx.id_sesion_caja]
  );
  const idFactura = number(invoice.rows[0].id_factura);
  await client.query(
    `INSERT INTO facturas_cobros (
       id_factura,id_sesion_caja,id_caja,id_sucursal,id_usuario_ejecutor,
       id_metodo_pago,monto,fecha_cobro,fecha_creacion
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [idFactura, ctx.id_sesion_caja, ctx.id_caja, ctx.id_sucursal, ctx.id_usuario, ctx.id_metodo_pago, total]
  );
  for (const line of lines) {
    const lineTotal = money(number(line.precio) * number(line.cantidad));
    await client.query(
      `INSERT INTO detalle_facturas (
         id_factura,id_producto,id_descuento,cantidad,precio_unitario,sub_total,total_detalle,id_pedido
       ) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)`,
      [idFactura, line.id_producto || null, line.cantidad, line.precio, lineTotal, lineTotal, idPedido]
    );
  }
  return { idPedido, idFactura, detailIds, invoiceCode };
};

const payloadFor = (ctx, created, lines) => ({
  id_pedido: created.idPedido,
  id_sucursal: number(ctx.id_sucursal),
  items: lines.map((line, index) => ({
    tipo_item: line.id_receta ? 'RECETA' : 'PRODUCTO',
    id_item: number(line.id_receta || line.id_producto),
    cantidad: number(line.cantidad),
    id_detalle_pedido: created.detailIds[index]
  }))
});

const movementRows = async (client, idPedido) => {
  const { rows } = await client.query(
    `SELECT mi.id_movimiento,mi.cantidad,mi.id_producto,mi.id_insumo,mi.ref_origen,
            mi.id_ref,mi.id_pedido_trazabilidad,mi.id_detalle_pedido,mi.origen_consumo,
            mi.saldo_antes,mi.saldo_despues,dp.id_pedido AS detalle_id_pedido
     FROM movimientos_inventario mi
     LEFT JOIN detalle_pedido dp ON dp.id_detalle_pedido=mi.id_detalle_pedido
     WHERE mi.id_ref=$1 AND mi.ref_origen=ANY($2::text[]) ORDER BY mi.id_movimiento`,
    [idPedido, ['PEDIDO', 'FALTANTE_COCINA']]
  );
  return rows;
};

const resourceStock = async (client, resource) => {
  const table = resource.type === 'producto' ? 'productos_almacenes' : 'insumos_almacenes';
  const column = resource.type === 'producto' ? 'id_producto' : 'id_insumo';
  const { rows } = await client.query(
    `SELECT cantidad FROM ${table} WHERE ${column}=$1 AND id_almacen=$2`,
    [resource.id, resource.idAlmacen]
  );
  ensure(rows.length === 1, 'QA_RESOURCE_MISSING', `No existe el recurso QA ${resource.type}.`);
  return number(rows[0].cantidad);
};

const validateMovement = ({ rows, created, resource, before, consumed, after }) => {
  ensure(rows.length === 1, 'QA_MOVEMENT_COUNT_INVALID', 'El caso debe generar exactamente un movimiento.', { count: rows.length });
  const row = rows[0];
  ensure(row.ref_origen === 'FALTANTE_COCINA', 'QA_MOVEMENT_REF_INVALID', 'El deficit debe usar FALTANTE_COCINA.');
  ensure(number(row.id_ref) === created.idPedido && number(row.id_pedido_trazabilidad) === created.idPedido, 'QA_MOVEMENT_ORDER_TRACE_INVALID', 'La referencia del movimiento no coincide con el pedido.');
  ensure(number(row.detalle_id_pedido) === created.idPedido && created.detailIds.includes(number(row.id_detalle_pedido)), 'QA_MOVEMENT_DETAIL_TRACE_INVALID', 'El detalle trazado no pertenece al pedido.');
  ensure(equalQty(row.cantidad, consumed) && equalQty(row.saldo_antes, before) && equalQty(row.saldo_despues, after), 'QA_MOVEMENT_QUANTITY_INVALID', 'Cantidad o saldos SQL no coinciden con el caso.');
  ensure(number(row.saldo_despues) < 0, 'QA_PROJECTED_STOCK_NOT_NEGATIVE', 'El saldo proyectado debe ser negativo.');
  if (resource.type === 'producto') {
    ensure(number(row.id_producto) === resource.id && row.id_insumo === null && row.origen_consumo === 'PRODUCTO', 'QA_PRODUCT_TRACE_INVALID', 'La traza no identifica el producto esperado.');
  } else {
    ensure(number(row.id_insumo) === resource.id && row.id_producto === null && row.origen_consumo === 'RECETA', 'QA_SUPPLY_TRACE_INVALID', 'La traza no identifica el insumo esperado.');
  }
};

const runDeficit = async ({ client, service, ctx, kitchenState, tag, code, lines, resource, before, consumed, after }) => {
  const created = await createSaleArtifacts(client, ctx, kitchenState, tag, code, lines);
  const result = await service(payloadFor(ctx, created, lines), {
    dbClient: client,
    id_usuario: number(ctx.id_usuario),
    allowNegativeStock: true,
    allowIncompleteConfiguration: false,
    shortageMode: 'FALTANTE_COCINA'
  });
  ensure(result.ok === true && result.code === 'DESCUENTO_OK', 'QA_DISCOUNT_FAILED', `Fallo el descuento ${code}.`, { result });
  ensure(result.warning?.code === 'STOCK_INSUFICIENTE_PERMITIDO', 'QA_WARNING_MISSING', `Falta la advertencia ${code}.`);
  const rows = await movementRows(client, created.idPedido);
  validateMovement({ rows, created, resource, before, consumed, after });
  const actualStock = await resourceStock(client, resource);
  ensure(equalQty(actualStock, after), 'QA_FINAL_STOCK_INVALID', `Stock final incorrecto en ${code}.`);
  return { ok: true, code: result.code, warning: result.warning.code, before, consumed, after: actualStock, movements: rows.length, created };
};

const runInvalidConfig = async ({ client, service, ctx, kitchenState, tag, fixture }) => {
  const lines = [{ id_receta: fixture.idRecetaRota, cantidad: 1, precio: 25 }];
  const created = await createSaleArtifacts(client, ctx, kitchenState, tag, 'E_CONFIG_INVALIDA', lines);
  const result = await service(payloadFor(ctx, created, lines), {
    dbClient: client,
    id_usuario: number(ctx.id_usuario),
    allowNegativeStock: true,
    allowIncompleteConfiguration: false,
    shortageMode: 'FALTANTE_COCINA'
  });
  ensure(result.ok === false && result.code === 'CONFIGURACION_INVENTARIO_INVALIDA', 'QA_INVALID_CONFIG_NOT_REJECTED', 'La configuracion invalida no fue rechazada.', { result });
  ensure((await movementRows(client, created.idPedido)).length === 0, 'QA_INVALID_CONFIG_MOVEMENT_FOUND', 'La configuracion invalida genero movimientos.');
  return { ok: true, code: result.code, movements: 0, created };
};

const runIdempotency = async ({ client, service, ctx, source, lines }) => {
  const before = await movementRows(client, source.created.idPedido);
  let rejection = null;
  try {
    await service(payloadFor(ctx, source.created, lines), {
      dbClient: client,
      id_usuario: number(ctx.id_usuario),
      allowNegativeStock: true,
      allowIncompleteConfiguration: false,
      shortageMode: 'FALTANTE_COCINA'
    });
  } catch (error) {
    rejection = error;
  }
  ensure(rejection?.code === 'PEDIDO_YA_DESCONTADO', 'QA_DUPLICATE_NOT_REJECTED', 'El segundo descuento no fue rechazado como PEDIDO_YA_DESCONTADO.');
  const after = await movementRows(client, source.created.idPedido);
  ensure(after.length === before.length && after.map((row) => row.id_movimiento).join() === before.map((row) => row.id_movimiento).join(), 'QA_DUPLICATE_MOVEMENT_FOUND', 'El segundo descuento altero movimientos.');
  return { ok: true, code: rejection.code, movementsBefore: before.length, movementsAfter: after.length };
};

const transactionChecks = async (client, cases) => {
  const orderIds = Object.values(cases).map((item) => item?.created?.idPedido).filter(Number.isInteger);
  const invoiceIds = Object.values(cases).map((item) => item?.created?.idFactura).filter(Number.isInteger);
  const { rows } = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM movimientos_inventario WHERE id_ref=ANY($1::int[]) AND ref_origen='VENTA') AS venta_movements,
       (SELECT COUNT(*) FROM movimientos_inventario WHERE id_ref=ANY($1::int[]) AND ref_origen=ANY($2::text[])) AS pedido_movements,
       (SELECT COUNT(*) FROM (
          SELECT id_ref,ref_origen,id_detalle_pedido,origen_consumo,COALESCE(id_producto,0),COALESCE(id_insumo,0)
          FROM movimientos_inventario WHERE id_ref=ANY($1::int[]) AND ref_origen=ANY($2::text[])
          GROUP BY id_ref,ref_origen,id_detalle_pedido,origen_consumo,COALESCE(id_producto,0),COALESCE(id_insumo,0)
          HAVING COUNT(*)>1
        ) duplicates) AS duplicate_groups,
       (SELECT COUNT(*) FROM pedidos WHERE id_pedido=ANY($1::int[])) AS orders,
       (SELECT COUNT(*) FROM facturas WHERE id_factura=ANY($3::int[])) AS invoices`,
    [orderIds, ['PEDIDO', 'FALTANTE_COCINA'], invoiceIds]
  );
  const checks = Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, number(value)]));
  ensure(checks.venta_movements === 0, 'QA_VENTA_MOVEMENT_FOUND', 'Se genero un movimiento VENTA.');
  ensure(checks.pedido_movements === 4 && checks.duplicate_groups === 0, 'QA_MOVEMENT_AGGREGATE_INVALID', 'El total SQL de movimientos o duplicados es incorrecto.', checks);
  ensure(checks.orders === orderIds.length && checks.invoices === invoiceIds.length, 'QA_ARTIFACT_RELATION_INVALID', 'Faltan pedidos o facturas dentro de la transaccion.', checks);
  return checks;
};

const verifyRollback = async (client, fixture, cases, tag) => {
  const orderIds = Object.values(cases).map((item) => item?.created?.idPedido).filter(Number.isInteger);
  const invoiceIds = Object.values(cases).map((item) => item?.created?.idFactura).filter(Number.isInteger);
  const invoiceCodes = Object.values(cases).map((item) => item?.created?.invoiceCode).filter(Boolean);
  const productIds = Object.values(fixture.products);
  const { rows } = await client.query(
    `SELECT
       ((SELECT COUNT(*) FROM productos WHERE id_producto=ANY($1::int[]) OR nombre_producto LIKE $5)
        + (SELECT COUNT(*) FROM productos_almacenes WHERE id_producto=ANY($1::int[]))
        + (SELECT COUNT(*) FROM productos_mapeo_maestro WHERE id_producto_maestro=ANY($1::int[]) OR id_producto_legacy=ANY($1::int[]))) AS products,
       ((SELECT COUNT(*) FROM insumos WHERE id_insumo=$2 OR nombre_insumo LIKE $5)
        + (SELECT COUNT(*) FROM insumos_almacenes WHERE id_insumo=$2)
        + (SELECT COUNT(*) FROM insumos_mapeo_maestro WHERE id_insumo_maestro=$2 OR id_insumo_legacy=$2)) AS supplies,
       (SELECT COUNT(*) FROM recetas WHERE id_receta=ANY($3::int[]) OR nombre_receta LIKE $5) AS recipes,
       (SELECT COUNT(*) FROM pedidos WHERE id_pedido=ANY($4::int[]) OR descripcion_pedido LIKE $5) AS orders,
       (SELECT COUNT(*) FROM facturas WHERE id_factura=ANY($6::int[]) OR codigo_venta=ANY($7::text[])) AS invoices,
       (SELECT COUNT(*) FROM facturas_cobros WHERE id_factura=ANY($6::int[])) AS payments,
       (SELECT COUNT(*) FROM movimientos_inventario WHERE id_ref=ANY($4::int[])) AS movements,
       (SELECT cantidad FROM productos WHERE id_producto=$8) AS original_product_stock,
       (SELECT cantidad FROM insumos WHERE id_insumo=$9) AS original_supply_stock`,
    [productIds, fixture.idInsumo, [fixture.idReceta, fixture.idRecetaRota], orderIds, `${PREFIX}_${tag}%`, invoiceIds, invoiceCodes, fixture.originals.product.id, fixture.originals.supply.id]
  );
  const row = rows[0];
  const persisted = Object.fromEntries(['products', 'supplies', 'recipes', 'orders', 'invoices', 'payments', 'movements'].map((key) => [key, number(row[key])]));
  ensure(Object.values(persisted).every((count) => count === 0), 'QA_ROLLBACK_PERSISTENCE_FOUND', 'El control independiente encontro artefactos persistidos.', persisted);
  ensure(equalQty(row.original_product_stock, fixture.originals.product.stock) && equalQty(row.original_supply_stock, fixture.originals.supply.stock), 'QA_ORIGINAL_STOCK_CHANGED', 'Cambio el stock de un recurso original de control.');
  return { ...persisted, original_stocks_unchanged: true };
};

const publicCases = (cases) => Object.fromEntries(Object.entries(cases).map(([key, value]) => [key, {
  ok: value.ok,
  code: value.code,
  warning: value.warning || null,
  stock_before: value.before,
  consumed: value.consumed,
  stock_after: value.after,
  movement_count: value.movements,
  movement_count_before: value.movementsBefore,
  movement_count_after: value.movementsAfter
}]));

const main = async () => {
  let pool;
  let client;
  let transactionStarted = false;
  try {
    const expected = preflight();
    if (process.argv.includes('--preflight-only')) {
      console.log(JSON.stringify({
        ok: true,
        mode: 'PREFLIGHT_ONLY',
        identity: {
          project_ref: expected.projectRef,
          connection_mode: expected.connectionMode,
          fingerprint: hash(`${expected.projectRef}|${expected.connectionMode}|${expected.configuredHost}`)
        }
      }, null, 2));
      return;
    }
    const [{ default: importedPool }, { validarYDescontarPedido }] = await Promise.all([
      import('../config/db-connection.js'),
      import('../services/inventarioPedidoService.js')
    ]);
    pool = importedPool;
    client = await pool.connect();
    const identity = await verifyRuntimeIdentity(client, expected);
    await client.query('BEGIN');
    transactionStarted = true;

    const tag = runTag();
    const ctx = await pickContext(client);
    const kitchenState = await getKitchenState(client);
    ensure(kitchenState > 0, 'QA_KITCHEN_STATE_MISSING', 'No se encontro EN_COCINA.');
    const fixture = await createFixtures(client, ctx, tag);
    const common = { client, service: validarYDescontarPedido, ctx, kitchenState, tag };
    const linesA = [{ id_producto: fixture.products.stock48, cantidad: 49, precio: 12.5 }];
    const cases = {};
    cases.A_producto_stock_48 = await runDeficit({ ...common, code: 'A_PRODUCTO_48_A_49', lines: linesA, resource: { type: 'producto', id: fixture.products.stock48, idAlmacen: fixture.idAlmacen }, before: 48, consumed: 49, after: -1 });
    cases.B_producto_stock_0 = await runDeficit({ ...common, code: 'B_PRODUCTO_0', lines: [{ id_producto: fixture.products.stock0, cantidad: 1, precio: 12.5 }], resource: { type: 'producto', id: fixture.products.stock0, idAlmacen: fixture.idAlmacen }, before: 0, consumed: 1, after: -1 });
    cases.C_producto_stock_negativo = await runDeficit({ ...common, code: 'C_PRODUCTO_NEG5', lines: [{ id_producto: fixture.products.stockNegative, cantidad: 2, precio: 12.5 }], resource: { type: 'producto', id: fixture.products.stockNegative, idAlmacen: fixture.idAlmacen }, before: -5, consumed: 2, after: -7 });
    cases.D_receta_insumo_stock_0 = await runDeficit({ ...common, code: 'D_RECETA_INSUMO_0', lines: [{ id_receta: fixture.idReceta, cantidad: 1, precio: 25 }], resource: { type: 'insumo', id: fixture.idInsumo, idAlmacen: fixture.idAlmacen }, before: 0, consumed: 2, after: -2 });
    cases.E_configuracion_invalida = await runInvalidConfig({ ...common, fixture });
    cases.F_idempotencia = await runIdempotency({ client, service: validarYDescontarPedido, ctx, source: cases.A_producto_stock_48, lines: linesA });
    const sqlChecks = await transactionChecks(client, cases);

    await client.query('ROLLBACK');
    transactionStarted = false;
    client.release();
    client = null;
    const independentClient = await pool.connect();
    let rollbackChecks;
    try {
      rollbackChecks = await verifyRollback(independentClient, fixture, cases, tag);
    } finally {
      independentClient.release();
    }
    console.log(JSON.stringify({ ok: true, mode: 'ROLLBACK_ONLY', database_identity: identity, cases: publicCases(cases), transaction_checks: sqlChecks, independent_post_rollback_checks: rollbackChecks }, null, 2));
  } catch (error) {
    let rollbackConfirmed = false;
    if (client && transactionStarted) {
      try {
        await client.query('ROLLBACK');
        rollbackConfirmed = true;
      } catch {
        rollbackConfirmed = false;
      }
    }
    console.error(JSON.stringify({ ok: false, mode: 'ROLLBACK_ONLY', code: error.code || 'QA_SCRIPT_ERROR', message: error.message, details: error.details || null, rollback_attempted: Boolean(transactionStarted), rollback_confirmed: rollbackConfirmed }, null, 2));
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
};

main();
