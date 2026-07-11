import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory, syncMemoryEntry } from '../../src/store/sqlite-memory-store.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';

let ROOT_DIR = '';

afterEach(() => {
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  return new DatabaseManager(ROOT_DIR);
}

describe('registerMemorySearchTool', () => {
  function captureTool(dbManager: DatabaseManager): any {
    let captured: any;
    registerMemorySearchTool({ registerTool: (definition: any) => { captured = definition; } } as any, dbManager);
    return captured;
  }

  it('bounds a six-million-character entry around a synthetic tail hit', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, `synthetic-private-payload ${'x'.repeat(6_000_000)} synthetic-memory-needle`);
    const captured = captureTool(dbManager);

    const result = await captured.execute('tc-tail', { query: 'synthetic-memory-needle' });
    const output = result.content[0].text as string;

    assert.ok(output.length <= 50 * 1024);
    assert.match(output, /synthetic-memory-needle/);
    assert.strictEqual(result.details.truncatedCount, 1);
    assert.strictEqual(result.details.output, undefined);
    assert.strictEqual(JSON.stringify(result.details).includes('synthetic-private-payload'), false);
    dbManager.close();
  });

  it('enforces the aggregate ceiling across twenty large matches', async () => {
    const dbManager = makeDbManager();
    for (let index = 0; index < 20; index++) {
      addMemory(dbManager, `synthetic-memory-needle-${index} ${'z'.repeat(10_000)}`, 'memory', `synthetic-project-${index}`);
    }
    const captured = captureTool(dbManager);

    const result = await captured.execute('tc-aggregate', {
      query: 'synthetic-memory-needle',
      limit: 20,
      snippetChars: 4_000,
    });
    const output = result.content[0].text as string;

    assert.ok(output.length <= 50 * 1024);
    assert.strictEqual(result.details.outputTruncated, true);
    assert.match(output, /output truncated/);
    dbManager.close();
  });

  it('does not echo an oversized zero-result query', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'synthetic indexed haystack');
    const captured = captureTool(dbManager);
    const query = `${' '.repeat(60_000)}synthetic-missing`;

    const result = await captured.execute('tc-zero', { query });

    assert.strictEqual(result.details.count, 0);
    assert.strictEqual(result.content[0].text.includes(query), false);
    assert.ok(result.content[0].text.length <= 50 * 1024);
    dbManager.close();
  });

  it('clamps and defaults snippetChars and limit symmetrically with session search', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, `synthetic-memory-bound ${'x'.repeat(10_000)}`);
    const captured = captureTool(dbManager);
    const schema = JSON.stringify(captured.parameters);

    const defaults = await captured.execute('tc-defaults', { query: 'synthetic-memory-bound' });
    const minimum = await captured.execute('tc-minimum', { query: 'synthetic-memory-bound', snippetChars: -1, limit: -2 });
    const maximum = await captured.execute('tc-maximum', { query: 'synthetic-memory-bound', snippetChars: 99_999, limit: 99 });

    assert.match(schema, /snippetChars/);
    assert.match(schema, /memoryId/);
    assert.match(schema, /"minimum":100/);
    assert.match(schema, /"maximum":4000/);
    assert.strictEqual(defaults.details.snippetChars, 1_200);
    assert.strictEqual(minimum.details.snippetChars, 100);
    assert.strictEqual(maximum.details.snippetChars, 4_000);
    assert.strictEqual(minimum.details.count, 1);
    assert.strictEqual(maximum.details.count, 1);
    dbManager.close();
  });

  it('returns compact ids-only refs and bounded memoryId deeper reads', async () => {
    const dbManager = makeDbManager();
    const selected = syncMemoryEntry(dbManager, {
      content: `synthetic-private-payload synthetic-memory-repeat needle ${'q'.repeat(5_000)}`,
      target: 'failure',
      project: 'synthetic-project',
      category: 'tool-quirk',
    }).entry;
    addMemory(dbManager, 'synthetic-memory-repeat needle other', 'memory', 'synthetic-other');
    const captured = captureTool(dbManager);

    const result = await captured.execute('tc-repeat', {
      query: 'synthetic-memory-repeat needle',
      memoryId: selected.id,
      limit: 1,
      snippetChars: 4_000,
    });
    const serializedDetails = JSON.stringify(result.details);

    assert.deepStrictEqual(result.details.refs, [{ memoryId: selected.id }]);
    assert.strictEqual(result.details.count, 1);
    assert.strictEqual(result.details.candidateCount, 1);
    assert.strictEqual(result.details.sourceCount, 1);
    assert.strictEqual(result.details.omittedCount, 0);
    assert.strictEqual(result.details.snippetChars, 4_000);
    assert.strictEqual(serializedDetails.includes('synthetic-private-payload'), false);
    assert.match(result.content[0].text, new RegExp(`ref: memory:${selected.id}`));
    assert.ok(result.content[0].text.length <= 50 * 1024);
    dbManager.close();
  });

  it('preserves filters and empty-store behavior', async () => {
    const emptyManager = makeDbManager();
    const emptyTool = captureTool(emptyManager);
    const empty = await emptyTool.execute('tc-empty', { query: 'synthetic' });
    assert.strictEqual(empty.details.success, false);
    const dbManager = emptyManager;
    syncMemoryEntry(dbManager, {
      content: 'synthetic filtered needle',
      target: 'failure',
      project: 'synthetic-filter-project',
      category: 'correction',
    });
    addMemory(dbManager, 'synthetic filtered needle outside', 'memory', 'synthetic-other-project');
    const captured = captureTool(dbManager);
    const filtered = await captured.execute('tc-filtered', {
      query: 'synthetic filtered needle',
      project: 'synthetic-filter-project',
      target: 'failure',
      category: 'correction',
    });
    assert.strictEqual(filtered.details.count, 1);
    assert.match(filtered.content[0].text, /synthetic-filter-project/);
    dbManager.close();
  });

  it('returns a broader natural-language match when strict term matching misses', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", 'user');

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);

    dbManager.close();
  });
});
