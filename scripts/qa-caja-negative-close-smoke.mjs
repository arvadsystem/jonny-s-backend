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

const QA_PROJECT_REF = 'cluideiojeikzcmmizhe';
const SAFE_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_SAFE.sql', import.meta.url);
const VERIFY_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_VERIFY.sql', import.meta.url);
const ROLLBACK_PATH = new URL('../sql/20260720_allow_negative_cash_close_theoretical_ROLLBACK.sql', import.meta.url);

// Usuario QA real (root/SUPER_ADMIN) usado unicamente para firmar una sesion
// de prueba desechable. No se lee ni modifica su clave; solo se crea y borra
// una fila de sesiones_activas propia de este smoke.
const QA_ROOT_USER_ID = 30;
const LEAVE_SAFE_APPLIED = process.argv.includes('--leave-safe-applied');

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

const NEGATIVE_CLOSE_CONSTRAINTS = Object.freeze([
  ['public.cajas_sesiones', 'ck_cajas_sesiones_monto_teorico'],
  ['public.cajas_cierres', 'ck_cajas_cierres_monto_teorico'],
  ['public.cajas_arqueos', 'ck_cajas_arqueos_teorico']
]);

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

// "legacy" (las 3 restricciones presentes, nada migrado) es el unico estado
// que se restaura al finalizar. Cualquier otro estado (0, 1 o 2 presentes)
// se trata como "safe": ya sea porque el smoke ya se ejecuto antes, o porque
// un fix previo (sesiones/cierres) dejo la migracion a medias mientras
// cajas_arqueos seguia bloqueando negativos (el propio bug de este cambio).
// En ambos casos el resultado correcto es completar y dejar SAFE, nunca
// revertir constraints que ya se habian retirado deliberadamente.
const resolveInitialMode = (rows) =>
  rows.length === NEGATIVE_CLOSE_CONSTRAINTS.length ? 'legacy' : 'safe';

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

const testWrongDefinition = async ({
  table,
  constraintName,
  wrongCheckSql,
  safeSql
}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${wrongCheckSql}`);
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

const testRollbackWrongDefinition = async ({
  table,
  constraintName,
  wrongCheckSql,
  rollbackSql
}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraintName}`);
    await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${wrongCheckSql}`);
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
  closed = false,
  idUsuarioResponsable = references.id_usuario
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
    idUsuarioResponsable,
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
    // Caso obligatorio: OTRO (400) debe aparecer como fila unica agrupada
    // OTROS_NO_EFECTIVO, no perderse dentro del total declarado.
    assert.equal(salesComputation.rows.length, 4);
    const otrosRow = salesComputation.rows.find((row) => row.metodo_pago_codigo === 'OTROS_NO_EFECTIVO');
    assert.ok(otrosRow, 'debe existir la fila OTROS_NO_EFECTIVO');
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
      snapshot: { ...salesSnapshot, totalTeorico: salesSnapshot.totalTeorico - 500 },
      payloadRows: [
        { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 100 },
        { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
        { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
      ],
      threshold: 0,
      requireObservacionOnDifference: true
    });
    const negativeOtrosRow = negativeOtrosComputation.rows.find((row) => row.metodo_pago_codigo === 'OTROS_NO_EFECTIVO');
    assert.equal(negativeOtrosRow.monto_teorico, -100);
    assert.equal(negativeOtrosRow.monto_declarado, 0);
    assert.ok(negativeOtrosRow.monto_declarado >= 0);
    assert.equal(negativeOtrosRow.requiere_revision, false);
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
    assert.equal(computation.rows.length, 4);

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
    assert.equal(state.arqueos, 4);
    assert.equal(state.notificaciones, 1);

    const emailPayload = await loadCajaCloseEmailPayload(client, closeId);
    const html = buildCajaCloseEmailHtml({ payload: emailPayload, pdfAttached: true });
    const pdf = await buildCajaCierrePdfBuffer(emailPayload);
    assert.match(html, /Total ventas/);
    assert.match(html, /OTROS_NO_EFECTIVO/);
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
        htmlOtrosNoEfectivo: true,
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

// Se limpia por id_sesion_caja (no solo por el id de validacion "principal")
// porque el flujo de prueba puede generar mas de un intento de validacion
// (p. ej. el caso "reintento del cierre"); todos deben quedar sin rastro.
const cleanupHttpCloseArtifacts = async ({ idSesionCaja, idCierreCaja }) => {
  if (idCierreCaja) {
    await pool.query('DELETE FROM public.cajas_cierres_arqueos_metodos WHERE id_cierre_caja = $1', [idCierreCaja]);
    await pool.query('DELETE FROM public.cajas_cierres_notificaciones_email WHERE id_cierre_caja = $1', [idCierreCaja]);
  }
  await pool.query(`
    DELETE FROM public.cajas_cierres_validaciones_metodos
    WHERE id_validacion_cierre IN (
      SELECT id_validacion_cierre FROM public.cajas_cierres_validaciones WHERE id_sesion_caja = $1
    )
  `, [idSesionCaja]);
  await pool.query('DELETE FROM public.cajas_cierres_validaciones WHERE id_sesion_caja = $1', [idSesionCaja]);
  if (idCierreCaja) {
    await pool.query('DELETE FROM public.cajas_cierres WHERE id_cierre_caja = $1', [idCierreCaja]);
  }
  await pool.query('DELETE FROM public.facturas_cobros WHERE id_sesion_caja = $1', [idSesionCaja]);
  await pool.query('DELETE FROM public.cajas_movimientos WHERE id_sesion_caja = $1', [idSesionCaja]);
  await pool.query('DELETE FROM public.cajas_sesiones WHERE id_sesion_caja = $1', [idSesionCaja]);
};

const runHttpCloseSmoke = async () => {
  const references = await loadSmokeReferences(pool);
  // Rango seguro para integer (algunas tablas de auditoria referencian el id
  // de sesion en una columna integer, no bigint), muy por encima de cualquier
  // secuencia real de QA.
  const idSesionCaja = 900_000_000 + (Date.now() % 90_000_000);
  const baseId = idSesionCaja;

  await insertSession(pool, {
    idSesionCaja,
    references,
    estado: references.estado_abierta,
    montoApertura: 3000,
    idUsuarioResponsable: QA_ROOT_USER_ID
  });
  await pool.query(`
    INSERT INTO public.cajas_movimientos (
      id_movimiento_caja, id_sesion_caja, id_caja, id_sucursal,
      id_tipo_movimiento_caja, id_usuario_ejecutor, monto,
      referencia, observacion, fecha_movimiento, fecha_creacion
    ) OVERRIDING SYSTEM VALUE
    VALUES ($1, $2, $3, $4, $5, $6, 16763, 'QA_SMOKE_HTTP_EGRESO', 'QA_SMOKE_CAJA_NEGATIVE_CLOSE', NOW(), NOW())
  `, [baseId + 1, idSesionCaja, references.id_caja, references.id_sucursal, references.tipo_egreso, QA_ROOT_USER_ID]);
  for (const [index, [methodCode, amount]] of [
    ['EFECTIVO', 100],
    ['TARJETA', 200],
    ['TRANSFERENCIA', 300],
    ['OTRO', 400]
  ].entries()) {
    await insertPayment(pool, {
      idFacturaCobro: baseId + 10 + index,
      idSesionCaja,
      references: { ...references, id_usuario: QA_ROOT_USER_ID },
      methodCode,
      amount
    });
  }

  // apertura 3000 + efectivo 100 - egreso 16763 = -13663; no-efectivo 900 (200+300+400)
  const expectedEfectivoTeorico = -13663;
  const expectedTotalTeorico = -12763;
  const expectedTotalDeclarado = 900; // efectivo declarado 0 + tarjeta 200 + transferencia 300 + otros 400

  const auth = await mintQaAuthContext({ idUsuario: QA_ROOT_USER_ID, idSucursal: references.id_sucursal });
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  let idCierreCaja = null;
  let idValidacionCierre = null;
  try {
    const arqueosPayload = [
      { metodo_pago_codigo: 'EFECTIVO', monto_declarado: 0, observacion: 'QA smoke HTTP: caja vacia tras egreso' },
      { metodo_pago_codigo: 'TARJETA', monto_declarado: 200, cantidad_referencias: 1 },
      { metodo_pago_codigo: 'TRANSFERENCIA', monto_declarado: 300, cantidad_referencias: 1 }
    ];
    const observacionCierre = 'QA_SMOKE_HTTP cierre negativo con OTRO';

    const preview = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-preview`, {
      auth,
      body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
    });
    assert.equal(preview.status, 200, `cierre-preview HTTP ${preview.status}: ${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.arqueos_metodos.length, 4);
    const previewOtros = preview.body.arqueos_metodos.find((row) => row.metodo_pago_codigo === 'OTROS_NO_EFECTIVO');
    assert.ok(previewOtros, 'preview debe incluir OTROS_NO_EFECTIVO');
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
    const validacionOtros = validaciones.body.metodos.find((row) => row.metodo_pago_codigo === 'OTROS_NO_EFECTIVO');
    assert.ok(validacionOtros, 'cierre-validaciones debe incluir OTROS_NO_EFECTIVO');
    assert.equal(validacionOtros.monto_declarado, 400);
    assert.equal(validacionOtros.diferencia, 0);
    assert.equal(validaciones.body.resumen.total_declarado, expectedTotalDeclarado);
    assert.equal(validaciones.body.resumen.hay_diferencia, true);

    // Reintento del cierre: reenviar cierre-validaciones antes de cerrar debe
    // seguir aceptando la revision (no hay estado que lo bloquee todavia).
    const revalidacion = await callJson(baseUrl, 'POST', `/ventas/cajas/sesiones/${idSesionCaja}/cierre-validaciones`, {
      auth,
      body: { observacion_cierre: observacionCierre, arqueos: arqueosPayload }
    });
    assert.equal(revalidacion.status, 201);
    assert.notEqual(revalidacion.body.id_validacion_cierre, idValidacionCierre);

    const cerrar = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
      auth,
      body: { observacion_cierre: observacionCierre, id_validacion_cierre: idValidacionCierre }
    });
    assert.equal(cerrar.status, 200, `cerrar HTTP ${cerrar.status}: ${JSON.stringify(cerrar.body)}`);
    idCierreCaja = cerrar.body.id_cierre_caja;
    assert.ok(idCierreCaja);
    assert.equal(cerrar.body.estado_revision, 'PENDIENTE_REVISION');
    assert.equal(cerrar.body.arqueos_metodos.length, 4);
    const cierreOtros = cerrar.body.arqueos_metodos.find((row) => row.metodo_pago_codigo === 'OTROS_NO_EFECTIVO');
    assert.ok(cierreOtros);
    assert.equal(cierreOtros.monto_declarado, 400);
    assert.equal(cerrar.body.correo_cierre.estado, 'PENDIENTE');

    // La validacion ya vinculada no debe poder reutilizarse en un segundo cierre.
    const idValidacionSobrante = revalidacion.body.id_validacion_cierre;
    const cerrarReintento = await callJson(baseUrl, 'PATCH', `/ventas/cajas/sesiones/${idSesionCaja}/cerrar`, {
      auth,
      body: { observacion_cierre: observacionCierre, id_validacion_cierre: idValidacionSobrante }
    });
    assert.equal(cerrarReintento.status, 409);

    const persisted = await pool.query(`
      SELECT
        cs.id_estado_sesion_caja, estado.codigo AS estado_codigo,
        cs.monto_teorico_cierre,
        cc.id_cierre_caja,
        cv.id_cierre_caja AS validacion_vinculada,
        COUNT(cam.id_arqueo_metodo)::int AS arqueos,
        COUNT(cam.id_arqueo_metodo) FILTER (WHERE cam.metodo_pago_codigo = 'OTROS_NO_EFECTIVO')::int AS arqueos_otros,
        SUM(cam.monto_declarado)::numeric AS suma_declarado,
        SUM(cam.monto_teorico)::numeric AS suma_teorico,
        COUNT(DISTINCT outbox.id_notificacion)::int AS outbox
      FROM public.cajas_sesiones cs
      INNER JOIN public.cat_cajas_sesiones_estados estado ON estado.id_estado_sesion_caja = cs.id_estado_sesion_caja
      INNER JOIN public.cajas_cierres cc ON cc.id_sesion_caja = cs.id_sesion_caja
      LEFT JOIN public.cajas_cierres_validaciones cv ON cv.id_validacion_cierre = $2
      LEFT JOIN public.cajas_cierres_arqueos_metodos cam ON cam.id_cierre_caja = cc.id_cierre_caja
      LEFT JOIN public.cajas_cierres_notificaciones_email outbox ON outbox.id_cierre_caja = cc.id_cierre_caja
      WHERE cs.id_sesion_caja = $1
      GROUP BY cs.id_estado_sesion_caja, estado.codigo, cs.monto_teorico_cierre, cc.id_cierre_caja, cv.id_cierre_caja
    `, [idSesionCaja, idValidacionCierre]);
    const state = persisted.rows[0];
    assert.equal(String(state.estado_codigo).trim().toUpperCase(), 'CERRADA');
    assert.equal(Number(state.monto_teorico_cierre), expectedTotalTeorico);
    assert.equal(String(state.id_cierre_caja), String(idCierreCaja));
    assert.equal(String(state.validacion_vinculada), String(idCierreCaja));
    assert.equal(state.arqueos, 4);
    assert.equal(state.arqueos_otros, 1);
    assert.equal(Number(state.suma_declarado), expectedTotalDeclarado);
    assert.equal(Number(state.suma_teorico), expectedTotalTeorico);
    assert.equal(state.outbox, 1);

    const emailPayload = await loadCajaCloseEmailPayload(pool, idCierreCaja);
    const html = buildCajaCloseEmailHtml({ payload: emailPayload, pdfAttached: true });
    const pdf = await buildCajaCierrePdfBuffer(emailPayload);
    assert.match(html, /OTROS_NO_EFECTIVO/);
    assert.doesNotMatch(html, /Extra Ranch/); // sanity: no leftover fixture data bleeding in
    assert.ok(Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === '%PDF');
    const detalleSumaDeclarado = emailPayload.arqueos.reduce((sum, row) => sum + Number(row.monto_declarado || 0), 0);
    assert.equal(detalleSumaDeclarado, expectedTotalDeclarado);

    return {
      httpStatus: { preview: preview.status, validaciones: validaciones.status, cerrar: cerrar.status },
      idSesionCaja: String(idSesionCaja),
      idCierreCaja: String(idCierreCaja),
      efectivoTeoricoEsperado: expectedEfectivoTeorico,
      totalTeorico: Number(state.monto_teorico_cierre),
      totalDeclarado: Number(state.suma_declarado),
      arqueos: state.arqueos,
      arqueosOtrosNoEfectivo: state.arqueos_otros,
      reintentoCierreRechazado: cerrarReintento.status === 409,
      pdfBytes: pdf.length
    };
  } finally {
    await stopServer(server);
    await closeQaAuthContext(auth.idSesion).catch(() => {});
    await cleanupHttpCloseArtifacts({ idSesionCaja, idCierreCaja, idValidacionCierre }).catch((cleanupError) => {
      console.error('[qa-caja-negative-close-smoke] fallo limpiando artefactos HTTP:', cleanupError);
      throw cleanupError;
    });
  }
};

const main = async () => {
  assertQaTarget();
  const [safeSql, verifySql, rollbackSql] = await Promise.all([
    readFile(SAFE_PATH, 'utf8'),
    readFile(VERIFY_PATH, 'utf8'),
    readFile(ROLLBACK_PATH, 'utf8')
  ]);

  const initialRows = await namedConstraintState(pool);
  const initialMode = resolveInitialMode(initialRows);

  try {
    const before = await runVerify(pool, verifySql);
    // Se compara contra el conteo real observado (initialRows), no contra un
    // modo binario asumido: un ambiente parcialmente migrado (p. ej. solo
    // cajas_arqueos aun bloqueando) es un estado inicial legitimo.
    assert.equal(
      before.negativeChecks.filter((row) =>
        ['cajas_sesiones', 'cajas_cierres', 'cajas_arqueos'].includes(String(row.tabla))
          && Number(row.checks_equivalentes_no_negativos) > 0
      ).length,
      initialRows.length
    );

    const lockTimeoutMs = await testLockTimeout(safeSql);
    await pool.query(safeSql);
    await pool.query(safeSql);
    assert.deepEqual(await namedConstraintState(pool), []);

    const after = await runVerify(pool, verifySql);
    assert.ok(after.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));

    await testWrongDefinition({
      table: 'public.cajas_sesiones',
      constraintName: 'ck_cajas_sesiones_monto_teorico',
      wrongCheckSql: 'CHECK (monto_teorico_cierre >= -999)',
      safeSql
    });
    await testWrongDefinition({
      table: 'public.cajas_arqueos',
      constraintName: 'ck_cajas_arqueos_teorico',
      wrongCheckSql: 'CHECK (monto_teorico >= -999)',
      safeSql
    });

    await pool.query(rollbackSql);
    await pool.query(rollbackSql);
    assert.equal((await namedConstraintState(pool)).length, NEGATIVE_CLOSE_CONSTRAINTS.length);

    await testRollbackWrongDefinition({
      table: 'public.cajas_sesiones',
      constraintName: 'ck_cajas_sesiones_monto_teorico',
      wrongCheckSql: 'CHECK (monto_teorico_cierre >= -999)',
      rollbackSql
    });
    await testRollbackWrongDefinition({
      table: 'public.cajas_arqueos',
      constraintName: 'ck_cajas_arqueos_teorico',
      wrongCheckSql: 'CHECK (monto_teorico >= -999)',
      rollbackSql
    });

    await pool.query(safeSql);
    const smoke = await runTransactionalFinancialSmoke();
    const httpSmoke = await runHttpCloseSmoke();
    const finalVerify = await runVerify(pool, verifySql);
    assert.ok(finalVerify.negativeChecks.every((row) => Number(row.checks_equivalentes_no_negativos) === 0));

    const targetMode = LEAVE_SAFE_APPLIED ? 'safe' : initialMode;
    if (targetMode === 'legacy') {
      await pool.query(rollbackSql);
    } else {
      await pool.query(safeSql);
    }
    const restoredRows = await namedConstraintState(pool);
    assert.equal(restoredRows.length, targetMode === 'legacy' ? NEGATIVE_CLOSE_CONSTRAINTS.length : 0);

    console.log(JSON.stringify({
      projectRef: QA_PROJECT_REF,
      initialMode,
      restoredMode: targetMode,
      leaveSafeApplied: LEAVE_SAFE_APPLIED,
      lockTimeoutMs,
      verifyBefore: before,
      verifyAfter: after,
      smoke,
      httpSmoke,
      finalNamedConstraints: restoredRows
    }, null, 2));
  } finally {
    await closePool();
  }
};

await main();
