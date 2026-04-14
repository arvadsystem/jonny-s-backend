import pool from '../config/db-connection.js';
import { getClientIp } from '../utils/security/clientInfo.js';

const CLIENT_ROLE_NAME = 'CLIENTE';
const TEGUCIGALPA_TIMEZONE = 'America/Tegucigalpa';

const hasBitacorasCache = {
  loaded: false,
  value: false
};

const normalizeText = (value) => String(value ?? '').trim();

const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseNonNegativeInt = (value) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parsePositiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

export const createFidelizacionError = (status, code, publicMessage, internalMessage = null) => {
  const error = new Error(internalMessage || publicMessage || 'Fidelizacion error');
  error.httpStatus = status;
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
};

const loadHasBitacoras = async (queryRunner = pool) => {
  if (!hasBitacorasCache.loaded) {
    const result = await queryRunner.query(`SELECT to_regclass('public.bitacoras') AS reg`);
    hasBitacorasCache.loaded = true;
    hasBitacorasCache.value = Boolean(result.rows?.[0]?.reg);
  }

  return hasBitacorasCache.value;
};

export const insertFidelizacionAuditLog = async ({
  client,
  req,
  idUsuario,
  accion,
  descripcion,
  idRegistro = null,
  datosAntes = null,
  datosDespues = null
}) => {
  const actorId = parsePositiveInt(idUsuario);
  if (!actorId) return;

  const hasBitacoras = await loadHasBitacoras(client);
  if (!hasBitacoras) return;

  await client.query(
    `
      INSERT INTO public.bitacoras (
        accion,
        descripcion,
        fecha_hora,
        id_usuario,
        modulo,
        tabla_afectada,
        id_registro,
        ip_origen,
        datos_antes,
        datos_despues
      )
      VALUES (
        $1,
        $2,
        timezone('${TEGUCIGALPA_TIMEZONE}', now()),
        $3,
        'FIDELIZACION',
        'FIDELIZACION',
        $4,
        $5,
        $6::jsonb,
        $7::jsonb
      )
    `,
    [
      normalizeText(accion).slice(0, 50) || 'FIDELIZACION_ACCION',
      normalizeText(descripcion).slice(0, 100) || 'Accion de fidelizacion',
      actorId,
      parsePositiveInt(idRegistro) || 0,
      normalizeText(getClientIp(req) || '-').slice(0, 60) || '-',
      datosAntes ? JSON.stringify(datosAntes) : JSON.stringify({}),
      datosDespues ? JSON.stringify(datosDespues) : JSON.stringify({})
    ]
  );
};

const getCatalogRowByCode = async (client, tableName, idField, code) => {
  const result = await client.query(
    `
      SELECT ${idField} AS id_catalogo, codigo, nombre, estado
      FROM public.${tableName}
      WHERE UPPER(TRIM(codigo)) = UPPER(TRIM($1))
      LIMIT 1
    `,
    [code]
  );

  return result.rows[0] || null;
};

const resolveFidelizacionCatalogs = async (client) => {
  const [tipoAcumulacion, tipoCanje, origenFactura, origenCanje, estadoRegistrado] = await Promise.all([
    getCatalogRowByCode(client, 'cat_fidelizacion_tipos_movimiento', 'id_tipo_movimiento', 'ACUMULACION'),
    getCatalogRowByCode(client, 'cat_fidelizacion_tipos_movimiento', 'id_tipo_movimiento', 'CANJE'),
    getCatalogRowByCode(client, 'cat_fidelizacion_origenes_movimiento', 'id_origen_movimiento', 'FACTURA'),
    getCatalogRowByCode(client, 'cat_fidelizacion_origenes_movimiento', 'id_origen_movimiento', 'CANJE'),
    getCatalogRowByCode(client, 'cat_fidelizacion_estados_canje', 'id_estado_canje', 'REGISTRADO')
  ]);

  const requiredRows = [
    ['tipo acumulacion', tipoAcumulacion],
    ['tipo canje', tipoCanje],
    ['origen factura', origenFactura],
    ['origen canje', origenCanje],
    ['estado registrado', estadoRegistrado]
  ];

  const missing = requiredRows.find(([, row]) => !row || row.estado === false);
  if (missing) {
    throw createFidelizacionError(
      500,
      'FIDELIZACION_CATALOGS_ERROR',
      'No se pudo procesar la solicitud de fidelizacion.'
    );
  }

  return {
    tipoAcumulacionId: Number(tipoAcumulacion.id_catalogo),
    tipoCanjeId: Number(tipoCanje.id_catalogo),
    origenFacturaId: Number(origenFactura.id_catalogo),
    origenCanjeId: Number(origenCanje.id_catalogo),
    estadoRegistradoId: Number(estadoRegistrado.id_catalogo)
  };
};

export const getActiveFidelizacionConfig = async (client, idSucursal) => {
  const sucursalId = parsePositiveInt(idSucursal);
  if (!sucursalId) return null;

  const result = await client.query(
    `
      SELECT
        fcs.id_configuracion,
        fcs.id_sucursal,
        fcs.lempiras_por_punto,
        fcs.vigente_desde,
        fcs.vigente_hasta,
        fcs.estado,
        fcs.id_usuario_creador,
        fcs.fecha_creacion,
        fcs.fecha_actualizacion
      FROM public.fidelizacion_configuracion_sucursal fcs
      WHERE fcs.id_sucursal = $1
        AND COALESCE(fcs.estado, true) = true
        AND fcs.vigente_desde <= NOW()
        AND (fcs.vigente_hasta IS NULL OR fcs.vigente_hasta > NOW())
      ORDER BY fcs.vigente_desde DESC, fcs.id_configuracion DESC
      LIMIT 1
    `,
    [sucursalId]
  );

  return result.rows[0] || null;
};

const ensureSaldoRow = async (client, idCliente) => {
  const clienteId = parsePositiveInt(idCliente);
  if (!clienteId) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CLIENTE_INVALIDO',
      'El cliente seleccionado no es valido.'
    );
  }

  await client.query(
    `
      INSERT INTO public.fidelizacion_saldos_cliente (
        id_cliente,
        puntos_disponibles,
        puntos_acumulados_total,
        puntos_canjeados_total,
        fecha_creacion,
        fecha_actualizacion
      )
      VALUES ($1, 0, 0, 0, NOW(), NOW())
      ON CONFLICT (id_cliente) DO NOTHING
    `,
    [clienteId]
  );
};

export const getClienteSaldoForUpdate = async (client, idCliente) => {
  await ensureSaldoRow(client, idCliente);

  const result = await client.query(
    `
      SELECT
        id_cliente,
        puntos_disponibles,
        puntos_acumulados_total,
        puntos_canjeados_total,
        fecha_creacion,
        fecha_actualizacion
      FROM public.fidelizacion_saldos_cliente
      WHERE id_cliente = $1
      FOR UPDATE
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};

const syncLegacyClientePoints = async (client, idCliente, puntosDisponibles) => {
  await client.query(
    `
      UPDATE public.clientes
      SET puntos = $1
      WHERE id_cliente = $2
    `,
    [parseNonNegativeInt(puntosDisponibles) || 0, idCliente]
  );
};

const isClienteUsuarioElegible = async (client, idCliente) => {
  const result = await client.query(
    `
      SELECT 1
      FROM public.usuarios_clientes uc
      INNER JOIN public.usuarios u
        ON u.id_usuario = uc.id_usuario
       AND u.id_cliente = uc.id_cliente
      INNER JOIN public.roles_usuarios ru
        ON ru.id_usuario = u.id_usuario
      INNER JOIN public.roles r
        ON r.id_rol = ru.id_rol
      WHERE uc.id_cliente = $1
        AND COALESCE(uc.estado, true) = true
        AND COALESCE(u.estado, false) = true
        AND UPPER(TRIM(r.nombre)) = $2
      LIMIT 1
    `,
    [idCliente, CLIENT_ROLE_NAME]
  );

  return result.rowCount > 0;
};

const registerFidelizacionMovement = async (client, payload) => {
  const result = await client.query(
    `
      INSERT INTO public.fidelizacion_movimientos (
        id_cliente,
        id_sucursal,
        id_tipo_movimiento,
        puntos_delta,
        saldo_anterior,
        saldo_nuevo,
        id_origen_movimiento,
        id_factura,
        id_pedido,
        id_canje,
        observacion,
        id_usuario_ejecutor,
        fecha_creacion
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        NOW()
      )
      RETURNING id_movimiento
    `,
    [
      payload.id_cliente,
      payload.id_sucursal,
      payload.id_tipo_movimiento,
      payload.puntos_delta,
      payload.saldo_anterior,
      payload.saldo_nuevo,
      payload.id_origen_movimiento,
      payload.id_factura || null,
      payload.id_pedido || null,
      payload.id_canje || null,
      payload.observacion || null,
      payload.id_usuario_ejecutor || null
    ]
  );

  return Number(result.rows?.[0]?.id_movimiento || 0);
};

const addSaldoPoints = async ({
  client,
  idCliente,
  puntosDelta,
  movementIds,
  idSucursal,
  idFactura = null,
  idPedido = null,
  idCanje = null,
  observacion = null,
  idUsuarioEjecutor = null
}) => {
  const saldo = await getClienteSaldoForUpdate(client, idCliente);
  if (!saldo) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_SALDO_NOT_FOUND',
      'No se encontro el saldo del cliente.'
    );
  }

  const saldoAnterior = Number(saldo.puntos_disponibles || 0);
  const acumuladosActuales = Number(saldo.puntos_acumulados_total || 0);
  const canjeadosActuales = Number(saldo.puntos_canjeados_total || 0);
  const nextSaldo = saldoAnterior + Number(puntosDelta || 0);

  if (nextSaldo < 0) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SALDO_INSUFICIENTE',
      'El cliente no tiene puntos suficientes para completar el canje.'
    );
  }

  const accumulatedDelta = puntosDelta > 0 ? Number(puntosDelta) : 0;
  const redeemedDelta = puntosDelta < 0 ? Math.abs(Number(puntosDelta)) : 0;

  await client.query(
    `
      UPDATE public.fidelizacion_saldos_cliente
      SET
        puntos_disponibles = $1,
        puntos_acumulados_total = $2,
        puntos_canjeados_total = $3,
        fecha_actualizacion = NOW()
      WHERE id_cliente = $4
    `,
    [
      nextSaldo,
      acumuladosActuales + accumulatedDelta,
      canjeadosActuales + redeemedDelta,
      idCliente
    ]
  );

  await syncLegacyClientePoints(client, idCliente, nextSaldo);

  const movementId = await registerFidelizacionMovement(client, {
    id_cliente: idCliente,
    id_sucursal: idSucursal,
    id_tipo_movimiento: movementIds.idTipoMovimiento,
    puntos_delta: Number(puntosDelta),
    saldo_anterior: saldoAnterior,
    saldo_nuevo: nextSaldo,
    id_origen_movimiento: movementIds.idOrigenMovimiento,
    id_factura: idFactura,
    id_pedido: idPedido,
    id_canje: idCanje,
    observacion,
    id_usuario_ejecutor: idUsuarioEjecutor
  });

  return {
    idMovimiento: movementId,
    saldoAnterior,
    saldoNuevo: nextSaldo
  };
};

const buildVentaNumero = (idFactura) => `VTA-${String(idFactura).padStart(5, '0')}`;
const buildCanjeNumero = (idCanje) => `CAN-${String(idCanje).padStart(5, '0')}`;

const computeAccumulationPoints = (montoFactura, lempirasPorPunto) => {
  const total = Number(montoFactura || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(total) || !Number.isFinite(ratio) || total <= 0 || ratio <= 0) return 0;
  return Math.floor(total / ratio);
};

const computeRedemptionPoints = (precioProducto, lempirasPorPunto) => {
  const price = Number(precioProducto || 0);
  const ratio = Number(lempirasPorPunto || 0);
  if (!Number.isFinite(price) || !Number.isFinite(ratio) || price <= 0 || ratio <= 0) return null;
  return Math.ceil(price / ratio);
};

export const registerFacturaLoyaltyAccumulation = async ({
  client,
  idFactura,
  idPedido = null,
  idCliente = null,
  idSucursal = null,
  idUsuarioEjecutor = null,
  montoFactura = 0
}) => {
  const facturaId = parsePositiveInt(idFactura);
  const clienteId = parsePositiveInt(idCliente);
  const sucursalId = parsePositiveInt(idSucursal);

  if (!facturaId || !clienteId || !sucursalId) {
    return { created: false, reason: 'MISSING_REQUIRED_DATA' };
  }

  const existingResult = await client.query(
    `
      SELECT fm.id_movimiento
      FROM public.fidelizacion_movimientos fm
      INNER JOIN public.cat_fidelizacion_tipos_movimiento tm
        ON tm.id_tipo_movimiento = fm.id_tipo_movimiento
      INNER JOIN public.cat_fidelizacion_origenes_movimiento om
        ON om.id_origen_movimiento = fm.id_origen_movimiento
      WHERE fm.id_factura = $1
        AND UPPER(TRIM(tm.codigo)) = 'ACUMULACION'
        AND UPPER(TRIM(om.codigo)) = 'FACTURA'
      LIMIT 1
    `,
    [facturaId]
  );

  if (existingResult.rowCount > 0) {
    return {
      created: false,
      reason: 'ALREADY_REGISTERED',
      idMovimiento: Number(existingResult.rows[0].id_movimiento)
    };
  }

  const clienteElegible = await isClienteUsuarioElegible(client, clienteId);
  if (!clienteElegible) {
    return { created: false, reason: 'CLIENT_NOT_ELIGIBLE' };
  }

  const activeConfig = await getActiveFidelizacionConfig(client, sucursalId);
  if (!activeConfig) {
    return { created: false, reason: 'CONFIG_NOT_FOUND' };
  }

  const points = computeAccumulationPoints(montoFactura, activeConfig.lempiras_por_punto);
  if (points <= 0) {
    return { created: false, reason: 'POINTS_ROUND_DOWN_TO_ZERO' };
  }

  const catalogs = await resolveFidelizacionCatalogs(client);
  const movement = await addSaldoPoints({
    client,
    idCliente: clienteId,
    puntosDelta: points,
    movementIds: {
      idTipoMovimiento: catalogs.tipoAcumulacionId,
      idOrigenMovimiento: catalogs.origenFacturaId
    },
    idSucursal: sucursalId,
    idFactura: facturaId,
    idPedido,
    observacion: `Acumulacion automatica por factura ${buildVentaNumero(facturaId)}.`,
    idUsuarioEjecutor: parsePositiveInt(idUsuarioEjecutor)
  });

  return {
    created: true,
    points,
    idMovimiento: movement.idMovimiento,
    saldoAnterior: movement.saldoAnterior,
    saldoNuevo: movement.saldoNuevo
  };
};

const fetchClienteEstado = async (client, idCliente) => {
  const result = await client.query(
    `
      SELECT id_cliente, COALESCE(estado, true) AS estado
      FROM public.clientes
      WHERE id_cliente = $1
      LIMIT 1
    `,
    [idCliente]
  );

  return result.rows[0] || null;
};

const fetchCanjeProductRowsForUpdate = async (client, idSucursal, productIds) => {
  if (!Array.isArray(productIds) || productIds.length === 0) return [];

  const result = await client.query(
    `
      SELECT
        fps.id_registro,
        fps.id_producto,
        fps.puntos_requeridos_override,
        COALESCE(fps.estado, true) AS canjeable_estado,
        p.nombre_producto,
        p.precio,
        COALESCE(p.cantidad, 0)::int AS cantidad,
        COALESCE(p.stock_minimo, 0)::int AS stock_minimo,
        COALESCE(p.estado, true) AS producto_estado,
        p.id_almacen,
        a.id_sucursal AS almacen_id_sucursal,
        COALESCE(a.estado, true) AS almacen_estado
      FROM public.fidelizacion_productos_canjeables_sucursal fps
      INNER JOIN public.productos p
        ON p.id_producto = fps.id_producto
      INNER JOIN public.almacenes a
        ON a.id_almacen = p.id_almacen
      WHERE fps.id_sucursal = $1
        AND fps.id_producto = ANY($2::int[])
      FOR UPDATE OF p
    `,
    [idSucursal, productIds]
  );

  return result.rows;
};

const insertInventoryMovement = async ({
  client,
  idAlmacen,
  idProducto,
  cantidad,
  idCanje
}) => {
  await client.query(
    `
      INSERT INTO public.movimientos_inventario (
        tipo,
        cantidad,
        id_almacen,
        id_producto,
        id_insumo,
        ref_origen,
        id_ref,
        descripcion
      )
      VALUES ('SALIDA', $1, $2, $3, NULL, 'CANJE', $4, $5)
    `,
    [
      cantidad,
      idAlmacen,
      idProducto,
      idCanje,
      `Salida por canje fidelizacion ${buildCanjeNumero(idCanje)}`
    ]
  );
};

const aggregateCanjeItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CANJE_ITEMS_REQUIRED',
      'Debe enviar al menos un producto para canjear.'
    );
  }

  const byProduct = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw createFidelizacionError(
        400,
        'FIDELIZACION_CANJE_ITEM_INVALID',
        'Cada item del canje debe ser un objeto valido.'
      );
    }

    const idProducto = parsePositiveInt(item.id_producto);
    const cantidad = parsePositiveInt(item.cantidad);

    if (!idProducto || !cantidad) {
      throw createFidelizacionError(
        400,
        'FIDELIZACION_CANJE_ITEM_INVALID',
        'Cada item debe incluir id_producto y cantidad enteros mayores a 0.'
      );
    }

    const current = byProduct.get(idProducto) || { id_producto: idProducto, cantidad: 0 };
    current.cantidad += cantidad;
    byProduct.set(idProducto, current);
  }

  return [...byProduct.values()];
};

export const createPresentialFidelizacionCanje = async ({
  client,
  req,
  idCliente,
  idSucursal,
  idUsuarioEjecutor,
  items,
  observacion = null
}) => {
  const clienteId = parsePositiveInt(idCliente);
  const sucursalId = parsePositiveInt(idSucursal);
  const actorId = parsePositiveInt(idUsuarioEjecutor);
  const safeObservation = normalizeText(observacion).slice(0, 200) || null;

  if (!clienteId) {
    throw createFidelizacionError(
      400,
      'FIDELIZACION_CLIENTE_INVALIDO',
      'El cliente seleccionado no es valido.'
    );
  }

  if (!sucursalId || !actorId) {
    throw createFidelizacionError(
      403,
      'FIDELIZACION_CANJE_SCOPE_ERROR',
      'No se pudo resolver la sucursal operativa del usuario.'
    );
  }

  const aggregatedItems = aggregateCanjeItems(items);
  const cliente = await fetchClienteEstado(client, clienteId);
  if (!cliente || !Boolean(cliente.estado)) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_CLIENTE_NOT_FOUND',
      'El cliente seleccionado no esta disponible.'
    );
  }

  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [clienteId]);

  const saldo = await getClienteSaldoForUpdate(client, clienteId);
  if (!saldo) {
    throw createFidelizacionError(
      404,
      'FIDELIZACION_SALDO_NOT_FOUND',
      'No se encontro el saldo del cliente.'
    );
  }

  const activeConfig = await getActiveFidelizacionConfig(client, sucursalId);
  if (!activeConfig) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_CONFIG_NOT_FOUND',
      'La sucursal no tiene una configuracion de fidelizacion vigente.'
    );
  }

  const productRows = await fetchCanjeProductRowsForUpdate(
    client,
    sucursalId,
    aggregatedItems.map((item) => item.id_producto)
  );
  const productMap = new Map(productRows.map((row) => [Number(row.id_producto), row]));

  const detailRows = [];
  let totalPuntos = 0;

  for (const item of aggregatedItems) {
    const row = productMap.get(item.id_producto);
    if (!row || !Boolean(row.canjeable_estado)) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_NOT_CANGEABLE',
        'Uno o mas productos no estan habilitados para canje en esta sucursal.'
      );
    }

    if (!Boolean(row.producto_estado)) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_INACTIVE',
        'Uno o mas productos seleccionados estan inactivos.'
      );
    }

    if (!Boolean(row.almacen_estado) || Number(row.almacen_id_sucursal || 0) !== sucursalId) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_SCOPE_ERROR',
        'Uno o mas productos no pertenecen al inventario operativo de la sucursal.'
      );
    }

    const stockDisponible = Math.max(
      Number(row.cantidad || 0) - Number(row.stock_minimo || 0),
      0
    );

    if (stockDisponible < item.cantidad) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_STOCK_INSUFFICIENT',
        `Stock insuficiente para ${row.nombre_producto || 'el producto solicitado'}.`
      );
    }

    const puntosUnitarios =
      parseNonNegativeInt(row.puntos_requeridos_override) ??
      computeRedemptionPoints(row.precio, activeConfig.lempiras_por_punto);

    if (!parsePositiveInt(puntosUnitarios)) {
      throw createFidelizacionError(
        409,
        'FIDELIZACION_PRODUCTO_POINTS_INVALID',
        'Uno o mas productos no tienen una equivalencia de puntos valida.'
      );
    }

    const subtotalPuntos = puntosUnitarios * Number(item.cantidad);
    totalPuntos += subtotalPuntos;

    detailRows.push({
      id_producto: Number(item.id_producto),
      cantidad: Number(item.cantidad),
      puntos_unitarios: Number(puntosUnitarios),
      subtotal_puntos: Number(subtotalPuntos),
      precio_referencia: roundMoney(row.precio),
      nombre_producto: row.nombre_producto,
      id_almacen: Number(row.id_almacen)
    });
  }

  if (Number(saldo.puntos_disponibles || 0) < totalPuntos) {
    throw createFidelizacionError(
      409,
      'FIDELIZACION_SALDO_INSUFICIENTE',
      'El cliente no tiene puntos suficientes para completar el canje.'
    );
  }

  const catalogs = await resolveFidelizacionCatalogs(client);
  const canjeResult = await client.query(
    `
      INSERT INTO public.fidelizacion_canjes (
        id_cliente,
        id_sucursal,
        id_estado_canje,
        total_puntos,
        observacion,
        id_usuario_ejecutor,
        fecha_creacion,
        fecha_entrega,
        fecha_anulacion
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL, NULL)
      RETURNING id_canje
    `,
    [
      clienteId,
      sucursalId,
      catalogs.estadoRegistradoId,
      totalPuntos,
      safeObservation,
      actorId
    ]
  );
  const idCanje = Number(canjeResult.rows?.[0]?.id_canje || 0);

  for (const row of detailRows) {
    await client.query(
      `
        INSERT INTO public.fidelizacion_canjes_detalle (
          id_canje,
          id_producto,
          cantidad,
          puntos_unitarios,
          subtotal_puntos,
          precio_referencia,
          fecha_creacion
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
      [
        idCanje,
        row.id_producto,
        row.cantidad,
        row.puntos_unitarios,
        row.subtotal_puntos,
        row.precio_referencia
      ]
    );
  }

  const movement = await addSaldoPoints({
    client,
    idCliente: clienteId,
    puntosDelta: totalPuntos * -1,
    movementIds: {
      idTipoMovimiento: catalogs.tipoCanjeId,
      idOrigenMovimiento: catalogs.origenCanjeId
    },
    idSucursal: sucursalId,
    idCanje,
    observacion: safeObservation || `Canje presencial ${buildCanjeNumero(idCanje)}.`,
    idUsuarioEjecutor: actorId
  });

  for (const row of detailRows) {
    await insertInventoryMovement({
      client,
      idAlmacen: row.id_almacen,
      idProducto: row.id_producto,
      cantidad: row.cantidad,
      idCanje
    });
  }

  await insertFidelizacionAuditLog({
    client,
    req,
    idUsuario: actorId,
    accion: 'FIDELIZACION_CANJE_CREAR',
    descripcion: `Canje presencial ${buildCanjeNumero(idCanje)} registrado`,
    idRegistro: idCanje,
    datosDespues: {
      id_canje: idCanje,
      id_cliente: clienteId,
      id_sucursal: sucursalId,
      total_puntos: totalPuntos,
      saldo_anterior: movement.saldoAnterior,
      saldo_nuevo: movement.saldoNuevo,
      items: detailRows.map((row) => ({
        id_producto: row.id_producto,
        cantidad: row.cantidad,
        puntos_unitarios: row.puntos_unitarios,
        subtotal_puntos: row.subtotal_puntos
      }))
    }
  });

  return {
    idCanje,
    totalPuntos,
    saldoAnterior: movement.saldoAnterior,
    saldoNuevo: movement.saldoNuevo,
    idMovimiento: movement.idMovimiento,
    estadoCanjeId: catalogs.estadoRegistradoId,
    items: detailRows
  };
};

export {
  normalizeText,
  parsePositiveInt,
  parseNonNegativeInt,
  parsePositiveNumber,
  computeAccumulationPoints,
  computeRedemptionPoints
};
