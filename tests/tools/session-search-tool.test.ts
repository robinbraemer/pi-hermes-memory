import { describe, it, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerSessionSearchTool } from "../../src/tools/session-search-tool.js";
import { DatabaseManager } from "../../src/store/db.js";
import { indexSession } from "../../src/store/session-indexer.js";

let ROOT_DIR = "";

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

function makeSessionsDir(): string {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-tool-test-"));
  return ROOT_DIR;
}

describe("registerSessionSearchTool", () => {
  it("registers the legacy query schema by default", () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;

    registerSessionSearchTool(mockPi, {} as any);

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /query/);
    assert.match(schema, /sessionId/);
    assert.doesNotMatch(schema, /markdown/);
    assert.match(schema, /"minimum":1/);
    assert.match(schema, /"maximum":20/);
  });

  it("clamps negative and fractional legacy limits before querying", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      for (let index = 0; index < 25; index++) {
        indexSession(dbManager, {
          id: `bounded-limit-session-${index}`,
          project: "bounded-project",
          cwd: "/synthetic/bounded",
          startedAt: "2026-07-11T00:00:00.000Z",
          endedAt: null,
          messages: [{
            id: `bounded-limit-message-${index}`,
            role: "assistant",
            content: `bounded-limit-needle ${index}`,
            timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
          }],
        });
      }
      registerSessionSearchTool(mockPi, dbManager);

      const negative = await captured.execute("tc-negative-limit", {
        query: "bounded-limit-needle",
        limit: -1,
      });
      const fractional = await captured.execute("tc-fractional-limit", {
        query: "bounded-limit-needle",
        limit: 2.9,
      });

      assert.strictEqual(negative.details.count, 1);
      assert.strictEqual(fractional.details.count, 2);
      assert.ok(negative.content[0].text.length < 2_000);
      assert.ok(fractional.content[0].text.length < 4_000);
    } finally {
      dbManager.close();
    }
  });

  it("bounds oversized legacy results and reports truncation without duplicating output in details", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);
    const oversizedContent = `needle ${"x".repeat(6_000_000)}`;

    try {
      indexSession(dbManager, {
        id: "oversized-session",
        project: "oversized-project",
        cwd: "/synthetic/oversized",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "oversized-message",
          role: "assistant",
          content: oversizedContent,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-oversized", { query: "needle" });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.match(output, /needle/);
      assert.doesNotMatch(output, /6000007 chars total/);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.strictEqual(result.details.outputChars, output.length);
      assert.strictEqual(result.details.output, undefined);
      assert.ok(JSON.stringify(result.details).length < 1_000);
    } finally {
      dbManager.close();
    }
  });

  it("offers a bounded snippetChars override for legacy searches", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "bounded-override-session",
        project: "bounded-project",
        cwd: "/synthetic/bounded",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "bounded-override-message",
          role: "assistant",
          content: `needle ${"y".repeat(10_000)}`,
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);

      assert.match(JSON.stringify(captured.parameters), /snippetChars/);
      const result = await captured.execute("tc-bounded-override", {
        query: "needle",
        snippetChars: 2_000,
      });

      assert.strictEqual(result.details.snippetChars, 2_000);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.match(result.content[0].text, /needle/);
      assert.doesNotMatch(result.content[0].text, /10007 chars total/);
      assert.ok(result.content[0].text.length < 3_000);
    } finally {
      dbManager.close();
    }
  });

  it("enforces a hard 50 KiB ceiling across many large legacy results", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      for (let index = 0; index < 20; index++) {
        indexSession(dbManager, {
          id: `aggregate-ceiling-session-${index}`,
          project: `aggregate-project-${index}`,
          cwd: "/synthetic/aggregate",
          startedAt: "2026-07-11T00:00:00.000Z",
          endedAt: null,
          messages: [{
            id: `aggregate-message-${index}`,
            role: "assistant",
            content: `needle-${index} ${"z".repeat(3_000)}`,
            timestamp: `2026-07-11T00:${String(index).padStart(2, "0")}:00.000Z`,
          }],
        });
      }
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-aggregate-ceiling", {
        query: "needle",
        limit: 20,
        snippetChars: 4_000,
      });
      const output = result.content[0].text as string;

      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(result.details.outputTruncated, true);
      assert.strictEqual(result.details.truncatedCount, 1);
      assert.match(output, /output truncated/);
      assert.match(output, /refine the query or lower the result limit/);
    } finally {
      dbManager.close();
    }
  });

  it("bounds the zero-result response without echoing an oversized query", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "zero-result-session",
        project: "zero-result-project",
        cwd: "/synthetic/zero-result",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [{
          id: "zero-result-message",
          role: "assistant",
          content: "indexed haystack",
          timestamp: "2026-07-11T00:01:00.000Z",
        }],
      });
      registerSessionSearchTool(mockPi, dbManager);
      const query = `${" ".repeat(60_000)}missing`;

      const result = await captured.execute("tc-zero-result", { query });
      const output = result.content[0].text as string;

      assert.strictEqual(result.details.count, 0);
      assert.ok(output.length <= 50 * 1024, `expected <= 50 KiB, got ${output.length}`);
      assert.strictEqual(output.includes(query), false);
      assert.ok(JSON.stringify(result.details).length < 1_000);
    } finally {
      dbManager.close();
    }
  });

  it("renders term-local compact refs, context, and ids-only details", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      indexSession(dbManager, {
        id: "synthetic-render-session",
        project: "synthetic-render-project",
        cwd: "/synthetic/private-cwd",
        startedAt: "2026-07-11T00:00:00.000Z",
        endedAt: null,
        messages: [
          { id: "synthetic-render-open", role: "user", content: "synthetic opener prose", timestamp: "2026-07-11T00:00:00.000Z" },
          { id: "synthetic-render-before", role: "user", content: "synthetic previous prose", timestamp: "2026-07-11T00:01:00.000Z" },
          { id: "synthetic-render-anchor", role: "assistant", content: `synthetic-private-payload ${"x".repeat(3_000)} tail-needle`, timestamp: "2026-07-11T00:02:00.000Z" },
          { id: "synthetic-render-after", role: "user", content: "synthetic next prose", timestamp: "2026-07-11T00:03:00.000Z" },
          { id: "synthetic-render-close", role: "assistant", content: "synthetic closer prose", timestamp: "2026-07-11T00:04:00.000Z" },
        ],
      });
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-render", { query: "tail-needle" });
      const output = result.content[0].text as string;
      const serializedDetails = JSON.stringify(result.details);

      assert.match(output, /tail-needle/);
      assert.match(output, /ref: session:synthetic-render-session\/message:synthetic-render-anchor/);
      assert.match(output, /root:synthetic-render-session source:interactive match:exact terms:1\/1/);
      assert.match(output, /context: 1 before, 1 after; 1 earlier, 1 later/);
      assert.ok(output.length <= 50 * 1024);
      assert.deepStrictEqual(result.details.refs, [{
        sessionId: "synthetic-render-session",
        rootSessionId: "synthetic-render-session",
        messageId: "synthetic-render-anchor",
      }]);
      assert.strictEqual(result.details.candidateCount, 1);
      assert.strictEqual(result.details.sourceCount, 1);
      assert.strictEqual(result.details.omittedCount, 0);
      assert.strictEqual(serializedDetails.includes("synthetic-private-payload"), false);
      assert.strictEqual(serializedDetails.includes("private-cwd"), false);
    } finally {
      dbManager.close();
    }
  });

  it("supports a bounded repeat query by session id", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      for (const suffix of ["a", "b"]) {
        indexSession(dbManager, {
          id: `synthetic-repeat-${suffix}`,
          project: "synthetic-repeat-project",
          cwd: "/synthetic/repeat",
          startedAt: "2026-07-11T00:00:00.000Z",
          endedAt: null,
          messages: [{
            id: `synthetic-repeat-message-${suffix}`,
            role: "assistant",
            content: `synthetic repeat needle ${suffix} ${"q".repeat(5_000)}`,
            timestamp: `2026-07-11T00:0${suffix === "a" ? 1 : 2}:00.000Z`,
          }],
        });
      }
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-repeat", {
        query: "synthetic repeat needle",
        sessionId: "synthetic-repeat-a",
        limit: 1,
        snippetChars: 4_000,
      });

      assert.strictEqual(result.details.count, 1);
      assert.strictEqual(result.details.snippetChars, 4_000);
      assert.deepStrictEqual(result.details.refs, [{
        sessionId: "synthetic-repeat-a",
        rootSessionId: "synthetic-repeat-a",
        messageId: "synthetic-repeat-message-a",
      }]);
      assert.doesNotMatch(result.content[0].text, /synthetic-repeat-message-b/);
      assert.ok(result.content[0].text.length <= 50 * 1024);
    } finally {
      dbManager.close();
    }
  });

  it("reports pre-shaping candidates and omissions", async () => {
    let captured: any;
    const mockPi = { registerTool: (def: any) => { captured = def; } } as any;
    const memoryDir = makeSessionsDir();
    const dbManager = new DatabaseManager(memoryDir);

    try {
      for (let index = 0; index < 4; index++) {
        indexSession(dbManager, {
          id: `metadata-session-${index}`,
          project: `metadata-project-${index}`,
          cwd: "/synthetic/metadata",
          source: `source-${index}`,
          startedAt: `2026-07-1${index}T00:00:00.000Z`,
          endedAt: null,
          messages: [{
            id: `metadata-message-${index}`,
            role: "assistant",
            content: "metadata candidate needle",
            timestamp: `2026-07-1${index}T00:01:00.000Z`,
          }],
        });
      }
      registerSessionSearchTool(mockPi, dbManager);

      const result = await captured.execute("tc-metadata", { query: "metadata candidate needle", limit: 2 });

      assert.strictEqual(result.details.count, 2);
      assert.strictEqual(result.details.candidateCount, 4);
      assert.strictEqual(result.details.sourceCount, 4);
      assert.strictEqual(result.details.omittedCount, 2);
    } finally {
      dbManager.close();
    }
  });

  it("registers and executes the anchor markdown-only schema when configured", async () => {
    let captured: any;
    const mockPi = {
      registerTool: (def: any) => { captured = def; },
    } as any;
    const sessionsDir = makeSessionsDir();
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-05-15T10:00:00.000Z",
      sessionId: "session-1",
      cwd: "/synthetic/project",
      message: { role: "user", content: "needle" },
    })}\n`);

    registerSessionSearchTool(mockPi, {} as any, { variant: "anchors" }, { sessionsDir });

    const schema = JSON.stringify(captured.parameters);
    assert.strictEqual(captured.name, "session_search");
    assert.match(schema, /markdown/);
    assert.doesNotMatch(schema, /query/);
    assert.match(captured.description, /all terms must match/);
    assert.match(captured.description, /any requires at least one listed term/);
    assert.match(captured.description, /exclude removes matching ranges/);
    assert.match(captured.description, /Output is plain text: count, optional message/);
    assert.match(captured.description, /path:startLine-endLine with a short reason/);
    assert.match(captured.description, /Example:\nfrom: 2026-05-14/);
    assert.match(captured.promptGuidelines.join("\n"), /Use all for required terms/);

    const empty = await captured.execute("tc-1", { markdown: "" });
    assert.strictEqual(empty.details.success, false);
    assert.strictEqual(empty.details.message, "markdown is required");

    const result = await captured.execute("tc-2", { markdown: "any:\n- needle" });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.deepStrictEqual(result.details.ranges.map((range: any) => ({
      path: range.path,
      startLine: range.startLine,
      endLine: range.endLine,
      reason: range.reason,
    })), [{ path: filePath, startLine: 1, endLine: 1, reason: "matched any: needle" }]);
    assert.strictEqual(result.details.output, result.content[0].text);
    assert.match(result.content[0].text, /^count: 1\nanchors:\n-/);
    assert.match(result.content[0].text, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1-1 — matched any: needle`));
    assert.doesNotMatch(result.content[0].text, /"ranges"/);
    assert.doesNotMatch(result.content[0].text, /"startLine"/);
    assert.doesNotMatch(result.content[0].text, /"sessionId"/);

    const sanitizedSnapshot = {
      parameters: JSON.parse(JSON.stringify(captured.parameters)),
      content: result.content,
      details: {
        success: result.details.success,
        count: result.details.count,
        output: result.details.output,
        ranges: result.details.ranges.map((range: any) => ({
          path: range.path,
          startLine: range.startLine,
          endLine: range.endLine,
          reason: range.reason,
        })),
      },
    };
    assert.deepStrictEqual(sanitizedSnapshot, {
      parameters: {
        type: "object",
        required: ["markdown"],
        properties: {
          markdown: {
            type: "string",
            description: "Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.",
          },
        },
      },
      content: [{ type: "text", text: `count: 1\nanchors:\n- ${filePath}:1-1 — matched any: needle` }],
      details: {
        success: true,
        count: 1,
        output: `count: 1\nanchors:\n- ${filePath}:1-1 — matched any: needle`,
        ranges: [{ path: filePath, startLine: 1, endLine: 1, reason: "matched any: needle" }],
      },
    });
  });
});
