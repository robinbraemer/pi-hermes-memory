import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applyReviewOperations,
  buildDirectReviewCompletionOptions,
  parseReviewOperations,
} from "../../src/handlers/review-memory-ops.js";
import { DatabaseManager } from "../../src/store/db.js";
import { reconcileMarkdownMemoryScope } from "../../src/store/sqlite-memory-store.js";

function mockModel(reasoning: boolean): Model<Api> {
  return {
    id: "test-model",
    provider: "test",
    api: "openai-completions",
    reasoning,
  } as Model<Api>;
}

describe("buildDirectReviewCompletionOptions", () => {
  it("forwards auth env and preserves reasoning level", () => {
    const signal = new AbortController().signal;
    const options = buildDirectReviewCompletionOptions(
      mockModel(true),
      {
        apiKey: "sk-test",
        headers: { "X-Test": "1" },
        env: { CUSTOM_BASE_URL: "https://proxy.example" },
      },
      "minimal",
      signal,
    );

    assert.strictEqual(options.apiKey, "sk-test");
    assert.deepStrictEqual(options.headers, { "X-Test": "1" });
    assert.deepStrictEqual(options.env, { CUSTOM_BASE_URL: "https://proxy.example" });
    assert.strictEqual(options.reasoning, "minimal");
    assert.strictEqual(options.signal, signal);
  });

  it("omits reasoning when thinking is off or model does not support it", () => {
    const signal = new AbortController().signal;
    const off = buildDirectReviewCompletionOptions(
      mockModel(true),
      { apiKey: "sk-test" },
      "off",
      signal,
    );
    const nonReasoning = buildDirectReviewCompletionOptions(
      mockModel(false),
      { apiKey: "sk-test" },
      "high",
      signal,
    );

    assert.strictEqual(off.reasoning, undefined);
    assert.strictEqual(nonReasoning.reasoning, undefined);
  });
});

describe("parseReviewOperations", () => {
  it("parses valid JSON operations", () => {
    const parsed = parseReviewOperations(JSON.stringify({
      operations: [
        { action: "add", target: "memory", content: "uses pnpm" },
      ],
    }));

    assert.deepStrictEqual(parsed, [
      { action: "add", target: "memory", content: "uses pnpm" },
    ]);
  });

  it("returns empty array for nothing-to-save text", () => {
    assert.deepStrictEqual(parseReviewOperations("Nothing to save."), []);
  });

  it("returns null for invalid JSON", () => {
    assert.strictEqual(parseReviewOperations("not json at all"), null);
  });

  it("extracts JSON from fenced blocks", () => {
    const parsed = parseReviewOperations("```json\n{\"operations\":[{\"action\":\"add\",\"target\":\"user\",\"content\":\"prefers dark mode\"}]}\n```");
    assert.deepStrictEqual(parsed, [
      { action: "add", target: "user", content: "prefers dark mode" },
    ]);
  });
});

describe("applyReviewOperations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-ops-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies add operations to memory store", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "prefers biome over eslint" },
    ]);

    assert.strictEqual(result.appliedCount, 1);
    assert.strictEqual(result.skippedCount, 0);
    assert.ok(store.getMemoryEntries().some((entry) => entry.includes("prefers biome over eslint")));
  });

  it("skips project operations when project store is unavailable", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "project", content: "api uses /v2" },
    ]);

    assert.strictEqual(result.appliedCount, 0);
    assert.strictEqual(result.skippedCount, 1);
  });

  it("rejects operations outside an allowed target set", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const result = await applyReviewOperations(store, null, [
      { action: "add", target: "memory", content: "allowed memory fact" },
      { action: "add", target: "user", content: "disallowed user fact" },
    ], null, null, ["memory"]);

    assert.strictEqual(result.appliedCount, 1);
    assert.strictEqual(result.skippedCount, 1);
    assert.deepStrictEqual(store.getMemoryEntries(), ["allowed memory fact"]);
    assert.deepStrictEqual(store.getUserEntries(), []);
  });

  it("rolls back every intended operation when an atomic batch is partially rejected", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 160,
      userCharLimit: 5000,
      memoryOverflowStrategy: "reject",
      autoConsolidate: false,
    } as any);
    await store.loadFromDisk();
    await store.add("memory", "synthetic original entry one occupies capacity");
    await store.add("memory", "synthetic original entry two occupies capacity");
    const before = store.getRawEntriesForSync("memory");

    const result = await (applyReviewOperations as any)(store, null, [
      { action: "add", target: "memory", content: "synthetic replacement entry that cannot fit before removals" },
      { action: "remove", target: "memory", old_text: "synthetic original entry one" },
    ], null, null, ["memory"], { atomic: true });

    assert.deepStrictEqual(result, { appliedCount: 0, skippedCount: 2 });
    assert.deepStrictEqual(store.getRawEntriesForSync("memory"), before);
  });

  it("reports all-rejected direct operations as a fallback result", async () => {
    const reviewModule = await import("../../src/handlers/review-memory-ops.js") as Record<string, unknown>;
    assert.strictEqual(typeof reviewModule.applyDirectReviewOperations, "function");
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: false,
    } as any);
    await store.loadFromDisk();

    const result = await (reviewModule.applyDirectReviewOperations as Function)(store, null, [
      { action: "add", target: "user", content: "synthetic disallowed preference" },
    ], null, null, { allowedTargets: ["memory"] });

    assert.deepStrictEqual(result, {
      ok: false,
      appliedCount: 0,
      skippedCount: 1,
      fallbackReason: "operations_rejected",
    });
  });

  it("uses the in-lock mutation observer as the sole SQLite reconciliation path", async () => {
    const store = new MemoryStore({
      memoryDir: tmpDir,
      memoryCharLimit: 5000,
      userCharLimit: 5000,
      autoConsolidate: true,
    });
    await store.loadFromDisk();

    const dbManager = new DatabaseManager(path.join(tmpDir, "db"));
    const originalGetDb = dbManager.getDb.bind(dbManager);
    let insideObserver = false;
    (dbManager as any).getDb = () => {
      if (!insideObserver) throw new Error("out-of-lock SQLite access");
      return originalGetDb();
    };
    store.setMutationObserver((_target, entries) => {
      insideObserver = true;
      try {
        reconcileMarkdownMemoryScope(dbManager, entries, "memory", null);
      } finally {
        insideObserver = false;
      }
      return null;
    });

    try {
      const result = await applyReviewOperations(store, null, [
        { action: "add", target: "memory", content: "observer owns reconciliation" },
      ], dbManager);

      assert.strictEqual(result.appliedCount, 1);
    } finally {
      dbManager.close();
    }
  });
});
