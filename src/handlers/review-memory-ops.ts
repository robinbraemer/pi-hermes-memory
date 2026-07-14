/**
 * Parse and apply structured memory operations from direct background review.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message, type SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore, type MemoryTargetTransaction } from "../store/memory-store.js";
import type { DatabaseManager } from "../store/db.js";
import type { MemoryCategory, MemoryConfig, ThinkingLevel } from "../types.js";

export interface ReviewMemoryOperation {
  action: "add" | "replace" | "remove";
  target: "memory" | "user" | "project" | "failure";
  content?: string;
  old_text?: string;
  category?: MemoryCategory;
  failure_reason?: string;
}

export interface ApplyReviewOperationsResult {
  appliedCount: number;
  skippedCount: number;
}

export interface DirectReviewResult {
  ok: boolean;
  appliedCount: number;
  skippedCount?: number;
  fallbackReason?: "no_model" | "no_auth" | "aborted" | "parse_error" | "provider_error" | "empty" | "operations_rejected";
  error?: string;
}

export interface ApplyReviewOperationsOptions {
  atomic?: boolean;
}

export interface RunDirectMemoryCompletionOptions {
  userPrompt: string;
  systemPrompt: string;
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowedTargets?: readonly ReviewMemoryOperation["target"][];
  atomic?: boolean;
}

/** Shared transport gate: review/flush/consolidation/correction all default to
 * the in-process direct completion path and fall back to a `pi -p` subprocess
 * only on failure, unless the user forces `reviewTransport: "subprocess"`. */
export function usesDirectTransport(config: Pick<MemoryConfig, "reviewTransport">): boolean {
  return (config.reviewTransport ?? "direct") === "direct";
}

type ReviewLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

function findExactModelReferenceMatch(modelReference: string, availableModels: Model<Api>[]): Model<Api> | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;

  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;

  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.substring(0, slashIndex).trim();
    const modelId = trimmedReference.substring(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) => model.provider.toLowerCase() === provider.toLowerCase()
          && model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
    }
  }

  const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

function normalizedModelOverride(config: ReviewLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ReviewLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

type ReviewModelRegistry = ExtensionContext["modelRegistry"];

export function buildDirectReviewCompletionOptions(
  model: Model<Api>,
  auth: {
    apiKey: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  },
  thinking: ThinkingLevel | undefined,
  signal: AbortSignal,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
    signal,
  };
  if (model.reasoning && thinking && thinking !== "off") {
    options.reasoning = thinking;
  }
  return options;
}

export function resolveReviewModel(
  ctxModel: Model<Api> | undefined,
  modelRegistry: ReviewModelRegistry,
  config: ReviewLlmConfig,
): Model<Api> | undefined {
  const override = normalizedModelOverride(config);
  if (override) {
    const matched = findExactModelReferenceMatch(override, modelRegistry.getAll());
    if (matched) return matched;
  }
  return ctxModel;
}

function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return value === "failure"
    || value === "correction"
    || value === "insight"
    || value === "preference"
    || value === "convention"
    || value === "tool-quirk";
}

function isReviewTarget(value: unknown): value is ReviewMemoryOperation["target"] {
  return value === "memory" || value === "user" || value === "project" || value === "failure";
}

function isReviewAction(value: unknown): value is ReviewMemoryOperation["action"] {
  return value === "add" || value === "replace" || value === "remove";
}

export function parseReviewOperations(text: string): ReviewMemoryOperation[] | null {
  if (/nothing to save/i.test(text) && !text.includes("{")) {
    return [];
  }

  const payload = extractJsonPayload(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const operations = (payload as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return null;

  const parsed: ReviewMemoryOperation[] = [];
  for (const item of operations) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (!isReviewAction(op.action) || !isReviewTarget(op.target)) continue;

    const operation: ReviewMemoryOperation = {
      action: op.action,
      target: op.target,
    };
    if (typeof op.content === "string") operation.content = op.content;
    if (typeof op.old_text === "string") operation.old_text = op.old_text;
    if (isMemoryCategory(op.category)) operation.category = op.category;
    if (typeof op.failure_reason === "string") operation.failure_reason = op.failure_reason;
    parsed.push(operation);
  }

  return parsed;
}

type ReviewOperationExecutor = Pick<MemoryTargetTransaction, "add" | "addFailure" | "replace" | "remove">;

async function applyReviewOperation(
  operation: ReviewMemoryOperation,
  executor: ReviewOperationExecutor,
): Promise<boolean> {
  switch (operation.action) {
    case "add": {
      if (!operation.content?.trim()) return false;
      const result = operation.target === "failure"
        ? await executor.addFailure(operation.content, {
            category: operation.category ?? "failure",
            failureReason: operation.failure_reason,
          })
        : await executor.add(operation.content);
      return result.success;
    }
    case "replace": {
      if (!operation.old_text || !operation.content?.trim()) return false;
      return (await executor.replace(operation.old_text, operation.content)).success;
    }
    case "remove": {
      if (!operation.old_text) return false;
      return (await executor.remove(operation.old_text)).success;
    }
  }
}

function operationScope(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operation: ReviewMemoryOperation,
): { store: MemoryStore; target: "memory" | "user" | "failure" } | null {
  if (operation.target === "project") {
    return projectStore ? { store: projectStore, target: "memory" } : null;
  }
  return { store, target: operation.target };
}

async function applyAtomicReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  allowedTargetSet: Set<ReviewMemoryOperation["target"]> | null,
): Promise<ApplyReviewOperationsResult> {
  let scope: { store: MemoryStore; target: "memory" | "user" | "failure" } | null = null;
  let preSkippedCount = 0;
  const executable: ReviewMemoryOperation[] = [];

  for (const operation of operations) {
    if (allowedTargetSet && !allowedTargetSet.has(operation.target)) {
      preSkippedCount++;
      continue;
    }
    const candidate = operationScope(store, projectStore, operation);
    if (!candidate) {
      preSkippedCount++;
      continue;
    }
    if (scope && (scope.store !== candidate.store || scope.target !== candidate.target)) {
      return { appliedCount: 0, skippedCount: operations.length };
    }
    scope = candidate;
    executable.push(operation);
  }

  if (!scope) return { appliedCount: 0, skippedCount: operations.length };

  return scope.store.runAtomicTargetMutation(scope.target, async (transaction) => {
    let appliedCount = 0;
    let skippedCount = preSkippedCount;
    for (const operation of executable) {
      if (await applyReviewOperation(operation, transaction)) appliedCount++;
      else skippedCount++;
    }
    const commit = skippedCount === 0;
    return {
      result: commit
        ? { appliedCount, skippedCount }
        : { appliedCount: 0, skippedCount: operations.length },
      commit,
    };
  });
}

export async function applyReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  _dbManager: DatabaseManager | null = null,
  _projectName?: string | null,
  allowedTargets?: readonly ReviewMemoryOperation["target"][],
  options: ApplyReviewOperationsOptions = {},
): Promise<ApplyReviewOperationsResult> {
  let appliedCount = 0;
  let skippedCount = 0;
  const allowedTargetSet = allowedTargets ? new Set(allowedTargets) : null;
  if (options.atomic) {
    return applyAtomicReviewOperations(store, projectStore, operations, allowedTargetSet);
  }

  for (const op of operations) {
    if (allowedTargetSet && !allowedTargetSet.has(op.target)) {
      skippedCount++;
      continue;
    }
    if (op.target === "project" && !projectStore) {
      skippedCount++;
      continue;
    }

    const rawTarget = op.target;
    const memoryTarget = rawTarget === "project" ? "memory" : rawTarget === "failure" ? "failure" : rawTarget;
    const activeStore = rawTarget === "project" ? projectStore! : store;

    const executor: ReviewOperationExecutor = {
      add: (content) => activeStore.add(memoryTarget, content),
      addFailure: (content, failureOptions) => activeStore.addFailure(content, failureOptions),
      replace: (oldText, newContent) => activeStore.replace(memoryTarget, oldText, newContent),
      remove: (oldText) => activeStore.remove(memoryTarget, oldText),
    };
    if (await applyReviewOperation(op, executor)) appliedCount++;
    else skippedCount++;
  }

  return { appliedCount, skippedCount };
}

export async function applyDirectReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  options: Pick<RunDirectMemoryCompletionOptions, "allowedTargets" | "atomic"> = {},
): Promise<DirectReviewResult> {
  const { appliedCount, skippedCount } = await applyReviewOperations(
    store,
    projectStore,
    operations,
    dbManager,
    projectName,
    options.allowedTargets,
    { atomic: options.atomic },
  );
  if (operations.length > 0 && appliedCount === 0 && skippedCount > 0) {
    return {
      ok: false,
      appliedCount: 0,
      skippedCount,
      fallbackReason: "operations_rejected",
    };
  }
  return { ok: true, appliedCount, skippedCount };
}

function responseText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      !!block && typeof block === "object" && (block as { type?: string }).type === "text"
    ))
    .map((block) => block.text)
    .join("\n");
}

export async function runDirectMemoryCompletion(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  options: RunDirectMemoryCompletionOptions,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): Promise<DirectReviewResult> {
  const model = resolveReviewModel(ctx.model, ctx.modelRegistry, options.config);
  if (!model) {
    return { ok: false, appliedCount: 0, fallbackReason: "no_model" };
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "no_auth",
      error: auth.ok ? `No API key for ${model.provider}` : auth.error,
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 120000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const thinking = effectiveThinkingOverride(options.config);
  const userMessage: Message = {
    role: "user",
    content: [{ type: "text", text: options.userPrompt }],
    timestamp: Date.now(),
  };

  try {
    const response = await completeSimple(
      model,
      { systemPrompt: options.systemPrompt, messages: [userMessage] },
      buildDirectReviewCompletionOptions(
        model,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        thinking,
        controller.signal,
      ),
    );

    if (response.stopReason === "aborted") {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }

    const text = responseText(response.content);
    const operations = parseReviewOperations(text);
    if (operations === null) {
      return { ok: false, appliedCount: 0, fallbackReason: "parse_error" };
    }
    if (operations.length === 0) {
      return { ok: true, appliedCount: 0, fallbackReason: "empty" };
    }

    return await applyDirectReviewOperations(
      store,
      projectStore,
      operations,
      dbManager,
      projectName,
      options,
    );
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, appliedCount: 0, fallbackReason: "aborted" };
    }
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: "provider_error",
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
