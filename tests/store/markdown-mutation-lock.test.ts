import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AtomicLockCoordinator } from "../../src/store/atomic-lock-coordinator.js";
import { withMarkdownMutationLock } from "../../src/store/markdown-mutation-lock.js";

describe("markdown mutation lock", () => {
  it("preserves a committed result and recovers release before the next acquire", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "markdown-lock-test-"));
    const filePath = path.join(tmpDir, "memory", "MEMORY.md");
    const originalRelease = AtomicLockCoordinator.prototype.release;
    let failRelease = true;
    AtomicLockCoordinator.prototype.release = function (key: string, token: string): void {
      if (failRelease) throw new Error("injected release failure");
      return originalRelease.call(this, key, token);
    };

    try {
      const first = await withMarkdownMutationLock(filePath, async () => "committed");
      assert.equal(first, "committed");

      failRelease = false;
      const second = await withMarkdownMutationLock(filePath, async () => "next mutation");
      assert.equal(second, "next mutation");
    } finally {
      AtomicLockCoordinator.prototype.release = originalRelease;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
