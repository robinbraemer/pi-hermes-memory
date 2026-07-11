/**
 * Markdown memory sync command — /memory-sync-markdown reconciles the SQLite
 * search mirror with authoritative Markdown memory files.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from '../store/db.js';
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from '../store/sqlite-memory-store.js';
import { ENTRY_DELIMITER, MEMORY_FILE, USER_FILE } from '../constants.js';
import { AGENT_ROOT } from '../paths.js';
import {
  migrateExtensionRoot,
  type ExtensionRootMigrationOptions,
} from '../extension-root-migration.js';
import { canonicalMarkdownIdentity, withMarkdownMutationLock } from '../store/markdown-mutation-lock.js';
import { recoverInterruptedMarkdownPublication } from '../store/memory-store.js';

export interface BackfillCounters {
  filesScanned: number;
  entriesScanned: number;
  imported: number;
  skipped: number;
  removed: number;
  warnings: string[];
  failedScopes: string[];
}

interface PersistenceReconciliationRetrierOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
}

export class PersistenceReconciliationRetrier {
  private state: 'idle' | 'running' | 'waiting' | 'succeeded' | 'exhausted' | 'cancelled' = 'idle';
  private attempts = 0;
  private retryTimer: unknown = null;
  private retryScheduled = false;
  private activeAttempt: Promise<void> | null = null;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutFn: (timer: unknown) => void;

  constructor(
    private readonly operation: () => Promise<
      Pick<BackfillCounters, 'failedScopes'> & Partial<Pick<BackfillCounters, 'warnings'>>
    >,
    private readonly onSucceeded: () => void,
    private readonly onFailed: (message: string) => void,
    options: PersistenceReconciliationRetrierOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  isInitialized(): boolean {
    return this.state === 'succeeded';
  }

  async start(): Promise<void> {
    if (this.state === 'exhausted') {
      this.state = 'idle';
      this.attempts = 0;
    }
    if (this.state !== 'idle') return;
    await this.runAttempt();
  }

  async cancel(): Promise<void> {
    if (this.state === 'cancelled') {
      if (this.activeAttempt) await this.activeAttempt;
      return;
    }
    if (this.state === 'succeeded' || this.state === 'exhausted') return;
    this.state = 'cancelled';
    if (this.retryScheduled) {
      this.retryScheduled = false;
      try { this.clearTimeoutFn(this.retryTimer); } catch {}
      this.retryTimer = null;
    }
    if (this.activeAttempt) await this.activeAttempt;
  }

  private async runAttempt(): Promise<void> {
    const attempt = this.attempt();
    this.activeAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (this.activeAttempt === attempt) this.activeAttempt = null;
    }
  }

  private isCancelled(): boolean {
    return this.state === 'cancelled';
  }

  private async attempt(): Promise<void> {
    if (this.isCancelled()) return;
    this.state = 'running';
    this.attempts++;
    let failure: string | null = null;
    try {
      const result = await this.operation();
      if (result.failedScopes.length > 0) {
        const details = result.warnings?.filter((warning) =>
          result.failedScopes.some((scope) => warning.startsWith(`${scope}:`))
        );
        failure = details?.length
          ? `Markdown reconciliation failed: ${details.join('; ')}`
          : `Markdown reconciliation failed for: ${result.failedScopes.join(', ')}`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (this.isCancelled()) return;
    if (!failure) {
      this.state = 'succeeded';
      try { this.onSucceeded(); } catch {}
      return;
    }

    const exhausted = this.attempts >= this.maxAttempts;
    this.state = exhausted ? 'exhausted' : 'waiting';
    try {
      this.onFailed(
        exhausted
          ? `Persistence initialization failed after ${this.attempts} attempts: ${failure}`
          : `Persistence initialization attempt ${this.attempts} failed; retrying: ${failure}`,
      );
    } catch {
    }
    if (exhausted) return;

    this.retryScheduled = true;
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryScheduled = false;
      this.retryTimer = null;
      if (this.state !== 'waiting') return;
      void this.runAttempt();
    }, this.retryDelayMs);
    (this.retryTimer as { unref?: () => void } | null)?.unref?.();
  }
}

export interface MigrationSyncOptions extends ExtensionRootMigrationOptions {
  onMigrationSucceeded?: () => void;
}

function readEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8').trim();
  if (!raw) return [];
  return raw.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean);
}

function scanProjectDirs(agentRoot: string, globalDir: string, projectsMemoryDir = "projects-memory"): {
  projects: Array<{ name: string; memoryFile: string }>;
  rejected: Set<string>;
  authoritative: Set<string>;
} {
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir);
  const projects = new Map<string, string>();
  const rejected = new Set<string>();
  const authoritative = new Set<string>();

  if (fs.existsSync(projectsRoot)) {
    for (const name of fs.readdirSync(projectsRoot)) {
      if (!isSafeProjectName(name, projectsRoot)) {
        rejected.add(name);
        continue;
      }
      const memoryFile = resolveAuthoritativeMemoryFile(projectsRoot, name);
      if (memoryFile) {
        authoritative.add(name);
        projects.set(name, memoryFile);
        rejected.delete(name);
      } else {
        rejected.add(name);
      }
    }
  }

  const resolvedAgentRoot = path.resolve(agentRoot);
  const resolvedGlobalDir = path.resolve(globalDir);
  const globalDirName = path.dirname(resolvedGlobalDir) === resolvedAgentRoot
    ? path.basename(resolvedGlobalDir)
    : null;
  if (fs.existsSync(agentRoot)) {
    for (const name of fs.readdirSync(agentRoot)) {
      if ((globalDirName && name === globalDirName) || name === projectsMemoryDir || name === 'skills' || name.startsWith('.')) continue;
      if (authoritative.has(name)) continue;
      if (!isSafeProjectName(name, resolvedAgentRoot)) {
        rejected.add(name);
        continue;
      }
      const memoryFile = resolveAuthoritativeMemoryFile(resolvedAgentRoot, name);
      if (memoryFile) {
        authoritative.add(name);
        projects.set(name, memoryFile);
        rejected.delete(name);
      } else {
        rejected.add(name);
      }
    }
  }

  return {
    projects: [...projects.entries()]
      .map(([name, memoryFile]) => ({ name, memoryFile }))
      .filter(({ memoryFile }) => fs.existsSync(memoryFile)),
    rejected,
    authoritative,
  };
}

function realpathIfPresent(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(filePath);
    throw error;
  }
}

function resolveAuthoritativeMemoryFile(root: string, projectName: string): string | null {
  const canonicalRoot = realpathIfPresent(root);
  if (!isSafeProjectName(projectName, path.resolve(root))) return null;

  const projectDir = path.join(root, projectName);
  let projectStat: fs.Stats;
  try {
    projectStat = fs.lstatSync(projectDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalRoot, projectName, MEMORY_FILE);
    }
    throw error;
  }
  if (projectStat.isSymbolicLink() || !projectStat.isDirectory()) return null;

  const canonicalProjectDir = fs.realpathSync(projectDir);
  if (path.dirname(canonicalProjectDir) !== canonicalRoot) return null;

  const memoryFile = path.join(projectDir, MEMORY_FILE);
  let memoryStat: fs.Stats;
  try {
    memoryStat = fs.lstatSync(memoryFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return path.join(canonicalProjectDir, MEMORY_FILE);
    }
    throw error;
  }
  if (memoryStat.isSymbolicLink() || !memoryStat.isFile()) return null;

  const canonicalMemoryFile = fs.realpathSync(memoryFile);
  if (path.dirname(canonicalMemoryFile) !== canonicalProjectDir || path.basename(canonicalMemoryFile) !== MEMORY_FILE) {
    return null;
  }
  return canonicalMemoryFile;
}

function isSafeProjectName(name: string, projectsRoot: string): boolean {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    return false;
  }
  const projectDir = path.resolve(projectsRoot, name);
  return path.dirname(projectDir) === projectsRoot && path.basename(projectDir) === name;
}

export async function syncMarkdownMemoriesToSqlite(
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): Promise<BackfillCounters & { projectCount: number }> {
  const counters: BackfillCounters = {
    filesScanned: 0,
    entriesScanned: 0,
    imported: 0,
    skipped: 0,
    removed: 0,
    warnings: [],
    failedScopes: [],
  };

  const globalMemoryFile = path.join(globalDir, MEMORY_FILE);
  const globalUserFile = path.join(globalDir, USER_FILE);
  const globalFailureFile = path.join(globalDir, 'failures.md');

  const reconcileFile = async (
    filePath: string | null,
    target: 'memory' | 'user' | 'failure',
    project: string | null = null,
  ) => {
    const reconcile = async (authoritativePath: string | null) => {
      if (authoritativePath) await recoverInterruptedMarkdownPublication(authoritativePath);
      if (authoritativePath && fs.existsSync(authoritativePath)) counters.filesScanned++;
      const entries = authoritativePath ? readEntries(authoritativePath) : [];
      counters.entriesScanned += entries.length;
      try {
        const result = target === 'failure'
          ? reconcileMarkdownFailureScopes(dbManager, entries)
          : reconcileMarkdownMemoryScope(dbManager, entries, target, project);
        counters.imported += result.inserted;
        counters.skipped += result.existing;
        counters.removed += result.removed;
      } catch (err) {
        const scope = `${path.basename(project ?? 'global')}/${target}`;
        counters.failedScopes.push(scope);
        counters.warnings.push(
          `${scope}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    if (filePath) {
      const authoritativePath = await canonicalMarkdownIdentity(filePath);
      await withMarkdownMutationLock(authoritativePath, () => reconcile(authoritativePath));
    } else {
      await reconcile(null);
    }
  };

  await reconcileFile(globalMemoryFile, 'memory');
  await reconcileFile(globalUserFile, 'user');
  await reconcileFile(globalFailureFile, 'failure');

  const scan = scanProjectDirs(agentRoot, globalDir, projectsMemoryDir);
  const projects = scan.projects;
  const projectFiles = new Map(projects.map((project) => [project.name, project.memoryFile]));
  const mirroredProjects = dbManager.getDb().prepare(`
    SELECT DISTINCT project
    FROM memories
    WHERE project IS NOT NULL AND target = 'memory'
  `).all() as Array<{ project: string }>;
  const projectNames = new Set([
    ...projectFiles.keys(),
    ...mirroredProjects.map(({ project }) => project),
  ]);
  const projectsRoot = path.resolve(agentRoot, projectsMemoryDir ?? 'projects-memory');
  for (const projectName of projectNames) {
    if (!projectFiles.has(projectName) && scan.rejected.has(projectName) && !scan.authoritative.has(projectName)) {
      counters.warnings.push(`${projectName}/memory: authoritative project path was rejected as unsafe; SQLite rows were preserved`);
      continue;
    }
    const memoryFile = projectFiles.get(projectName)
      ?? resolveAuthoritativeMemoryFile(projectsRoot, projectName);
    if (!memoryFile) {
      counters.warnings.push(`${projectName}/memory: authoritative project path was rejected as unsafe; SQLite rows were preserved`);
      continue;
    }
    await reconcileFile(memoryFile, 'memory', projectName);
  }

  return { ...counters, projectCount: projectNames.size };
}

export async function migrateThenSyncMarkdownMemories(
  dbManager: DatabaseManager,
  legacyGlobalDir: string | null,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
  migrationOptions: MigrationSyncOptions = {},
): Promise<BackfillCounters & { projectCount: number }> {
  if (legacyGlobalDir) {
    const migration = await migrateExtensionRoot(legacyGlobalDir, globalDir, migrationOptions);
    const sessionsFailure = migration.criticalFailures.find((failure) => failure.name === 'sessions.db');
    if (sessionsFailure) {
      throw new Error(`sessions.db migration failed: ${sessionsFailure.message}`);
    }
    const authoritativeNames = new Set([MEMORY_FILE, USER_FILE, 'failures.md']);
    const authoritativeFailure = migration.assetFailures.find((failure) =>
      path.resolve(path.dirname(failure.source)) === path.resolve(legacyGlobalDir)
      && authoritativeNames.has(path.basename(failure.source))
    );
    if (authoritativeFailure) {
      throw new Error(
        `${path.basename(authoritativeFailure.source)} migration failed: ${authoritativeFailure.message}`,
      );
    }
    migrationOptions.onMigrationSucceeded?.();
  }
  return await syncMarkdownMemoriesToSqlite(dbManager, globalDir, projectsMemoryDir, agentRoot);
}

export function registerSyncMarkdownMemoriesCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  globalDir: string,
  projectsMemoryDir?: string,
  agentRoot = AGENT_ROOT,
): void {
  pi.registerCommand('memory-sync-markdown', {
    description: 'Reconcile the SQLite search mirror with Markdown memories',
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify('🔄 Reconciling the SQLite search mirror with Markdown memories...', 'info');

      try {
        const counters = await syncMarkdownMemoriesToSqlite(dbManager, globalDir, projectsMemoryDir, agentRoot);

        let output = `\n✅ Markdown → SQLite sync complete!\n\n`;
        output += `📊 Results:\n`;
        output += `├─ Files scanned: ${counters.filesScanned}\n`;
        output += `├─ Entries scanned: ${counters.entriesScanned}\n`;
        output += `├─ Imported into SQLite: ${counters.imported}\n`;
        output += `├─ Skipped as duplicates: ${counters.skipped}\n`;
        output += `└─ Removed orphaned rows: ${counters.removed}\n`;

        if (counters.projectCount > 0) {
          output += `\n📁 Project memories scanned: ${counters.projectCount}\n`;
        }

        if (counters.warnings.length > 0) {
          output += `\n⚠️ Warnings (${counters.warnings.length}):\n`;
          for (const warning of counters.warnings.slice(0, 5)) {
            output += `├─ ${warning}\n`;
          }
          if (counters.warnings.length > 5) {
            output += `└─ ... and ${counters.warnings.length - 5} more\n`;
          }
        }

        output += `\n💡 Re-running this command is safe — existing SQLite rows are de-duplicated.`;
        ctx.ui.notify(output, 'info');
      } catch (err) {
        ctx.ui.notify(`❌ Markdown sync failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    },
  });
}
