import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import {
  canonicalMarkdownIdentity,
  markdownLockCoordinatorPath,
  withMarkdownMutationLock,
} from "../../src/store/markdown-mutation-lock.js";

describe("markdown mutation lock", () => {
  it("uses one stable coordinator before and after target-directory creation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-location-test-"));
    const memoryDir = path.join(tmpDir, "deleted-project", "memory");
    const filePath = path.join(memoryDir, "MEMORY.md");
    const coordinatorPath = markdownLockCoordinatorPath();
    const identityBefore = await canonicalMarkdownIdentity(filePath);
    const coordinator = new AtomicLockCoordinator(coordinatorPath);
    const lease = coordinator.tryAcquire(`mutation:${identityBefore}`, { staleMs: 300_000 });
    assert.ok(lease);

    try {
      fs.mkdirSync(memoryDir, { recursive: true });
      const identityAfter = await canonicalMarkdownIdentity(filePath);
      assert.equal(identityAfter, identityBefore);
      assert.equal(markdownLockCoordinatorPath(), coordinatorPath);
      assert.equal(
        new AtomicLockCoordinator(coordinatorPath).tryAcquire(`mutation:${identityAfter}`, { staleMs: 300_000 }),
        null,
      );
      assert.equal(fs.existsSync(path.join(memoryDir, ".pi-hermes-locks.sqlite")), false);
    } finally {
      lease.release();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not recreate a deleted target scope to coordinate mutations", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-deleted-scope-test-"));
    const memoryDir = path.join(tmpDir, "deleted-project");
    const filePath = path.join(memoryDir, "MEMORY.md");

    try {
      const result = await withMarkdownMutationLock(filePath, async () => "mutated");
      assert.equal(result, "mutated");
      assert.equal(fs.existsSync(memoryDir), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves a committed result and recovers release before the next acquire", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-test-"));
    const filePath = path.join(tmpDir, "memory", "MEMORY.md");
    const prototype = AtomicLockCoordinator.prototype as any;
    const originalDeleteOwnedLock = prototype.deleteOwnedLock;
    let deleteAttempts = 0;
    prototype.deleteOwnedLock = function (key: string, token: string): void {
      deleteAttempts++;
      if (deleteAttempts <= 3) throw new Error("injected release failure");
      return originalDeleteOwnedLock.call(this, key, token);
    };

    try {
      const first = await withMarkdownMutationLock(filePath, async () => "committed");
      assert.equal(first, "committed");
      await new Promise((resolve) => setTimeout(resolve, 75));

      const second = await withMarkdownMutationLock(filePath, async () => "next mutation");
      assert.equal(second, "next mutation");
      assert.ok(deleteAttempts >= 4);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
