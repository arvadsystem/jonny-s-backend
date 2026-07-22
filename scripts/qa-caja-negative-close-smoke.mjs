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
import { runIsolatedPostgresMigrationSuite } from './qa-caja-negative-close-postgres-isolated.mjs';

const QA_PROJECT_REF = 'cluideiojeikzcmmizhe';
const VERIFY_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql', import.meta.url);

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

const LEAVE_SAFE_APPLIED = process.argv.includes('--leave-safe-applied');
const INJECT_FAILURE_AFTER_SAFE = process.argv.includes('--inject-failure-after-safe');

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

const runTransactionalFinancialSmoke = async () => {
  const client = await pool.connect();
  const baseId = 8_000_000_000_000 + (Date.now() % 100_000_000);
  const salesSessionId = baseId;
  const negativeSessionId = baseId + 1;
  const closeId = baseId + 2;
  const validationId = baseId + 3;
  const outboxId = baseId + 4;
  const arqueoId = baseId + 5;
  let rolledBack = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '120s'");
    const references = await loadSmokeReferences(client);

    await insertSession(client, {
      idSesionCaja: salesSessionId,
      references,
      estado: references.estado_abierta,
      montoApertura: 0,
      closed: false
    });
    const salesFixtureReference = `QAC${baseId}`;
    const salesInvoice = await insertSyntheticInvoice(client, {
      idSesionCaja: salesSessionId,
      references,
      fixtureReference: salesFixtureReference
    });
    for (const [index, [methodCode, amount]] of [
      ['EFECTIVO', 100],
      ['TARJETA', 200],
      ['TRANSFERENCIA', 300],
      ['OTRO', 400]
    ].entries()) {
      await insertPayment(client, {
        idFacturaCobro: baseId + 100 + index,
        idFactura: salesInvoice.idFactura,
        idSesionCaja: salesSessionId,
        references,
        methodCode,
        amount,
        fixtureReference: salesFixtureReference
      });
    }

    const salesSnapshot = await loadCajaCloseFinancialSnapshot({
      queryRunner: client,
      idSesionCaja: salesSessionId
    });
    assert.equal(salesSnapshot.ventasEfectivoNetas, 100);
    assert.equal(salesSnapshot.ventasNoEfectivoNetas, 900);
    assert.equal(salesSnapshot.totalTeorico, 1000);
    assert.equal(salesSnapshot.fingerprint.ventas_no_efectivo_netas, 900);
    const salesComputation = buildSegmentedArqueoComputation({
      snapshot: salesSnapshot,
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    // Caso obligatorio: OTRO (400) debe aparecer como fila unica agrupada
    // OTRO (codigo tecnico persistido; "Otros no efectivo" es solo la
    // etiqueta de presentacion), no perderse dentro del total declarado.
    assert.equal(salesComputation.rows.length, 4);
    const otrosRow = salesComputation.rows.find((row) => row.metodo_pago_codigo === 'OTRO');
    assert.ok(otrosRow, 'debe existir la fila OTRO');
    assert.equal(otrosRow.display_name, 'Otros no efectivo');
    assert.equal(otrosRow.monto_teorico, 400);
    assert.equal(otrosRow.monto_declarado, 400);
    assert.equal(otrosRow.diferencia, 0);
    assert.equal(otrosRow.completado_automaticamente, true);
    assert.equal(otrosRow.requiere_revision, false);
    // Ancla FK real (fk_ccam_metodo es NOT NULL): un metodo real del catalogo,
    // no un sentinel ni null.
    assert.ok(Number.isInteger(otrosRow.id_metodo_pago) && otrosRow.id_metodo_pago > 0);
    assert.equal(salesComputation.monto_teorico_total, 1000);
    assert.equal(salesComputation.monto_declarado_total, 1000);
    assert.equal(salesComputation.diferencia_total, 0);
    const sumDeclarado = salesComputation.rows.reduce((sum, row) => sum + row.monto_declarado, 0);
    const sumTeorico = salesComputation.rows.reduce((sum, row) => sum + row.monto_teorico, 0);
    assert.equal(sumDeclarado, salesComputation.monto_declarado_total);
    assert.equal(sumTeorico, salesComputation.monto_teorico_total);
    assert.equal(
      salesComputation.rows.filter((row) => row.metodo_pago_codigo === 'TARJETA').length,
      1,
      'TARJETA no debe duplicarse'
    );
    assert.equal(
      salesComputation.rows.filter((row) => row.metodo_pago_codigo === 'TRANSFERENCIA').length,
      1,
      'TRANSFERENCIA no debe duplicarse'
    );

    // Caso limite: metodo no efectivo neto negativo (p. ej. reversion de otra
    // sesion). monto_declarado nunca debe quedar negativo (CHECK >=0 fuera de
    // alcance) y el cierre no debe bloquearse ni lanzar.
    const negativeOtrosComputation = buildSegmentedArqueoComputation({
      snapshot: {
        ...salesSnapshot,
        otrosNoEfectivo: {
          ...salesSnapshot.otrosNoEfectivo,
          ventas_brutas: 400,
          reversiones: 500,
          ventas_netas: -100
        }
      },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: true
    });
    const negativeOtrosRow = negativeOtrosComputation.rows.find((row) => row.metodo_pago_codigo === 'OTRO');
    assert.equal(negativeOtrosRow.monto_teorico, -100);
    assert.equal(negativeOtrosRow.monto_declarado, 0);
    assert.ok(negativeOtrosRow.monto_declarado >= 0);
    // 5.4: residual negativo SI exige revision (a diferencia del diseno
    // anterior); el cierre no se bloquea, pero queda PENDIENTE_REVISION.
    assert.equal(negativeOtrosRow.requiere_revision, true);
    assert.equal(negativeOtrosRow.diferencia, 100);
    assert.match(negativeOtrosRow.observacion, /Conciliaci.n autom.tica/);
    assert.equal(negativeOtrosRow.completado_automaticamente, true);

    await client.query('SAVEPOINT metodo_inactivo');
    await client.query("UPDATE public.cat_metodos_pago SET estado = false WHERE UPPER(TRIM(codigo)) = 'OTRO'");
    await assert.rejects(
      loadCajaCloseFinancialSnapshot({ queryRunner: client, idSesionCaja: salesSessionId }),
      (error) => error.code === 'VENTAS_CAJAS_METODO_PAGO_NO_CONTABILIZABLE'
    );
    await client.query('ROLLBACK TO SAVEPOINT metodo_inactivo');

    await client.query(`
      UPDATE public.cajas_sesiones
      SET id_estado_sesion_caja = $1,
          id_usuario_cierre = $2,
          fecha_cierre = NOW()
      WHERE id_sesion_caja = $3
    `, [references.estado_cerrada, references.id_usuario, salesSessionId]);

    await insertSession(client, {
      idSesionCaja: negativeSessionId,
      references,
      estado: references.estado_abierta,
      montoApertura: 3000
    });
    await client.query(`
      INSERT INTO public.cajas_movimientos (
        id_movimiento_caja, id_sesion_caja, id_caja, id_sucursal,
        id_tipo_movimiento_caja, id_usuario_ejecutor, monto,
        referencia, observacion, fecha_movimiento, fecha_creacion
      ) OVERRIDING SYSTEM VALUE
      VALUES
        ($1, $2, $3, $4, $5, $6, 3000, 'QA_SMOKE_APERTURA', 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW()),
        ($7, $2, $3, $4, $8, $6, 16763, 'QA_SMOKE_EGRESO', 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW())
    `, [
      baseId + 200,
      negativeSessionId,
      references.id_caja,
      references.id_sucursal,
      references.tipo_apertura,
      references.id_usuario,
      baseId + 201,
      references.tipo_egreso
    ]);

    const negativeSnapshot = await loadCajaCloseFinancialSnapshot({
      queryRunner: client,
      idSesionCaja: negativeSessionId
    });
    assert.equal(negativeSnapshot.montoApertura, 3000);
    assert.equal(negativeSnapshot.egresosManuales, 16763);
    assert.equal(negativeSnapshot.efectivoTeorico, -13763);
    assert.equal(negativeSnapshot.totalTeorico, -13763);

    // Problema 1 a nivel de tabla cajas_arqueos: el endpoint de arqueo puntual
    // inserta resumen.efectivoTeorico directamente en monto_teorico. Prueba
    // que, con SAFE aplicado, ya no bloquea valores negativos.
    const arqueoMontoContado = 0;
    const arqueoDiferencia = Number((arqueoMontoContado - negativeSnapshot.efectivoTeorico).toFixed(2));
    await client.query(`
      INSERT INTO public.cajas_arqueos (
        id_arqueo_caja, id_sesion_caja, id_caja, id_sucursal, id_tipo_arqueo_caja,
        id_usuario_ejecutor, monto_teorico, monto_contado, diferencia, observacion,
        fecha_arqueo, fecha_creacion
      ) OVERRIDING SYSTEM VALUE
      VALUES ($1, $2, $3, $4,
        (SELECT id_tipo_arqueo_caja FROM public.cat_cajas_arqueos_tipos WHERE UPPER(TRIM(codigo)) = 'CIERRE' LIMIT 1),
        $5, $6, $7, $8, 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW())
    `, [
      arqueoId,
      negativeSessionId,
      references.id_caja,
      references.id_sucursal,
      references.id_usuario,
      negativeSnapshot.efectivoTeorico,
      arqueoMontoContado,
      arqueoDiferencia
    ]);
    const persistedArqueo = await client.query(
      'SELECT monto_teorico, diferencia FROM public.cajas_arqueos WHERE id_arqueo_caja = $1',
      [arqueoId]
    );
    assert.equal(Number(persistedArqueo.rows[0].monto_teorico), -13763);
    assert.equal(Number(persistedArqueo.rows[0].diferencia), 13763);

    const computation = buildSegmentedArqueoComputation({
      snapshot: negativeSnapshot,
      payloadRows: [{
        metodo_pago_codigo: 'EFECTIVO',
        monto_declarado: 0,
        observacion: 'QA smoke monto teorico negativo'
      }],
      threshold: 0,
      requireObservacionOnDifference: false
    });
    assert.equal(computation.monto_teorico_total, -13763);
    assert.equal(computation.monto_declarado_total, 0);
    assert.equal(computation.diferencia_total, 13763);
    assert.equal(computation.rows.length, 3);

    await client.query(`
      INSERT INTO public.cajas_cierres_validaciones (
        id_validacion_cierre, id_sesion_caja, id_caja, id_sucursal,
        id_usuario_valida, numero_intento, origen, total_teorico,
        total_declarado, diferencia_total, hay_diferencia,
        payload_declarado_json, resultado_json, observacion_general,
        fecha_validacion, fecha_creacion
      ) VALUES (
        $1, $2, $3, $4, $5, 1, 'QA_SMOKE', $6, $7, $8, true,
        $9::jsonb, $10::jsonb, 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW()
      )
    `, [
      validationId,
      negativeSessionId,
      references.id_caja,
      references.id_sucursal,
      references.id_usuario,
      computation.monto_teorico_total,
      computation.monto_declarado_total,
      computation.diferencia_total,
      JSON.stringify({ arqueos: computation.rows }),
      JSON.stringify({ huella_operacional: negativeSnapshot.fingerprint })
    ]);

    for (const [index, row] of computation.rows.entries()) {
      await client.query(`
        INSERT INTO public.cajas_cierres_validaciones_metodos (
          id_validacion_metodo, id_validacion_cierre, id_metodo_pago,
          metodo_pago_codigo, monto_teorico, monto_declarado, diferencia,
          cantidad_referencias, resultado, requiere_revision, observacion,
          fecha_creacion
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      `, [
        baseId + 300 + index,
        validationId,
        row.id_metodo_pago,
        row.metodo_pago_codigo,
        row.monto_teorico,
        row.monto_declarado,
        row.diferencia,
        row.cantidad_referencias,
        row.resultado,
        row.requiere_revision,
        row.observacion
      ]);
    }

    await client.query(`
      INSERT INTO public.cajas_cierres (
        id_cierre_caja, id_sesion_caja, id_caja, id_sucursal,
        id_usuario_responsable, id_usuario_cierre,
        id_resolucion_cierre_caja, fecha_cierre, monto_apertura,
        monto_ventas_efectivo, monto_ventas_no_efectivo,
        monto_ingresos_manuales, monto_egresos_manuales,
        monto_teorico_cierre, monto_declarado_cierre, diferencia,
        observacion, fecha_creacion
      ) OVERRIDING SYSTEM VALUE
      VALUES (
        $1, $2, $3, $4, $5, $5, $6, NOW(), 3000,
        0, 0, 0, 16763, -13763, 0, 13763,
        'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW()
      )
    `, [
      closeId,
      negativeSessionId,
      references.id_caja,
      references.id_sucursal,
      references.id_usuario,
      references.resolucion_pendiente
    ]);
    await client.query(`
      UPDATE public.cajas_cierres_validaciones
      SET id_cierre_caja = $1
      WHERE id_validacion_cierre = $2
    `, [closeId, validationId]);

    for (const [index, row] of computation.rows.entries()) {
      await client.query(`
        INSERT INTO public.cajas_cierres_arqueos_metodos (
          id_arqueo_metodo, id_cierre_caja, id_sesion_caja, id_caja,
          id_sucursal, id_metodo_pago, metodo_pago_codigo, monto_teorico,
          monto_declarado, diferencia, cantidad_referencias, observacion,
          requiere_revision, completado_automaticamente, fecha_registro,
          id_usuario_registro
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14, NOW(), $15
        )
      `, [
        baseId + 400 + index,
        closeId,
        negativeSessionId,
        references.id_caja,
        references.id_sucursal,
        Number(row.id_metodo_pago) || 0,
        row.metodo_pago_codigo,
        row.monto_teorico,
        row.monto_declarado,
        row.diferencia,
        row.cantidad_referencias,
        row.observacion,
        row.requiere_revision,
        row.completado_automaticamente,
        references.id_usuario
      ]);
    }

    await client.query(`
      UPDATE public.cajas_sesiones
      SET id_estado_sesion_caja = $1,
          id_usuario_cierre = $2,
          fecha_cierre = NOW(),
          monto_teorico_cierre = -13763,
          monto_declarado_cierre = 0,
          diferencia_cierre = 13763,
          id_resolucion_cierre_caja = $3,
          observacion_cierre = 'QA_SMOKE_CAJA_NEGATIVE_CLOSE'
      WHERE id_sesion_caja = $4
    `, [
      references.estado_cerrada,
      references.id_usuario,
      references.resolucion_pendiente,
      negativeSessionId
    ]);
    await client.query(`
      INSERT INTO public.cajas_cierres_notificaciones_email (
        id_notificacion, id_cierre_caja, estado, intentos,
        email_destino, fecha_creacion, fecha_actualizacion
      ) VALUES ($1, $2, 'PENDIENTE', 0, 'qa-smoke@example.invalid', NOW(), NOW())
    `, [outboxId, closeId]);

    const persisted = await client.query(`
      SELECT
        cs.monto_teorico_cierre,
        cs.diferencia_cierre,
        estado.codigo AS estado_sesion,
        resolucion.codigo AS resolucion,
        cc.id_cierre_caja,
        cv.id_cierre_caja AS validacion_vinculada,
        COUNT(DISTINCT cam.id_arqueo_metodo)::int AS arqueos,
        COUNT(DISTINCT outbox.id_notificacion)::int AS notificaciones
      FROM public.cajas_sesiones cs
      INNER JOIN public.cat_cajas_sesiones_estados estado
        ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      INNER JOIN public.cat_cajas_resoluciones_cierre resolucion
        ON resolucion.id_resolucion_cierre_caja = cs.id_resolucion_cierre_caja
      INNER JOIN public.cajas_cierres cc
        ON cc.id_sesion_caja = cs.id_sesion_caja
      INNER JOIN public.cajas_cierres_validaciones cv
        ON cv.id_validacion_cierre = $2
      LEFT JOIN public.cajas_cierres_arqueos_metodos cam
        ON cam.id_cierre_caja = cc.id_cierre_caja
      LEFT JOIN public.cajas_cierres_notificaciones_email outbox
        ON outbox.id_cierre_caja = cc.id_cierre_caja
      WHERE cs.id_sesion_caja = $1
      GROUP BY cs.monto_teorico_cierre, cs.diferencia_cierre,
               estado.codigo, resolucion.codigo, cc.id_cierre_caja,
               cv.id_cierre_caja
    `, [negativeSessionId, validationId]);
    const state = persisted.rows[0];
    assert.equal(Number(state.monto_teorico_cierre), -13763);
    assert.equal(Number(state.diferencia_cierre), 13763);
    assert.equal(String(state.estado_sesion).trim().toUpperCase(), 'CERRADA');
    assert.equal(String(state.resolucion).trim().toUpperCase(), 'PENDIENTE_REVISION');
    assert.equal(String(state.id_cierre_caja), String(closeId));
    assert.equal(String(state.validacion_vinculada), String(closeId));
    assert.equal(state.arqueos, 3);
    assert.equal(state.notificaciones, 1);

    const emailPayload = await loadCajaCloseEmailPayload(client, closeId);
    const html = buildCajaCloseEmailHtml({ payload: emailPayload, pdfAttached: true });
    const pdf = await buildCajaCierrePdfBuffer(emailPayload);
    assert.match(html, /Total ventas/);
    // Esta sesion no tiene actividad OTRO; el documento nunca debe filtrar
    // codigos tecnicos de metodos.
    assert.doesNotMatch(html, /OTROS_NO_EFECTIVO/);
    assert.doesNotMatch(html, />OTRO</);
    assert.ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === '%PDF');

    await client.query('ROLLBACK');
    rolledBack = true;

    const cleanup = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM public.cajas_sesiones WHERE id_sesion_caja IN ($1, $2)) AS sesiones,
        EXISTS (SELECT 1 FROM public.cajas_cierres WHERE id_cierre_caja = $3) AS cierres,
        EXISTS (SELECT 1 FROM public.cajas_cierres_validaciones WHERE id_validacion_cierre = $4) AS validaciones,
        EXISTS (SELECT 1 FROM public.cajas_arqueos WHERE id_arqueo_caja = $5) AS arqueos,
        EXISTS (SELECT 1 FROM public.cajas_cierres_notificaciones_email WHERE id_notificacion = $6) AS outbox
    `, [salesSessionId, negativeSessionId, closeId, validationId, arqueoId, outboxId]);
    assert.deepEqual(cleanup.rows[0], {
      sesiones: false,
      cierres: false,
      validaciones: false,
      arqueos: false,
      outbox: false
    });

    return {
      sales: {
        efectivo: salesSnapshot.ventasEfectivoNetas,
        noEfectivo: salesSnapshot.ventasNoEfectivoNetas,
        total: salesSnapshot.totalTeorico,
        otrosNoEfectivo: otrosRow.monto_teorico
      },
      negativeClose: {
        efectivoTeorico: -13763,
        diferencia: 13763,
        estado: 'CERRADA',
        resolucion: 'PENDIENTE_REVISION',
        arqueos: state.arqueos,
        outbox: state.notificaciones,
        pdfBytes: pdf.length,
        htmlTotalVentas: true,
        htmlSinCodigosTecnicos: true,
        arqueoCajaMontoTeorico: Number(persistedArqueo.rows[0].monto_teorico)
      },
      cleanup: cleanup.rows[0]
    };
  } finally {
    if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
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
       WHERE UPPER(TRIM(estado.codigo)) = 'ABIERTA')::text AS sesiones_abiertas
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
          (SELECT COUNT(*)::int FROM public.cajas_cierres_notificaciones_email outbox
           INNER JOIN public.cajas_cierres cierre ON cierre.id_cierre_caja = outbox.id_cierre_caja
           WHERE cierre.id_sesion_caja = $1) AS outbox
      `, [idSesionCaja]);
      assert.deepEqual(partialWrites.rows[0], { cierres: 0, outbox: 0 }, `${label} dejo escritura parcial`);
      return response;
    };

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

    // Catalogo desactivado despues de validar. TARJETA y TRANSFERENCIA se
    // prueban expresamente con teorico cero para que la invalidacion no pueda
    // depender de una diferencia monetaria.
    const zeroPaymentRows = await pool.query(`
      SELECT fc.id_factura_cobro, fc.monto, UPPER(TRIM(mp.codigo)) AS codigo
      FROM public.facturas_cobros fc
      INNER JOIN public.cat_metodos_pago mp ON mp.id_metodo_pago = fc.id_metodo_pago
      WHERE fc.id_sesion_caja = $1
        AND UPPER(TRIM(mp.codigo)) IN ('TARJETA', 'TRANSFERENCIA')
      ORDER BY fc.id_factura_cobro
    `, [idSesionCaja]);
    assert.equal(zeroPaymentRows.rowCount, 2);
    const inactiveCatalogRejections = [];
    try {
      await pool.query(`
        DELETE FROM public.facturas_cobros
        WHERE id_factura_cobro = ANY($1::bigint[])
      `, [zeroPaymentRows.rows.map((row) => String(row.id_factura_cobro))]);
      const zeroPayload = [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0, observacion: 'QA smoke HTTP: caja vacia tras egreso' },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 0 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 0 }
      ];
      for (const methodCode of ['EFECTIVO', 'TARJETA', 'TRANSFERENCIA', 'OTRO']) {
        const validation = await createCloseValidation(zeroPayload);
        const catalogRow = await pool.query(`
          SELECT id_metodo_pago, estado
          FROM public.cat_metodos_pago
          WHERE UPPER(TRIM(codigo)) = $1
          ORDER BY id_metodo_pago
        `, [methodCode]);
        assert.equal(catalogRow.rowCount, 1, `${methodCode} debe ser unico`);
        await pool.query('UPDATE public.cat_metodos_pago SET estado = false WHERE id_metodo_pago = $1', [catalogRow.rows[0].id_metodo_pago]);
        try {
          const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, `${methodCode} inactivo`);
          inactiveCatalogRejections.push({ metodo: methodCode, teoricoCero: ['TARJETA', 'TRANSFERENCIA'].includes(methodCode), code: rejected.body?.code || null });
        } finally {
          await pool.query('UPDATE public.cat_metodos_pago SET estado = $1 WHERE id_metodo_pago = $2', [catalogRow.rows[0].estado, catalogRow.rows[0].id_metodo_pago]);
        }
      }
    } finally {
      for (const row of zeroPaymentRows.rows) {
        await insertPayment(pool, {
          idFacturaCobro: row.id_factura_cobro,
          idFactura,
          idSesionCaja,
          references: { ...references, id_usuario: qaTestUserId },
          methodCode: row.codigo,
          amount: row.monto,
          fixtureReference
        });
      }
    }

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
      `, [`R${baseId}`, idFactura, references.id_sucursal, references.id_caja, idSesionCaja, qaTestUserId]);
      const idReversion = reversal.rows[0].id_reversion;
      try {
        const rejected = await expectControlledCloseRejection(validation.body.id_validacion_cierre, 'nueva reversion', 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
        operationalChangeRejections.nuevaReversion = rejected.status;
      } finally {
        await pool.query('DELETE FROM public.facturas_reversiones WHERE id_reversion = $1', [idReversion]);
      }
    }

    const catalogIdValidation = await createCloseValidation();
    const catalogIdRows = await pool.query(`
      SELECT id_metodo_pago, codigo
      FROM public.cat_metodos_pago
      WHERE UPPER(TRIM(codigo)) IN ('TARJETA', 'OTRO')
      ORDER BY id_metodo_pago
    `);
    assert.equal(catalogIdRows.rowCount, 2);
    const tarjetaCatalog = catalogIdRows.rows.find((row) => String(row.codigo).trim().toUpperCase() === 'TARJETA');
    const otroCatalog = catalogIdRows.rows.find((row) => String(row.codigo).trim().toUpperCase() === 'OTRO');
    const swapCode = `QA_SWAP_${baseId}`;
    let catalogIdChangeRejected = false;
    try {
      await pool.query('UPDATE public.cat_metodos_pago SET codigo = $1 WHERE id_metodo_pago = $2', [swapCode, tarjetaCatalog.id_metodo_pago]);
      await pool.query("UPDATE public.cat_metodos_pago SET codigo = 'TARJETA' WHERE id_metodo_pago = $1", [otroCatalog.id_metodo_pago]);
      await pool.query("UPDATE public.cat_metodos_pago SET codigo = 'OTRO' WHERE id_metodo_pago = $1", [tarjetaCatalog.id_metodo_pago]);
      const rejected = await expectControlledCloseRejection(
        catalogIdValidation.body.id_validacion_cierre,
        'cambio de id asociado al codigo',
        'VENTAS_CAJAS_CLOSE_VALIDATION_STALE'
      );
      catalogIdChangeRejected = rejected.status === 409;
    } finally {
      await pool.query('UPDATE public.cat_metodos_pago SET codigo = $1 WHERE id_metodo_pago = $2', [`${swapCode}_T`, tarjetaCatalog.id_metodo_pago]);
      await pool.query('UPDATE public.cat_metodos_pago SET codigo = $1 WHERE id_metodo_pago = $2', [`${swapCode}_O`, otroCatalog.id_metodo_pago]);
      await pool.query("UPDATE public.cat_metodos_pago SET codigo = 'TARJETA' WHERE id_metodo_pago = $1", [tarjetaCatalog.id_metodo_pago]);
      await pool.query("UPDATE public.cat_metodos_pago SET codigo = 'OTRO' WHERE id_metodo_pago = $1", [otroCatalog.id_metodo_pago]);
    }

    const catalogValidation = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-validaciones`, {
      auth,
      body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
    });
    assert.equal(catalogValidation.status, 201);
    const catalogOriginalResult = await pool.query(`
      SELECT id_metodo_pago, estado, afecta_efectivo
      FROM public.cat_metodos_pago
      WHERE UPPER(TRIM(codigo)) = 'OTRO'
      ORDER BY id_metodo_pago
    `);
    assert.equal(catalogOriginalResult.rowCount, 1, 'OTRO debe ser unico antes de probar cambio de catalogo.');
    const catalogOriginal = catalogOriginalResult.rows[0];
    await pool.query(
      'UPDATE public.cat_metodos_pago SET afecta_efectivo = NOT $1::boolean WHERE id_metodo_pago = $2',
      [catalogOriginal.afecta_efectivo, catalogOriginal.id_metodo_pago]
    );
    let catalogChangeRejected = false;
    try {
      const rejected = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
        auth,
        body: { observacion_cierre: observacionCierre, id_validacion_cierre: catalogValidation.body.id_validacion_cierre }
      });
      assert.equal(rejected.status, 409, `cambio catalogo: ${JSON.stringify(rejected.body)}`);
      assert.equal(rejected.body?.code, 'VENTAS_CAJAS_CLOSE_VALIDATION_STALE');
      catalogChangeRejected = true;
    } finally {
      await pool.query(`
        UPDATE public.cat_metodos_pago
        SET estado = $1, afecta_efectivo = $2
        WHERE id_metodo_pago = $3
      `, [catalogOriginal.estado, catalogOriginal.afecta_efectivo, catalogOriginal.id_metodo_pago]);
    }

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
    const idValidacionSobrante = catalogValidation.body.id_validacion_cierre;
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
      inactiveCatalogRejections,
      duplicateRejections,
      malformedValidationRejections,
      operationalChangeRejections,
      catalogIdChangeRejected,
      catalogChangeRejected,
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
  assertQaTarget();
  const verifySql = await readFile(VERIFY_PATH, 'utf8');
  try {
    // Toda mutacion DDL vive en PostgreSQL aislado. QA solo recibe el fixture
    // DML sintetico de los endpoints y debe encontrarse previamente en SAFE.
    const isolatedPostgres = await runIsolatedPostgresMigrationSuite({
      injectFailureAfterSafe: INJECT_FAILURE_AFTER_SAFE,
      leaveSafeApplied: LEAVE_SAFE_APPLIED
    });
    const qaNamedConstraints = await namedConstraintState(pool);
    assert.deepEqual(
      qaNamedConstraints,
      [],
      'QA debe estar previamente en SAFE; este arnes no altera restricciones del proyecto compartido.'
    );
    const before = await runVerify(pool, verifySql);
    assert.ok(before.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));
    const smoke = await runTransactionalFinancialSmoke();
    const httpSmoke = await runHttpCloseSmoke();
    const after = await runVerify(pool, verifySql);
    assert.ok(after.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));
    assert.deepEqual(after.regressionCounts, before.regressionCounts);

    console.log(JSON.stringify({
      projectRef: QA_PROJECT_REF,
      qaSchemaMutation: false,
      isolatedPostgres,
      verifyBefore: before,
      verifyAfter: after,
      smoke,
      httpSmoke
    }, null, 2));
  } finally {
    await closePool();
  }
};

await main();
