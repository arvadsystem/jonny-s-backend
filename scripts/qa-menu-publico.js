import pool from '../config/db-connection.js';

const BASE_URL = String(process.env.MENU_QA_BASE_URL || 'http://localhost:3001').trim();
const LOGIN_IDENTIFIER = String(process.env.MENU_QA_IDENTIFIER || '').trim();
const LOGIN_PASSWORD = String(process.env.MENU_QA_PASSWORD || '').trim();
const FORCED_BRANCH_ID = Number.parseInt(String(process.env.MENU_QA_BRANCH_ID || '').trim(), 10);
const RATE_LIMIT_STRESS_ENABLED = String(process.env.MENU_QA_RATE_LIMIT_STRESS || '').trim() === '1';

const RUN_KEY = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const AUTH_FLOW_ENABLED = LOGIN_IDENTIFIER.length > 0 && LOGIN_PASSWORD.length > 0;

const ORDER_DELIVERY_TYPE_MAP = Object.freeze({
  'dine-in': 'LOCAL',
  pickup: 'RECOGER',
  delivery: 'DELIVERY'
});

const toPositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseJsonSafe = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(response) {
    const setCookieValues =
      typeof response?.headers?.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];

    if (!Array.isArray(setCookieValues) || setCookieValues.length === 0) return;

    for (const cookieLine of setCookieValues) {
      const firstToken = String(cookieLine || '').split(';')[0] || '';
      const separatorIndex = firstToken.indexOf('=');
      if (separatorIndex <= 0) continue;

      const name = firstToken.slice(0, separatorIndex).trim();
      const value = firstToken.slice(separatorIndex + 1).trim();
      if (!name) continue;
      this.cookies.set(name, value);
    }
  }

  toHeader() {
    if (this.cookies.size === 0) return '';
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

const cookieJar = new CookieJar();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = async ({ method = 'GET', path, body, headers = {}, retryOnNetworkError = null }) => {
  const url = `${BASE_URL}${path}`;
  const methodUpper = String(method || 'GET').trim().toUpperCase();
  const shouldRetry = retryOnNetworkError === null
    ? methodUpper === 'GET'
    : retryOnNetworkError === true;
  const maxAttempts = shouldRetry ? 3 : 1;

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const finalHeaders = {
        Accept: 'application/json',
        ...headers
      };

      const cookieHeader = cookieJar.toHeader();
      if (cookieHeader) {
        finalHeaders.Cookie = cookieHeader;
      }

      let requestBody;
      if (body !== undefined) {
        finalHeaders['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(body);
      }

      const response = await fetch(url, {
        method: methodUpper,
        headers: finalHeaders,
        body: requestBody
      });

      cookieJar.capture(response);

      const text = await response.text();
      const json = parseJsonSafe(text);

      return {
        status: Number(response.status || 0),
        headers: response.headers,
        text,
        json
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await wait(250);
    }
  }

  throw lastError || new Error('Network request failed');
};

const getHeader = (headers, name) => {
  if (!headers) return '';
  return String(headers.get(name) || '').trim();
};

const hasRequestIdInError = (responseBody) =>
  Boolean(responseBody && typeof responseBody === 'object' && String(responseBody.request_id || '').trim());

const runCase = async (name, executor, results) => {
  process.stdout.write(`\n[CASE] ${name} ... `);

  try {
    const outcome = await executor();
    if (outcome && outcome.skip === true) {
      results.push({
        name,
        status: 'SKIP',
        reason: String(outcome.reason || 'sin razon')
      });
      console.log('SKIP');
      console.log(`  -> ${outcome.reason}`);
      return;
    }

    results.push({
      name,
      status: 'PASS',
      meta: outcome?.meta || null
    });
    console.log('PASS');
  } catch (error) {
    results.push({
      name,
      status: 'FAIL',
      error: String(error?.message || error)
    });
    console.log('FAIL');
    console.log(`  -> ${error?.message || error}`);
  }
};

const findOrderCandidateItem = (catalogData) => {
  const items = Array.isArray(catalogData?.items) ? catalogData.items : [];
  const available = items.filter((item) => item?.disponibilidad?.available === true);
  if (available.length === 0) return null;

  // Preferimos item simple para minimizar dependencias de configuracion extra/salsas.
  const simple = available.find(
    (item) =>
      Number(item?.salsas_requeridas_base || 0) === 0 &&
      (!Array.isArray(item?.extras_opciones) || item.extras_opciones.length === 0)
  );
  return simple || available[0];
};

const buildOrderLineFromCatalogItem = (item) => {
  const idDetalleMenu = toPositiveInt(item?.id_detalle_menu);
  ensure(idDetalleMenu, 'No se pudo resolver id_detalle_menu para la prueba.');

  const line = {
    id_detalle_menu: idDetalleMenu,
    cantidad: 1
  };

  const requiredSauces = Number(item?.salsas_requeridas_base || 0);
  const allowedSauces = Array.isArray(item?.salsas_permitidas) ? item.salsas_permitidas : [];

  if (requiredSauces > 0) {
    ensure(allowedSauces.length > 0, `El item ${idDetalleMenu} requiere salsas pero no tiene salsas permitidas.`);
    const firstSauceId = toPositiveInt(allowedSauces[0]?.id_salsa);
    ensure(firstSauceId, `No se pudo resolver una salsa valida para el item ${idDetalleMenu}.`);

    line.salsas_por_unidad = [
      {
        id_salsa: firstSauceId,
        cantidad: requiredSauces
      }
    ];
  }

  return line;
};

const buildOrderPayload = ({ branchId, orderType, itemLine, validBusiness = true }) => {
  const payload = {
    id_sucursal: Number(branchId),
    tipo_pedido: orderType,
    origen: `qa-menu-${RUN_KEY}`,
    items: [itemLine]
  };

  // Reglas de negocio del menu publico por tipo de pedido.
  if (orderType === 'pickup') {
    payload.contacto = { telefono: '9999-0001' };
    payload.pago = validBusiness
      ? { metodo: 'transferencia', comprobante_transferencia: `QA-PICKUP-${RUN_KEY}` }
      : { metodo: 'transferencia' };
  }

  if (orderType === 'delivery') {
    payload.contacto = { telefono: '9999-0002' };
    payload.pago = { metodo: 'transferencia', comprobante_transferencia: `QA-DELIVERY-${RUN_KEY}` };
    payload.entrega = validBusiness
      ? { direccion: 'Colonia Centro, Casa #12', referencia: 'Porton negro' }
      : { referencia: 'Sin direccion para validar rechazo' };
  }

  return payload;
};

const fetchDbCapabilities = async () => {
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'detalle_pedido'
        AND column_name = 'configuracion_menu';
    `
  );

  return {
    hasConfiguracionMenu: result.rowCount > 0
  };
};

const verifyOrderInDb = async ({ idPedido, orderType, dbCapabilities }) => {
  const pedidoRs = await pool.query(
    `
      SELECT
        id_pedido,
        id_cliente,
        id_estado_pedido,
        COALESCE(estado_pago::text, '') AS estado_pago,
        COALESCE(tipo_entrega::text, '') AS tipo_entrega,
        COALESCE(origen_pedido::text, '') AS origen_pedido
      FROM pedidos
      WHERE id_pedido = $1
      LIMIT 1;
    `,
    [idPedido]
  );

  ensure(pedidoRs.rowCount > 0, `No existe pedido ${idPedido} en BD.`);

  const pedido = pedidoRs.rows[0];
  ensure(toPositiveInt(pedido.id_cliente), `Pedido ${idPedido} sin id_cliente valido.`);
  ensure(toPositiveInt(pedido.id_estado_pedido), `Pedido ${idPedido} sin id_estado_pedido valido.`);
  ensure(String(pedido.estado_pago || '').trim().toUpperCase() === 'PENDIENTE', `Pedido ${idPedido} con estado_pago inesperado.`);

  const expectedDeliveryType = ORDER_DELIVERY_TYPE_MAP[orderType];
  ensure(
    String(pedido.tipo_entrega || '').trim().toUpperCase() === String(expectedDeliveryType).toUpperCase(),
    `Pedido ${idPedido} con tipo_entrega inesperado: recibido=${pedido.tipo_entrega} esperado=${expectedDeliveryType}.`
  );

  const detailSql = dbCapabilities.hasConfiguracionMenu
    ? `
      SELECT
        id_pedido,
        observacion,
        configuracion_menu
      FROM detalle_pedido
      WHERE id_pedido = $1
      ORDER BY id_detalle_pedido ASC
      LIMIT 1;
    `
    : `
      SELECT
        id_pedido,
        observacion
      FROM detalle_pedido
      WHERE id_pedido = $1
      ORDER BY id_detalle_pedido ASC
      LIMIT 1;
    `;

  const detailRs = await pool.query(detailSql, [idPedido]);
  ensure(detailRs.rowCount > 0, `Pedido ${idPedido} sin lineas en detalle_pedido.`);

  if (dbCapabilities.hasConfiguracionMenu) {
    const cfg = detailRs.rows[0].configuracion_menu;
    ensure(cfg && typeof cfg === 'object', `Pedido ${idPedido} sin configuracion_menu estructurada.`);
    ensure(
      String(cfg.schema_version || '').trim() === 'menu_publico_linea_v1',
      `Pedido ${idPedido} con schema_version inesperado en configuracion_menu.`
    );
    ensure(
      Number.isInteger(Number(cfg.cantidad || 0)) && Number(cfg.cantidad || 0) > 0,
      `Pedido ${idPedido} con cantidad invalida en configuracion_menu.`
    );
  }
};

const main = async () => {
  const results = [];
  const context = {
    branchId: null,
    csrfToken: '',
    dbCapabilities: null,
    createdOrders: []
  };

  try {
    console.log('==============================================');
    console.log('QA Menu Publico - Pre Go-Live');
    console.log('==============================================');
    console.log(`BASE_URL: ${BASE_URL}`);
    console.log(`AUTH_FLOW: ${AUTH_FLOW_ENABLED ? 'ENABLED' : 'DISABLED (faltan MENU_QA_IDENTIFIER/MENU_QA_PASSWORD)'}`);

    context.dbCapabilities = await fetchDbCapabilities();

    await runCase('GET /api/public-menu/sucursales (lectura publica)', async () => {
      const response = await requestJson({
        method: 'GET',
        path: '/api/public-menu/sucursales'
      });

      ensure(response.status === 200, `HTTP inesperado: ${response.status}`);
      ensure(response.json?.ok === true, 'Respuesta sin ok=true.');
      ensure(Array.isArray(response.json?.data), 'La respuesta no contiene data[]');
      ensure(response.json.data.length > 0, 'No hay sucursales publicas para probar.');

      const branchId = toPositiveInt(FORCED_BRANCH_ID) || toPositiveInt(response.json.data[0]?.id);
      ensure(branchId, 'No se pudo resolver id_sucursal para el resto de pruebas.');

      context.branchId = branchId;

      const requestIdHeader = getHeader(response.headers, 'X-Request-Id');
      ensure(requestIdHeader.length > 0, 'Falta header X-Request-Id en lectura publica.');

      return { meta: { id_sucursal_test: branchId } };
    }, results);

    await runCase('GET /api/public-menu/catalogo sin id_sucursal (400 saneado)', async () => {
      const response = await requestJson({
        method: 'GET',
        path: '/api/public-menu/catalogo'
      });

      ensure(response.status === 400, `HTTP inesperado: ${response.status}`);
      ensure(response.json?.ok === false, 'Debe responder ok=false.');
      ensure(
        String(response.json?.code || '').trim() === 'PUBLIC_MENU_VALIDATION_ERROR',
        `Code inesperado: ${response.json?.code}`
      );
      ensure(hasRequestIdInError(response.json), 'Falta request_id en error de validacion.');
      return {};
    }, results);

    await runCase('GET /api/public-menu/catalogo por sucursal', async () => {
      ensure(context.branchId, 'No hay id_sucursal en contexto.');
      const response = await requestJson({
        method: 'GET',
        path: `/api/public-menu/catalogo?id_sucursal=${context.branchId}`
      });

      ensure(response.status === 200, `HTTP inesperado: ${response.status}`);
      ensure(response.json?.ok === true, 'Debe responder ok=true.');
      ensure(response.json?.data && typeof response.json.data === 'object', 'Falta objeto data en catalogo.');
      ensure(Array.isArray(response.json?.data?.items), 'Catalogo sin arreglo items.');

      return {
        meta: {
          total_items: response.json.data.items.length
        }
      };
    }, results);

    await runCase('POST /api/public-menu/pedidos sin sesion (401)', async () => {
      const response = await requestJson({
        method: 'POST',
        path: '/api/public-menu/pedidos',
        body: {}
      });

      ensure(response.status === 401, `HTTP inesperado: ${response.status}`);
      ensure(response.json?.ok === false, 'Debe responder ok=false.');
      ensure(
        String(response.json?.code || '').trim() === 'PUBLIC_MENU_UNAUTHORIZED',
        `Code inesperado: ${response.json?.code}`
      );
      ensure(hasRequestIdInError(response.json), 'Falta request_id en error de no autorizado.');
      return {};
    }, results);

    await runCase('GET /api/public-menu/items/:id detalle de item', async () => {
      ensure(context.branchId, 'No hay id_sucursal en contexto.');
      const catalogResponse = await requestJson({
        method: 'GET',
        path: `/api/public-menu/catalogo?id_sucursal=${context.branchId}`
      });

      ensure(catalogResponse.status === 200, `No se pudo cargar catalogo: HTTP ${catalogResponse.status}`);
      const candidate = findOrderCandidateItem(catalogResponse.json?.data);
      if (!candidate) {
        return { skip: true, reason: 'La sucursal no tiene items disponibles para validar detalle.' };
      }

      const idDetalleMenu = toPositiveInt(candidate.id_detalle_menu);
      ensure(idDetalleMenu, 'No se pudo resolver id_detalle_menu para detalle.');

      const detailResponse = await requestJson({
        method: 'GET',
        path: `/api/public-menu/items/${idDetalleMenu}?id_sucursal=${context.branchId}`
      });

      ensure(detailResponse.status === 200, `HTTP inesperado: ${detailResponse.status}`);
      ensure(detailResponse.json?.ok === true, 'Debe responder ok=true.');
      ensure(
        toPositiveInt(detailResponse.json?.data?.item?.id_detalle_menu) === idDetalleMenu,
        'El detalle no coincide con el item solicitado.'
      );

      return { meta: { id_detalle_menu: idDetalleMenu } };
    }, results);

    await runCase('Flujo autenticado de cliente (login + pedidos por tipo)', async () => {
      if (!AUTH_FLOW_ENABLED) {
        return { skip: true, reason: 'No hay credenciales en MENU_QA_IDENTIFIER/MENU_QA_PASSWORD.' };
      }
      ensure(context.branchId, 'No hay id_sucursal para ejecutar flujo autenticado.');

      const loginResponse = await requestJson({
        method: 'POST',
        path: '/api/public/login',
        body: {
          identifier: LOGIN_IDENTIFIER,
          clave: LOGIN_PASSWORD
        }
      });

      ensure(loginResponse.status === 200, `Login no exitoso: HTTP ${loginResponse.status}`);
      ensure(loginResponse.json && typeof loginResponse.json === 'object', 'Login sin cuerpo JSON valido.');
      ensure(String(loginResponse.json?.csrfToken || '').trim(), 'Login sin csrfToken.');
      context.csrfToken = String(loginResponse.json.csrfToken).trim();

      const createOrder = async (orderType, validBusiness = true) => {
        const catalogResponse = await requestJson({
          method: 'GET',
          path: `/api/public-menu/catalogo?id_sucursal=${context.branchId}&tipo_pedido=${orderType}`
        });
        ensure(catalogResponse.status === 200, `Catalogo ${orderType} fallo con HTTP ${catalogResponse.status}`);

        const candidate = findOrderCandidateItem(catalogResponse.json?.data);
        ensure(candidate, `No hay item disponible para crear pedido ${orderType}.`);

        const line = buildOrderLineFromCatalogItem(candidate);
        const payload = buildOrderPayload({
          branchId: context.branchId,
          orderType,
          itemLine: line,
          validBusiness
        });

        return requestJson({
          method: 'POST',
          path: '/api/public-menu/pedidos',
          headers: {
            'X-CSRF-Token': context.csrfToken
          },
          body: payload
        });
      };

      // pickup sin comprobante debe ser rechazado por validacion.
      const pickupInvalid = await createOrder('pickup', false);
      ensure(pickupInvalid.status === 400, `Pickup invalido devolvio HTTP ${pickupInvalid.status}`);
      ensure(
        String(pickupInvalid.json?.code || '').trim() === 'PUBLIC_MENU_VALIDATION_ERROR',
        `Pickup invalido sin code esperado: ${pickupInvalid.json?.code}`
      );

      // delivery sin direccion debe ser rechazado por validacion.
      const deliveryInvalid = await createOrder('delivery', false);
      ensure(deliveryInvalid.status === 400, `Delivery invalido devolvio HTTP ${deliveryInvalid.status}`);
      ensure(
        String(deliveryInvalid.json?.code || '').trim() === 'PUBLIC_MENU_VALIDATION_ERROR',
        `Delivery invalido sin code esperado: ${deliveryInvalid.json?.code}`
      );

      // Pedidos validos por tipo.
      const dineInResponse = await createOrder('dine-in', true);
      ensure(dineInResponse.status === 201, `dine-in valido devolvio HTTP ${dineInResponse.status}`);
      const dineInId = toPositiveInt(dineInResponse.json?.data?.id_pedido);
      ensure(dineInId, 'No se obtuvo id_pedido para dine-in.');
      context.createdOrders.push({ idPedido: dineInId, orderType: 'dine-in' });

      const pickupResponse = await createOrder('pickup', true);
      ensure(pickupResponse.status === 201, `pickup valido devolvio HTTP ${pickupResponse.status}`);
      const pickupId = toPositiveInt(pickupResponse.json?.data?.id_pedido);
      ensure(pickupId, 'No se obtuvo id_pedido para pickup.');
      context.createdOrders.push({ idPedido: pickupId, orderType: 'pickup' });

      const deliveryResponse = await createOrder('delivery', true);
      ensure(deliveryResponse.status === 201, `delivery valido devolvio HTTP ${deliveryResponse.status}`);
      const deliveryId = toPositiveInt(deliveryResponse.json?.data?.id_pedido);
      ensure(deliveryId, 'No se obtuvo id_pedido para delivery.');
      context.createdOrders.push({ idPedido: deliveryId, orderType: 'delivery' });

      return {
        meta: {
          created_orders: context.createdOrders
        }
      };
    }, results);

    await runCase('Verificacion BD de pedidos creados desde menu', async () => {
      if (!AUTH_FLOW_ENABLED) {
        return { skip: true, reason: 'No se ejecuta sin login de cliente.' };
      }
      if (context.createdOrders.length === 0) {
        return { skip: true, reason: 'No hay pedidos creados para validar en BD.' };
      }

      for (const order of context.createdOrders) {
        await verifyOrderInDb({
          idPedido: order.idPedido,
          orderType: order.orderType,
          dbCapabilities: context.dbCapabilities
        });
      }

      return {
        meta: {
          validated_orders: context.createdOrders.length,
          has_configuracion_menu_column: context.dbCapabilities.hasConfiguracionMenu
        }
      };
    }, results);

    await runCase('Rate limit de menu publico (opcional)', async () => {
      if (!RATE_LIMIT_STRESS_ENABLED) {
        return { skip: true, reason: 'Habilita MENU_QA_RATE_LIMIT_STRESS=1 para ejecutar este caso.' };
      }
      ensure(context.branchId, 'No hay id_sucursal para prueba de rate limit.');

      let rateLimitedResponse = null;
      for (let i = 0; i < 70; i += 1) {
        const response = await requestJson({
          method: 'GET',
          path: `/api/public-menu/catalogo?id_sucursal=${context.branchId}`
        });
        if (response.status === 429) {
          rateLimitedResponse = response;
          break;
        }
      }

      ensure(rateLimitedResponse, 'No se alcanzo respuesta 429 durante stress test.');
      ensure(
        String(rateLimitedResponse.json?.code || '').trim() === 'PUBLIC_MENU_RATE_LIMIT',
        `Code inesperado en 429: ${rateLimitedResponse.json?.code}`
      );
      ensure(hasRequestIdInError(rateLimitedResponse.json), 'Falta request_id en respuesta 429.');

      return {};
    }, results);

    console.log('\n==============================================');
    console.log('RESULTADOS QA MENU PUBLICO');
    console.log('==============================================');
    results.forEach((result) => {
      if (result.status === 'PASS') {
        console.log(`- PASS: ${result.name}`);
        if (result.meta) {
          console.log(`  meta: ${JSON.stringify(result.meta)}`);
        }
      } else if (result.status === 'SKIP') {
        console.log(`- SKIP: ${result.name}`);
        console.log(`  reason: ${result.reason}`);
      } else {
        console.log(`- FAIL: ${result.name}`);
        console.log(`  error: ${result.error}`);
      }
    });

    const failed = results.filter((result) => result.status === 'FAIL');
    if (failed.length > 0) {
      console.error(`\nQA MENU FINAL: FAIL (${failed.length} caso(s) fallaron)`);
      process.exitCode = 1;
      return;
    }

    console.log('\nQA MENU FINAL: PASS');
  } catch (error) {
    console.error('\nQA MENU FINAL: ERROR no controlado');
    console.error(error?.message || error);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
};

main();
