import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import pool, { closePool } from '../config/db-connection.js';
import app from '../app.js';
import {
  buildCajaCloseEmailHtml,
  loadCajaCloseEmailPayload
} from '../services/cajaCloseEmailOutboxService.js';
import { buildSegmentedArqueoComputation } from '../services/cajaCloseComputationService.js';
import { loadCajaCloseFinancialSnapshot } from '../services/cajaCloseFinancialSnapshotService.js';
import { buildCajaCierrePdfBuffer } from '../utils/cajaCierreReportePdf.js';
import { createSession } from '../utils/security/sessionService.js';
import {
  buildAuthTokenPayload,
  getUserAuthzSnapshot
} from '../utils/security/authTokenPayload.js';
import { issueAccessToken } from '../utils/security/accessTokenPolicy.js';
import { assertQaSharedPaymentCatalogWriteForbidden } from '../services/cajaCloseIsolatedDatabaseGuard.js';

const QA_PROJECT_REF = 'cluideiojeikzcmmizhe';
const VERIFY_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql', import.meta.url);
const QA_CATALOG_GUARD_INSTALLED = Symbol.for('jonnys.qaCajaCatalogGuardInstalled');

const installQaSharedPaymentCatalogWriteGuard = () => {
  const protectClient = (client) => {
    if (!client || client[QA_CATALOG_GUARD_INSTALLED]) return client;
    const originalQuery = client.query.bind(client);
    client.query = (query, ...args) => {
      assertQaSharedPaymentCatalogWriteForbidden(query);
      return originalQuery(query, ...args);
    };
    Object.defineProperty(client, QA_CATALOG_GUARD_INSTALLED, { value: true });
    return client;
  };

  if (!pool[QA_CATALOG_GUARD_INSTALLED]) {
    pool.on('connect', protectClient);
    const originalPoolQuery = pool.query.bind(pool);
    pool.query = (query, ...args) => {
      assertQaSharedPaymentCatalogWriteForbidden(query);
      return originalPoolQuery(query, ...args);
    };
    const originalPoolConnect = pool.connect.bind(pool);
    pool.connect = async (...args) => protectClient(await originalPoolConnect(...args));
    Object.defineProperty(pool, QA_CATALOG_GUARD_INSTALLED, { value: true });
  }
};

// Usuario QA real con rol SUPER_ADMIN, resuelto dinamicamente (nunca un ID
// hardcodeado): usado unicamente para firmar una sesion de prueba
// desechable. No se lee ni modifica su clave; solo se crea y borra una fila
// de sesiones_activas propia de este smoke.
const resolveQaHttpTestUser = async (client) => {
  const result = await client.query(`
    SELECT u.id_usuario
    FROM public.usuarios u
    INNER JOIN public.roles_usuarios ru ON ru.id_usuario = u.id_usuario
    INNER JOIN public.roles r ON r.id_rol = ru.id_rol
    WHERE COALESCE(u.estado, true) = true
      AND UPPER(REGEXP_REPLACE(TRIM(r.nombre), '[\\s-]+', '_', 'g')) = 'SUPER_ADMIN'
    ORDER BY u.id_usuario
    LIMIT 1
  `);
  const idUsuario = Number(result.rows[0]?.id_usuario) || null;
  assert.ok(idUsuario, 'No se encontro un usuario SUPER_ADMIN activo en QA para firmar la sesion de prueba HTTP.');
  return idUsuario;
};

const assertQaTarget = () => {
  if (process.env.QA_CAJAS_NEGATIVE_CLOSE_SMOKE !== 'true') {
    throw new Error('QA_CAJAS_NEGATIVE_CLOSE_SMOKE=true es obligatorio.');
  }
  const user = String(process.env.DB_USER || '');
  const projectRef = user.includes('.') ? user.split('.').at(-1) : '';
  if (projectRef !== QA_PROJECT_REF) {
    throw new Error('QA_CAJAS_SMOKE_TARGET_INVALID');
  }
};

const namedConstraintState = async (queryRunner) => {
  const result = await queryRunner.query(`
    SELECT c.conrelid::regclass::text AS tabla, c.conname, c.convalidated,
           pg_get_expr(c.conbin, c.conrelid) AS expresion
    FROM pg_constraint c
    WHERE (c.conrelid, c.conname) IN (
      ('public.cajas_sesiones'::regclass, 'ck_cajas_sesiones_monto_teorico'),
      ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico'),
      ('public.cajas_arqueos'::regclass, 'ck_cajas_arqueos_teorico')
    )
    ORDER BY tabla
  `);
  return result.rows;
};

const runVerify = async (queryRunner, verifySql) => {
  const rawResults = await queryRunner.query(verifySql);
  const results = Array.isArray(rawResults) ? rawResults : [rawResults];
  const negativeChecks = results.find((result) =>
    result.fields?.some((field) => field.name === 'permite_valores_negativos')
  );
  const requiredChecks = results.find((result) =>
    result.fields?.some((field) => field.name === 'control_no_negativo_presente_y_validado')
  );
  const absenceChecks = results.find((result) =>
    result.fields?.some((field) => field.name === 'ausente')
  );
  const arqueosContadoCheck = results.find((result) =>
    result.fields?.some((field) => field.name === 'protege_exclusivamente_monto_contado')
  );
  const catalogChecks = results.find((result) =>
    result.fields?.some((field) => field.name === 'valido') && result.fields?.some((field) => field.name === 'codigo')
  );
  const regressionCounts = results.find((result) =>
    result.fields?.some((field) => field.name === 'cantidad_facturas')
  );

  assert.ok(negativeChecks);
  assert.ok(requiredChecks);
  assert.ok(absenceChecks);
  assert.ok(arqueosContadoCheck);
  assert.ok(catalogChecks);
  assert.ok(regressionCounts);
  assert.ok(requiredChecks.rows.every((row) => row.control_no_negativo_presente_y_validado === true));
  assert.equal(arqueosContadoCheck.rows[0].existe, true);
  assert.equal(arqueosContadoCheck.rows[0].protege_exclusivamente_monto_contado, true);
  assert.equal(arqueosContadoCheck.rows[0].expresion_no_negativa_exacta, true);
  assert.ok(catalogChecks.rows.every((row) => row.valido === true), 'catalogo EFECTIVO/TARJETA/TRANSFERENCIA/OTRO debe ser valido');

  return {
    negativeChecks: negativeChecks.rows,
    protectedChecks: requiredChecks.rows.length,
    absenceChecks: absenceChecks.rows,
    catalog: catalogChecks.rows,
    regressionCounts: regressionCounts.rows[0]
  };
};


const loadSmokeReferences = async (client) => {
  const result = await client.query(`
    SELECT
      caja.id_caja,
      caja.id_sucursal,
      usuario.id_usuario,
      (SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo)) = 'ABIERTA' LIMIT 1) AS estado_abierta,
      (SELECT id_estado_sesion_caja FROM public.cat_cajas_sesiones_estados WHERE UPPER(TRIM(codigo)) = 'CERRADA' LIMIT 1) AS estado_cerrada,
      (SELECT id_tipo_movimiento_caja FROM public.cat_cajas_movimientos_tipos WHERE UPPER(TRIM(codigo)) = 'APERTURA' LIMIT 1) AS tipo_apertura,
      (SELECT id_tipo_movimiento_caja FROM public.cat_cajas_movimientos_tipos WHERE UPPER(TRIM(codigo)) IN ('EGRESO_MANUAL','EGRESO','RETIRO','SALIDA_CAJA') ORDER BY CASE WHEN UPPER(TRIM(codigo)) = 'EGRESO_MANUAL' THEN 0 ELSE 1 END LIMIT 1) AS tipo_egreso,
      (SELECT id_resolucion_cierre_caja FROM public.cat_cajas_resoluciones_cierre WHERE UPPER(TRIM(codigo)) = 'PENDIENTE_REVISION' LIMIT 1) AS resolucion_pendiente
    FROM public.cajas caja
    CROSS JOIN LATERAL (
      SELECT u.id_usuario
      FROM public.usuarios u
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.cajas_sesiones cs
        INNER JOIN public.cat_cajas_sesiones_estados estado
          ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
        WHERE UPPER(TRIM(estado.codigo)) = 'ABIERTA'
          AND (cs.id_caja = caja.id_caja OR cs.id_usuario_responsable = u.id_usuario)
      )
      ORDER BY u.id_usuario
      LIMIT 1
    ) usuario
    WHERE COALESCE(caja.estado, true) = true
    ORDER BY caja.id_caja
    LIMIT 1
  `);
  const row = result.rows[0];
  assert.ok(row);
  for (const key of [
    'id_caja',
    'id_sucursal',
    'id_usuario',
    'estado_abierta',
    'estado_cerrada',
    'tipo_apertura',
    'tipo_egreso',
    'resolucion_pendiente'
  ]) assert.ok(row[key], `Referencia QA faltante: ${key}`);
  return row;
};

const insertSyntheticInvoice = async (client, {
  idSesionCaja,
  references,
  idUsuario = references.id_usuario,
  fixtureReference,
  total = 1000
}) => {
  const invoice = await client.query(`
    INSERT INTO public.facturas (
      id_caja, id_pedido, id_sucursal, id_usuario, id_cliente,
      codigo_venta, fecha_operacion, efectivo_entregado, cambio,
      fecha_hora_facturacion, isv_15, isv_18, id_sesion_caja
    ) VALUES (
      $1, NULL, $2, $3, NULL,
      $4, (NOW() AT TIME ZONE 'America/Tegucigalpa')::date, $5, 0,
      (NOW() AT TIME ZONE 'America/Tegucigalpa'), 0, 0, $6
    )
    RETURNING id_factura
  `, [
    references.id_caja,
    references.id_sucursal,
    idUsuario,
    fixtureReference,
    total,
    idSesionCaja
  ]);
  const idFactura = Number(invoice.rows[0]?.id_factura) || null;
  assert.ok(idFactura, 'No se pudo crear la factura sintetica del smoke.');

  const detail = await client.query(`
    INSERT INTO public.detalle_facturas (
      id_factura, id_producto, id_descuento, cantidad,
      precio_unitario, sub_total, total_detalle, id_pedido, tipo_item
    ) VALUES ($1, NULL, NULL, 1, $2, $2, $2, NULL, NULL)
    RETURNING id_detalle_factura
  `, [idFactura, total]);
  const idDetalleFactura = Number(detail.rows[0]?.id_detalle_factura) || null;
  assert.ok(idDetalleFactura, 'No se pudo crear el detalle sintetico del smoke.');

  return { idFactura, idDetalleFactura };
};

const insertSession = async (client, {
  idSesionCaja,
  references,
  estado,
  montoApertura,
  closed = false,
  idUsuarioResponsable = references.id_usuario,
  fixtureReference = 'QA_SMOKE_CAJA_NEGATIVE_CLOSE'
}) => {
  await client.query(`
    INSERT INTO public.cajas_sesiones (
      id_sesion_caja, id_caja, id_sucursal, id_usuario_responsable,
      id_estado_sesion_caja, id_usuario_apertura, id_usuario_cierre,
      fecha_apertura, fecha_cierre, monto_apertura, observacion_apertura,
      fecha_creacion, fecha_actualizacion
    ) OVERRIDING SYSTEM VALUE
    VALUES (
      $1::bigint, $2::integer, $3::integer, $4::integer, $5::integer, $4::integer,
      CASE WHEN $6::boolean THEN $4::integer ELSE NULL::integer END,
      NOW() - interval '1 minute',
      CASE WHEN $6::boolean THEN NOW() ELSE NULL END,
      $7::numeric, $8, NOW(), NOW()
    )
  `, [
    idSesionCaja,
    references.id_caja,
    references.id_sucursal,
    idUsuarioResponsable,
    estado,
    closed,
    montoApertura,
    fixtureReference
  ]);
};

const insertPayment = async (client, {
  idFacturaCobro,
  idFactura,
  idSesionCaja,
  references,
  methodCode,
  amount,
  fixtureReference
}) => {
  await client.query(`
    INSERT INTO public.facturas_cobros (
      id_factura_cobro, id_factura, id_sesion_caja, id_caja, id_sucursal,
      id_usuario_ejecutor, id_metodo_pago, monto, referencia, observacion,
      fecha_cobro, fecha_creacion
    ) OVERRIDING SYSTEM VALUE
    SELECT $1, $2, $3, $4, $5, $6, mp.id_metodo_pago, $7,
           $8, $8, NOW(), NOW()
    FROM public.cat_metodos_pago mp
    WHERE UPPER(TRIM(mp.codigo)) = $9
  `, [
    idFacturaCobro,
    idFactura,
    idSesionCaja,
    references.id_caja,
    references.id_sucursal,
    references.id_usuario,
    amount,
    fixtureReference,
    methodCode
  ]);
};


// --- Problema 3: integracion HTTP real (cierre-preview / cierre-validaciones / cerrar) ---

const startServer = () => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1');
  server.once('listening', () => resolve(server));
  server.once('error', reject);
});

const stopServer = (server) => new Promise((resolve) => server.close(() => resolve()));

const mintQaAuthContext = async ({ idUsuario, idSucursal }) => {
  const idSesion = await createSession({
    id_usuario: idUsuario,
    ip_origen: '127.0.0.1',
    user_agent: 'qa-caja-negative-close-smoke'
  });
  const authz = await getUserAuthzSnapshot(pool, idUsuario);
  const userRow = await pool.query('SELECT nombre_usuario FROM public.usuarios WHERE id_usuario = $1', [idUsuario]);
  const payload = buildAuthTokenPayload({
    id_usuario: idUsuario,
    nombre_usuario: userRow.rows[0]?.nombre_usuario || null,
    id_sucursal: idSucursal,
    must_change_password: false,
    sid: idSesion
  }, authz);
  const { token } = issueAccessToken(payload, { roles: authz.roles });
  const csrfToken = crypto.randomBytes(32).toString('hex');
  return {
    idSesion,
    cookieHeader: `access_token=${token}; csrf_token=${csrfToken}`,
    csrfToken
  };
};

const closeQaAuthContext = async (idSesion) => {
  await pool.query('DELETE FROM sesiones_activas WHERE id_sesion = $1', [idSesion]);
};

const callJson = async (baseUrl, method, path, { auth, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    headers.Cookie = auth.cookieHeader;
    headers['X-CSRF-Token'] = auth.csrfToken;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};

const captureRegressionMetrics = async (queryRunner) => {
  const result = await queryRunner.query(`
    SELECT
      (SELECT COUNT(*)::bigint FROM public.facturas)::text AS cantidad_facturas,
      (SELECT COALESCE(SUM(total_detalle), 0)::numeric FROM public.detalle_facturas)::text AS suma_facturas,
      (SELECT COUNT(*)::bigint FROM public.facturas_cobros)::text AS cantidad_cobros,
      (SELECT COALESCE(SUM(monto), 0)::numeric FROM public.facturas_cobros)::text AS suma_cobros,
      (SELECT COUNT(*)::bigint FROM public.pedidos)::text AS cantidad_pedidos,
      (SELECT COUNT(*)::bigint FROM public.cajas_movimientos)::text AS cantidad_movimientos,
      (SELECT COUNT(*)::bigint FROM public.cajas_cierres)::text AS cantidad_cierres,
      (SELECT COUNT(*)::bigint
       FROM public.cajas_sesiones cs
       INNER JOIN public.cat_cajas_sesiones_estados estado
         ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
       WHERE UPPER(TRIM(estado.codigo)) = 'ABIERTA')::text AS sesiones_abiertas,
      (SELECT COALESCE(
         JSONB_AGG(
           JSONB_BUILD_OBJECT(
             'id_metodo_pago', id_metodo_pago,
             'codigo', codigo,
             'estado', estado,
             'afecta_efectivo', afecta_efectivo
           ) ORDER BY id_metodo_pago
         ),
         '[]'::jsonb
       )::text FROM public.cat_metodos_pago) AS catalogo_metodos_pago
  `);
  return result.rows[0];
};

// Limpieza idempotente y por alcance completo. Descubre todos los cierres y
// todas las validaciones de la sesion; no depende de que el flujo haya llegado
// a devolver sus identificadores antes de fallar.
const cleanupHttpCloseArtifacts = async ({ idSesionCaja, idFactura, fixtureReference }) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const closeRows = await client.query(
      'SELECT id_cierre_caja FROM public.cajas_cierres WHERE id_sesion_caja = $1',
      [idSesionCaja]
    );
    const closeIds = closeRows.rows.map((row) => String(row.id_cierre_caja));
    if (closeIds.length > 0) {
      await client.query('DELETE FROM public.cajas_cierres_notificaciones_email WHERE id_cierre_caja = ANY($1::bigint[])', [closeIds]);
      await client.query('DELETE FROM public.cajas_cierres_arqueos_metodos WHERE id_cierre_caja = ANY($1::bigint[])', [closeIds]);
    }
    await client.query('UPDATE public.cajas_cierres_validaciones SET id_cierre_caja = NULL WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query(`
      DELETE FROM public.cajas_cierres_validaciones_metodos
      WHERE id_validacion_cierre IN (
        SELECT id_validacion_cierre FROM public.cajas_cierres_validaciones WHERE id_sesion_caja = $1
      )
    `, [idSesionCaja]);
    await client.query('DELETE FROM public.cajas_cierres_validaciones WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query('DELETE FROM public.cajas_cierres WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query('DELETE FROM public.cajas_arqueos WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query(`
      DELETE FROM public.facturas_reversiones_detalle
      WHERE id_reversion IN (
        SELECT id_reversion FROM public.facturas_reversiones
        WHERE id_sesion_caja_original = $1
           OR id_sesion_caja_actual = $1
           OR codigo_reversion LIKE $2 || '%'
      )
    `, [idSesionCaja, fixtureReference]);
    await client.query(`
      DELETE FROM public.facturas_reversiones
      WHERE id_sesion_caja_original = $1
         OR id_sesion_caja_actual = $1
         OR codigo_reversion LIKE $2 || '%'
    `, [idSesionCaja, fixtureReference]);
    await client.query("DELETE FROM public.facturas_cobros WHERE id_sesion_caja = $1 OR referencia LIKE $2 || '%' OR observacion LIKE $2 || '%'", [idSesionCaja, fixtureReference]);
    await client.query("DELETE FROM public.cajas_movimientos WHERE id_sesion_caja = $1 OR referencia LIKE $2 || '%' OR observacion LIKE $2 || '%'", [idSesionCaja, fixtureReference]);
    await client.query('DELETE FROM public.cajas_sesiones_participantes WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query(`
      DELETE FROM public.detalle_facturas
      WHERE id_factura IN (
        SELECT id_factura FROM public.facturas
        WHERE id_factura = $1 OR codigo_venta LIKE $2 || '%'
      )
    `, [idFactura, fixtureReference]);
    await client.query("DELETE FROM public.facturas WHERE id_factura = $1 OR codigo_venta LIKE $2 || '%'", [idFactura, fixtureReference]);
    await client.query('DELETE FROM public.cajas_sesiones WHERE id_sesion_caja = $1', [idSesionCaja]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const assertZeroHttpCloseArtifacts = async ({ idSesionCaja, fixtureReference, authSessionId }) => {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.cajas_sesiones WHERE id_sesion_caja = $1) AS sesiones,
      (SELECT COUNT(*)::int FROM public.cajas_sesiones_participantes WHERE id_sesion_caja = $1) AS participantes,
      (SELECT COUNT(*)::int FROM public.cajas_movimientos WHERE id_sesion_caja = $1 OR referencia LIKE $2 || '%' OR observacion LIKE $2 || '%') AS movimientos,
      (SELECT COUNT(*)::int FROM public.facturas_cobros WHERE id_sesion_caja = $1 OR referencia LIKE $2 || '%' OR observacion LIKE $2 || '%') AS cobros,
      (SELECT COUNT(*)::int FROM public.facturas WHERE id_sesion_caja = $1 OR codigo_venta LIKE $2 || '%') AS facturas,
      (SELECT COUNT(*)::int FROM public.detalle_facturas df
       INNER JOIN public.facturas f ON f.id_factura = df.id_factura
       WHERE f.id_sesion_caja = $1 OR f.codigo_venta LIKE $2 || '%') AS detalles,
      (SELECT COUNT(*)::int FROM public.facturas_reversiones
       WHERE id_sesion_caja_original = $1 OR id_sesion_caja_actual = $1 OR codigo_reversion LIKE $2 || '%') AS reversiones,
      (SELECT COUNT(*)::int FROM public.cajas_cierres_validaciones WHERE id_sesion_caja = $1) AS validaciones,
      (SELECT COUNT(*)::int FROM public.cajas_cierres WHERE id_sesion_caja = $1) AS cierres,
      (SELECT COUNT(*)::int FROM public.cajas_arqueos WHERE id_sesion_caja = $1) AS arqueos,
      (SELECT COUNT(*)::int FROM public.sesiones_activas WHERE id_sesion = $3) AS autenticaciones
  `, [idSesionCaja, fixtureReference, authSessionId]);
  const residues = result.rows[0];
  assert.ok(Object.values(residues).every((value) => Number(value) === 0), `Quedaron residuos del smoke HTTP: ${JSON.stringify(residues)}`);
  return residues;
};

const runHttpCloseSmoke = async () => {
  // Rango seguro para integer (algunas tablas de auditoria referencian el id
  // de sesion en una columna integer, no bigint), muy por encima de cualquier
  // secuencia real de QA.
  const idSesionCaja = 900_000_000 + (Date.now() % 90_000_000);
  const baseId = idSesionCaja;
  const fixtureReference = `QAH${baseId}`;
  let references = null;
  let qaTestUserId = null;
  let auth = null;
  let server = null;
  let baseUrl = null;
  let idFactura = null;
  let idDetalleFactura = null;
  let idCierreCaja = null;
  let idValidacionCierre = null;
  let metricsBefore = null;
  let result = null;
  try {
    references = await loadSmokeReferences(pool);
    qaTestUserId = await resolveQaHttpTestUser(pool);
    metricsBefore = await captureRegressionMetrics(pool);
    await insertSession(pool, {
      idSesionCaja,
      references,
      estado: references.estado_abierta,
      montoApertura: 3000,
      idUsuarioResponsable: qaTestUserId,
      fixtureReference
    });
    const syntheticInvoice = await insertSyntheticInvoice(pool, {
      idSesionCaja,
      references,
      idUsuario: qaTestUserId,
      fixtureReference
    });
    ({ idFactura, idDetalleFactura } = syntheticInvoice);
    const invoiceProof = await pool.query(`
      SELECT f.id_factura, f.id_pedido, f.codigo_venta,
             COUNT(df.id_detalle_factura)::int AS detalles,
             COALESCE(SUM(df.total_detalle), 0)::numeric AS total_detalle
      FROM public.facturas f
      LEFT JOIN public.detalle_facturas df ON df.id_factura = f.id_factura
      WHERE f.id_factura = $1 AND f.codigo_venta = $2 AND f.id_sesion_caja = $3
      GROUP BY f.id_factura, f.id_pedido, f.codigo_venta
    `, [idFactura, fixtureReference, idSesionCaja]);
    assert.equal(invoiceProof.rowCount, 1);
    assert.equal(invoiceProof.rows[0].id_pedido, null);
    assert.equal(invoiceProof.rows[0].detalles, 1);
    assert.equal(Number(invoiceProof.rows[0].total_detalle), 1000);

    await pool.query(`
      INSERT INTO public.cajas_movimientos (
        id_movimiento_caja, id_sesion_caja, id_caja, id_sucursal,
        id_tipo_movimiento_caja, id_usuario_ejecutor, monto,
        referencia, observacion, fecha_movimiento, fecha_creacion
      ) OVERRIDING SYSTEM VALUE
      VALUES ($1, $2, $3, $4, $5, $6, 16763, $7, $7, NOW(), NOW())
    `, [baseId + 1, idSesionCaja, references.id_caja, references.id_sucursal, references.tipo_egreso, qaTestUserId, fixtureReference]);
    for (const [index, [methodCode, amount]] of [
      ['EFECTIVO', 100],
      ['TARJETA', 200],
      ['TRANSFERENCIA', 300],
      ['OTRO', 400]
    ].entries()) {
      await insertPayment(pool, {
        idFacturaCobro: baseId + 10 + index,
        idFactura,
        idSesionCaja,
        references: { ...references, id_usuario: qaTestUserId },
        methodCode,
        amount,
        fixtureReference
      });
    }

    // apertura 3000 + efectivo 100 - egreso 16763 = -13663;
    // no-efectivo 900 (200+300+400).
    const expectedEfectivoTeorico = -13663;
    const expectedTotalTeorico = -12763;
    const expectedTotalDeclarado = 900;
    auth = await mintQaAuthContext({ idUsuario: qaTestUserId, idSucursal: references.id_sucursal });
    server = await startServer();
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const arqueosPayload = [
      { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0, observacion: 'QA smoke HTTP: caja vacia tras egreso' },
      { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
      { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
    ];
    const observacionCierre = 'QA_SMOKE_HTTP cierre negativo con OTRO';
    const createCloseValidation = async (rows = arqueosPayload) => {
      const response = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-validaciones`, {
        auth,
        body: { observacion_cierre: observacionCierre, arqueos: rows }
      });
      assert.equal(response.status, 201, `cierre-validaciones HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      assert.ok(response.body?.id_validacion_cierre);
      return response;
    };
    const expectControlledCloseRejection = async (validationId, label, expectedCode = null) => {
      const response = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
        auth,
        body: { observacion_cierre: observacionCierre, id_validacion_cierre: validationId }
      });
      assert.ok(response.status >= 400 && response.status < 500, `${label} produjo HTTP ${response.status}: ${JSON.stringify(response.body)}`);
      if (expectedCode) assert.equal(response.body?.code, expectedCode, label);
      const partialWrites = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM public.cajas_cierres WHERE id_sesion_caja = $1) AS cierres,
          (SELECT COUNT(*)::int FROM public.cajas_cierres_arqueos_metodos WHERE id_sesion_caja = $1) AS arqueos,
          (SELECT COUNT(*)::int FROM public.cajas_cierres_notificaciones_email outbox
           INNER JOIN public.cajas_cierres cierre ON cierre.id_cierre_caja = outbox.id_cierre_caja
           WHERE cierre.id_sesion_caja = $1) AS outbox,
          (SELECT UPPER(TRIM(estado.codigo))
           FROM public.cajas_sesiones sesion
           INNER JOIN public.cat_cajas_sesiones_estados estado
             ON estado.id_estado_sesion_caja = sesion.id_estado_sesion_caja
           WHERE sesion.id_sesion_caja = $1) AS estado_sesion,
          (SELECT id_cierre_caja FROM public.cajas_cierres_validaciones
           WHERE id_validacion_cierre = $2) AS validacion_vinculada
      `, [idSesionCaja, validationId]);
      assert.deepEqual(partialWrites.rows[0], {
        cierres: 0,
        arqueos: 0,
        outbox: 0,
        estado_sesion: 'ABIERTA',
        validacion_vinculada: null
      }, `${label} dejo escritura parcial`);
      return response;
    };

    const manualPayloadRejections = [];
    const expectManualPayloadRejection = async ({ rows, expectedCode, label }) => {
      for (const endpoint of ['cierre-preview', 'cierre-validaciones']) {
        const beforeCount = await pool.query(
          'SELECT COUNT(*)::int AS count FROM public.cajas_cierres_validaciones WHERE id_sesion_caja=$1',
          [idSesionCaja]
        );
        const response = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/${endpoint}`, {
          auth,
          body: { observacion_cierre: observacionCierre, arqueos: rows }
        });
        assert.equal(response.status, 400, `${label}/${endpoint}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body?.code, expectedCode, `${label}/${endpoint}`);
        const afterCount = await pool.query(
          'SELECT COUNT(*)::int AS count FROM public.cajas_cierres_validaciones WHERE id_sesion_caja=$1',
          [idSesionCaja]
        );
        assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count, `${label}/${endpoint} escribio validacion parcial`);
        manualPayloadRejections.push({ label, endpoint, code: response.body.code });
      }
    };

    const efectivoRow = arqueosPayload[0];
    const tarjetaRow = arqueosPayload[1];
    const transferenciaRow = arqueosPayload[2];
    await expectManualPayloadRejection({
      rows: [efectivoRow],
      expectedCode: 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED',
      label: 'solo EFECTIVO'
    });
    await expectManualPayloadRejection({
      rows: [efectivoRow, tarjetaRow],
      expectedCode: 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED',
      label: 'EFECTIVO + TARJETA'
    });
    await expectManualPayloadRejection({
      rows: [efectivoRow, transferenciaRow],
      expectedCode: 'VENTAS_CAJAS_ARQUEO_METODO_REQUIRED',
      label: 'EFECTIVO + TRANSFERENCIA'
    });
    await expectManualPayloadRejection({
      rows: [...arqueosPayload, { metodo_pago_codigo: 'OTRO', monto_declarado: 400 }],
      expectedCode: 'VENTAS_CAJAS_ARQUEO_METODO_INVALID',
      label: 'OTRO enviado por cliente'
    });
    for (const duplicateCode of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA']) {
      const duplicateRow = arqueosPayload.find((row) => row.metodo_pago_codigo === duplicateCode);
      await expectManualPayloadRejection({
        rows: [...arqueosPayload, { ...duplicateRow }],
        expectedCode: 'VENTAS_CAJAS_ARQUEO_METODO_DUPLICATE',
        label: `duplicado ${duplicateCode}`
      });
    }

    const preview = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-preview`, {
      auth,
      body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
    });
    assert.equal(preview.status, 200, `cierre-preview HTTP ${preview.status}: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.arqueos_metodos.length, 4);
    const previewOtros = preview.body.arqueos_metodos.find((row) => row.metodo_pago_codigo === 'OTRO');
    assert.ok(previewOtros, 'preview debe incluir la fila OTRO');
    assert.equal(previewOtros.display_name, 'Otros no efectivo');
    assert.equal(previewOtros.editable, false);
    assert.equal(previewOtros.monto_teorico, 400);
    assert.equal(previewOtros.monto_declarado, 400);
    assert.equal(preview.body.resumen.total_teorico, expectedTotalTeorico);
    assert.equal(preview.body.resumen.total_declarado, expectedTotalDeclarado);

    const validaciones = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-validaciones`, {
      auth,
      body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
    });
    assert.equal(validaciones.status, 201, `cierre-validaciones HTTP ${validaciones.status}: ${JSON.stringify(validaciones.body)}`);
    idValidacionCierre = validaciones.body.id_validacion_cierre;
    assert.ok(idValidacionCierre);
    assert.equal(validaciones.body.metodos.length, 4);
    const validacionOtros = validaciones.body.metodos.find((row) => row.metodo_pago_codigo === 'OTRO');
    assert.ok(validacionOtros, 'cierre-validaciones debe incluir la fila OTRO');
    assert.equal(validacionOtros.completado_automaticamente, true);
    assert.equal(validacionOtros.monto_declarado, 400);
    assert.equal(validacionOtros.diferencia, 0);
    assert.equal(validaciones.body.resumen.total_declarado, expectedTotalDeclarado);
    assert.equal(validaciones.body.resumen.hay_diferencia, true);
    const duplicateRejections = [];
    const methodCodes = ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO'];
    for (const [index, methodCode] of methodCodes.entries()) {
      const validationForDuplicate = index === 0
        ? validaciones
        : await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-validaciones`, {
            auth,
            body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
          });
      assert.equal(validationForDuplicate.status, index === 0 ? 201 : 201);
      const validationId = validationForDuplicate.body.id_validacion_cierre;
      const rows = await pool.query(`
        SELECT id_validacion_metodo, id_metodo_pago, metodo_pago_codigo
        FROM public.cajas_cierres_validaciones_metodos
        WHERE id_validacion_cierre = $1
        ORDER BY id_validacion_metodo
      `, [validationId]);
      const target = rows.rows.find((row) => String(row.metodo_pago_codigo).trim().toUpperCase() === methodCode);
      const donor = rows.rows.find((row) => String(row.metodo_pago_codigo).trim().toUpperCase() !== methodCode);
      assert.ok(target && donor);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET id_metodo_pago = $1, metodo_pago_codigo = $2
        WHERE id_validacion_metodo = $3
      `, [target.id_metodo_pago, methodCode, donor.id_validacion_metodo]);
      try {
        const rejected = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
          auth,
          body: { observacion_cierre: observacionCierre, id_validacion_cierre: validationId }
        });
        assert.equal(rejected.status, 409, `duplicado ${methodCode}: ${JSON.stringify(rejected.body)}`);
        assert.equal(rejected.body?.code, 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        duplicateRejections.push(methodCode);
      } finally {
        await pool.query(`
          UPDATE public.cajas_cierres_validaciones_metodos
          SET id_metodo_pago = $1, metodo_pago_codigo = $2
          WHERE id_validacion_metodo = $3
        `, [donor.id_metodo_pago, donor.metodo_pago_codigo, donor.id_validacion_metodo]);
      }
    }

    const malformedValidationRejections = {};
    {
      const validation = await createCloseValidation();
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET metodo_pago_codigo = 'INESPERADO_QA'
        WHERE id_validacion_metodo = (
          SELECT id_validacion_metodo
          FROM public.cajas_cierres_validaciones_metodos
          WHERE id_validacion_cierre = $1
          ORDER BY id_validacion_metodo DESC
          LIMIT 1
        )
      `, [validation.body.id_validacion_cierre]);
      const rejected = await expectControlledCloseRejection(
        validation.body.id_validacion_cierre,
        'codigo inesperado',
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      malformedValidationRejections.codigoInesperado = rejected.status;
    }
    {
      const validation = await createCloseValidation();
      const rows = await pool.query(`
        SELECT id_validacion_metodo, id_metodo_pago, UPPER(TRIM(metodo_pago_codigo)) AS codigo
        FROM public.cajas_cierres_validaciones_metodos
        WHERE id_validacion_cierre = $1
      `, [validation.body.id_validacion_cierre]);
      const tarjeta = rows.rows.find((row) => row.codigo === 'TARJETA');
      const otro = rows.rows.find((row) => row.codigo === 'OTRO');
      assert.ok(tarjeta && otro);
      await pool.query(
        'UPDATE public.cajas_cierres_validaciones_metodos SET id_metodo_pago = $1 WHERE id_validacion_metodo = $2',
        [otro.id_metodo_pago, tarjeta.id_validacion_metodo]
      );
      const rejected = await expectControlledCloseRejection(
        validation.body.id_validacion_cierre,
        'id y codigo desalineados',
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      malformedValidationRejections.idCodigoDesalineados = rejected.status;
    }
    {
      const validation = await createCloseValidation();
      await pool.query(`
        DELETE FROM public.cajas_cierres_validaciones_metodos
        WHERE id_validacion_cierre = $1
          AND UPPER(TRIM(metodo_pago_codigo)) IN ('TRANSFERENCIA', 'OTRO')
      `, [validation.body.id_validacion_cierre]);
      const rejected = await expectControlledCloseRejection(
        validation.body.id_validacion_cierre,
        'validacion con solo dos metodos',
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      malformedValidationRejections.soloDosMetodos = rejected.status;
    }
    {
      const validation = await createCloseValidation();
      await pool.query(
        'DELETE FROM public.cajas_cierres_validaciones_metodos WHERE id_validacion_cierre = $1',
        [validation.body.id_validacion_cierre]
      );
      const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'validacion sin detalle');
      assert.equal(rejected.body?.code, 'VENTAS_CAJAS_VALIDACION_CIERRE_INCOMPLETA');
      malformedValidationRejections.sinDetalle = rejected.status;
    }

    const arithmeticTamperRejections = {};
    const runArithmeticTamper = async (label, mutate) => {
      const validation = await createCloseValidation();
      await mutate(validation.body.id_validacion_cierre);
      const rejected = await expectControlledCloseRejection(
        validation.body.id_validacion_cierre,
        label,
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      assert.equal(rejected.status, 409);
      arithmeticTamperRejections[label] = rejected.status;
    };
    await runArithmeticTamper('monto_declarado_alterado', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones_metodos
      SET monto_declarado = monto_declarado + 1
      WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'EFECTIVO'
    `, [validationId]));
    await runArithmeticTamper('diferencia_alterada', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones_metodos
      SET diferencia = diferencia + 1
      WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'TARJETA'
    `, [validationId]));
    await runArithmeticTamper('total_declarado_alterado', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones
      SET total_declarado = total_declarado + 1
      WHERE id_validacion_cierre = $1
    `, [validationId]));
    await runArithmeticTamper('diferencia_total_alterada', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones
      SET diferencia_total = diferencia_total + 1
      WHERE id_validacion_cierre = $1
    `, [validationId]));
    await runArithmeticTamper('requiere_revision_false_con_diferencia', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones_metodos
      SET requiere_revision = false
      WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'EFECTIVO'
    `, [validationId]));
    await runArithmeticTamper('suma_filas_distinta_encabezado', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones_metodos
      SET monto_teorico = monto_teorico + 1
      WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'TRANSFERENCIA'
    `, [validationId]));
    await runArithmeticTamper('otro_declarado_no_automatico', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones_metodos
      SET monto_declarado = monto_declarado + 1,
          diferencia = diferencia + 1,
          requiere_revision = true
      WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'OTRO'
    `, [validationId]));

    const coherentTamperRejections = {};
    const runCoherentTamper = async (label, mutate) => {
      const validation = await createCloseValidation();
      const validationId = validation.body.id_validacion_cierre;
      await mutate(validationId);
      const rejected = await expectControlledCloseRejection(
        validationId,
        label,
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      assert.equal(rejected.status, 409);
      assert.equal(rejected.body?.details?.motivo, 'VALIDATION_RECOMPUTATION_MISMATCH');
      coherentTamperRejections[label] = rejected.status;
    };
    await runCoherentTamper('efectivo_coherente', async (validationId) => {
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET monto_declarado = monto_declarado + 100,
            diferencia = diferencia + 100,
            requiere_revision = true
        WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'EFECTIVO'
      `, [validationId]);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones
        SET total_declarado = total_declarado + 100,
            diferencia_total = diferencia_total + 100,
            hay_diferencia = true
        WHERE id_validacion_cierre = $1
      `, [validationId]);
    });
    await runCoherentTamper('tarjeta_coherente', async (validationId) => {
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET monto_declarado = monto_declarado + 10,
            diferencia = diferencia + 10,
            cantidad_referencias = COALESCE(cantidad_referencias, 0) + 1,
            requiere_revision = true
        WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'TARJETA'
      `, [validationId]);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones
        SET total_declarado = total_declarado + 10,
            diferencia_total = diferencia_total + 10,
            hay_diferencia = true
        WHERE id_validacion_cierre = $1
      `, [validationId]);
    });
    await runCoherentTamper('transferencia_coherente', async (validationId) => {
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET monto_declarado = monto_declarado + 10,
            diferencia = diferencia + 10,
            observacion = 'QA alteracion coordinada transferencia',
            requiere_revision = true
        WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'TRANSFERENCIA'
      `, [validationId]);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones
        SET total_declarado = total_declarado + 10,
            diferencia_total = diferencia_total + 10,
            hay_diferencia = true
        WHERE id_validacion_cierre = $1
      `, [validationId]);
    });
    await runCoherentTamper('todos_los_manuales_coherentes', async (validationId) => {
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET monto_declarado = monto_declarado + 10,
            diferencia = diferencia + 10,
            observacion = COALESCE(observacion, 'QA alteracion coordinada completa'),
            requiere_revision = true
        WHERE id_validacion_cierre = $1
          AND metodo_pago_codigo IN ('EFECTIVO','TARJETA','TRANSFERENCIA')
      `, [validationId]);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones
        SET total_declarado = total_declarado + 30,
            diferencia_total = diferencia_total + 30,
            hay_diferencia = true
        WHERE id_validacion_cierre = $1
      `, [validationId]);
    });
    await runCoherentTamper('otro_coherente', async (validationId) => {
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones_metodos
        SET monto_declarado = monto_declarado + 10,
            diferencia = diferencia + 10,
            requiere_revision = true
        WHERE id_validacion_cierre = $1 AND metodo_pago_codigo = 'OTRO'
      `, [validationId]);
      await pool.query(`
        UPDATE public.cajas_cierres_validaciones
        SET total_declarado = total_declarado + 10,
            diferencia_total = diferencia_total + 10,
            hay_diferencia = true
        WHERE id_validacion_cierre = $1
      `, [validationId]);
    });
    await runCoherentTamper('payload_original_alterado', (validationId) => pool.query(`
      UPDATE public.cajas_cierres_validaciones
      SET payload_declarado_json = jsonb_set(
        payload_declarado_json,
        '{arqueos,0,monto_declarado}',
        '100'::jsonb,
        false
      )
      WHERE id_validacion_cierre = $1
    `, [validationId]));

    const invalidOriginalPayloadRejections = {};
    const invalidOriginalPayloads = {
      json_nulo: null,
      estructura_incorrecta: {},
      solo_dos_metodos: { arqueos: arqueosPayload.slice(0, 2) },
      metodo_duplicado: { arqueos: [...arqueosPayload, { ...arqueosPayload[0] }] },
      otro_manual: { arqueos: [...arqueosPayload.slice(0, 2), { metodo_pago_codigo: 'OTRO', monto_declarado: 400 }] },
      codigo_inesperado: { arqueos: [...arqueosPayload.slice(0, 2), { metodo_pago_codigo: 'CRIPTO', monto_declarado: 0 }] }
    };
    for (const [label, payload] of Object.entries(invalidOriginalPayloads)) {
      const validation = await createCloseValidation();
      const validationId = validation.body.id_validacion_cierre;
      await pool.query(
        'UPDATE public.cajas_cierres_validaciones SET payload_declarado_json = $2::jsonb WHERE id_validacion_cierre = $1',
        [validationId, JSON.stringify(payload)]
      );
      const rejected = await expectControlledCloseRejection(
        validationId,
        `payload original ${label}`,
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      assert.equal(rejected.status, 409);
      invalidOriginalPayloadRejections[label] = rejected.status;
    }

    const operationalChangeRejections = {};
    {
      const validation = await createCloseValidation();
      await insertPayment(pool, {
        idFacturaCobro: baseId + 100,
        idFactura,
        idSesionCaja,
        references: { ...references, id_usuario: qaTestUserId },
        methodCode: 'EFECTIVO',
        amount: 1,
        fixtureReference
      });
      try {
        const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'nuevo cobro', 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        operationalChangeRejections.nuevoCobro = rejected.status;
      } finally {
        await pool.query('DELETE FROM public.facturas_cobros WHERE id_factura_cobro = $1', [baseId + 100]);
      }
    }
    {
      const validation = await createCloseValidation();
      await pool.query(`
        INSERT INTO public.cajas_movimientos (
          id_movimiento_caja, id_sesion_caja, id_caja, id_sucursal,
          id_tipo_movimiento_caja, id_usuario_ejecutor, monto,
          referencia, observacion, fecha_movimiento, fecha_creacion
        ) OVERRIDING SYSTEM VALUE
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, NOW(), NOW())
      `, [baseId + 101, idSesionCaja, references.id_caja, references.id_sucursal, references.tipo_egreso, qaTestUserId, fixtureReference]);
      try {
        const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'nuevo movimiento', 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        operationalChangeRejections.nuevoMovimiento = rejected.status;
      } finally {
        await pool.query('DELETE FROM public.cajas_movimientos WHERE id_movimiento_caja = $1', [baseId + 101]);
      }
    }
    {
      const validation = await createCloseValidation();
      const saleReference = `${fixtureReference}S`;
      const saleInvoice = await insertSyntheticInvoice(pool, {
        idSesionCaja,
        references,
        idUsuario: qaTestUserId,
        fixtureReference: saleReference,
        total: 1
      });
      await insertPayment(pool, {
        idFacturaCobro: baseId + 102,
        idFactura: saleInvoice.idFactura,
        idSesionCaja,
        references: { ...references, id_usuario: qaTestUserId },
        methodCode: 'EFECTIVO',
        amount: 1,
        fixtureReference: saleReference
      });
      try {
        const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'nueva venta', 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        operationalChangeRejections.nuevaVenta = rejected.status;
      } finally {
        await pool.query('DELETE FROM public.facturas_cobros WHERE id_factura_cobro = $1', [baseId + 102]);
        await pool.query('DELETE FROM public.detalle_facturas WHERE id_factura = $1', [saleInvoice.idFactura]);
        await pool.query('DELETE FROM public.facturas WHERE id_factura = $1', [saleInvoice.idFactura]);
      }
    }
    {
      const validation = await createCloseValidation();
      const reversal = await pool.query(`
        INSERT INTO public.facturas_reversiones (
          codigo_reversion, id_factura_original, id_sucursal,
          id_caja_original, id_sesion_caja_original, id_caja_actual,
          id_sesion_caja_actual, tipo_reversion, motivo, observacion,
          monto_reversado, estado, creada_por, creada_en,
          fecha_operacion, ip_origen, dispositivo, user_agent, correo_notificado
        ) VALUES (
          $1, $2, $3, $4, $5, $4, $5, 'PARCIAL', 'OTRO', $1,
          1, 'APLICADA', $6, NOW(),
          (NOW() AT TIME ZONE 'America/Tegucigalpa')::date,
          '127.0.0.1', 'QA_SMOKE', 'qa-caja-negative-close-smoke', false
        )
        RETURNING id_reversion
      `, [`${fixtureReference}R`, idFactura, references.id_sucursal, references.id_caja, idSesionCaja, qaTestUserId]);
      const idReversion = reversal.rows[0].id_reversion;
      try {
        const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'nueva reversion', 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        operationalChangeRejections.nuevaReversion = rejected.status;
      } finally {
        await pool.query('DELETE FROM public.facturas_reversiones WHERE id_reversion = $1', [idReversion]);
      }
    }
    const validacionSobrante = await createCloseValidation();
    const idValidacionSobrante = validacionSobrante.body.id_validacion_cierre;
    const cerrar = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
      auth,
      body: { observacion_cierre: observacionCierre, id_validacion_cierre: idValidacionCierre }
    });
    assert.equal(cerrar.status, 200, `cerrar HTTP ${cerrar.status}: ${JSON.stringify(cerrar.body)}`);
    idCierreCaja = cerrar.body.id_cierre_caja;
    assert.ok(idCierreCaja);
    assert.equal(cerrar.body.estado_revision, 'PENDIENTE_REVISION');
    assert.equal(cerrar.body.arqueos_metodos.length, 4);
    const cierreOtros = cerrar.body.arqueos_metodos.find((row) => row.metodo_pago_codigo === 'OTRO');
    assert.ok(cierreOtros);
    assert.equal(cierreOtros.monto_declarado, 400);
    assert.equal(cerrar.body.correo_cierre.estado, 'PENDIENTE');

    // Una validacion sobrante no debe producir un segundo cierre.
    const cerrarReintento = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
      auth,
      body: { observacion_cierre: observacionCierre, id_validacion_cierre: idValidacionSobrante }
    });
    assert.equal(cerrarReintento.status, 409);

    const persisted = await pool.query(`
      SELECT
        cs.id_estado_sesion_caja, estado.codigo AS estado_codigo,
        cs.monto_teorico_cierre, cs.monto_declarado_cierre, cs.diferencia_cierre,
        cc.id_cierre_caja,
        cv.id_cierre_caja AS validacion_vinculada,
        COUNT(cam.id_arqueo_metodo)::int AS arqueos,
        COUNT(cam.id_arqueo_metodo) FILTER (WHERE cam.metodo_pago_codigo = 'OTRO')::int AS arqueos_otros,
        COUNT(cam.id_arqueo_metodo) FILTER (WHERE cam.metodo_pago_codigo = 'OTRO' AND cam.completado_automaticamente IS TRUE)::int AS otros_automaticos,
        COUNT(cam.id_arqueo_metodo) FILTER (WHERE cam.metodo_pago_codigo IN ('EFECTIVO','TARJETA','TRANSFERENCIA') AND cam.completado_automaticamente IS FALSE)::int AS core_no_automaticos,
        SUM(cam.monto_declarado)::numeric AS suma_declarado,
        SUM(cam.monto_teorico)::numeric AS suma_teorico,
        SUM(cam.diferencia)::numeric AS suma_diferencia,
        COUNT(DISTINCT outbox.id_notificacion)::int AS outbox
      FROM public.cajas_sesiones cs
      INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      INNER JOIN public.cajas_cierres cc ON cc.id_sesion_caja = cs.id_sesion_caja
      LEFT JOIN public.cajas_cierres_validaciones cv ON cv.id_validacion_cierre = $2
      LEFT JOIN public.cajas_cierres_arqueos_metodos cam ON cam.id_cierre_caja = cc.id_cierre_caja
      LEFT JOIN public.cajas_cierres_notificaciones_email outbox ON outbox.id_cierre_caja = cc.id_cierre_caja
      WHERE cs.id_sesion_caja = $1
      GROUP BY cs.id_estado_sesion_caja, estado.codigo, cs.monto_teorico_cierre,
               cs.monto_declarado_cierre, cs.diferencia_cierre,
               cc.id_cierre_caja, cv.id_cierre_caja
    `, [idSesionCaja, idValidacionCierre]);
    const state = persisted.rows[0];
    assert.equal(String(state.estado_codigo).trim().toUpperCase(), 'CERRADA');
    assert.equal(Number(state.monto_teorico_cierre), expectedTotalTeorico);
    assert.equal(String(state.id_cierre_caja), String(idCierreCaja));
    assert.equal(String(state.validacion_vinculada), String(idCierreCaja));
    assert.equal(state.arqueos, 4);
    assert.equal(state.arqueos_otros, 1);
    assert.equal(state.otros_automaticos, 1);
    assert.equal(state.core_no_automaticos, 3);
    assert.equal(Number(state.suma_declarado), expectedTotalDeclarado);
    assert.equal(Number(state.suma_teorico), expectedTotalTeorico);
    assert.equal(Number(state.suma_diferencia), Number(state.diferencia_cierre));
    assert.equal(Number(state.suma_declarado), Number(state.monto_declarado_cierre));
    assert.equal(state.outbox, 1);

    const persistedMethods = await pool.query(`
      SELECT metodo_pago_codigo, id_metodo_pago, completado_automaticamente,
             requiere_revision, monto_teorico, monto_declarado, diferencia,
             observacion
      FROM public.cajas_cierres_arqueos_metodos
      WHERE id_cierre_caja = $1
      ORDER BY id_arqueo_metodo
    `, [idCierreCaja]);
    assert.deepEqual(
      persistedMethods.rows.map((row) => [row.metodo_pago_codigo, row.completado_automaticamente]),
      [
        ['EFECTIVO', false],
        ['TARJETA', false],
        ['TRANSFERENCIA', false],
        ['OTRO', true]
      ]
    );
    const persistedOtro = persistedMethods.rows.find((row) => row.metodo_pago_codigo === 'OTRO');
    const canonicalOtro = await pool.query("SELECT id_metodo_pago FROM public.cat_metodos_pago WHERE UPPER(TRIM(codigo)) = 'OTRO'");
    assert.equal(canonicalOtro.rowCount, 1);
    assert.equal(Number(persistedOtro.id_metodo_pago), Number(canonicalOtro.rows[0].id_metodo_pago));
    assert.equal(persistedOtro.requiere_revision, false);
    assert.equal(Number(persistedOtro.diferencia), 0);

    const emailPayload = await loadCajaCloseEmailPayload(pool, idCierreCaja);
    const html = buildCajaCloseEmailHtml({ payload: emailPayload, pdfAttached: true });
    const pdf = await buildCajaCierrePdfBuffer(emailPayload);
    assert.match(html, /Otros no efectivo/);
    assert.doesNotMatch(html, /OTROS_NO_EFECTIVO/);
    assert.doesNotMatch(html, /Extra Ranch/); // sanity: no leftover fixture data bleeding in
    assert.ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === '%PDF');
    const detalleSumaDeclarado = emailPayload.arqueos.reduce((sum, row) => sum + Number(row.monto_declarado || 0), 0);
    assert.equal(detalleSumaDeclarado, expectedTotalDeclarado);

    result = {
      httpStatus: { preview: preview.status, validaciones: validaciones.status, cerrar: cerrar.status },
      idSesionCaja: String(idSesionCaja),
      idCierreCaja: String(idCierreCaja),
      syntheticInvoice: { idFactura: String(idFactura), idDetalleFactura: String(idDetalleFactura), fixtureReference },
      efectivoTeoricoEsperado: expectedEfectivoTeorico,
      totalTeorico: Number(state.monto_teorico_cierre),
      totalDeclarado: Number(state.suma_declarado),
      diferencia: Number(state.suma_diferencia),
      arqueos: state.arqueos,
      arqueosOtrosNoEfectivo: state.arqueos_otros,
      otroAutomaticoPersistido: state.otros_automaticos === 1 && state.core_no_automaticos === 3,
      persistedMethods: persistedMethods.rows,
      manualPayloadRejections,
      duplicateRejections,
      malformedValidationRejections,
      arithmeticTamperRejections,
      coherentTamperRejections,
      invalidOriginalPayloadRejections,
      operationalChangeRejections,
      sharedQaCatalogMutations: false,
      reintentoCierreRechazado: cerrarReintento.status === 409,
      pdfBytes: pdf.length
    };
  } finally {
    if (server) await stopServer(server);
    if (auth?.idSesion) await closeQaAuthContext(auth.idSesion).catch(() => {});
    await cleanupHttpCloseArtifacts({ idSesionCaja, idFactura, fixtureReference });
  }
  const residues = await assertZeroHttpCloseArtifacts({ idSesionCaja, fixtureReference, authSessionId: auth?.idSesion || null });
  const metricsAfter = await captureRegressionMetrics(pool);
  assert.deepEqual(metricsAfter, metricsBefore, 'Los conteos/sumas globales deben volver exactamente al baseline tras limpiar el fixture HTTP.');
  return { ...result, cleanup: residues, metricsBefore, metricsAfter };
};

const main = async () => {
  installQaSharedPaymentCatalogWriteGuard();
  assertQaTarget();
  const verifySql = await readFile(VERIFY_PATH, 'utf8');
  try {
    // PostgreSQL aislado se ejecuta por separado. Este proceso solo opera el
    // fixture sintetico de QA y exige que el esquema compartido ya este SAFE.
    const qaNamedConstraints = await namedConstraintState(pool);
    assert.deepEqual(
      qaNamedConstraints,
      [],
      'QA debe estar previamente en SAFE; este arnes no altera restricciones del proyecto compartido.'
    );
    const before = await runVerify(pool, verifySql);
    assert.ok(before.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));
    const httpSmoke = await runHttpCloseSmoke();
    const after = await runVerify(pool, verifySql);
    assert.ok(after.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));
    assert.deepEqual(after.regressionCounts, before.regressionCounts);

    console.log(JSON.stringify({
      projectRef: QA_PROJECT_REF,
      qaSchemaMutation: false,
      sharedQaCatalogMutations: false,
      verifyBefore: before,
      verifyAfter: after,
      httpSmoke
    }, null, 2));
  } finally {
    await closePool();
  }
};

const isDirectExecution = process.argv[1]
  && new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href === import.meta.url;

if (isDirectExecution) await main();
