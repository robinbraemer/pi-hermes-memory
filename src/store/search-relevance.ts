import { collectNaturalLanguageTerms } from './fts-query.js';

export type SearchMatchMode = 'exact' | 'fallback' | 'like';

export interface RelevanceKey {
  matchMode: SearchMatchMode;
  matchedTerms: number;
  totalTerms: number;
  phraseMatch: boolean;
  occurrences: number;
  recencyMs: number;
  stableSource: string;
  stableId: string;
}

interface TermRange {
  term: string;
  start: number;
  end: number;
}

const MATCH_MODE_ORDER: Record<SearchMatchMode, number> = {
  exact: 0,
  fallback: 1,
  like: 2,
};

function lower(value: string): string {
  return value.toLocaleLowerCase('en-US');
}

function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of collectNaturalLanguageTerms(query)) {
    const normalized = lower(term);
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      terms.push(normalized);
    }
  }
  return terms;
}

function findRanges(content: string, terms: string[]): TermRange[] {
  const normalizedContent = lower(content);
  const ranges: TermRange[] = [];
  for (const term of terms) {
    let from = 0;
    while (from <= normalizedContent.length - term.length) {
      const start = normalizedContent.indexOf(term, from);
      if (start < 0) break;
      ranges.push({ term, start, end: start + term.length });
      from = start + Math.max(1, term.length);
    }
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
}

function alignStart(content: string, index: number): number {
  if (index > 0 && index < content.length) {
    const code = content.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) return index + 1;
  }
  return index;
}

function alignEnd(content: string, index: number): number {
  if (index > 0 && index < content.length) {
    const code = content.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) return index - 1;
  }
  return index;
}

function centeredBounds(contentLength: number, anchor: TermRange, budget: number): { start: number; end: number } {
  const anchorLength = anchor.end - anchor.start;
  const remaining = Math.max(0, budget - anchorLength);
  let start = anchor.start - Math.floor(remaining / 2);
  let end = anchor.end + Math.ceil(remaining / 2);

  if (start < 0) {
    end = Math.min(contentLength, end - start);
    start = 0;
  }
  if (end > contentLength) {
    start = Math.max(0, start - (end - contentLength));
    end = contentLength;
  }
  return { start, end };
}

export function buildRelevanceKey(
  content: string,
  query: string,
  matchMode: SearchMatchMode,
  recency: string,
  stableSource: string,
  stableId: string,
): RelevanceKey {
  const terms = queryTerms(query);
  const ranges = findRanges(content, terms);
  const matched = new Set(ranges.map((range) => range.term));
  const normalizedContent = lower(content);
  const phraseCandidates = collectNaturalLanguageTerms(query)
    .map(lower)
    .filter((term) => term.includes(' '));
  const trimmedQuery = lower(query.trim().replace(/^"|"$/g, ''));
  const phraseMatch = phraseCandidates.some((phrase) => normalizedContent.includes(phrase))
    || (trimmedQuery.includes(' ') && normalizedContent.includes(trimmedQuery));
  const parsedRecency = Date.parse(recency);

  return {
    matchMode,
    matchedTerms: matched.size,
    totalTerms: Math.max(1, terms.length),
    phraseMatch,
    occurrences: Math.min(20, ranges.length),
    recencyMs: Number.isFinite(parsedRecency) ? parsedRecency : 0,
    stableSource,
    stableId,
  };
}

export function compareRelevance(a: RelevanceKey, b: RelevanceKey): number {
  const mode = MATCH_MODE_ORDER[a.matchMode] - MATCH_MODE_ORDER[b.matchMode];
  if (mode !== 0) return mode;

  const coverageA = a.matchedTerms * b.totalTerms;
  const coverageB = b.matchedTerms * a.totalTerms;
  if (coverageA !== coverageB) return coverageB - coverageA;
  if (a.phraseMatch !== b.phraseMatch) return a.phraseMatch ? -1 : 1;
  if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
  if (a.recencyMs !== b.recencyMs) return b.recencyMs - a.recencyMs;
  const source = a.stableSource < b.stableSource ? -1 : a.stableSource > b.stableSource ? 1 : 0;
  if (source !== 0) return source;
  return a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0;
}

export function termLocalSnippet(
  content: string,
  query: string,
  maxChars: number,
): { text: string; truncated: boolean; start: number; end: number } {
  const limit = Math.max(0, Math.floor(maxChars));
  if (content.length <= limit) {
    return { text: content, truncated: false, start: 0, end: content.length };
  }
  if (limit === 0) return { text: '', truncated: content.length > 0, start: 0, end: 0 };

  const ranges = findRanges(content, queryTerms(query));
  if (ranges.length === 0) {
    const end = alignEnd(content, Math.max(0, limit - 1));
    return { text: `${content.slice(0, end)}…`, truncated: true, start: 0, end };
  }

  let best: { anchor: TermRange; distinct: number; occurrences: number } | undefined;
  for (const anchor of ranges) {
    const provisional = centeredBounds(content.length, anchor, Math.max(1, limit - 2));
    const contained = ranges.filter((range) => range.start >= provisional.start && range.end <= provisional.end);
    const candidate = {
      anchor,
      distinct: new Set(contained.map((range) => range.term)).size,
      occurrences: contained.length,
    };
    if (!best
      || candidate.distinct > best.distinct
      || (candidate.distinct === best.distinct && candidate.occurrences > best.occurrences)
      || (candidate.distinct === best.distinct && candidate.occurrences === best.occurrences
        && candidate.anchor.start < best.anchor.start)) {
      best = candidate;
    }
  }

  const anchor = best!.anchor;
  let ellipsisCount = 2;
  let bounds = centeredBounds(content.length, anchor, Math.max(1, limit - ellipsisCount));
  ellipsisCount = Number(bounds.start > 0) + Number(bounds.end < content.length);
  bounds = centeredBounds(content.length, anchor, Math.max(1, limit - ellipsisCount));
  const start = alignStart(content, bounds.start);
  const end = alignEnd(content, bounds.end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  const text = `${prefix}${content.slice(start, end)}${suffix}`;

  return { text: text.slice(0, limit), truncated: true, start, end };
}
