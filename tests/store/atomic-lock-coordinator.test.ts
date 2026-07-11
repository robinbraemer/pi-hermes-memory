import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { AtomicLockCoordinator } from '../../src/store/atomic-lock-coordinator.js';

describe('AtomicLockCoordinator', () => {
  it('cannot release a successor with a stale ownership token', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const dbPath = path.join(tmpDir, 'locks.sqlite');
    const moduleUrl = new URL('../../src/store/atomic-lock-coordinator.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { AtomicLockCoordinator } from ${JSON.stringify(moduleUrl)};
       const coordinator = new AtomicLockCoordinator(process.argv[1]);
       const lease = coordinator.tryAcquire('shared-target', { staleMs: 60_000 });
       if (!lease) process.exit(2);
       process.stdout.write(lease.token);`,
      dbPath,
    ], { encoding: 'utf-8' });

    try {
      assert.strictEqual(child.status, 0, child.stderr);
      const coordinator = new AtomicLockCoordinator(dbPath);
      const successor = coordinator.tryAcquire('shared-target', { staleMs: 60_000 });
      assert.ok(successor, 'dead owner should be replaced atomically');

      coordinator.release('shared-target', child.stdout);

      assert.strictEqual(
        coordinator.tryAcquire('shared-target', { staleMs: 0 }),
        null,
        'stale release must not delete the successor',
      );
      successor.release();
      assert.ok(coordinator.tryAcquire('shared-target', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps live owners and distinct keys independent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const first = coordinator.tryAcquire('first', { staleMs: 0 });
      assert.ok(first);
      assert.strictEqual(coordinator.tryAcquire('first', { staleMs: 0 }), null);
      assert.ok(coordinator.tryAcquire('second', { staleMs: 0 }));
      first.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows shared leases together and excludes them from exclusive leases', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const first = coordinator.tryAcquireShared('database-access', { staleMs: 0 });
      const second = coordinator.tryAcquireShared('database-access', { staleMs: 0 });
      assert.ok(first);
      assert.ok(second);
      assert.strictEqual(coordinator.tryAcquireExclusive('database-access', { staleMs: 0 }), null);

      first.release();
      second.release();
      const exclusive = coordinator.tryAcquireExclusive('database-access', { staleMs: 0 });
      assert.ok(exclusive);
      assert.strictEqual(coordinator.tryAcquireShared('database-access', { staleMs: 0 }), null);
      exclusive.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps new readers behind an exclusive waiter while readers drain', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const dbPath = path.join(tmpDir, 'locks.sqlite');
    const coordinator = new AtomicLockCoordinator(dbPath);
    const reader = coordinator.tryAcquireShared('database-access', { staleMs: 0 });
    assert.ok(reader);
    const moduleUrl = new URL('../../src/store/atomic-lock-coordinator.ts', import.meta.url).href;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { AtomicLockCoordinator } from ${JSON.stringify(moduleUrl)};
       const coordinator = new AtomicLockCoordinator(process.argv[1]);
       process.stdout.write('waiting\\n');
       const lease = coordinator.tryAcquireExclusive('database-access', {
         staleMs: 60_000,
         waitMs: 1_000,
         pollMs: 5,
       });
       process.stdout.write(lease ? 'acquired\\n' : 'missed\\n');
       lease?.release();`,
      dbPath,
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let waiterStarted: (() => void) | null = null;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('waiting')) waiterStarted?.();
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const childExit = new Promise<number | null>((resolve) => child.once('exit', resolve));

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('exclusive waiter did not start')), 2_000);
        waiterStarted = () => {
          clearTimeout(timeout);
          resolve();
        };
        if (stdout.includes('waiting')) waiterStarted();
      });
      const lockDb = new Database(dbPath);
      const gateDeadline = Date.now() + 2_000;
      let gateHeld = false;
      try {
        const readGate = lockDb.prepare('SELECT 1 FROM locks WHERE lock_key = ?');
        while (!gateHeld && Date.now() < gateDeadline) {
          gateHeld = readGate.get('read-write-gate:database-access') !== undefined;
          if (!gateHeld) await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        lockDb.close();
      }
      assert.strictEqual(gateHeld, true);
      assert.strictEqual(coordinator.tryAcquireShared('database-access', { staleMs: 0 }), null);
      reader.release();
      const code = await childExit;
      assert.strictEqual(code, 0, stderr);
      assert.match(stdout, /acquired/);
    } finally {
      reader.release();
      if (child.exitCode === null) child.kill();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('takes over a reused PID without taking over the original incarnation', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const dbPath = path.join(tmpDir, 'locks.sqlite');
      let observedIncarnation = 'owner-start';
      const owner = new AtomicLockCoordinator(dbPath, {
        pid: 4242,
        incarnation: 'owner-start',
        probeIncarnation: () => observedIncarnation,
      });
      assert.ok(owner.tryAcquire('shared', { staleMs: 0 }));

      const contender = new AtomicLockCoordinator(dbPath, {
        pid: 4242,
        incarnation: 'successor-start',
        probeIncarnation: () => observedIncarnation,
      });
      assert.strictEqual(contender.tryAcquire('shared', { staleMs: 0 }), null);

      observedIncarnation = 'successor-start';
      assert.ok(contender.tryAcquire('shared', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps a live owner when either incarnation probe is unavailable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    try {
      const dbPath = path.join(tmpDir, 'locks.sqlite');
      const owner = new AtomicLockCoordinator(dbPath, {
        pid: process.pid,
        probeIncarnation: () => null,
      });
      const lease = owner.tryAcquire('shared', { staleMs: 0 });
      assert.ok(lease);

      const contender = new AtomicLockCoordinator(dbPath, {
        pid: process.pid,
        incarnation: 'known-later',
        probeIncarnation: () => 'known-later',
      });
      assert.strictEqual(contender.tryAcquire('shared', { staleMs: 0 }), null);

      lease.release();
      assert.ok(contender.tryAcquire('shared', { staleMs: 0 }));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retries a failed owner release before the next same-process acquisition', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error('injected release failure');
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const first = coordinator.tryAcquire('shared', { staleMs: 60_000 });
      assert.ok(first);
      assert.doesNotThrow(() => first.release());

      const second = coordinator.tryAcquire('shared', { staleMs: 60_000 });
      assert.ok(second);
      assert.equal(deleteAttempts, 4);
      second.release();
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('continues an expired shared release so another process can recover', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalTryDeleteOwnedReadLock = prototype.tryDeleteOwnedReadLock;
    const originalDateNow = Date.now;
    let deletionBlocked = true;
    prototype.tryDeleteOwnedReadLock = function (key: string, token: string): boolean {
      return deletionBlocked ? false : originalTryDeleteOwnedReadLock.call(this, key, token);
    };

    try {
      const coordinator = new AtomicLockCoordinator(path.join(tmpDir, 'locks.sqlite'));
      const reader = coordinator.tryAcquireShared('database-access', { staleMs: 60_000 });
      assert.ok(reader);
      const now = originalDateNow();
      let nowCalls = 0;
      Date.now = () => nowCalls++ === 0 ? now : now + 60_000;
      reader.release();
      Date.now = originalDateNow;
      deletionBlocked = false;
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      const moduleUrl = new URL('../../src/store/atomic-lock-coordinator.ts', import.meta.url).href;
      const child = spawnSync(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { AtomicLockCoordinator } from ${JSON.stringify(moduleUrl)};
         const coordinator = new AtomicLockCoordinator(process.argv[1]);
         const lease = coordinator.tryAcquireExclusive('database-access', { staleMs: 60_000 });
         if (!lease) process.exit(2);
         lease.release();`,
        path.join(tmpDir, 'locks.sqlite'),
      ], { encoding: 'utf-8' });
      assert.strictEqual(child.status, 0, child.stderr);
    } finally {
      Date.now = originalDateNow;
      prototype.tryDeleteOwnedReadLock = originalTryDeleteOwnedReadLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retries a failed owner release independently so another process can acquire', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lock-test-'));
    const dbPath = path.join(tmpDir, 'locks.sqlite');
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    let releaseFailureEndsAt = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (Date.now() < releaseFailureEndsAt) throw new Error('injected release failure');
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const owner = new AtomicLockCoordinator(dbPath);
      const lease = owner.tryAcquire('shared', { staleMs: 60_000 });
      assert.ok(lease);
      releaseFailureEndsAt = Date.now() + 150;
      lease.release();
      await new Promise((resolve) => setTimeout(resolve, 250));

      const moduleUrl = new URL('../../src/store/atomic-lock-coordinator.ts', import.meta.url).href;
      const child = spawnSync(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { AtomicLockCoordinator } from ${JSON.stringify(moduleUrl)};
         const coordinator = new AtomicLockCoordinator(process.argv[1]);
         const lease = coordinator.tryAcquire('shared', { staleMs: 60_000 });
         if (!lease) process.exit(2);
         lease.release();`,
        dbPath,
      ], { encoding: 'utf-8' });

      assert.ok(deleteAttempts > 3);
      assert.strictEqual(child.status, 0, child.stderr);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
