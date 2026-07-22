import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertIsolatedDatabaseServerAndMarker,
  assertIsolatedDatabaseUrlAllowed,
  assertQaSharedPaymentCatalogWriteForbidden
} from '../cajaCloseIsolatedDatabaseGuard.js';

const expectPolicyCode = (input, expectedCode) => {
  assert.throws(
    () => assertIsolatedDatabaseUrlAllowed(input),
    (error) => error.code === expectedCode
  );
};

describe('caja close isolated database destructive guard', () => {
  it('bloquea DML del smoke QA contra cat_metodos_pago y permite lecturas', () => {
    assert.doesNotThrow(() => assertQaSharedPaymentCatalogWriteForbidden(
      'SELECT * FROM public.cat_metodos_pago'
    ));
    for (const sql of [
      "UPDATE public.cat_metodos_pago SET estado=false",
      "INSERT INTO cat_metodos_pago (codigo) VALUES ('X')",
      "DELETE FROM public.cat_metodos_pago WHERE codigo='X'"
    ]) {
      assert.throws(
        () => assertQaSharedPaymentCatalogWriteForbidden(sql),
        (error) => error.code === 'QA_CAJAS_SHARED_CATALOG_MUTATION_FORBIDDEN'
      );
    }
  });

  it('rechaza explicitamente URLs Supabase de produccion y QA antes de conectar', () => {
    for (const projectRef of ['ooofeoziqaoqcufifqci', 'cluideiojeikzcmmizhe']) {
      expectPolicyCode({
        connectionString: `postgresql://postgres.${projectRef}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
        allowDestructive: 'true'
      }, 'CAJA_CLOSE_ISOLATED_SUPABASE_PROJECT_FORBIDDEN');
    }
  });

  it('rechaza base postgres local, nombre no permitido y falta de opt-in destructivo', () => {
    expectPolicyCode({
      connectionString: 'postgresql://postgres:secret@127.0.0.1:5432/postgres',
      allowDestructive: 'true'
    }, 'CAJA_CLOSE_ISOLATED_DATABASE_FORBIDDEN');
    expectPolicyCode({
      connectionString: 'postgresql://postgres:secret@127.0.0.1:5432/caja_test',
      allowDestructive: 'true'
    }, 'CAJA_CLOSE_ISOLATED_DATABASE_NAME_INVALID');
    expectPolicyCode({
      connectionString: 'postgresql://postgres:secret@127.0.0.1:5432/jonnys_caja_close_test_guard',
      allowDestructive: 'false'
    }, 'CAJA_CLOSE_ISOLATED_DESTRUCTIVE_NOT_ALLOWED');
  });

  it('rechaza una base local con nombre valido cuando falta la tabla marcadora', async () => {
    const expectedTarget = assertIsolatedDatabaseUrlAllowed({
      connectionString: 'postgresql://postgres:secret@127.0.0.1:5432/jonnys_caja_close_test_missing_marker',
      allowDestructive: 'true'
    });
    const queryRunner = {
      async query(sql) {
        if (/current_database\(\)/.test(sql)) {
          return { rows: [{ database_name: expectedTarget.databaseName, server_address: '::ffff:127.0.0.1/128' }] };
        }
        if (/to_regclass/.test(sql)) return { rows: [{ marker_exists: false }] };
        throw new Error('consulta inesperada');
      }
    };
    await assert.rejects(
      assertIsolatedDatabaseServerAndMarker({ queryRunner, expectedTarget }),
      (error) => error.code === 'CAJA_CLOSE_ISOLATED_MARKER_MISSING'
    );
  });

  it('permite una base local desechable solo cuando identidad, direccion y marcador coinciden', async () => {
    const expectedTarget = assertIsolatedDatabaseUrlAllowed({
      connectionString: 'postgresql://postgres:secret@localhost:5432/jonnys_caja_close_test_allowed',
      allowDestructive: 'true'
    });
    const queryRunner = {
      async query(sql) {
        if (/current_database\(\)/.test(sql)) {
          return { rows: [{ database_name: expectedTarget.databaseName, server_address: '::ffff:127.0.0.1' }] };
        }
        if (/to_regclass/.test(sql)) {
          return { rows: [{ marker_exists: true }] };
        }
        if (/valid_marker/.test(sql)) return { rows: [{ valid_marker: true }] };
        throw new Error('consulta inesperada');
      }
    };
    assert.deepEqual(
      await assertIsolatedDatabaseServerAndMarker({ queryRunner, expectedTarget }),
      {
        databaseName: 'jonnys_caja_close_test_allowed',
        serverAddress: '::ffff:127.0.0.1',
        markerPurpose: 'CAJA_CLOSE_ISOLATED_TEST'
      }
    );
  });
});
