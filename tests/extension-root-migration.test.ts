import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  isDatabaseMigrationPending,
  migrateExtensionRoot,
} from "../src/extension-root-migration.js";

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
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async () => {
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

  it("migrates one SQLite snapshot while a checkpoint runs", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    let checkpointTriggered = false;
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("wal_autocheckpoint = 0");
      sourceDb.pragma("busy_timeout = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT)");
      sourceDb.pragma("wal_checkpoint(TRUNCATE)");
      const insert = sourceDb.prepare("INSERT INTO memories VALUES (?)");
      const insertMany = sourceDb.transaction(() => {
        for (let index = 0; index < 500; index++) insert.run(`committed-${index}-${"x".repeat(1024)}`);
      });
      insertMany();

      const result = await migrateExtensionRoot(legacy, target, {
        onDatabaseBackupProgress: () => {
          if (checkpointTriggered) return;
          checkpointTriggered = true;
          sourceDb.pragma("wal_checkpoint(TRUNCATE)");
        },
      });

      assert.equal(checkpointTriggered, true);
      assert.deepStrictEqual(result.criticalFailures, []);
      assert.equal(fs.existsSync(path.join(target, "sessions.db-wal")), false);
      assert.equal(fs.existsSync(path.join(target, "sessions.db-shm")), false);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.equal(
          (migrated.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number }).count,
          500,
        );
        assert.deepStrictEqual(migrated.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      } finally {
        migrated.close();
      }
    } finally {
      sourceDb.close();
    }
  });

  it("holds a write exclusion through snapshot publication and source retirement", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    let concurrentWriteCode = "";
    try {
      sourceDb.pragma("journal_mode = WAL");
      sourceDb.pragma("busy_timeout = 0");
      sourceDb.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('before migration')");

      const result = await migrateExtensionRoot(legacy, target, {
        onDatabaseBackupProgress: () => {
          if (concurrentWriteCode) return;
          try {
            sourceDb.prepare("INSERT INTO memories VALUES (?)").run("raced migration");
          } catch (error) {
            concurrentWriteCode = (error as { code?: string }).code ?? "unknown";
          }
        },
      });

      assert.equal(concurrentWriteCode, "SQLITE_BUSY");
      assert.deepStrictEqual(result.criticalFailures, []);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.deepStrictEqual(
          migrated.prepare("SELECT content FROM memories ORDER BY rowid").all(),
          [{ content: "before migration" }],
        );
      } finally {
        migrated.close();
      }
      assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
    } finally {
      sourceDb.close();
    }
  });

  it("closes the source database before retirement and snapshots the retired generation", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourcePath = path.join(legacy, "sessions.db");
    const sourceDb = new Database(sourcePath);
    sourceDb.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('before migration')");
    sourceDb.close();
    let retirementWriteCompleted = false;

    const result = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        if (path.basename(source) === "sessions.db") {
          const writer = new Database(source, { fileMustExist: true, timeout: 0 });
          try {
            writer.pragma("busy_timeout = 0");
            writer.prepare("INSERT INTO memories VALUES (?)").run("during retirement");
            retirementWriteCompleted = true;
          } finally {
            writer.close();
          }
        }
        await fs.promises.rename(source, destination);
      },
    });

    assert.equal(retirementWriteCompleted, true);
    assert.deepStrictEqual(result.criticalFailures, []);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(
        migrated.prepare("SELECT content FROM memories ORDER BY rowid").all(),
        [{ content: "before migration" }, { content: "during retirement" }],
      );
    } finally {
      migrated.close();
    }
  });

  it("rolls back a failed source retirement so migration can retry", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        throw new Error("injected source retirement failure");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);

    const retried = await migrateExtensionRoot(legacy, target);
    assert.deepStrictEqual(retried.criticalFailures, []);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "legacy" }]);
    } finally {
      migrated.close();
    }
  });

  it("does not delete a destination created while source retirement fails", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        const concurrent = new Database(path.join(target, "sessions.db"));
        concurrent.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('concurrent')");
        concurrent.close();
        throw new Error("injected source retirement failure");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    const concurrent = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(concurrent.prepare("SELECT value FROM retained").all(), [{ value: "concurrent" }]);
    } finally {
      concurrent.close();
    }
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), true);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
    const retried = await migrateExtensionRoot(legacy, target);
    assert.deepStrictEqual(retried.criticalFailures.map(({ name }) => name), ["sessions.db"]);
  });

  it("keeps corrupt generation publication behind the pending boundary", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "sessions.db"), "not sqlite", "utf-8");
    fs.writeFileSync(path.join(legacy, "sessions.db-wal"), "legacy wal", "utf-8");
    const observations: boolean[] = [];

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, destination) => {
        observations.push(isDatabaseMigrationPending(legacy, target));
        await fs.promises.link(source, destination);
      },
    });

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.ok(observations.length >= 1);
    assert.ok(observations.every(Boolean));
    assert.equal(isDatabaseMigrationPending(legacy, target), false);
    assert.equal(fs.readFileSync(path.join(target, "sessions.db"), "utf-8"), "not sqlite");
  });

  it("preserves the retirement directory when rollback restoration is incomplete", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();

    const failed = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        fs.writeFileSync(source, "concurrent legacy successor", "utf-8");
        throw new Error("injected retirement failure after move");
      },
    });

    assert.deepStrictEqual(failed.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    const retirementDirs = fs.readdirSync(legacy).filter((name) => name.startsWith(".sessions-db-retirement-"));
    assert.equal(retirementDirs.length, 1);
    assert.equal(fs.existsSync(path.join(legacy, retirementDirs[0], "sessions.db")), true);
    assert.equal(fs.readFileSync(path.join(legacy, "sessions.db"), "utf-8"), "concurrent legacy successor");
    assert.match(failed.criticalFailures[0].message, /recovery artifacts preserved at/);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
  });

  it("preserves both generations when a legacy successor wins the reservation race", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('retired generation')");
    sourceDb.close();

    const result = await migrateExtensionRoot(legacy, target, {
      retireDatabaseFile: async (source, destination) => {
        await fs.promises.rename(source, destination);
        if (path.basename(source) === "sessions.db") {
          fs.writeFileSync(path.join(legacy, "sessions.db"), "successor generation", "utf-8");
        }
      },
    });

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.match(result.criticalFailures[0].message, /EEXIST/);
    assert.equal(fs.readFileSync(path.join(legacy, "sessions.db"), "utf-8"), "successor generation");
    const retirementDirs = fs.readdirSync(legacy).filter((name) => name.startsWith(".sessions-db-retirement-"));
    assert.equal(retirementDirs.length, 1);
    const retired = new Database(path.join(legacy, retirementDirs[0], "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(retired.prepare("SELECT value FROM retained").all(), [{ value: "retired generation" }]);
    } finally {
      retired.close();
    }
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);
    assert.equal(isDatabaseMigrationPending(legacy, target), true);
  });

  it("blocks a legacy successor through migration cleanup", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('retired generation')");
    sourceDb.close();
    const mutablePromises = fs.promises as any;
    const originalRm = mutablePromises.rm;
    let successorBlocked = false;
    mutablePromises.rm = async (filePath: string, options: unknown) => {
      if (!successorBlocked && path.basename(filePath).startsWith(".sessions-db-migration-")) {
        try {
          fs.writeFileSync(path.join(legacy, "sessions.db"), "late successor", { flag: "wx" });
        } catch (error) {
          successorBlocked = ["EEXIST", "EISDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
        }
      }
      return await originalRm(filePath, options);
    };

    try {
      const result = await migrateExtensionRoot(legacy, target);

      assert.deepStrictEqual(result.criticalFailures, []);
      assert.equal(successorBlocked, true);
      assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
      assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
      const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
      try {
        assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "retired generation" }]);
      } finally {
        migrated.close();
      }
    } finally {
      mutablePromises.rm = originalRm;
    }
  });

  it("preserves the raw generation when backup detects corruption after locking", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('raw generation')");
    sourceDb.close();
    let backupAttempted = false;

    const result = await migrateExtensionRoot(legacy, target, {
      backupDatabase: async () => {
        backupAttempted = true;
        throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
      },
    });

    assert.equal(backupAttempted, true);
    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "raw generation" }]);
    } finally {
      migrated.close();
    }
  });

  it("leaves the legacy SQLite generation retryable when snapshot publish fails", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.pragma("journal_mode = WAL");
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy')");
    sourceDb.close();
    let publishes = 0;

    const result = await migrateExtensionRoot(legacy, target, {
      publishDatabaseFile: async (source, destination) => {
        publishes++;
        if (publishes === 1) throw new Error("injected snapshot publish failure");
        await fs.promises.link(source, destination);
      },
    });

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(publishes, 1);
    for (const name of ["sessions.db", "sessions.db-wal", "sessions.db-shm"]) {
      if (name === "sessions.db") assert.equal(fs.existsSync(path.join(legacy, name)), true);
      assert.equal(fs.existsSync(path.join(target, name)), false);
    }
  });

  it("stops resume when a pending migration has retired only part of the SQLite generation", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-interrupted");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('main generation')");
    sourceDb.close();
    fs.writeFileSync(path.join(legacy, "sessions.db-shm"), "remaining shm", "utf-8");
    fs.writeFileSync(path.join(retirement, "sessions.db-wal"), "retired wal", "utf-8");
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), "interrupted", "utf-8");
    let backupAttempted = false;

    const result = await migrateExtensionRoot(legacy, target, {
      backupDatabase: async () => {
        backupAttempted = true;
      },
    });

    assert.equal(backupAttempted, false);
    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.match(result.criticalFailures[0].message, /recovery artifacts/);
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);
    assert.equal(fs.readFileSync(path.join(retirement, "sessions.db-wal"), "utf-8"), "retired wal");
  });

  it("retries an owned preparing migration with empty staging", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const staging = path.join(target, ".sessions-db-migration-abandoned");
    const retirement = path.join(legacy, ".sessions-db-retirement-abandoned");
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(staging, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('legacy generation')");
    sourceDb.close();
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "preparing",
      retirementDirectory: path.basename(retirement),
      stagingDirectory: path.basename(staging),
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
    assert.equal(fs.existsSync(path.join(legacy, "sessions.db")), false);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(migrated.prepare("SELECT value FROM retained").all(), [{ value: "legacy generation" }]);
    } finally {
      migrated.close();
    }
  });

  it("finishes resume after the complete SQLite generation was published and retired", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-complete");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredDb = new Database(path.join(retirement, "sessions.db"));
    retiredDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('published generation')");
    retiredDb.close();
    const targetDb = path.join(target, "sessions.db");
    fs.copyFileSync(path.join(retirement, "sessions.db"), targetDb);
    const targetState = fs.lstatSync(targetDb);
    const reservationPath = path.join(legacy, "sessions.db");
    fs.mkdirSync(reservationPath);
    const reservationState = fs.lstatSync(reservationPath);
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: path.basename(retirement),
      retiredNames: ["sessions.db"],
      publication: "snapshot",
      targets: {
        "sessions.db": { type: "file", dev: targetState.dev, ino: targetState.ino },
      },
      reservation: { dev: reservationState.dev, ino: reservationState.ino },
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
    assert.equal(fs.existsSync(reservationPath), false);
    assert.equal(fs.existsSync(retirement), false);
    const migrated = new Database(path.join(target, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(
        migrated.prepare("SELECT value FROM retained").all(),
        [{ value: "published generation" }],
      );
    } finally {
      migrated.close();
    }
  });

  it("finishes resume after completed migration retirement cleanup", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-cleaned");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredDb = new Database(path.join(retirement, "sessions.db"));
    retiredDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('published generation')");
    retiredDb.close();
    const targetDb = path.join(target, "sessions.db");
    fs.copyFileSync(path.join(retirement, "sessions.db"), targetDb);
    const targetState = fs.lstatSync(targetDb);
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: path.basename(retirement),
      retiredNames: ["sessions.db"],
      publication: "snapshot",
      targets: {
        "sessions.db": { type: "file", dev: targetState.dev, ino: targetState.ino },
      },
    }), "utf-8");
    fs.rmSync(retirement, { recursive: true });

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
    const migrated = new Database(targetDb, { readonly: true });
    try {
      assert.deepStrictEqual(
        migrated.prepare("SELECT value FROM retained").all(),
        [{ value: "published generation" }],
      );
    } finally {
      migrated.close();
    }
  });

  it("finishes a verified published migration when the legacy root is absent", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(target, { recursive: true });
    const targetDb = path.join(target, "sessions.db");
    const published = new Database(targetDb);
    published.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('published generation')");
    published.close();
    const targetState = fs.lstatSync(targetDb);
    const pendingMarker = path.join(target, ".sessions-db-migration-pending");
    fs.writeFileSync(pendingMarker, JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: ".sessions-db-retirement-cleaned",
      retiredNames: ["sessions.db"],
      publication: "snapshot",
      targets: {
        "sessions.db": { type: "file", dev: targetState.dev, ino: targetState.ino },
      },
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(pendingMarker), false);
    assert.equal(fs.existsSync(legacy), false);
  });

  it("keeps an uncertain pending migration guarded when the legacy root is absent", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(target, { recursive: true });
    const pendingMarker = path.join(target, ".sessions-db-migration-pending");
    fs.writeFileSync(pendingMarker, "interrupted", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(fs.existsSync(pendingMarker), true);
    assert.equal(fs.existsSync(path.join(target, "sessions.db")), false);
  });

  it("keeps cleanup tracked until migration-owned staging is removed", { skip: process.platform === "win32" }, async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    fs.mkdirSync(legacy, { recursive: true });
    const sourceDb = new Database(path.join(legacy, "sessions.db"));
    sourceDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('published generation')");
    sourceDb.close();
    let stagingDir = "";

    const first = await migrateExtensionRoot(legacy, target, {
      backupDatabase: async (source, staged) => {
        fs.copyFileSync(source, staged);
        stagingDir = path.dirname(staged);
        fs.chmodSync(stagingDir, 0o500);
      },
    });

    try {
      assert.deepStrictEqual(first.criticalFailures.map(({ name }) => name), ["sessions.db"]);
      assert.match(first.criticalFailures[0].message, /cleanup/);
      assert.equal(fs.existsSync(stagingDir), true);
      assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), true);

      fs.chmodSync(stagingDir, 0o700);
      const resumed = await migrateExtensionRoot(legacy, target);

      assert.deepStrictEqual(resumed.criticalFailures, []);
      assert.equal(fs.existsSync(stagingDir), false);
      assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
    } finally {
      if (stagingDir && fs.existsSync(stagingDir)) fs.chmodSync(stagingDir, 0o700);
    }
  });

  it("preserves recovery artifacts when a completed destination is not owned by the pending migration", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-unverified");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredDb = new Database(path.join(retirement, "sessions.db"));
    retiredDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('recoverable generation')");
    retiredDb.close();
    const unrelatedDb = new Database(path.join(target, "sessions.db"));
    unrelatedDb.exec("CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('replacement')");
    unrelatedDb.close();
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), "interrupted", "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.match(result.criticalFailures[0].message, /recovery artifacts/);
    assert.equal(fs.existsSync(retirement), true);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), true);
    const preserved = new Database(path.join(retirement, "sessions.db"), { readonly: true });
    try {
      assert.deepStrictEqual(
        preserved.prepare("SELECT value FROM retained").all(),
        [{ value: "recoverable generation" }],
      );
    } finally {
      preserved.close();
    }
  });

  it("preserves recovery artifacts when an owned snapshot symlink is dangling", { skip: process.platform === "win32" }, async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-dangling");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredDb = new Database(path.join(retirement, "sessions.db"));
    retiredDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('recoverable generation')");
    retiredDb.close();
    const linkTarget = path.join(tmpDir, "missing.db");
    fs.symlinkSync(linkTarget, path.join(target, "sessions.db"));
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: path.basename(retirement),
      retiredNames: ["sessions.db"],
      publication: "snapshot",
      targets: {
        "sessions.db": { type: "symlink", target: linkTarget },
      },
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(fs.existsSync(retirement), true);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), true);
  });

  it("preserves a verified retirement directory containing an unexpected entry", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-extra");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredDb = new Database(path.join(retirement, "sessions.db"));
    retiredDb.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('recoverable generation')");
    retiredDb.close();
    fs.writeFileSync(path.join(retirement, "unexpected.txt"), "preserve me", "utf-8");
    const targetPath = path.join(target, "sessions.db");
    fs.copyFileSync(path.join(retirement, "sessions.db"), targetPath);
    const targetState = fs.lstatSync(targetPath);
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: path.basename(retirement),
      retiredNames: ["sessions.db"],
      publication: "snapshot",
      targets: {
        "sessions.db": { type: "file", dev: targetState.dev, ino: targetState.ino },
      },
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures.map(({ name }) => name), ["sessions.db"]);
    assert.equal(fs.readFileSync(path.join(retirement, "unexpected.txt"), "utf-8"), "preserve me");
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), true);
  });

  it("finishes resume for an owned raw corrupt generation without integrity validation", async () => {
    const legacy = path.join(tmpDir, "memory");
    const target = path.join(tmpDir, "pi-hermes-memory");
    const retirement = path.join(legacy, ".sessions-db-retirement-raw");
    fs.mkdirSync(retirement, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const retiredPath = path.join(retirement, "sessions.db");
    const targetPath = path.join(target, "sessions.db");
    fs.writeFileSync(retiredPath, "intentionally preserved corrupt SQLite bytes", "utf-8");
    fs.linkSync(retiredPath, targetPath);
    const targetState = fs.lstatSync(targetPath);
    fs.writeFileSync(path.join(target, ".sessions-db-migration-pending"), JSON.stringify({
      version: 1,
      state: "publishing",
      retirementDirectory: path.basename(retirement),
      retiredNames: ["sessions.db"],
      publication: "raw",
      targets: {
        "sessions.db": { type: "file", dev: targetState.dev, ino: targetState.ino },
      },
    }), "utf-8");

    const result = await migrateExtensionRoot(legacy, target);

    assert.deepStrictEqual(result.criticalFailures, []);
    assert.equal(fs.existsSync(path.join(target, ".sessions-db-migration-pending")), false);
    assert.equal(fs.existsSync(retirement), false);
    assert.equal(fs.readFileSync(targetPath, "utf-8"), "intentionally preserved corrupt SQLite bytes");
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
