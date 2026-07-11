import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { withMarkdownMutationLock } from "../../src/store/markdown-mutation-lock.js";

describe("markdown mutation lock", () => {
  it("stores lock coordination beside a writable canonical target", { skip: process.platform === "win32" }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-permissions-test-"));
    const memoryDir = path.join(tmpDir, "memory");
    const filePath = path.join(memoryDir, "MEMORY.md");
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(filePath, "memory", "utf-8");
    fs.chmodSync(tmpDir, 0o500);

    try {
      const result = await withMarkdownMutationLock(filePath, async () => "mutated");
      assert.equal(result, "mutated");
      assert.equal(fs.existsSync(path.join(memoryDir, ".pi-hermes-locks.sqlite")), true);
      assert.equal(fs.existsSync(path.join(tmpDir, ".pi-hermes-locks.sqlite")), false);
    } finally {
      fs.chmodSync(tmpDir, 0o700);
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

      const second = await withMarkdownMutationLock(filePath, async () => "next mutation");
      assert.equal(second, "next mutation");
      assert.ok(deleteAttempts >= 4);
    } finally {
      prototype.deleteOwnedLock = originalDeleteOwnedLock;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
