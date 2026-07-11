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
  content: string;
  timestamp: string;
}

const DEFAULT_SNIPPET_CHARS = 1_200;
const MIN_SNIPPET_CHARS = 100;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_CANDIDATES = 300;
const CONTEXT_SNIPPET_CHARS = 240;
const DEMOTED_SOURCES = new Set(['cron', 'automation']);

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value!)));
}

function escapeLikePattern(text: string): string {
  return text.replace(/[\%_]/g, '\\$&');
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
  const seen = new Set<string>();
  let current = sessionId;

  while (true) {
    const known = cache.get(current);
    if (known) {
      for (const id of visited) cache.set(id, known);
      return known;
    }
    if (seen.has(current)) {
      const root = [...seen].sort()[0] ?? sessionId;
      for (const id of visited) cache.set(id, root);
      return root;
    }

    seen.add(current);
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

function applyProjectDiversity(
  candidates: RankedCandidate[],
  limit: number,
  disabled: boolean,
): RankedCandidate[] {
  if (disabled) return candidates.slice(0, limit);

  const selected: RankedCandidate[] = [];
  const remainder: RankedCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const count = counts.get(candidate.project) ?? 0;
    if (count < 2 && selected.length < limit) {
      selected.push(candidate);
      counts.set(candidate.project, count + 1);
    } else {
      remainder.push(candidate);
    }
  }
  if (selected.length < limit) {
    selected.push(...remainder.slice(0, limit - selected.length));
  }
  return selected;
}

function loadContext(
  db: ReturnType<DatabaseManager['getDb']>,
  candidate: RankedCandidate,
  query: string,
  snippetChars: number,
  roleFilter?: string,
): Pick<SessionSearchResult, 'snippet' | 'window' | 'bookendStart' | 'bookendEnd' | 'messagesBefore' | 'messagesAfter'> {
  const rows = db.prepare(`
    SELECT id, role, content, timestamp
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(candidate.session_id) as StoredMessage[];
  const eligible = rows.filter((message) => {
    if (!message.content.trim()) return false;
    if (message.id === candidate.message_id) return true;
    if (message.role !== 'user' && message.role !== 'assistant') return false;
    return !roleFilter || message.role === roleFilter;
  });
  const anchorIndex = eligible.findIndex((message) => message.id === candidate.message_id);
  const anchorSnippet = termLocalSnippet(candidate.content, query, snippetChars).text;
  if (anchorIndex < 0) {
    return {
      snippet: anchorSnippet,
      window: [{
        id: candidate.message_id,
        role: candidate.role,
        timestamp: candidate.timestamp,
        snippet: anchorSnippet,
        anchor: true,
      }],
      bookendStart: [],
      bookendEnd: [],
      messagesBefore: 0,
      messagesAfter: 0,
    };
  }

  const windowStart = Math.max(0, anchorIndex - 1);
  const windowEnd = Math.min(eligible.length, anchorIndex + 2);
  const toContext = (message: StoredMessage): SessionContextMessage => {
    const anchor = message.id === candidate.message_id;
    return {
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      snippet: anchor ? anchorSnippet : termLocalSnippet(message.content, query, CONTEXT_SNIPPET_CHARS).text,
      anchor,
    };
  };
  const window = eligible.slice(windowStart, windowEnd).map(toContext);
  const used = new Set(window.map((message) => message.id));
  const bookendStart: SessionContextMessage[] = [];
  const bookendEnd: SessionContextMessage[] = [];

  if (windowStart > 0) {
    const opener = eligible[0];
    if (!used.has(opener.id)) {
      bookendStart.push(toContext(opener));
      used.add(opener.id);
    }
  }
  if (windowEnd < eligible.length) {
    const closer = eligible[eligible.length - 1];
    if (!used.has(closer.id)) bookendEnd.push(toContext(closer));
  }

  return {
    snippet: anchorSnippet,
    window,
    bookendStart,
    bookendEnd,
    messagesBefore: windowStart,
    messagesAfter: eligible.length - windowEnd,
  };
}

/** Search across indexed session messages using FTS5. */
export function searchSessions(
  dbManager: DatabaseManager,
  query: string,
  options: SessionSearchOptions = {},
): SessionSearchResult[] {
  if (query.trim().length === 0) return [];

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
  if (!normalizedQuery) return [];
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
  const selected = applyProjectDiversity(collapsed, limit, Boolean(options.project || options.sessionId));

  return selected.map((candidate) => {
    const context = loadContext(db, candidate, query, snippetChars, options.role);
    return {
      sessionId: candidate.session_id,
      project: candidate.project,
      role: candidate.role,
      content: candidate.content,
      timestamp: candidate.timestamp,
      snippet: context.snippet,
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
}

/** Get the total number of indexed messages. */
export function getIndexedMessageCount(dbManager: DatabaseManager): number {
  const db = dbManager.getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}
