import * as fs from "node:fs";
import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";

const MUTATION_WAIT_MS = 5_000;
const MUTATION_STALE_MS = 300_000;

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  return canonicalStoragePath(filePath);
}

function nearestExistingDirectory(filePath: string): string {
  let directory = path.dirname(filePath);
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) return directory;
    directory = parent;
  }
  return directory;
}

export async function acquireMarkdownMutationLock(filePath: string): Promise<AtomicLockLease> {
  const identity = await canonicalMarkdownIdentity(filePath);
  const coordinatorDir = nearestExistingDirectory(identity);
  const coordinator = new AtomicLockCoordinator(path.join(coordinatorDir, ".pi-hermes-locks.sqlite"));
  const lockKey = `mutation:${identity}`;
  const deadline = Date.now() + MUTATION_WAIT_MS;
  let lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });

  while (!lease) {
    if (Date.now() >= deadline) {
      throw new Error(`Memory mutation already in progress for ${identity}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    lease = coordinator.tryAcquire(lockKey, { staleMs: MUTATION_STALE_MS });
  }

  return lease;
}

export async function withMarkdownMutationLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
  const lease = await acquireMarkdownMutationLock(filePath);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}
