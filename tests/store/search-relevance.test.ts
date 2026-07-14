import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelevanceKey, compareRelevance, termLocalSnippet } from '../../src/store/search-relevance.js';

describe('search relevance', () => {
  it('orders exact, coverage, phrase, occurrences, recency, source, then id', () => {
    const older = buildRelevanceKey('synthetic alpha beta', 'alpha beta', 'exact', '2026-01-01T00:00:00Z', 'source-b', 'id-b');
    const newer = buildRelevanceKey('synthetic alpha beta', 'alpha beta', 'exact', '2026-01-02T00:00:00Z', 'source-a', 'id-a');
    assert.ok(compareRelevance(newer, older) < 0);
    assert.ok(compareRelevance(
      buildRelevanceKey('synthetic alpha', 'alpha beta', 'exact', '2026-02-01T00:00:00Z', 'x', 'x'),
      older,
    ) > 0);
    assert.ok(compareRelevance(
      buildRelevanceKey('synthetic alpha beta', 'alpha beta', 'fallback', '2026-03-01T00:00:00Z', 'x', 'x'),
      older,
    ) > 0);
  });

  it('centers a bounded snippet on a tail match and is deterministic', () => {
    const content = `synthetic-prefix-${'x'.repeat(500)}-alpha-beta-${'y'.repeat(500)}`;
    const first = termLocalSnippet(content, 'alpha beta', 120);
    const second = termLocalSnippet(content, 'alpha beta', 120);
    assert.deepStrictEqual(first, second);
    assert.ok(first.text.length <= 120);
    assert.match(first.text, /alpha-beta/);
    assert.ok(first.start > 0);
    assert.ok(first.end < content.length);
  });

  it('handles unicode and query punctuation without regex construction', () => {
    const result = termLocalSnippet(`synthetic ${'界'.repeat(80)} 执行 [a+b]? ${'界'.repeat(80)}`, '执行 [a+b]?', 80);
    assert.ok(result.text.length <= 80);
    assert.match(result.text, /执行/);
    assert.doesNotThrow(() => buildRelevanceKey(result.text, '[a+b]?', 'like', 'invalid', 's', 'i'));
  });

  it('does not score explicit uppercase FTS operators as query terms', () => {
    const key = buildRelevanceKey('synthetic alpha beta', 'alpha OR beta', 'exact', 'invalid', 's', 'i');
    assert.equal(key.matchedTerms, 2);
    assert.equal(key.totalTerms, 2);
  });
});
