import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";

const MUTATION_WAIT_MS = 5_000;
const MUTATION_STALE_MS = 300_000;

export async function canonicalMarkdownIdentity(filePath: string): Promise<string> {
  return canonicalStoragePath(filePath);
}

export function markdownLockCoordinatorPath(): string {
  const uid = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  const coordinatorDir = path.join(os.tmpdir(), `pi-hermes-memory-locks${uid}`);
  fs.mkdirSync(coordinatorDir, { recursive: true, mode: 0o700 });
  const state = fs.lstatSync(coordinatorDir);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`Invalid Markdown lock coordinator directory at ${coordinatorDir}`);
  }
  if (typeof process.getuid === "function" && state.uid !== process.getuid()) {
    throw new Error(`Markdown lock coordinator directory is owned by another user at ${coordinatorDir}`);
  }
  if (process.platform !== "win32") fs.chmodSync(coordinatorDir, 0o700);
  return path.join(coordinatorDir, "coordinator.sqlite");
}

export async function acquireMarkdownMutationLock(filePath: string): Promise<AtomicLockLease> {
  const identity = await canonicalMarkdownIdentity(filePath);
  const coordinator = new AtomicLockCoordinator(markdownLockCoordinatorPath());
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
