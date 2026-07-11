import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;

export interface AtomicLockOptions {
  staleMs: number;
  waitMs?: number;
  pollMs?: number;
}

export interface AtomicLockLease {
  token: string;
  release: () => void;
}

export interface AtomicLockCoordinatorOptions {
  pid?: number;
  incarnation?: string;
  probeIncarnation?: (pid: number) => string | null;
}

function loadDatabaseCtor(): DatabaseCtor {
  const require = createRequire(import.meta.url);
  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const bunSqlite = require('bun:sqlite') as { Database: DatabaseCtor };
    return bunSqlite.Database;
  }
  const mod = require('better-sqlite3') as { default?: DatabaseCtor } | DatabaseCtor;
  return (mod as { default?: DatabaseCtor }).default ?? (mod as DatabaseCtor);
}

const Database = loadDatabaseCtor();

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function probeProcessIncarnation(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const end = stat.lastIndexOf(')');
      const fields = stat.slice(end + 2).split(' ');
      return fields[19] || null;
    } catch {
      return null;
    }
  }

  if (process.platform !== 'win32') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 250,
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().Ticks`],
    { encoding: 'utf-8', timeout: 500 },
  );
  return result.status === 0 ? result.stdout.trim() || null : null;
}

const currentProcessIncarnation = probeProcessIncarnation(process.pid);
const RELEASE_RETRY_WINDOW_MS = 30_000;
const RELEASE_RETRY_INITIAL_DELAY_MS = 10;
const RELEASE_RETRY_MAX_DELAY_MS = 1_000;
const RELEASE_PERSISTENT_RETRY_MAX_DELAY_MS = 60_000;

interface PendingRelease {
  attempt: () => boolean;
  deadline: number;
  nextDelayMs: number;
  persistentDelayMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

const pendingReleases = new Map<string, PendingRelease>();

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export class AtomicLockCoordinator {
  private readonly pid: number;
  private readonly incarnation: string | null;
  private readonly probeIncarnation: (pid: number) => string | null;

  constructor(private readonly dbPath: string, options: AtomicLockCoordinatorOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.probeIncarnation = options.probeIncarnation
      ?? ((pid) => pid === process.pid ? currentProcessIncarnation : probeProcessIncarnation(pid));
    this.incarnation = options.incarnation
      ?? this.probeIncarnation(this.pid)
      ?? null;
  }

  tryAcquire(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    let acquired = false;

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const owner = db.prepare(`
          SELECT token, pid, incarnation, acquired_at
          FROM locks
          WHERE lock_key = ?
        `).get(key) as { token: string; pid: number; incarnation: string | null; acquired_at: number } | undefined;

        if (!owner) {
          db.prepare(`
            INSERT INTO locks (lock_key, token, pid, incarnation, acquired_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(key, token, this.pid, this.incarnation, now);
          acquired = true;
        } else {
          if (!this.ownerIsActive(owner.pid, owner.incarnation)) {
            db.prepare(`
              UPDATE locks
              SET token = ?, pid = ?, incarnation = ?, acquired_at = ?
              WHERE lock_key = ? AND token = ?
            `).run(token, this.pid, this.incarnation, now, key, owner.token);
            acquired = true;
          }
        }

        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    } finally {
      db.close();
    }

    if (!acquired) return null;
    return {
      token,
      release: () => this.release(key, token),
    };
  }

  tryAcquireShared(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const gate = this.tryAcquire(this.readWriteGateKey(key), options);
    if (!gate) return null;
    const token = randomUUID();
    let db: DatabaseLike;
    try {
      db = this.open();
    } catch (error) {
      gate.release();
      throw error;
    }
    try {
      db.prepare(`
        INSERT INTO read_locks (lock_key, token, pid, incarnation, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, token, this.pid, this.incarnation, Date.now());
    } finally {
      db.close();
      gate.release();
    }
    return {
      token,
      release: () => this.releaseShared(key, token),
    };
  }

  tryAcquireExclusive(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    this.retryPendingReleases(key);
    const gate = this.tryAcquire(this.readWriteGateKey(key), options);
    if (!gate) return null;
    let db: DatabaseLike;
    try {
      db = this.open();
    } catch (error) {
      gate.release();
      throw error;
    }
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    try {
      while (true) {
        let hasReaders = false;
        db.exec('BEGIN IMMEDIATE');
        try {
          const readers = db.prepare(`
            SELECT token, pid, incarnation
            FROM read_locks
            WHERE lock_key = ?
          `).all(key) as Array<{ token: string; pid: number; incarnation: string | null }>;
          for (const reader of readers) {
            if (!this.ownerIsActive(reader.pid, reader.incarnation)) {
              db.prepare('DELETE FROM read_locks WHERE lock_key = ? AND token = ?').run(key, reader.token);
            } else {
              hasReaders = true;
            }
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }

        if (!hasReaders) return gate;
        if (Date.now() >= deadline) {
          gate.release();
          return null;
        }
        sleepSync(Math.min(
          Math.max(1, options.pollMs ?? 10),
          Math.max(1, deadline - Date.now()),
        ));
      }
    } catch (error) {
      gate.release();
      throw error;
    } finally {
      db.close();
    }
  }

  release(key: string, token: string): void {
    const pendingKey = this.pendingReleaseKey(key, token);
    if (this.tryDeleteOwnedLock(key, token, 1, 0)) {
      this.clearPendingRelease(pendingKey);
      return;
    }
    if (pendingReleases.has(pendingKey)) return;
    const pending: PendingRelease = {
      attempt: () => this.tryDeleteOwnedLock(key, token, 1, 0),
      deadline: Date.now() + RELEASE_RETRY_WINDOW_MS,
      nextDelayMs: RELEASE_RETRY_INITIAL_DELAY_MS,
      persistentDelayMs: RELEASE_RETRY_MAX_DELAY_MS,
    };
    pendingReleases.set(pendingKey, pending);
    this.schedulePendingRelease(pendingKey, pending);
  }

  private releaseShared(key: string, token: string): void {
    const pendingKey = this.pendingReleaseKey(key, token);
    if (this.tryDeleteOwnedReadLock(key, token, 1, 0)) {
      this.clearPendingRelease(pendingKey);
      return;
    }
    if (pendingReleases.has(pendingKey)) return;
    const pending: PendingRelease = {
      attempt: () => this.tryDeleteOwnedReadLock(key, token, 1, 0),
      deadline: Date.now() + RELEASE_RETRY_WINDOW_MS,
      nextDelayMs: RELEASE_RETRY_INITIAL_DELAY_MS,
      persistentDelayMs: RELEASE_RETRY_MAX_DELAY_MS,
    };
    pendingReleases.set(pendingKey, pending);
    this.schedulePendingRelease(pendingKey, pending);
  }

  private tryDeleteOwnedLock(
    key: string,
    token: string,
    attempts = 1,
    busyTimeoutMs = 0,
  ): boolean {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        this.deleteOwnedLock(key, token, busyTimeoutMs);
        return true;
      } catch {
      }
    }
    return false;
  }

  private deleteOwnedLock(key: string, token: string, busyTimeoutMs = 0): void {
    const db = this.open(busyTimeoutMs);
    try {
      db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, token);
    } finally {
      db.close();
    }
  }

  private tryDeleteOwnedReadLock(
    key: string,
    token: string,
    attempts = 1,
    busyTimeoutMs = 0,
  ): boolean {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const db = this.open(busyTimeoutMs);
        try {
          db.prepare('DELETE FROM read_locks WHERE lock_key = ? AND token = ?').run(key, token);
        } finally {
          db.close();
        }
        return true;
      } catch {
      }
    }
    return false;
  }

  private ownerIsActive(pid: number, incarnation: string | null): boolean {
    const observedIncarnation = this.probeIncarnation(pid);
    const alive = observedIncarnation !== null || processIsAlive(pid);
    const sameIncarnation = alive
      && incarnation !== null
      && observedIncarnation !== null
      && incarnation === observedIncarnation;
    const unknownIncarnation = alive && (incarnation === null || observedIncarnation === null);
    return sameIncarnation || unknownIncarnation;
  }

  private readWriteGateKey(key: string): string {
    return `read-write-gate:${key}`;
  }

  private retryPendingReleases(key: string): void {
    const prefix = `${path.resolve(this.dbPath)}\0${key}\0`;
    for (const [pendingKey, pending] of [...pendingReleases.entries()]) {
      if (pendingKey.startsWith(prefix) && pending.attempt()) {
        this.clearPendingRelease(pendingKey, pending);
      }
    }
  }

  private schedulePendingRelease(pendingKey: string, pending: PendingRelease): void {
    const remainingMs = pending.deadline - Date.now();
    const persistent = remainingMs <= 0;
    const delayMs = remainingMs > 0
      ? Math.min(pending.nextDelayMs, remainingMs)
      : pending.persistentDelayMs;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      if (pendingReleases.get(pendingKey) !== pending) return;
      if (pending.attempt()) {
        this.clearPendingRelease(pendingKey, pending);
        return;
      }
      if (persistent) {
        pending.persistentDelayMs = Math.min(
          pending.persistentDelayMs * 2,
          RELEASE_PERSISTENT_RETRY_MAX_DELAY_MS,
        );
      } else {
        pending.nextDelayMs = Math.min(pending.nextDelayMs * 2, RELEASE_RETRY_MAX_DELAY_MS);
      }
      this.schedulePendingRelease(pendingKey, pending);
    }, delayMs);
    pending.timer.unref?.();
  }

  private clearPendingRelease(pendingKey: string, expected?: PendingRelease): void {
    const pending = pendingReleases.get(pendingKey);
    if (!pending || (expected && pending !== expected)) return;
    if (pending.timer) clearTimeout(pending.timer);
    pendingReleases.delete(pendingKey);
  }

  private pendingReleaseKey(key: string, token: string): string {
    return `${path.resolve(this.dbPath)}\0${key}\0${token}`;
  }

  private open(busyTimeoutMs = 5_000): DatabaseLike {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const existed = fs.existsSync(this.dbPath);
    const db = new Database(this.dbPath);
    try {
      db.exec(`
        PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))};
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          incarnation TEXT,
          acquired_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS read_locks (
          lock_key TEXT NOT NULL,
          token TEXT PRIMARY KEY,
          pid INTEGER NOT NULL,
          incarnation TEXT,
          acquired_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_read_locks_key ON read_locks(lock_key);
      `);
      const columns = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
      if (!columns.some(({ name }) => name === 'incarnation')) {
        try {
          db.exec('ALTER TABLE locks ADD COLUMN incarnation TEXT');
        } catch (error) {
          const refreshed = db.prepare('PRAGMA table_info(locks)').all() as Array<{ name: string }>;
          if (!refreshed.some(({ name }) => name === 'incarnation')) throw error;
        }
      }
      if (!existed) fs.chmodSync(this.dbPath, 0o600);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}
