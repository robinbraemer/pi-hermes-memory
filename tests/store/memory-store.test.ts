/**
 * Unit tests for MemoryStore — core persistent memory with file-backed storage.
 *
 * Uses real file I/O via the hardcoded ~/.pi/agent/memory/ path.
 * Each test isolates via beforeEach/afterEach cleanup with aggressive settling.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";


import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Helpers (module-level) ───

const TEST_MARKER = "[MEMORY-TEST]";
let MEMORY_DIR = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

/** Read raw file content, return "" if missing. */
async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Write a file (creating directories if needed). */
async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/** Delete a file, ignoring errors. */
async function removeFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

function failureEntry(text: string, createdDaysAgo = 0): string {
  const date = dateDaysAgo(createdDaysAgo);
  return `${text} <!-- created=${date}, last=${date} -->`;
}

// ─── Tests ───

describe("MemoryStore", { concurrency: 1 }, () => {
  let memoryPath = "";
  let userPath = "";
  let failurePath = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
    userPath = path.join(MEMORY_DIR, USER_FILE);
    failurePath = path.join(MEMORY_DIR, "failures.md");
  });

  after(async () => {
    // Clean up temp directory
    try {
      await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /** Wait for fire-and-forget atomic write to settle. */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
  }

  /** Aggressively clean both memory files and wait for pending writes. */
  async function cleanSlate(): Promise<void> {
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 250));
    // Remove again in case a pending write sneaked in during the wait
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 50));
  }

  beforeEach(async () => {
    await cleanSlate();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  // ─── add() tests ───

  describe("add()", () => {
    it("persists entry to file and returns success with usage stats", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} project uses pnpm`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "memory");
      assert.ok(result.usage);
      assert.ok(result.usage!.includes("chars"));
      assert.equal(result.entry_count, 1);
      assert.equal(result.message, "Entry added.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} project uses pnpm`));
    });

    it("no-ops on duplicate entry and returns message", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} dup test entry`;
      const r1 = await store.add("memory", entry);
      assert.ok(r1.success);
      assert.equal(r1.entry_count, 1);

      const r2 = await store.add("memory", entry);
      await settle();

      assert.ok(r2.success);
      assert.equal(r2.entry_count, 1);
      assert.equal(r2.message, "Entry already exists (no duplicate added).");

      const raw = await readRaw(memoryPath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("returns error when content would exceed char limit", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 50 }));
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
      assert.ok(result.error!.includes("chars"));
    });

    it("rejects without consolidation when memoryOverflowStrategy is reject", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "reject",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);
      await settle();

      assert.ok(!result.success);
      assert.equal(consolidatorCalled, false);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("evicts oldest entries in file order when memoryOverflowStrategy is fifo-evict", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 150,
        memoryOverflowStrategy: "fifo-evict",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const first = `${TEST_MARKER} fifo first`;
      const second = `${TEST_MARKER} fifo second`;
      const next = `${TEST_MARKER} fifo next`;

      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);
      await settle();

      assert.ok(result.success, result.error);
      assert.equal(consolidatorCalled, false);
      assert.equal(result.message, "Memory updated. Rotated 1 older entry to stay within the limit.");
      assert.deepEqual(result.evicted_entries, [first]);
      assert.equal(result.evicted_count, 1);
      assert.equal(result.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first));
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
      assert.ok(raw.indexOf(second) < raw.indexOf(next));
    });

    it("does not evict when the new entry cannot fit an empty memory", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 80,
        memoryOverflowStrategy: "fifo-evict",
      }));
      await store.loadFromDisk();

      const existing = `${TEST_MARKER} keep me`;
      assert.ok((await store.add("memory", existing)).success);

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(120)}`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(existing));
    });

    it("returns error for empty content", async () => {
      const store = new MemoryStore(makeConfig());

      const result = await await store.add("memory", "   ");
      assert.ok(!result.success);
      assert.equal(result.error, "Content cannot be empty.");
    });

    it("writes to USER.md for 'user' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("user", `${TEST_MARKER} prefers dark mode`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "user");

      const raw = await readRaw(userPath);
      assert.ok(raw.includes(`${TEST_MARKER} prefers dark mode`));

      const memRaw = await readRaw(memoryPath);
      assert.equal(memRaw, "");
    });

    it("writes to MEMORY.md for 'memory' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} uses node 22`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.target, "memory");

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} uses node 22`));
    });

    it("handles content with § delimiter in entry", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} section divider${ENTRY_DELIMITER}continued`;
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles unicode content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} 日本語テスト 🧪`;
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles very long entry near char limit", async () => {
      const limit = 250;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      // Account for metadata overhead (~45 chars for <!-- created=..., last=... -->)
      const entry = `${TEST_MARKER} ${"a".repeat(limit - 100)}`;
      const result = await await store.add("memory", entry);
      await settle();

      assert.ok(result.success, `Expected success but got error: ${result.error}`);
    });

    it("handles sequential adds (two in sequence)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const r1 = await store.add("memory", `${TEST_MARKER} first entry`);
      assert.ok(r1.success, `First add failed: ${r1.error}`);
      await settle();

      const r2 = await store.add("memory", `${TEST_MARKER} second entry`);
      assert.ok(r2.success, `Second add failed: ${r2.error}`);
      await settle();

      assert.equal(r2.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} first entry`));
      assert.ok(raw.includes(`${TEST_MARKER} second entry`));
    });
  });

  describe("addFailure()", () => {
    it("applies failure-target char limits", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 40 }));
      await store.loadFromDisk();

      const result = await store.addFailure(`${TEST_MARKER} ${"x".repeat(120)}`, {
        category: "failure",
      });
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("deduplicates exact failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      await settle();

      assert.ok(first.success);
      assert.equal(first.message, "Failure memory saved: correction");
      assert.ok(second.success);
      assert.equal(second.message, "Entry already exists (no duplicate added).");
      assert.equal(second.entry_count, 1);

      const raw = await readRaw(failurePath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("keeps identical failure text in global and distinct project scopes", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-a",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-b",
      });
      const global = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
      });
      const duplicate = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        project: "project-a",
      });

      assert.ok(first.success);
      assert.ok(second.success);
      assert.equal(second.entry_count, 2);
      assert.ok(global.success);
      assert.equal(global.entry_count, 3);
      assert.equal(duplicate.message, "Entry already exists (no duplicate added).");
      assert.equal(duplicate.entry_count, 3);
      assert.equal(store.getRawEntriesForSync("failure").length, 3);
    });
  });

  // ─── replace() tests ───

  describe("replace()", () => {
    it("updates entry in file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} uses vim`);
      await settle();

      const result = await store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry replaced.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} uses vim`));
      assert.ok(raw.includes(`${TEST_MARKER} uses neovim`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} some entry`);
      await settle();

      const result = await store.replace("memory", "nonexistent substring", "new content");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for multiple matches", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} config: port=8080`);
      await store.add("memory", `${TEST_MARKER} config: port=9090`);
      await settle();

      const result = await store.replace("memory", "config:", `${TEST_MARKER} unified config`);
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("Multiple entries matched"));
      assert.ok(result.matches);
      assert.equal(result.matches!.length, 2);
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "  ", "new content");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("returns error for empty new_content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", `${TEST_MARKER} some entry`, "   ");

      assert.ok(!result.success);
      assert.equal(result.error, "new_content cannot be empty. Use 'remove' to delete entries.");
    });
  });

  // ─── remove() tests ───

  describe("remove()", () => {
    it("removes entry from file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} to be removed`);
      await store.add("memory", `${TEST_MARKER} to keep`);
      await settle();

      const result = await store.remove("memory", `${TEST_MARKER} to be removed`);
      await settle();

      assert.ok(result.success);
      assert.equal(result.message, "Entry removed.");
      assert.equal(result.entry_count, 1);
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} to be removed`));
      assert.ok(raw.includes(`${TEST_MARKER} to keep`));
    });

    it("accepts a pasted memory_search line for normal memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} prefers pnpm over npm`);
      await settle();

      const result = await store.remove("memory", `🧠 [global] ${TEST_MARKER} prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27`);
      await settle();

      assert.ok(result.success);
      const raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });

    it("accepts a pasted memory_search line for failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      await settle();

      const result = await store.remove(
        "failure",
        `⚠️ [global] [correction] [correction] ${TEST_MARKER} use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27`,
      );
      await settle();

      assert.ok(result.success);
      const raw = await readRaw(failurePath);
      assert.equal(raw.trim(), "");
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);
      await settle();

      const result = await store.remove("memory", "nonexistent");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.remove("memory", "  ");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });
  });

  // ─── loadFromDisk() tests ───

  describe("loadFromDisk()", () => {
    it("reads existing MEMORY.md and USER.md correctly", async () => {
      // beforeEach already cleaned slate; write test data
      await writeRaw(memoryPath, `${TEST_MARKER} mem entry 1${ENTRY_DELIMITER}${TEST_MARKER} mem entry 2`);
      await writeRaw(userPath, `${TEST_MARKER} user entry 1`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const memEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();

      assert.deepEqual(memEntries, [`${TEST_MARKER} mem entry 1`, `${TEST_MARKER} mem entry 2`]);
      assert.deepEqual(userEntries, [`${TEST_MARKER} user entry 1`]);
    });

    it("handles missing files gracefully (returns empty)", async () => {
      // beforeEach cleaned slate — files should not exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      assert.deepEqual(store.getMemoryEntries(), []);
      assert.deepEqual(store.getUserEntries(), []);
    });

    it("deduplicates entries preserving order", async () => {
      const entry1 = `${TEST_MARKER} dup original`;
      const entry2 = `${TEST_MARKER} dup second`;
      const entry3 = `${TEST_MARKER} dup third`;

      await writeRaw(memoryPath, [entry1, entry2, entry1, entry3].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = store.getMemoryEntries();
      assert.deepEqual(entries, [entry1, entry2, entry3]);
    });
  });

  // ─── formatForSystemPrompt() tests ───

  describe("formatForSystemPrompt()", () => {
    it("returns frozen snapshot — add after load does not change it", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} original note`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const before = store.formatForSystemPrompt();
      assert.ok(before.includes(`${TEST_MARKER} original note`));

      // Add a new entry — this should NOT affect the snapshot
      await store.add("memory", `${TEST_MARKER} new note after load`);

      const after = store.formatForSystemPrompt();
      assert.equal(before, after, "Snapshot should not change after add");
      assert.ok(!after.includes(`${TEST_MARKER} new note after load`));
    });

    it("returns empty string when no entries", async () => {
      // beforeEach cleaned slate — no entries exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.equal(result, "");
    });

    it("injects recent failure memories by default", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} failure 1`),
        failureEntry(`${TEST_MARKER} failure 2`),
        failureEntry(`${TEST_MARKER} failure 3`),
        failureEntry(`${TEST_MARKER} failure 4`),
        failureEntry(`${TEST_MARKER} failure 5`),
        failureEntry(`${TEST_MARKER} failure 6`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(result.includes(`${TEST_MARKER} failure 1`));
      assert.ok(result.includes(`${TEST_MARKER} failure 5`));
      assert.ok(!result.includes(`${TEST_MARKER} failure 6`), "default should preserve existing first-5 slice behavior");
    });

    it("does not inject failure memories when disabled", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} regular memory`);
      await writeRaw(failurePath, failureEntry(`${TEST_MARKER} disabled failure`));

      const store = new MemoryStore(makeConfig({ failureInjectionEnabled: false }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} regular memory`));
      assert.ok(!result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(!result.includes(`${TEST_MARKER} disabled failure`));
    });

    it("respects configured failure injection max entries", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} max entry 1`),
        failureEntry(`${TEST_MARKER} max entry 2`),
        failureEntry(`${TEST_MARKER} max entry 3`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxEntries: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} max entry 1`));
      assert.ok(result.includes(`${TEST_MARKER} max entry 2`));
      assert.ok(!result.includes(`${TEST_MARKER} max entry 3`));
    });

    it("respects configured failure injection max age days", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} recent failure`, 1),
        failureEntry(`${TEST_MARKER} old failure`, 3),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxAgeDays: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} recent failure`));
      assert.ok(!result.includes(`${TEST_MARKER} old failure`));
    });

    it("includes both memory and user blocks when both have entries", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} mem data`);
      await writeRaw(userPath, `${TEST_MARKER} user data`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      // Content should be present inside fenced blocks
      assert.ok(result.includes("<memory-context>"), "should use context fencing");
      assert.ok(result.includes("PERSISTENT MEMORY"), "should have guard note");
      assert.ok(result.includes("NOT new user input"), "should disclaim as not user input");
      assert.ok(result.includes("END MEMORY"), "should close fence");
      assert.ok(result.includes("</memory-context>"), "should close XML tag");
      assert.ok(result.includes("MEMORY"), "should contain MEMORY header");
      assert.ok(result.includes("USER PROFILE"), "should contain USER PROFILE header");
      assert.ok(result.includes(`${TEST_MARKER} mem data`));
      assert.ok(result.includes(`${TEST_MARKER} user data`));
    });
  });

  // ─── Atomic writes ───

  describe("atomic writes", () => {
    it("file content is correct after write (read back and check)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = [
        `${TEST_MARKER} first atomic entry`,
        `${TEST_MARKER} second atomic entry`,
      ];

      await store.add("memory", entries[0]);
      await settle();
      await store.add("memory", entries[1]);
      await settle();


      const raw = await readRaw(memoryPath);
      const parsed = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);

      // Strip metadata comments for comparison (entries now include <!-- created=..., last=... -->)
      const stripped = parsed.map((e) => e.replace(/\s*<!--.*?-->\s*$/, "").trim());
      assert.deepEqual(stripped, entries);
    });

    it("file is empty after all entries are removed", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      await store.remove("memory", `${TEST_MARKER} temporary entry`);
      await settle();

      raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });
  });

  // ─── Both targets ───

  describe("both targets", () => {
    it("add to 'user' goes to USER.md, add to 'memory' goes to MEMORY.md", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("user", `${TEST_MARKER} user fact`);
      await store.add("memory", `${TEST_MARKER} memory fact`);
      await settle();

      const userRaw = await readRaw(userPath);
      const memRaw = await readRaw(memoryPath);

      assert.ok(userRaw.includes(`${TEST_MARKER} user fact`));
      assert.ok(!userRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(memRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(!memRaw.includes(`${TEST_MARKER} user fact`));
    });
  });

  describe("external file changes", () => {
    async function replaceOnDiskSameSize(from: string, to: string): Promise<void> {
      assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
      const before = await readRaw(memoryPath);
      const after = before.replace(from, to);
      assert.notEqual(after, before);
      assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
      await writeRaw(memoryPath, after);
    }

    it("add preserves a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.add("memory", `${TEST_MARKER} appended`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /fresh-B/);
      assert.match(raw, /appended/);
      assert.doesNotMatch(raw, /stale-A/);
    });

    it("replace sees a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.replace("memory", `${TEST_MARKER} fresh-B`, `${TEST_MARKER} replaced`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /replaced/);
      assert.doesNotMatch(raw, /fresh-B|stale-A/);
    });

    it("remove sees a same-size external rewrite", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} stale-A`);
      await settle();

      await replaceOnDiskSameSize("stale-A", "fresh-B");
      const result = await store.remove("memory", `${TEST_MARKER} fresh-B`);
      await settle();

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.doesNotMatch(raw, /fresh-B|stale-A/);
    });

    it("reapplies an add when an external write lands immediately before rename", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      await store.add("memory", `${TEST_MARKER} existing`);

      const originalSave = (store as any).saveToDisk.bind(store);
      let injected = false;
      (store as any).saveToDisk = async (target: "memory") => {
        if (!injected) {
          injected = true;
          const current = await readRaw(memoryPath);
          await writeRaw(memoryPath, `${current}${ENTRY_DELIMITER}${TEST_MARKER} external editor`);
        }
        return originalSave(target);
      };

      const result = await store.add("memory", `${TEST_MARKER} local add`);

      assert.equal(result.success, true);
      const raw = await readRaw(memoryPath);
      assert.match(raw, /external editor/);
      assert.match(raw, /local add/);
      assert.equal(raw.match(/external editor/g)?.length, 1);
      assert.equal(raw.match(/local add/g)?.length, 1);
    });

    it("serializes concurrent mutations of the same canonical target", async () => {
      const firstStore = new MemoryStore(makeConfig());
      const secondStore = new MemoryStore(makeConfig());
      await Promise.all([firstStore.loadFromDisk(), secondStore.loadFromDisk()]);

      const originalSave = (firstStore as any).saveToDisk.bind(firstStore);
      let releaseFirst!: () => void;
      const firstCanSave = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstEntered!: () => void;
      const firstEnteredSave = new Promise<void>((resolve) => { firstEntered = resolve; });
      (firstStore as any).saveToDisk = async (target: "memory") => {
        firstEntered();
        await firstCanSave;
        await originalSave(target);
      };

      const first = firstStore.add("memory", `${TEST_MARKER} first writer`);
      await firstEnteredSave;
      const second = secondStore.add("memory", `${TEST_MARKER} second writer`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseFirst();
      await Promise.all([first, second]);

      const raw = await readRaw(memoryPath);
      assert.match(raw, /first writer/);
      assert.match(raw, /second writer/);
    });

    it("allows different targets to mutate concurrently", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const originalSave = (store as any).saveToDisk.bind(store);
      let releaseMemory!: () => void;
      const memoryCanSave = new Promise<void>((resolve) => { releaseMemory = resolve; });
      let memoryEntered!: () => void;
      const memoryEnteredSave = new Promise<void>((resolve) => { memoryEntered = resolve; });
      (store as any).saveToDisk = async (target: "memory" | "user") => {
        if (target === "memory") {
          memoryEntered();
          await memoryCanSave;
        }
        await originalSave(target);
      };

      const memoryWrite = store.add("memory", `${TEST_MARKER} blocked memory writer`);
      await memoryEnteredSave;
      const userWrite = store.add("user", `${TEST_MARKER} independent user writer`);
      const outcome = await Promise.race([
        userWrite.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
      ]);
      releaseMemory();
      const [, userResult] = await Promise.all([memoryWrite, userWrite]);

      assert.equal(outcome, "completed");
      assert.equal(userResult.success, true);
      assert.match(await readRaw(userPath), /independent user writer/);
    });

  });
});
