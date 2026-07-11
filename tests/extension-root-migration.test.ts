import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateExtensionRoot } from "../src/extension-root-migration.js";

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-root-migration-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrateExtensionRoot", () => {
  it("moves legacy files into new extension root", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(path.join(legacy, "skills", "abc"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "MEMORY.md"), "legacy memory", "utf-8");
    fs.writeFileSync(path.join(legacy, "skills", "abc", "SKILL.md"), "legacy skill", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.ok(fs.existsSync(path.join(target, "MEMORY.md")));
    assert.ok(fs.existsSync(path.join(target, "skills", "abc", "SKILL.md")));
    assert.strictEqual(result.warnings.length, 0);
    assert.ok(result.moved >= 1);
  });

  it("does not overwrite existing target files", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });

    fs.writeFileSync(path.join(legacy, "MEMORY.md"), "legacy memory", "utf-8");
    fs.writeFileSync(path.join(target, "MEMORY.md"), "new memory", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.strictEqual(fs.readFileSync(path.join(target, "MEMORY.md"), "utf-8"), "new memory");
    assert.ok(result.skipped >= 1);
  });

  it("reports a failed sessions database move as critical", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "populated legacy database", "utf-8");

    const result = await migrateExtensionRoot(legacy, target, {
      moveFile: async () => {
        throw new Error("injected sessions.db move failure");
      },
    });

    assert.deepStrictEqual(
      result.criticalFailures.map((failure) => failure.name),
      ["sessions.db"],
    );
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
  });
});
