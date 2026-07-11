import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

  it("publishes the complete SQLite generation and removes the legacy set", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("wal_autocheckpoint = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT)");
      sourceDb.pragma("wal_checkpoint(TRUNCATE)");
      sourceDb.prepare("INSERT INTO memories VALUES (?)").run("committed only in WAL");
      assert.equal(fs.existsSync(path.join(legacy, "sessions.db-wal")), true);

      const result = await migrateExtensionRoot(legacy, target);

      assert.deepStrictEqual(result.criticalFailures, []);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.equal(
          (migrated.prepare("SELECT content FROM memories").get() as { content: string }).content,
          "committed only in WAL",
        );
      } finally {
        migrated.close();
      }
      for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
        assert.equal(fs.existsSync(path.join(legacy, name)), false);
      }
    } finally {
      sourceDb.close();
    }
  });

  it("rolls back a partial SQLite publish and leaves the legacy generation retryable", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "database generation", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-wal"), "committed wal rows", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-shm"), "shared memory", "utf-8");
    let publishes = 0;

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, destination) => {
        publishes++;
        if (publishes === 2) throw new Error("injected sidecar publish failure");
        await fs.promises.link(source, destination);
      },
    });

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
      assert.equal(fs.existsSync(path.join(legacy, name)), true);
      assert.equal(fs.existsSync(path.join(target, name)), false);
    }
  });

  it("never mixes legacy sidecars into an existing destination generation", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "legacy database", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-wal"), "legacy wal", "utf-8");
    fs.writeFileSync(path.join(target, "sessions.db"), "destination database", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.readFileSync(path.join(target, "sessions.db"), "utf-8"), "destination database");
    assert.equal(fs.existsSync(path.join(target, "sessions.db-wal")), false);
    assert.equal(fs.readFileSync(path.join(legacy, "sessions.db-wal"), "utf-8"), "legacy wal");
  });
});
