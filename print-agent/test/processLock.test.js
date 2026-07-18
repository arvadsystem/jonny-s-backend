import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireProcessLock, isProcessRunning } from '../src/processLock.js';

const makeLockPath = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jonnys-print-agent-lock-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, '.print-agent.lock');
};

const lockMetadata = (overrides = {}) => ({
  version: 1,
  pid: 4567,
  owner_id: 'existing-owner',
  created_at: '2026-07-18T12:00:00.000Z',
  ...overrides
});

test('creates an exclusive lock with PID and non-sensitive ownership metadata', async (t) => {
  const lockPath = await makeLockPath(t);
  const lock = acquireProcessLock({
    lockPath,
    pid: 1234,
    now: () => new Date('2026-07-18T15:30:00.000Z'),
    createOwnerId: () => 'new-owner'
  });

  const contents = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.deepEqual(contents, {
    version: 1,
    pid: 1234,
    owner_id: 'new-owner',
    created_at: '2026-07-18T15:30:00.000Z'
  });
  assert.equal(lock.release(), true);
});

test('rejects startup when the lock PID is still active', async (t) => {
  const lockPath = await makeLockPath(t);
  const existing = lockMetadata();
  await fs.writeFile(lockPath, JSON.stringify(existing));

  assert.throws(
    () => acquireProcessLock({ lockPath, isRunning: (pid) => pid === existing.pid }),
    (error) => error?.code === 'PRINT_AGENT_ALREADY_RUNNING'
  );
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), existing);
});

test('replaces a stale lock when its PID is no longer active', async (t) => {
  const lockPath = await makeLockPath(t);
  const stale = lockMetadata();
  await fs.writeFile(lockPath, JSON.stringify(stale));
  const removed = [];

  const lock = acquireProcessLock({
    lockPath,
    pid: 9999,
    isRunning: () => false,
    createOwnerId: () => 'replacement-owner',
    onStaleLockRemoved: (metadata) => removed.push(metadata)
  });

  assert.deepEqual(removed, [stale]);
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, 9999);
  assert.equal(lock.release(), true);
});

test('replaces an invalid lock without trusting its contents', async (t) => {
  const lockPath = await makeLockPath(t);
  await fs.writeFile(lockPath, 'not-json');

  const lock = acquireProcessLock({
    lockPath,
    pid: 2222,
    isRunning: () => {
      throw new Error('invalid lock must not provide a PID');
    },
    createOwnerId: () => 'valid-owner'
  });

  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).owner_id, 'valid-owner');
  assert.equal(lock.release(), true);
});

test('release is idempotent and removes its own lock', async (t) => {
  const lockPath = await makeLockPath(t);
  const lock = acquireProcessLock({ lockPath });

  assert.equal(lock.release(), true);
  assert.equal(lock.release(), false);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('release does not remove a lock that belongs to another process', async (t) => {
  const lockPath = await makeLockPath(t);
  const lock = acquireProcessLock({ lockPath, pid: 1111, createOwnerId: () => 'first-owner' });
  const replacement = lockMetadata({ pid: 2222, owner_id: 'second-owner' });
  await fs.writeFile(lockPath, JSON.stringify(replacement));

  assert.equal(lock.release(), false);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), replacement);
});

test('PID probing treats Windows/Linux access denied as active and missing PID as stale', () => {
  assert.equal(isProcessRunning(123, () => undefined), true);
  assert.equal(isProcessRunning(123, () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }), true);
  assert.equal(isProcessRunning(123, () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); }), false);
});
