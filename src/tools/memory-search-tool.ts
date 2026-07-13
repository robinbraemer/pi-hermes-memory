import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemoriesDetailed, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { termLocalSnippet } from '../store/search-relevance.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  outputChars?: number;
  outputTruncated?: boolean;
  snippetChars?: number;
  truncatedCount?: number;
  candidateCount?: number;
  sourceCount?: number;
  omittedCount?: number;
  refs?: Array<{ memoryId: number }>;
}

const DEFAULT_MEMORY_SNIPPET_CHARS = 1_200;
const MIN_MEMORY_SNIPPET_CHARS = 100;
const MAX_MEMORY_SNIPPET_CHARS = 4_000;
const MAX_MEMORY_OUTPUT_CHARS = 50 * 1024;

function boundMemoryOutput(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_MEMORY_OUTPUT_CHARS) return { text: value, truncated: false };
  const notice = `\n... (output truncated, ${value.length} chars total — refine the query or lower the result limit)`;
  const available = Math.max(0, MAX_MEMORY_OUTPUT_CHARS - notice.length);
  return { text: value.substring(0, available).concat(notice), truncated: true };
}

function clampNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

Returns matching memory entries with project context and dates.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type (memory, user, or failure).' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      memoryId: Type.Optional(Type.Number({ description: 'Filter by an opaque memory ref from a prior result.', minimum: 1 })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, min: 1, max: 20).', minimum: 1, maximum: 20 })),
      snippetChars: Type.Optional(Type.Number({
        description: `Maximum characters per result snippet (default: ${DEFAULT_MEMORY_SNIPPET_CHARS}, max: ${MAX_MEMORY_SNIPPET_CHARS}).`,
        minimum: MIN_MEMORY_SNIPPET_CHARS,
        maximum: MAX_MEMORY_SNIPPET_CHARS,
      })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: string; category?: string; memoryId?: number; limit?: number; snippetChars?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const memoryId = Number.isFinite(args.memoryId) ? Math.floor(args.memoryId!) : undefined;
      const limit = clampNumber(args.limit, 10, 1, 20);
      const snippetChars = clampNumber(
        args.snippetChars,
        DEFAULT_MEMORY_SNIPPET_CHARS,
        MIN_MEMORY_SNIPPET_CHARS,
        MAX_MEMORY_SNIPPET_CHARS,
      );

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use the memory tool with add action to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const search = searchMemoriesDetailed(dbManager, query, { project, target, category, memoryId, limit });
      const { results } = search;

      if (results.length === 0) {
        const message = 'No memories found. Try a different search term or broader query.';
        const output = boundMemoryOutput(message);
        const result: SearchResult = {
          success: true,
          count: 0,
          message: output.text,
          outputChars: output.text.length,
          outputTruncated: output.truncated,
        };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const blocks: string[] = [`Found ${results.length} memories:`];
      let truncatedCount = 0;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        const snippet = termLocalSnippet(entry.content, query, snippetChars);
        if (snippet.truncated) truncatedCount += 1;
        blocks.push([
          '---',
          `ref: memory:${entry.id} source:${entry.sourceKey} match:${entry.matchMode} terms:${entry.matchedTerms}/${entry.totalTerms}`,
          `${targetLabel} ${projectLabel}${categoryLabel} ${snippet.text}`,
          `Created: ${entry.created} | Last used: ${entry.lastReferenced}`,
        ].join('\n'));
      }

      const output = boundMemoryOutput(blocks.join('\n\n').trim());
      const finalResult: SearchResult = {
        success: true,
        count: results.length,
        candidateCount: search.candidateCount,
        sourceCount: search.sourceCount,
        omittedCount: search.omittedCount,
        truncatedCount,
        snippetChars,
        outputChars: output.text.length,
        outputTruncated: output.truncated,
        refs: results.map((entry) => ({ memoryId: entry.id })),
      };
      return { content: [{ type: 'text' as const, text: output.text }], details: finalResult };
    },
  });
}
