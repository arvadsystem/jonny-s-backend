import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const LOCK_VERSION = 1;
const MAX_ACQUIRE_ATTEMPTS = 5;

const alreadyRunningError = () => {
  const error = new Error('PRINT_AGENT_ALREADY_RUNNING');
  error.code = 'PRINT_AGENT_ALREADY_RUNNING';
  return error;
};

const readSnapshot = (lockPath) => {
  try {
    const stats = fs.statSync(lockPath);
    return {
      contents: fs.readFileSync(lockPath, 'utf8'),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      createdAt: stats.birthtimeMs,
      inode: stats.ino
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const sameSnapshot = (left, right) => Boolean(
  left
  && right
  && left.contents === right.contents
  && left.size === right.size
  && left.modifiedAt === right.modifiedAt
  && left.createdAt === right.createdAt
  && left.inode === right.inode
);

const parseMetadata = (contents) => {
  try {
    const metadata = JSON.parse(contents);
    if (
      metadata?.version !== LOCK_VERSION
      || !Number.isSafeInteger(metadata.pid)
      || metadata.pid <= 0
      || typeof metadata.owner_id !== 'string'
      || metadata.owner_id.length === 0
      || typeof metadata.created_at !== 'string'
      || !Number.isFinite(Date.parse(metadata.created_at))
    ) {
      return null;
    }
    return metadata;
  } catch {
    return null;
  }
};

export const isProcessRunning = (pid, kill = process.kill) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
};

const removeIfUnchanged = (lockPath, snapshot) => {
  const currentSnapshot = readSnapshot(lockPath);
  if (!sameSnapshot(snapshot, currentSnapshot)) return false;

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

export const acquireProcessLock = ({
  lockPath,
  pid = process.pid,
  isRunning = isProcessRunning,
  now = () => new Date(),
  createOwnerId = randomUUID,
  onStaleLockRemoved = () => undefined
}) => {
  const createdAt = now();
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error('PRINT_AGENT_LOCK_INVALID_DATE');
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('PRINT_AGENT_LOCK_INVALID_PID');
  }

  const ownerId = createOwnerId();
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error('PRINT_AGENT_LOCK_INVALID_OWNER');
  }

  const metadata = {
    version: LOCK_VERSION,
    pid,
    owner_id: ownerId,
    created_at: createdAt.toISOString()
  };
  const contents = `${JSON.stringify(metadata)}\n`;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });

      let released = false;
      return {
        metadata,
        release: () => {
          if (released) return false;
          released = true;

          const snapshot = readSnapshot(lockPath);
          const current = snapshot ? parseMetadata(snapshot.contents) : null;
          if (current?.pid !== metadata.pid || current?.owner_id !== metadata.owner_id) return false;
          return removeIfUnchanged(lockPath, snapshot);
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const snapshot = readSnapshot(lockPath);
    if (!snapshot) continue;

    const existing = parseMetadata(snapshot.contents);
    if (existing && isRunning(existing.pid)) throw alreadyRunningError();

    if (removeIfUnchanged(lockPath, snapshot)) {
      onStaleLockRemoved(existing);
    }
  }

  const error = new Error('PRINT_AGENT_LOCK_ACQUIRE_FAILED');
  error.code = 'PRINT_AGENT_LOCK_ACQUIRE_FAILED';
  throw error;
};
