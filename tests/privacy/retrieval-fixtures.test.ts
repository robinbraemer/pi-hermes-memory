import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';
import { registerSessionSearchTool } from '../../src/tools/session-search-tool.js';

const retrievalTests = [
  'tests/store/search-relevance.test.ts',
  'tests/store/session-search.test.ts',
  'tests/store/sqlite-memory-store.test.ts',
  'tests/tools/session-search-tool.test.ts',
  'tests/tools/memory-search-tool.test.ts',
];

const forbiddenPatterns = [
  { name: 'mac-home-path', pattern: /\/Users\// },
  { name: 'linux-home-path', pattern: /\/home\// },
  { name: 'private-marker', pattern: /BEGIN\s+[^\n]*PRIVATE/i },
  { name: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._~-]{12,}/ },
  { name: 'api-key-prefix', pattern: /(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{16,}/ },
  { name: 'email-address', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: 'phone-number', pattern: /(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)[ -]?)?\d{3}[ -]\d{3}[ -]\d{4}/ },
];

let tempRoot = '';

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = '';
});

function assertSanitized(label: string, content: string): void {
  for (const { name, pattern } of forbiddenPatterns) {
    assert.strictEqual(pattern.test(content), false, `${label}: forbidden ${name}`);
  }

  const quotedAbsolutePaths = content.matchAll(/(['"])(\/[^'"\n]+)\1/g);
  for (const match of quotedAbsolutePaths) {
    assert.ok(match[2].startsWith('/synthetic/'), `${label}: forbidden absolute-path`);
  }
}

function captureTools(dbManager: DatabaseManager): { memory: any; session: any } {
  let memory: any;
  let session: any;
  registerMemorySearchTool({ registerTool: (definition: any) => { memory = definition; } } as any, dbManager);
  registerSessionSearchTool({ registerTool: (definition: any) => { session = definition; } } as any, dbManager);
  return { memory, session };
}

describe('retrieval fixture privacy', () => {
  it('contains only sanitized synthetic retrieval fixture source', () => {
    for (const file of retrievalTests) {
      const absolutePath = path.join(process.cwd(), file);
      assertSanitized(file, fs.readFileSync(absolutePath, 'utf8'));
    }
  });

  it('keeps synthetic private payloads out of both tool details objects', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-retrieval-privacy-'));
    const dbManager = new DatabaseManager(tempRoot);
    try {
      addMemory(dbManager, `synthetic-private-payload ${'x'.repeat(2_000)} synthetic-memory-needle`);
      indexSession(dbManager, {
        id: 'synthetic-private-session',
        project: 'synthetic-private-project',
        cwd: '/synthetic/private-project',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: null,
        messages: [{
          id: 'synthetic-private-message',
          role: 'assistant',
          content: `synthetic-private-payload ${'y'.repeat(2_000)} synthetic-session-needle`,
          timestamp: '2026-01-01T00:01:00Z',
        }],
      });
      const tools = captureTools(dbManager);

      const memoryResult = await tools.memory.execute('synthetic-memory-call', { query: 'synthetic-memory-needle' });
      const sessionResult = await tools.session.execute('synthetic-session-call', { query: 'synthetic-session-needle' });

      assert.strictEqual(JSON.stringify(memoryResult.details).includes('synthetic-private-payload'), false);
      assert.strictEqual(JSON.stringify(sessionResult.details).includes('synthetic-private-payload'), false);
      assert.match(memoryResult.content[0].text, /synthetic-memory-needle/);
      assert.match(sessionResult.content[0].text, /synthetic-session-needle/);
      assert.ok(memoryResult.content[0].text.length <= 50 * 1024);
      assert.ok(sessionResult.content[0].text.length <= 50 * 1024);
    } finally {
      dbManager.close();
    }
  });
});
