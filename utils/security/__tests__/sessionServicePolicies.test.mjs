import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DAILY_CUTOFF_PROTECTED_ROLE_CODES,
  INACTIVITY_EXCLUDED_ROLE_CODES,
  OPERATIONAL_DAILY_CUTOFF_ROLE_CODES,
  closeOperationalSessionsAtDailyCutoff,
  createExclusiveClientSession
} from '../sessionService.js';

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const createTransactionalPool = ({
  initialSessions = [],
  failInsert = false,
  isClient = true,
  tryLock = true,
  dailyClosedSessions = 0
} = {}) => {
  let sessions = structuredClone(initialSessions);
  let nextSessionId = 1;
  let lockTail = Promise.resolve();
  const calls = [];

  return {
    calls,
    getSessions: () => structuredClone(sessions),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    async connect() {
      let snapshot = null;
      let releaseAdvisoryLock = null;

      return {
        async query(sql, params = []) {
          const normalized = normalizeSql(sql);
          calls.push({ sql: normalized, params });

          if (normalized === 'BEGIN') {
            snapshot = structuredClone(sessions);
            return { rows: [] };
          }
          if (normalized.includes("set_config('statement_timeout'")) return { rows: [{}] };
          if (normalized.includes('pg_try_advisory_xact_lock')) {
            return { rows: [{ acquired: tryLock }] };
          }
          if (normalized.includes('pg_advisory_xact_lock')) {
            const previous = lockTail;
            let releaseCurrent;
            lockTail = new Promise((resolve) => {
              releaseCurrent = resolve;
            });
            await previous;
            releaseAdvisoryLock = releaseCurrent;
            return { rows: [{}] };
          }
          if (normalized.includes('FROM usuarios') && normalized.includes('FOR SHARE')) {
            return { rows: isClient ? [{ '?column?': 1 }] : [], rowCount: isClient ? 1 : 0 };
          }
          if (normalized.includes("motivo_cierre = 'replaced_by_new_login'")) {
            for (const session of sessions) {
              if (session.id_usuario === params[0] && session.activa) {
                session.activa = false;
                session.motivo_cierre = 'replaced_by_new_login';
              }
            }
            return { rows: [], rowCount: 1 };
          }
          if (normalized.startsWith('INSERT INTO sesiones_activas')) {
            if (failInsert) throw Object.assign(new Error('insert failed'), { code: 'INSERT_FAILED' });
            const id = `session-${nextSessionId++}`;
            sessions.push({ id_sesion: id, id_usuario: params[0], activa: true });
            return { rows: [{ id_sesion: id }], rowCount: 1 };
          }
          if (normalized.includes("motivo_cierre = 'daily_cutoff'")) {
            return { rows: [], rowCount: dailyClosedSessions };
          }
          if (normalized === 'COMMIT') {
            releaseAdvisoryLock?.();
            releaseAdvisoryLock = null;
            snapshot = null;
            return { rows: [] };
          }
          if (normalized === 'ROLLBACK') {
            sessions = structuredClone(snapshot || sessions);
            releaseAdvisoryLock?.();
            releaseAdvisoryLock = null;
            return { rows: [] };
          }

          throw new Error(`Unexpected SQL in test: ${normalized}`);
        },
        release() {}
      };
    }
  };
};

describe('createExclusiveClientSession', () => {
  it('reemplaza la sesion Cliente anterior dentro de una transaccion', async () => {
    const pool = createTransactionalPool({
      initialSessions: [{ id_sesion: 'session-a', id_usuario: 17, activa: true }]
    });

    const newSessionId = await createExclusiveClientSession(
      { id_usuario: 17, ip_origen: '127.0.0.1' },
      { poolOverride: pool }
    );

    assert.equal(newSessionId, 'session-1');
    assert.deepEqual(
      pool.getSessions().map(({ id_sesion, activa, motivo_cierre = null }) => ({
        id_sesion,
        activa,
        motivo_cierre
      })),
      [
        { id_sesion: 'session-a', activa: false, motivo_cierre: 'replaced_by_new_login' },
        { id_sesion: 'session-1', activa: true, motivo_cierre: null }
      ]
    );
    assert.ok(pool.calls.some(({ sql }) => sql.includes('pg_advisory_xact_lock')));
    assert.ok(pool.calls.some(({ sql }) => sql === 'COMMIT'));
  });

  it('serializa dos logins simultaneos y deja exactamente una sesion activa', async () => {
    const pool = createTransactionalPool({
      initialSessions: [{ id_sesion: 'session-a', id_usuario: 17, activa: true }]
    });

    await Promise.all([
      createExclusiveClientSession({ id_usuario: 17 }, { poolOverride: pool }),
      createExclusiveClientSession({ id_usuario: 17 }, { poolOverride: pool })
    ]);

    const activeSessions = pool.getSessions().filter((session) => session.activa);
    assert.equal(activeSessions.length, 1);
    assert.equal(
      pool.calls.filter(({ sql }) => sql.includes('pg_advisory_xact_lock')).length,
      2
    );
  });

  it('hace rollback y conserva la sesion previa si falla la nueva insercion', async () => {
    const pool = createTransactionalPool({
      initialSessions: [{ id_sesion: 'session-a', id_usuario: 17, activa: true }],
      failInsert: true
    });

    await assert.rejects(
      () => createExclusiveClientSession({ id_usuario: 17 }, { poolOverride: pool }),
      /insert failed/
    );

    assert.deepEqual(pool.getSessions(), [
      { id_sesion: 'session-a', id_usuario: 17, activa: true }
    ]);
    assert.ok(pool.calls.some(({ sql }) => sql === 'ROLLBACK'));
  });

  it('rechaza usuarios que no pertenecen al alcance Cliente', async () => {
    const pool = createTransactionalPool({ isClient: false });

    await assert.rejects(
      () => createExclusiveClientSession({ id_usuario: 17 }, { poolOverride: pool }),
      (error) => error?.code === 'CLIENT_SESSION_SCOPE_REQUIRED'
    );

    assert.equal(
      pool.calls.some(({ sql }) => sql.includes("motivo_cierre = 'replaced_by_new_login'")),
      false
    );
  });
});

describe('closeOperationalSessionsAtDailyCutoff', () => {
  it('mantiene P_COCINA fuera del daily cutoff pero dentro de la exclusion por inactividad', async () => {
    assert.deepEqual(OPERATIONAL_DAILY_CUTOFF_ROLE_CODES, [
      'COCINA',
      'MESERO',
      'AUXILIAR_COCINA'
    ]);
    assert.equal(OPERATIONAL_DAILY_CUTOFF_ROLE_CODES.includes('P_COCINA'), false);
    assert.equal(INACTIVITY_EXCLUDED_ROLE_CODES.includes('P_COCINA'), true);
  });

  it('limita el cierre a los tres roles operativos, al cutoff y conserva historico', async () => {
    const pool = createTransactionalPool({ dailyClosedSessions: 4 });

    const result = await closeOperationalSessionsAtDailyCutoff(
      { cutoffLocal: '2026-06-28 23:59:00' },
      { poolOverride: pool }
    );

    assert.equal(result.executed, true);
    assert.equal(result.closedSessions, 4);
    const update = pool.calls.find(({ sql }) => sql.includes("motivo_cierre = 'daily_cutoff'"));
    assert.ok(update);
    assert.equal(update.params[0], '2026-06-28 23:59:00');
    assert.deepEqual(update.params[1], OPERATIONAL_DAILY_CUTOFF_ROLE_CODES);
    assert.deepEqual(update.params[2], DAILY_CUTOFF_PROTECTED_ROLE_CODES);
    assert.match(update.sql, /sa\.fecha_inicio <= \$1::timestamp/);
    assert.match(update.sql, /sa\.activa = TRUE/);
    assert.doesNotMatch(update.sql, /DELETE FROM sesiones_activas/i);
  });

  it('omite el trabajo si otra instancia conserva el advisory lock', async () => {
    const pool = createTransactionalPool({ tryLock: false });

    const result = await closeOperationalSessionsAtDailyCutoff(
      { cutoffLocal: '2026-06-28 23:59:00' },
      { poolOverride: pool }
    );

    assert.deepEqual(result, {
      executed: false,
      reason: 'LOCK_NOT_ACQUIRED',
      closedSessions: 0,
      cutoffLocal: '2026-06-28 23:59:00'
    });
    assert.equal(
      pool.calls.some(({ sql }) => sql.includes("motivo_cierre = 'daily_cutoff'")),
      false
    );
  });
});
