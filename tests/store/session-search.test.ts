import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseManager } from '../../src/store/db.js';
import { indexSession } from '../../src/store/session-indexer.js';
import { searchSessions, getIndexedMessageCount } from '../../src/store/session-search.js';
import type { ParsedSession } from '../../src/store/session-parser.js';

describe('session-search', () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
    const id = overrides.id ?? 'session-1';
    return {
      id,
      project: 'test-project',
      cwd: '/synthetic/test',
      startedAt: '2026-05-03T00:00:00Z',
      endedAt: null,
      parentSessionId: null,
      source: 'interactive',
      messages: [
        { id: `${id}-msg-1`, role: 'user', content: 'How do I set up Prisma with PostgreSQL?', timestamp: '2026-05-03T00:01:00Z' },
        { id: `${id}-msg-2`, role: 'assistant', content: 'To set up Prisma, install the package and run prisma init. Then configure your DATABASE_URL in .env', timestamp: '2026-05-03T00:01:30Z' },
        { id: `${id}-msg-3`, role: 'user', content: 'What about database migrations?', timestamp: '2026-05-03T00:02:00Z' },
        { id: `${id}-msg-4`, role: 'assistant', content: 'Use prisma migrate dev to create migrations. This generates SQL files and applies them.', timestamp: '2026-05-03T00:02:30Z' },
        { id: `${id}-msg-5`, role: 'user', content: 'What about gpu timeout issue debugging?', timestamp: '2026-05-03T00:03:00Z' },
        { id: `${id}-msg-6`, role: 'assistant', content: 'This exact phrase memory search example helps verify phrase queries.', timestamp: '2026-05-03T00:03:30Z' },
      ],
      ...overrides,
    };
  }

  describe('searchSessions', () => {
    it('widens the scan and demotes synthetic automation without excluding it', () => {
      for (let index = 0; index < 59; index++) {
        indexSession(dbManager, createTestSession({
          id: `synthetic-cron-${String(index).padStart(2, '0')}`,
          project: 'synthetic-automation',
          source: 'cron',
          messages: [{
            id: `synthetic-cron-message-${String(index).padStart(2, '0')}`,
            role: 'assistant',
            content: 'synthetic retrieval needle',
            timestamp: `2026-02-${String((index % 27) + 1).padStart(2, '0')}T00:00:00Z`,
          }],
        }));
      }
      indexSession(dbManager, createTestSession({
        id: 'synthetic-interactive',
        project: 'synthetic-human',
        source: 'interactive',
        messages: [{
          id: 'synthetic-interactive-message',
          role: 'assistant',
          content: 'synthetic retrieval needle',
          timestamp: '2026-01-01T00:00:00Z',
        }],
      }));

      const results = searchSessions(dbManager, 'synthetic retrieval needle', { limit: 3 });

      assert.strictEqual(results[0].sessionId, 'synthetic-interactive');
      assert.ok(results.some((result) => result.source === 'cron'));
    });

    it('returns automation when it is the only synthetic match', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-cron-only',
        source: 'automation',
        messages: [{
          id: 'synthetic-cron-only-message',
          role: 'assistant',
          content: 'synthetic automation only needle',
          timestamp: '2026-01-01T00:00:00Z',
        }],
      }));

      const results = searchSessions(dbManager, 'synthetic automation only needle');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].source, 'automation');
    });

    it('collapses root and child hits while retaining the winning child anchor', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-root',
        messages: [{ id: 'synthetic-root-message', role: 'user', content: 'synthetic lineage needle', timestamp: '2026-01-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({
        id: 'synthetic-child',
        parentSessionId: 'synthetic-root',
        messages: [{ id: 'synthetic-child-message', role: 'assistant', content: 'synthetic lineage needle', timestamp: '2026-02-01T00:00:00Z' }],
      }));

      const results = searchSessions(dbManager, 'synthetic lineage needle');

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].rootSessionId, 'synthetic-root');
      assert.strictEqual(results[0].sessionId, 'synthetic-child');
      assert.strictEqual(results[0].messageId, 'synthetic-child-message');
    });

    it('collapses parent cycles deterministically', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-cycle-a',
        messages: [{ id: 'synthetic-cycle-a-message', role: 'user', content: 'synthetic cycle needle', timestamp: '2026-01-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({
        id: 'synthetic-cycle-b',
        parentSessionId: 'synthetic-cycle-a',
        messages: [{ id: 'synthetic-cycle-b-message', role: 'assistant', content: 'synthetic cycle needle', timestamp: '2026-02-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({ id: 'synthetic-cycle-a', parentSessionId: 'synthetic-cycle-b' }));

      const first = searchSessions(dbManager, 'synthetic cycle needle');
      const second = searchSessions(dbManager, 'synthetic cycle needle');

      assert.deepStrictEqual(first, second);
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0].rootSessionId, 'synthetic-cycle-a');
    });

    it('ranks exact term coverage ahead of a newer fallback hit', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-exact',
        messages: [{ id: 'synthetic-exact-message', role: 'assistant', content: 'synthetic alpha beta', timestamp: '2026-01-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({
        id: 'synthetic-fallback',
        messages: [{ id: 'synthetic-fallback-message', role: 'assistant', content: 'synthetic alpha', timestamp: '2026-03-01T00:00:00Z' }],
      }));

      const results = searchSessions(dbManager, 'alpha beta');

      assert.deepStrictEqual(results.map((result) => result.sessionId), ['synthetic-exact', 'synthetic-fallback']);
      assert.deepStrictEqual(results.map((result) => result.matchMode), ['exact', 'fallback']);
    });

    it('breaks exact ties by timestamp, project, then message id', () => {
      const fixtures = [
        ['synthetic-tie-old', 'project-a', 'synthetic-tie-old-message', '2026-01-01T00:00:00Z'],
        ['synthetic-tie-b', 'project-b', 'synthetic-tie-b-message', '2026-02-01T00:00:00Z'],
        ['synthetic-tie-a2', 'project-a', 'synthetic-tie-message-b', '2026-02-01T00:00:00Z'],
        ['synthetic-tie-a1', 'project-a', 'synthetic-tie-message-a', '2026-02-01T00:00:00Z'],
      ] as const;
      for (const [id, project, messageId, timestamp] of fixtures) {
        indexSession(dbManager, createTestSession({
          id,
          project,
          messages: [{ id: messageId, role: 'assistant', content: 'synthetic tie needle', timestamp }],
        }));
      }

      const results = searchSessions(dbManager, 'synthetic tie needle');

      assert.deepStrictEqual(results.map((result) => result.messageId), [
        'synthetic-tie-message-a',
        'synthetic-tie-message-b',
        'synthetic-tie-b-message',
        'synthetic-tie-old-message',
      ]);
    });

    it('diversifies projects in the first pass and then fills capacity', () => {
      for (let index = 0; index < 3; index++) {
        indexSession(dbManager, createTestSession({
          id: `synthetic-project-a-${index}`,
          project: 'project-a',
          messages: [{
            id: `synthetic-project-a-message-${index}`,
            role: 'assistant',
            content: 'synthetic diversity needle',
            timestamp: `2026-03-0${index + 1}T00:00:00Z`,
          }],
        }));
      }
      indexSession(dbManager, createTestSession({
        id: 'synthetic-project-b',
        project: 'project-b',
        messages: [{ id: 'synthetic-project-b-message', role: 'assistant', content: 'synthetic diversity needle', timestamp: '2026-01-01T00:00:00Z' }],
      }));

      const diverse = searchSessions(dbManager, 'synthetic diversity needle', { limit: 3 });
      const filtered = searchSessions(dbManager, 'synthetic diversity needle', { limit: 3, project: 'project-a' });

      assert.strictEqual(diverse.length, 3);
      assert.ok(diverse.some((result) => result.project === 'project-b'));
      assert.strictEqual(filtered.length, 3);
      assert.ok(filtered.every((result) => result.project === 'project-a'));
    });

    it('uses project and source together for diversity buckets', () => {
      const fixtures = [
        ['same-source-a', 'project-a', 'interactive', '2026-04-04T00:00:00Z'],
        ['same-source-b', 'project-a', 'interactive', '2026-04-03T00:00:00Z'],
        ['other-source', 'project-a', 'imported', '2026-04-02T00:00:00Z'],
        ['other-project', 'project-b', 'interactive', '2026-04-01T00:00:00Z'],
      ] as const;
      for (const [id, project, source, timestamp] of fixtures) {
        indexSession(dbManager, createTestSession({
          id,
          project,
          source,
          messages: [{ id: `${id}-message`, role: 'assistant', content: 'combined diversity needle', timestamp }],
        }));
      }

      const results = searchSessions(dbManager, 'combined diversity needle', { limit: 3 });

      assert.deepStrictEqual(results.map((result) => result.sessionId), [
        'same-source-a',
        'same-source-b',
        'other-source',
      ]);
    });

    it('filters by the owning session id', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-session-filter-a',
        messages: [{ id: 'synthetic-session-filter-a-message', role: 'user', content: 'synthetic session filter needle', timestamp: '2026-01-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({
        id: 'synthetic-session-filter-b',
        messages: [{ id: 'synthetic-session-filter-b-message', role: 'user', content: 'synthetic session filter needle', timestamp: '2026-02-01T00:00:00Z' }],
      }));

      const results = searchSessions(dbManager, 'synthetic session filter needle', { sessionId: 'synthetic-session-filter-a' });

      assert.deepStrictEqual(results.map((result) => result.sessionId), ['synthetic-session-filter-a']);
    });

    it('returns an ordered bounded local window and non-overlapping bookends', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-context',
        messages: [
          { id: 'synthetic-context-1', role: 'user', content: 'synthetic opener', timestamp: '2026-01-01T00:00:00Z' },
          { id: 'synthetic-context-2', role: 'assistant', content: 'synthetic earlier prose', timestamp: '2026-01-01T00:01:00Z' },
          { id: 'synthetic-context-3', role: 'system', content: 'synthetic system prose', timestamp: '2026-01-01T00:02:00Z' },
          { id: 'synthetic-context-4', role: 'user', content: `synthetic previous prose ${'p'.repeat(500)} context needle`, timestamp: '2026-01-01T00:03:00Z' },
          { id: 'synthetic-context-5', role: 'assistant', content: `synthetic ${'x'.repeat(500)} context needle ${'y'.repeat(500)}`, timestamp: '2026-01-01T00:04:00Z' },
          { id: 'synthetic-context-6', role: 'assistant', content: 'synthetic next prose', timestamp: '2026-01-01T00:05:00Z' },
          { id: 'synthetic-context-7', role: 'user', content: 'synthetic closer', timestamp: '2026-01-01T00:06:00Z' },
          { id: 'synthetic-context-8', role: 'assistant', content: '', timestamp: '2026-01-01T00:07:00Z' },
        ],
      }));

      const [result] = searchSessions(dbManager, 'context needle', { snippetChars: 120 });

      assert.match(result.snippet, /context needle/);
      assert.ok(result.snippet.length <= 120);
      assert.strictEqual(result.snippetTruncated, true);
      assert.deepStrictEqual(result.window.map((message) => message.id), [
        'synthetic-context-4',
        'synthetic-context-5',
        'synthetic-context-6',
      ]);
      assert.deepStrictEqual(result.bookendStart.map((message) => message.id), ['synthetic-context-1']);
      assert.deepStrictEqual(result.bookendEnd.map((message) => message.id), ['synthetic-context-7']);
      assert.strictEqual(result.messagesBefore, 2);
      assert.strictEqual(result.messagesAfter, 1);
      const ids = [result.window, result.bookendStart, result.bookendEnd].flat().map((message) => message.id);
      assert.strictEqual(new Set(ids).size, ids.length);
      assert.ok(result.window.every((message) => message.role === 'user' || message.role === 'assistant'));
      assert.strictEqual(result.window.find((message) => message.anchor)?.id, 'synthetic-context-5');
      const previous = result.window.find((message) => message.id === 'synthetic-context-4')!;
      assert.match(previous.snippet, /context needle/);
      assert.strictEqual(previous.snippetTruncated, true);
      assert.ok(previous.contentChars > previous.snippet.length);
      assert.ok([...result.window, ...result.bookendStart, ...result.bookendEnd]
        .every((message) => message.snippet.length <= (message.anchor ? 120 : 240)));
    });

    it('uses bounded SQL for context neighbors and bookends', () => {
      indexSession(dbManager, createTestSession({
        id: 'bounded-context-session',
        messages: Array.from({ length: 9 }, (_, index) => ({
          id: `bounded-context-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: index === 4 ? 'bounded context needle' : `context body ${index}`,
          timestamp: `2026-01-01T00:0${index}:00Z`,
        })),
      }));
      const db = dbManager.getDb() as any;
      const prototype = Object.getPrototypeOf(db) as { prepare: (source: string) => unknown };
      const originalPrepare = prototype.prepare;
      const statements: string[] = [];
      prototype.prepare = function (source: string): unknown {
        statements.push(source.replace(/\s+/g, ' ').trim());
        return originalPrepare.call(this, source);
      };

      try {
        const [result] = searchSessions(dbManager, 'bounded context needle');
        assert.strictEqual(result.window.length, 3);
        assert.strictEqual(result.bookendStart.length, 1);
        assert.strictEqual(result.bookendEnd.length, 1);
      } finally {
        prototype.prepare = originalPrepare;
      }

      const contextQueries = statements.filter((source) => source.includes('FROM messages') && source.includes('id = ? OR'));
      assert.ok(contextQueries.length > 0);
      assert.ok(contextQueries.every((source) => source.includes('COUNT(*)') || source.includes('LIMIT 1')));
      assert.ok(contextQueries.filter((source) => !source.includes('COUNT(*)'))
        .every((source) => source.includes('length(content) AS contentChars') && !source.includes(' content,')));
      const fragmentQueries = statements.filter((source) => source.includes('substr(content, ?, ?)') && source.includes('WHERE id = ?'));
      assert.ok(fragmentQueries.length > 0);
    });

    it('should find messages matching a search query', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.ok(results.some(r => r.content.includes('Prisma')));
    });

    it('should return results with snippets', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'migrations');
      assert.ok(results.length > 0);
      assert.ok(results[0].snippet.length > 0);
    });

    it('should return results with session metadata', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma');
      assert.ok(results.length > 0);
      assert.strictEqual(results[0].sessionId, 'session-1');
      assert.strictEqual(results[0].project, 'test-project');
      assert.ok(results[0].timestamp.length > 0);
    });

    it('should limit results', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma', { limit: 1 });
      assert.strictEqual(results.length, 1);
    });

    it('should filter by role', () => {
      indexSession(dbManager, createTestSession());

      const userResults = searchSessions(dbManager, 'Prisma', { role: 'user' });
      const assistantResults = searchSessions(dbManager, 'Prisma', { role: 'assistant' });

      // User asked about Prisma, assistant answered about Prisma
      assert.ok(userResults.length > 0);
      assert.ok(assistantResults.length > 0);
      assert.ok(userResults.every(r => r.role === 'user'));
      assert.ok(assistantResults.every(r => r.role === 'assistant'));
    });

    it('should filter by project', () => {
      indexSession(dbManager, createTestSession({ id: 's1', project: 'project-a' }));
      indexSession(dbManager, createTestSession({ id: 's2', project: 'project-b', messages: [
        { id: 's2-m1', role: 'user', content: 'Different topic entirely', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'Prisma', { project: 'project-a' });
      assert.ok(results.length > 0);
      assert.ok(results.every(r => r.project === 'project-a'));
    });

    it('should return empty for no matches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'nonexistent-topic-xyz');
      assert.strictEqual(results.length, 0);
    });

    it('should return empty for empty database', () => {
      const results = searchSessions(dbManager, 'anything');
      assert.strictEqual(results.length, 0);
    });

    it('should match multi-word queries without requiring an exact phrase', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should ignore lowercase connector words in natural-language queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'gpu and issue');
      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should preserve explicit quoted phrase searches', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, '"memory search"');
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('memory search')));
    });

    it('should preserve valid operator queries', () => {
      indexSession(dbManager, createTestSession({
        id: 'synthetic-operator-prisma',
        messages: [{ id: 'synthetic-operator-prisma-message', role: 'user', content: 'synthetic Prisma operator hit', timestamp: '2026-01-01T00:00:00Z' }],
      }));
      indexSession(dbManager, createTestSession({
        id: 'synthetic-operator-gpu',
        messages: [{ id: 'synthetic-operator-gpu-message', role: 'user', content: 'synthetic gpu timeout issue operator hit', timestamp: '2026-01-02T00:00:00Z' }],
      }));

      const results = searchSessions(dbManager, 'Prisma OR gpu');
      assert.ok(results.length >= 2);
      assert.ok(results.some((r) => r.content.includes('Prisma')));
      assert.ok(results.some((r) => r.content.includes('gpu timeout issue')));
    });

    it('should fall back to broader natural-language FTS matching when strict term matching misses', () => {
      indexSession(dbManager, createTestSession({ id: 'fallback-session', messages: [
        { id: 'fallback-session-msg-1', role: 'assistant', content: "The user's name is Naruto", timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'name identity Naruto');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('Naruto')));
    });

    it('should find mixed Chinese/English queries via fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'mixed-cjk-session', messages: [
        { id: 'mixed-cjk-session-msg-1', role: 'assistant', content: 'codex 已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, 'codex 执行 任务');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('codex 已经开始执行探索任务了')));
    });

    it('should find Chinese-only substrings via LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-only-session', messages: [
        { id: 'cjk-only-session-msg-1', role: 'assistant', content: '已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行');

      assert.ok(results.length > 0);
      assert.ok(results.some((r) => r.content.includes('已经开始执行探索任务了')));
    });

    it('should preserve filters, ordering, and limit during LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-a', project: 'project-a', messages: [
        { id: 'cjk-filter-a-msg-1', role: 'user', content: '早期已经开始执行探索任务了', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'cjk-filter-a-msg-2', role: 'user', content: '后续继续执行更多任务', timestamp: '2026-05-03T00:03:00Z' },
      ] }));
      indexSession(dbManager, createTestSession({ id: 'cjk-filter-b', project: 'project-b', messages: [
        { id: 'cjk-filter-b-msg-1', role: 'assistant', content: '另一个项目也执行任务', timestamp: '2026-05-03T00:04:00Z' },
      ] }));

      const results = searchSessions(dbManager, '执行', {
        project: 'project-a',
        role: 'user',
        since: '2026-05-03T00:02:00Z',
        limit: 1,
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].project, 'project-a');
      assert.strictEqual(results[0].role, 'user');
      assert.strictEqual(results[0].timestamp, '2026-05-03T00:03:00Z');
      assert.ok(results[0].content.includes('后续继续执行更多任务'));
    });

    it('should escape LIKE wildcard characters during fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'like-escape-session', messages: [
        { id: 'like-escape-session-msg-1', role: 'user', content: 'Progress reached 100% today', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'like-escape-session-msg-2', role: 'user', content: 'A plain message without the wildcard character', timestamp: '2026-05-03T00:02:00Z' },
      ] }));

      const results = searchSessions(dbManager, '%');

      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.content.includes('%')));
    });

    it('should escape backslashes during LIKE fallback', () => {
      indexSession(dbManager, createTestSession({ id: 'like-backslash-session', messages: [
        { id: 'like-backslash-hit', role: 'user', content: 'literal \\ backslash', timestamp: '2026-05-03T00:01:00Z' },
        { id: 'like-backslash-decoy', role: 'user', content: 'literal backslash', timestamp: '2026-05-03T00:02:00Z' },
      ] }));

      const results = searchSessions(dbManager, '\\');

      assert.ok(results.some((result) => result.messageId === 'like-backslash-hit'));
      assert.ok(results.every((result) => result.messageId !== 'like-backslash-decoy'));
    });

    it('should not broaden explicit operator queries', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'Prisma AND nonexistent');

      assert.strictEqual(results.length, 0);
    });

    it('should handle malformed FTS5 queries gracefully', () => {
      indexSession(dbManager, createTestSession());

      // Malformed FTS5 query should not throw
      const results = searchSessions(dbManager, 'AND OR NOT');
      assert.ok(Array.isArray(results));
    });

    it('should handle unmatched quotes gracefully', () => {
      indexSession(dbManager, createTestSession());

      const results = searchSessions(dbManager, 'issue "timeout');
      assert.ok(Array.isArray(results));
    });

    it('should return empty for blank queries', () => {
      assert.deepStrictEqual(searchSessions(dbManager, '   '), []);
    });
  });

  describe('getIndexedMessageCount', () => {
    it('should return 0 for empty database', () => {
      assert.strictEqual(getIndexedMessageCount(dbManager), 0);
    });

    it('should return correct count after indexing', () => {
      indexSession(dbManager, createTestSession());
      assert.strictEqual(getIndexedMessageCount(dbManager), 6);
    });
  });
});
