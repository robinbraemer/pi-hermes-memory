import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};

type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;

export interface AtomicLockOptions {
  staleMs: number;
}

export interface AtomicLockLease {
  token: string;
  release: () => void;
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

export class AtomicLockCoordinator {
  constructor(private readonly dbPath: string) {}

  tryAcquire(key: string, options: AtomicLockOptions): AtomicLockLease | null {
    const token = randomUUID();
    const now = Date.now();
    const db = this.open();
    let acquired = false;

    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const owner = db.prepare(`
          SELECT token, pid, acquired_at
          FROM locks
          WHERE lock_key = ?
        `).get(key) as { token: string; pid: number; acquired_at: number } | undefined;

        if (!owner) {
          db.prepare(`
            INSERT INTO locks (lock_key, token, pid, acquired_at)
            VALUES (?, ?, ?, ?)
          `).run(key, token, process.pid, now);
          acquired = true;
        } else if (!processIsAlive(owner.pid) || now - owner.acquired_at > Math.max(0, options.staleMs)) {
          if (!processIsAlive(owner.pid)) {
            db.prepare(`
              UPDATE locks
              SET token = ?, pid = ?, acquired_at = ?
              WHERE lock_key = ? AND token = ?
            `).run(token, process.pid, now, key, owner.token);
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

  release(key: string, token: string): void {
    const db = this.open();
    try {
      db.prepare('DELETE FROM locks WHERE lock_key = ? AND token = ?').run(key, token);
    } finally {
      db.close();
    }
  }

  private open(): DatabaseLike {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const existed = fs.existsSync(this.dbPath);
    const db = new Database(this.dbPath);
    try {
      db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS locks (
          lock_key TEXT PRIMARY KEY,
          token TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at INTEGER NOT NULL
        );
      `);
      if (!existed) fs.chmodSync(this.dbPath, 0o600);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
}
