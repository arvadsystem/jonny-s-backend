import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import pool, { closePool } from '../config/db-connection.js';
import {
  buildCajaCloseEmailHtml,
  loadCajaCloseEmailPayload
} from '../services/cajaCloseEmailOutboxService.js';
import { buildSegmentedArqueoComputation } from '../services/cajaCloseComputationService.js';
import { loadCajaCloseFinancialSnapshot } from '../services/cajaCloseFinancialSnapshotService.js';
import { buildCajaCierrePdfBuffer } from '../utils/cajaCierreReportePdf.js';

const QA_PROJECT_REF = 'cluideiojeikzcmmizhe';
const SAFE_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql', import.meta.url);
const VERIFY_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql', import.meta.url);
const ROLLBACK_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql', import.meta.url);

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
      ('public.cajas_cierres'::regclass, 'ck_cajas_cierres_monto_teorico')
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
  const financialCase = results.find((result) =>
    result.fields?.some((field) => field.name === 'efectivo_teorico_esperado')
  );

  assert.ok(negativeChecks);
  assert.ok(requiredChecks);
  assert.ok(financialCase);
  assert.ok(requiredChecks.rows.every((row) => row.control_no_negativo_presente_y_validado === true));
  assert.equal(Number(financialCase.rows[0].efectivo_teorico_esperado), -13763);

  return {
    negativeChecks: negativeChecks.rows,
    protectedChecks: requiredChecks.rows.length,
    financialResult: Number(financialCase.rows[0].efectivo_teorico_esperado)
  };
};

const expectMigrationFailure = async ({ client, sql, code, messagePattern }) => {
  await assert.rejects(
    client.query(sql),
    (error) => {
      if (code) assert.equal(error.code, code);
      if (messagePattern) assert.match(error.message, messagePattern);
      return true;
    }
  );
};

const testLockTimeout = async (safeSql) => {
  const locker = await pool.connect();
  const runner = await pool.connect();
  try {
    await locker.query('BEGIN');
    await locker.query('LOCK TABLE public.cajas_sesiones IN ACCESS EXCLUSIVE MODE');
    const startedAt = Date.now();
    await expectMigrationFailure({ client: runner, sql: safeSql, code: '55P03' });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 4500 && elapsedMs < 15000, `lock_timeout inesperado: ${elapsedMs}ms`);
    await runner.query('ROLLBACK');
    return elapsedMs;
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    await runner.query('ROLLBACK').catch(() => {});
    locker.release();
    runner.release();
  }
};

const testSafeWrongDefinition = async (safeSql) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE public.cajas_sesiones
        ADD CONSTRAINT ck_cajas_sesiones_monto_teorico
        CHECK (monto_teorico_cierre >= -999)
    `);
    await expectMigrationFailure({
      client,
      sql: safeSql,
      messagePattern: /no coincide con el CHECK no-negativo esperado/
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
};

const testRollbackWrongDefinition = async (rollbackSql) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE public.cajas_sesiones DROP CONSTRAINT ck_cajas_sesiones_monto_teorico');
    await client.query(`
      ALTER TABLE public.cajas_sesiones
        ADD CONSTRAINT ck_cajas_sesiones_monto_teorico
        CHECK (monto_teorico_cierre >= -999)
    `);
    await expectMigrationFailure({
      client,
      sql: rollbackSql,
      messagePattern: /definicion incorrecta o no validada/
    });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
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
      (SELECT id_resolucion_cierre_caja FROM public.cat_cajas_resoluciones_cierre WHERE UPPER(TRIM(codigo)) = 'PENDIENTE_REVISION' LIMIT 1) AS resolucion_pendiente,
      (SELECT id_factura FROM public.facturas f WHERE NOT EXISTS (SELECT 1 FROM public.facturas_reversiones fr WHERE fr.id_factura_original = f.id_factura) ORDER BY id_factura DESC LIMIT 1) AS id_factura
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
    'resolucion_pendiente',
    'id_factura'
  ]) assert.ok(row[key], `Referencia QA faltante: ${key}`);
  return row;
};

const insertSession = async (client, {
  idSesionCaja,
  references,
  estado,
  montoApertura,
  closed = false
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
      $7::numeric, 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW()
    )
  `, [
    idSesionCaja,
    references.id_caja,
    references.id_sucursal,
    references.id_usuario,
    estado,
    closed,
    montoApertura
  ]);
};

const insertPayment = async (client, {
  idFacturaCobro,
  idSesionCaja,
  references,
  methodCode,
  amount
}) => {
  await client.query(`
    INSERT INTO public.facturas_cobros (
      id_factura_cobro, id_factura, id_sesion_caja, id_caja, id_sucursal,
      id_usuario_ejecutor, id_metodo_pago, monto, referencia, observacion,
      fecha_cobro, fecha_creacion
    ) OVERRIDING SYSTEM VALUE
    SELECT $1, $2, $3, $4, $5, $6, mp.id_metodo_pago, $7,
           'QA_SMOKE', 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW()
    FROM public.cat_metodos_pago mp
    WHERE UPPER(TRIM(mp.codigo)) = $8
  `, [
    idFacturaCobro,
    references.id_factura,
    idSesionCaja,
    references.id_caja,
    references.id_sucursal,
    references.id_usuario,
    amount,
    methodCode
  ]);
};

const runTransactionalFinancialSmoke = async (rollbackSql) => {
  const client = await pool.connect();
  const baseId = 8_000_000_000_000 + (Date.now() % 100_000_000);
  const salesSessionId = baseId;
  const negativeSessionId = baseId + 1;
  const closeId = baseId + 2;
  const validationId = baseId + 3;
  const outboxId = baseId + 4;
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
    for (const [index, [methodCode, amount]] of [
      ['EFECTIVO', 100],
      ['TARJETA', 200],
      ['TRANSFERENCIA', 300],
      ['OTRO', 400]
    ].entries()) {
      await insertPayment(client, {
        idFacturaCobro: baseId + 100 + index,
        idSesionCaja: salesSessionId,
        references,
        methodCode,
        amount
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
    assert.equal(salesComputation.monto_teorico_total, 1000);
    assert.equal(salesComputation.monto_declarado_total, 1000);
    assert.equal(salesComputation.diferencia_total, 0);
    assert.equal(salesComputation.rows.length, 3);

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
        row.id_metodo_pago,
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
    assert.ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === '%PDF');

    await expectMigrationFailure({
      client,
      sql: rollbackSql,
      messagePattern: /existen montos teoricos negativos/
    });
    await client.query('ROLLBACK');
    rolledBack = true;

    const cleanup = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM public.cajas_sesiones WHERE id_sesion_caja IN ($1, $2)) AS sesiones,
        EXISTS (SELECT 1 FROM public.cajas_cierres WHERE id_cierre_caja = $3) AS cierres,
        EXISTS (SELECT 1 FROM public.cajas_cierres_validaciones WHERE id_validacion_cierre = $4) AS validaciones,
        EXISTS (SELECT 1 FROM public.cajas_cierres_notificaciones_email WHERE id_notificacion = $5) AS outbox
    `, [salesSessionId, negativeSessionId, closeId, validationId, outboxId]);
    assert.deepEqual(cleanup.rows[0], {
      sesiones: false,
      cierres: false,
      validaciones: false,
      outbox: false
    });

    return {
      sales: {
        efectivo: salesSnapshot.ventasEfectivoNetas,
        noEfectivo: salesSnapshot.ventasNoEfectivoNetas,
        total: salesSnapshot.totalTeorico
      },
      negativeClose: {
        efectivoTeorico: -13763,
        diferencia: 13763,
        estado: 'CERRADA',
        resolucion: 'PENDIENTE_REVISION',
        arqueos: state.arqueos,
        outbox: state.notificaciones,
        pdfBytes: pdf.length,
        htmlTotalVentas: true
      },
      cleanup: cleanup.rows[0]
    };
  } finally {
    if (!rolledBack) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
};

assertQaTarget();
const [safeSql, verifySql, rollbackSql] = await Promise.all([
  readFile(SAFE_PATH, 'utf8'),
  readFile(VERIFY_PATH, 'utf8'),
  readFile(ROLLBACK_PATH, 'utf8')
]);

try {
  const before = await runVerify(pool, verifySql);
  assert.equal(before.negativeChecks.filter((row) =>
    ['cajas_sesiones', 'cajas_cierres'].includes(String(row.tabla))
      && Number(row.checks_equivalentes_no_negativos) > 0
  ).length, 2);

  const lockTimeoutMs = await testLockTimeout(safeSql);
  await pool.query(safeSql);
  await pool.query(safeSql);
  assert.deepEqual(await namedConstraintState(pool), []);

  const after = await runVerify(pool, verifySql);
  assert.ok(after.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));

  await testSafeWrongDefinition(safeSql);
  await pool.query(rollbackSql);
  await pool.query(rollbackSql);
  assert.equal((await namedConstraintState(pool)).length, 2);
  await testRollbackWrongDefinition(rollbackSql);

  await pool.query(safeSql);
  const smoke = await runTransactionalFinancialSmoke(rollbackSql);
  const finalVerify = await runVerify(pool, verifySql);
  assert.ok(finalVerify.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));

  console.log(JSON.stringify({
    projectRef: QA_PROJECT_REF,
    lockTimeoutMs,
    verifyBefore: before,
    verifyAfter: after,
    smoke,
    finalNamedConstraints: await namedConstraintState(pool)
  }, null, 2));
} finally {
  await closePool();
}
