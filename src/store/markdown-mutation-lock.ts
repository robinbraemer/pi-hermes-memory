import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";

const MUTATION_WAIT_MS = 5_000;
const MUTATION_STALE_MS = 300_000;
const RELEASE_ATTEMPTS = 3;
const pendingReleases = new Map<string, () => void>();

function releaseBestEffort(identity: string, release: () => void): void {
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    try {
      release();
      if (pendingReleases.get(identity) === release) pendingReleases.delete(identity);
      return;
    } catch {
    }
  }
  pendingReleases.set(identity, release);
}

function retryPendingRelease(identity: string): void {
  const pending = pendingReleases.get(identity);
  if (pending) releaseBestEffort(identity, pending);
}

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  let candidate = resolvedPath;
  const suffix: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(candidate), ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolvedPath;
      suffix.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function acquireMarkdownMutationLock(filePath: string): Promise<AtomicLockLease> {
  const identity = await canonicalMarkdownIdentity(filePath);
  retryPendingRelease(identity);
  const coordinatorDir = path.dirname(path.dirname(identity));
  const coordinator = new AtomicLockCoordinator(path.join(coordinatorDir, ".pi-hermes-locks.sqlite"));
  const lockKey = `mutation:${identity}`;
  const deadline = Date.now() + MUTATION_WAIT_MS;
  let lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });

  while (!lease) {
    if (Date.now() >= deadline) {
      throw new Error(`Memory mutation already in progress for ${identity}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    retryPendingRelease(identity);
    lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });
  }

  const release = lease.release;
  return {
    token: lease.token,
    release: () => releaseBestEffort(identity, release),
  };
}

export async function withMarkdownMutationLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
  const lease = await acquireMarkdownMutationLock(filePath);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}
