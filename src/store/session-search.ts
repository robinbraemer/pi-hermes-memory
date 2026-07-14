import { DatabaseManager } from './db.js';
import {
  buildFallbackFts5Query,
  collectNaturalLanguageTerms,
  hasExplicitFts5Operator,
  isFts5QueryError,
  normalizeFts5Query,
} from './fts-query.js';
import {
  buildRelevanceKey,
  compareRelevance,
  termLocalSnippet,
  type RelevanceKey,
  type SearchMatchMode,
} from './search-relevance.js';

export interface SessionContextMessage {
  id: string;
  role: string;
  timestamp: string;
  snippet: string;
  snippetTruncated: boolean;
  contentChars: number;
  anchor: boolean;
}

/** Search result from session history. */
export interface SessionSearchResult {
  sessionId: string;
  project: string;
  role: string;
  content: string;
  timestamp: string;
  snippet: string;
  snippetTruncated: boolean;
  messageId: string;
  rootSessionId: string;
  source: string;
  matchMode: SearchMatchMode;
  matchedTerms: number;
  totalTerms: number;
  window: SessionContextMessage[];
  bookendStart: SessionContextMessage[];
  bookendEnd: SessionContextMessage[];
  messagesBefore: number;
  messagesAfter: number;
}

/** Search options for session search. */
export interface SessionSearchOptions {
  /** Maximum number of results (default: 10) */
  limit?: number;
  /** Filter by project name */
  project?: string;
  /** Filter by role: 'user', 'assistant', 'system' */
  role?: string;
  /** Only return messages after this date (ISO string) */
  since?: string;
  /** Filter by the session that owns the matching message. */
  sessionId?: string;
  /** Maximum characters in the query-local anchor snippet. */
  snippetChars?: number;
  /** Candidate scan override for internal callers and tests. */
  candidateLimit?: number;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  candidateCount: number;
  sourceCount: number;
  omittedCount: number;
}

type SearchMatch =
  | { type: 'fts'; query: string; mode: 'exact' | 'fallback' }
  | { type: 'like'; terms: string[]; mode: 'like' };

interface CandidateRow {
  message_id: string;
  session_id: string;
  project: string;
  source: string;
  role: string;
  content: string;
  timestamp: string;
}

interface RankedCandidate extends CandidateRow {
  matchMode: SearchMatchMode;
  key: RelevanceKey;
  rootSessionId: string;
}

interface StoredMessage {
  id: string;
  role: string;
  contentChars: number;
  timestamp: string;
}

const DEFAULT_SNIPPET_CHARS = 1_200;
const MIN_SNIPPET_CHARS = 100;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_CANDIDATES = 300;
const CONTEXT_SNIPPET_CHARS = 240;
const MAX_CONTEXT_QUERY_TERMS = 16;
const DEMOTED_SOURCES = new Set(['cron', 'automation']);

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value!)));
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

function resolveRoot(
  db: ReturnType<DatabaseManager['getDb']>,
  sessionId: string,
  project: string,
  cache: Map<string, string>,
): string {
  const cached = cache.get(sessionId);
  if (cached) return cached;

  const visited: string[] = [];
  const visitedIndex = new Map<string, number>();
  let current = sessionId;

  while (true) {
    const known = cache.get(current);
    if (known) {
      for (const id of visited) cache.set(id, known);
      return known;
    }
    const cycleStart = visitedIndex.get(current);
    if (cycleStart !== undefined) {
      const root = visited.slice(cycleStart).sort()[0] ?? current;
      for (const id of visited) cache.set(id, root);
      return root;
    }

    visitedIndex.set(current, visited.length);
    visited.push(current);
    const row = db.prepare(
      'SELECT parent_session_id, project FROM sessions WHERE id = ?',
    ).get(current) as { parent_session_id: string | null; project: string } | undefined;
    if (!row?.parent_session_id) {
      for (const id of visited) cache.set(id, current);
      return current;
    }
    const parent = db.prepare('SELECT id, project FROM sessions WHERE id = ?').get(row.parent_session_id) as {
      id: string;
      project: string;
    } | undefined;
    if (!parent || parent.project !== project) {
      for (const id of visited) cache.set(id, current);
      return current;
    }
    current = parent.id;
  }
}

function applyProjectSourceDiversity(
  candidates: RankedCandidate[],
  limit: number,
  disabled: boolean,
): RankedCandidate[] {
  if (disabled) return candidates.slice(0, limit);

  const selected: RankedCandidate[] = [];
  const remainder: RankedCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const diversityKey = `${candidate.project}\u0000${candidate.source}`;
    const count = counts.get(diversityKey) ?? 0;
    if (count < 2 && selected.length < limit) {
      selected.push(candidate);
      counts.set(diversityKey, count + 1);
    } else {
      remainder.push(candidate);
    }
  }
  if (selected.length < limit) {
    selected.push(...remainder.slice(0, limit - selected.length));
  }
  return selected;
}

function contextQueryTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of collectNaturalLanguageTerms(query)) {
    const normalized = term.toLocaleLowerCase('en-US');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length === MAX_CONTEXT_QUERY_TERMS) break;
  }
  return terms;
}

function centeredContextStart(
  contentChars: number,
  anchorStart: number,
  anchorChars: number,
  budget: number,
): number {
  if (anchorStart < 0) return 0;
  const remaining = Math.max(0, budget - anchorChars);
  let start = Math.max(0, anchorStart - Math.floor(remaining / 2));
  let end = start + budget;
  if (end > contentChars) {
    start = Math.max(0, start - (end - contentChars));
    end = contentChars;
  }
  return start;
}

function loadContextSnippet(
  db: ReturnType<DatabaseManager['getDb']>,
  message: StoredMessage,
  query: string,
): { text: string; truncated: boolean; contentChars: number } {
  if (message.contentChars <= 0) {
    return { text: '', truncated: false, contentChars: 0 };
  }

  const terms = contextQueryTerms(query);
  let anchorStart = -1;
  let anchorChars = 0;
  if (terms.length > 0) {
    const projections = terms.map((_, index) => `instr(lower(content), ?) AS position_${index}`);
    const positions = db.prepare(`
      SELECT ${projections.join(', ')}
      FROM messages
      WHERE id = ?
    `).get(...terms, message.id) as Record<string, number> | undefined;
    for (let index = 0; index < terms.length; index++) {
      const position = positions?.[`position_${index}`] ?? 0;
      if (position > 0 && (anchorStart < 0 || position - 1 < anchorStart)) {
        anchorStart = position - 1;
        anchorChars = Array.from(terms[index]).length;
      }
    }
  }

  let bodyBudget = CONTEXT_SNIPPET_CHARS;
  let start = 0;
  let prefix = false;
  let suffix = false;
  if (message.contentChars > CONTEXT_SNIPPET_CHARS) {
    bodyBudget = CONTEXT_SNIPPET_CHARS - 2;
    start = centeredContextStart(message.contentChars, anchorStart, anchorChars, bodyBudget);
    prefix = start > 0;
    suffix = start + bodyBudget < message.contentChars;
    bodyBudget = CONTEXT_SNIPPET_CHARS - Number(prefix) - Number(suffix);
    start = centeredContextStart(message.contentChars, anchorStart, anchorChars, bodyBudget);
    prefix = start > 0;
    suffix = start + bodyBudget < message.contentChars;
    bodyBudget = CONTEXT_SNIPPET_CHARS - Number(prefix) - Number(suffix);
  }

  const row = db.prepare(`
    SELECT substr(content, ?, ?) AS fragment
    FROM messages
    WHERE id = ?
  `).get(start + 1, bodyBudget, message.id) as { fragment: string } | undefined;
  const fragment = row?.fragment ?? '';
  const boundedFragment = termLocalSnippet(fragment, query, bodyBudget);
  const text = `${prefix ? '…' : ''}${boundedFragment.text}${suffix ? '…' : ''}`;
  return {
    text,
    truncated: prefix || suffix || boundedFragment.truncated,
    contentChars: message.contentChars,
  };
}

function loadContext(
  db: ReturnType<DatabaseManager['getDb']>,
  candidate: RankedCandidate,
  query: string,
  snippetChars: number,
  roleFilter?: string,
): Pick<SessionSearchResult, 'snippet' | 'snippetTruncated' | 'window' | 'bookendStart' | 'bookendEnd' | 'messagesBefore' | 'messagesAfter'> {
  const anchorSnippet = termLocalSnippet(candidate.content, query, snippetChars);
  const roleCondition = roleFilter ? 'role = ?' : "role IN ('user', 'assistant')";
  const eligibility = `(id = ? OR (TRIM(content) <> '' AND ${roleCondition}))`;
  const eligibilityParams: unknown[] = [candidate.message_id];
  if (roleFilter) eligibilityParams.push(roleFilter);
  const before = '(timestamp < ? OR (timestamp = ? AND id < ?))';
  const after = '(timestamp > ? OR (timestamp = ? AND id > ?))';
  const anchorOrderParams = [candidate.timestamp, candidate.timestamp, candidate.message_id];
  const selectMessage = (direction: 'before' | 'after', order: 'ASC' | 'DESC'): StoredMessage[] => db.prepare(`
    SELECT id, role, length(content) AS contentChars, timestamp
    FROM messages
    WHERE session_id = ? AND ${eligibility} AND ${direction === 'before' ? before : after}
    ORDER BY timestamp ${order}, id ${order}
    LIMIT 1
  `).all(
    candidate.session_id,
    ...eligibilityParams,
    ...anchorOrderParams,
  ) as StoredMessage[];
  const countMessages = (direction: 'before' | 'after'): number => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE session_id = ? AND ${eligibility} AND ${direction === 'before' ? before : after}
    `).get(candidate.session_id, ...eligibilityParams, ...anchorOrderParams) as { count: number };
    return row.count;
  };
  const previous = selectMessage('before', 'DESC');
  const next = selectMessage('after', 'ASC');
  const beforeCount = countMessages('before');
  const afterCount = countMessages('after');
  const anchor: StoredMessage = {
    id: candidate.message_id,
    role: candidate.role,
    contentChars: candidate.content.length,
    timestamp: candidate.timestamp,
  };
  const toContext = (message: StoredMessage): SessionContextMessage => {
    const anchor = message.id === candidate.message_id;
    const snippet = anchor
      ? { text: anchorSnippet.text, truncated: anchorSnippet.truncated, contentChars: candidate.content.length }
      : loadContextSnippet(db, message, query);
    return {
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      snippet: snippet.text,
      snippetTruncated: snippet.truncated,
      contentChars: snippet.contentChars,
      anchor,
    };
  };
  const window = [...previous.reverse(), anchor, ...next].map(toContext);
  const used = new Set(window.map((message) => message.id));
  const bookendStart: SessionContextMessage[] = [];
  const bookendEnd: SessionContextMessage[] = [];

  if (beforeCount > previous.length) {
    const [opener] = selectMessage('before', 'ASC');
    if (opener && !used.has(opener.id)) {
      bookendStart.push(toContext(opener));
      used.add(opener.id);
    }
  }
  if (afterCount > next.length) {
    const [closer] = selectMessage('after', 'DESC');
    if (closer && !used.has(closer.id)) bookendEnd.push(toContext(closer));
  }

  return {
    snippet: anchorSnippet.text,
    snippetTruncated: anchorSnippet.truncated,
    window,
    bookendStart,
    bookendEnd,
    messagesBefore: Math.max(0, beforeCount - previous.length),
    messagesAfter: Math.max(0, afterCount - next.length),
  };
}

/** Search across indexed session messages using FTS5. */
export function searchSessionsDetailed(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {},
): SessionSearchResponse {
  if (query.trim().length === 0) return { results: [], candidateCount: 0, sourceCount: 0, omittedCount: 0 };

  const db = dbManager.getDb();
  const limit = clampInteger(options.limit, 10, 1, 20);
  const snippetChars = clampInteger(options.snippetChars, DEFAULT_SNIPPET_CHARS, MIN_SNIPPET_CHARS, MAX_SNIPPET_CHARS);
  const defaultCandidateLimit = Math.min(MAX_CANDIDATES, Math.max(60, limit * 12));
  const candidateLimit = clampInteger(options.candidateLimit, defaultCandidateLimit, 1, MAX_CANDIDATES);
  const candidates = new Map<string, RankedCandidate>();

  const executeSearch = (match: SearchMatch): CandidateRow[] => {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (match.type === 'fts') {
      conditions.push('m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)');
      params.push(match.query);
    } else {
      if (match.terms.length === 0) return [];
      conditions.push(`(${match.terms.map(() => `m.content LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      params.push(...match.terms.map((term) => `%${escapeLikePattern(term)}%`));
    }
    if (options.project) {
      conditions.push('s.project = ?');
      params.push(options.project);
    }
    if (options.role) {
      conditions.push('m.role = ?');
      params.push(options.role);
    }
    if (options.since) {
      conditions.push('m.timestamp >= ?');
      params.push(options.since);
    }
    if (options.sessionId) {
      conditions.push('m.session_id = ?');
      params.push(options.sessionId);
    }

    try {
      return db.prepare(`
        SELECT
          m.id AS message_id,
          m.session_id,
          s.project,
          s.source,
          m.role,
          m.content,
          m.timestamp
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.timestamp DESC, s.project ASC, m.id ASC
        LIMIT ?
      `).all(...params, candidateLimit) as CandidateRow[];
    } catch (err) {
      if (match.type === 'fts' && isFts5QueryError(err)) return [];
      throw err;
    }
  };

  const addAttempt = (match: SearchMatch): void => {
    for (const row of executeSearch(match)) {
      if (candidates.has(row.message_id)) continue;
      candidates.set(row.message_id, {
        ...row,
        matchMode: match.mode,
        key: buildRelevanceKey(row.content, query, match.mode, row.timestamp, row.project, row.message_id),
        rootSessionId: row.session_id,
      });
    }
  };

  const normalizedQuery = normalizeFts5Query(query);
  if (!normalizedQuery) return { results: [], candidateCount: 0, sourceCount: 0, omittedCount: 0 };
  addAttempt({ type: 'fts', query: normalizedQuery, mode: 'exact' });

  if (!hasExplicitFts5Operator(query)) {
    const fallbackQuery = buildFallbackFts5Query(query);
    if (fallbackQuery && fallbackQuery !== normalizedQuery) {
      addAttempt({ type: 'fts', query: fallbackQuery, mode: 'fallback' });
    }
    if (candidates.size === 0) {
      addAttempt({ type: 'like', terms: collectNaturalLanguageTerms(query), mode: 'like' });
    }
  }

  const rootCache = new Map<string, string>();
  const ranked = [...candidates.values()];
  for (const candidate of ranked) {
    candidate.rootSessionId = resolveRoot(db, candidate.session_id, candidate.project, rootCache);
  }
  const compareCandidates = (a: RankedCandidate, b: RankedCandidate): number => compareRelevance(a.key, b.key);
  const normal = ranked.filter((candidate) => !DEMOTED_SOURCES.has(candidate.source.toLowerCase())).sort(compareCandidates);
  const demoted = ranked.filter((candidate) => DEMOTED_SOURCES.has(candidate.source.toLowerCase())).sort(compareCandidates);
  const collapsed: RankedCandidate[] = [];
  const roots = new Set<string>();
  for (const candidate of [...normal, ...demoted]) {
    if (roots.has(candidate.rootSessionId)) continue;
    roots.add(candidate.rootSessionId);
    collapsed.push(candidate);
  }
  const selected = applyProjectSourceDiversity(collapsed, limit, Boolean(options.project || options.sessionId));

  const results = selected.map((candidate) => {
    const context = loadContext(db, candidate, query, snippetChars, options.role);
    return {
      sessionId: candidate.session_id,
      project: candidate.project,
      role: candidate.role,
      content: candidate.content,
      timestamp: candidate.timestamp,
      snippet: context.snippet,
      snippetTruncated: context.snippetTruncated,
      messageId: candidate.message_id,
      rootSessionId: candidate.rootSessionId,
      source: candidate.source,
      matchMode: candidate.matchMode,
      matchedTerms: candidate.key.matchedTerms,
      totalTerms: candidate.key.totalTerms,
      window: context.window,
      bookendStart: context.bookendStart,
      bookendEnd: context.bookendEnd,
      messagesBefore: context.messagesBefore,
      messagesAfter: context.messagesAfter,
    };
  });
  return {
    results,
    candidateCount: ranked.length,
    sourceCount: new Set(ranked.map((candidate) => `${candidate.project}\u0000${candidate.source}`)).size,
    omittedCount: Math.max(0, ranked.length - results.length),
  };
}

export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {},
): SessionSearchResult[] {
  return searchSessionsDetailed(dbManager, query, options).results;
}

/** Get the total number of indexed messages. */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
