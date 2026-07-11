import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_FILES = ["sessions.db", "sessions.db-wal", "sessions.db-shm"] as const;

export interface ExtensionRootMigrationResult {
  moved: number;
  merged: number;
  skipped: number;
  warnings: string[];
  criticalFailures: Array<{
    name: string;
    source: string;
    target: string;
    message: string;
  }>;
}

export interface ExtensionRootMigrationOptions {
  moveFile?: (source: string, target: string) => Promise<void>;
  publishDatabaseFile?: (source: string, target: string) => Promise<void>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function moveFileSafe(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });

  try {
    await fs.rename(source, target);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "EXDEV") throw error;
  }

  await fs.copyFile(source, target);
  await fs.unlink(source);
}

async function fileFingerprint(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function stageDatabaseArtifact(source: string, staged: string, name: string): Promise<void> {
  const sourceState = await fs.lstat(source);
  if (sourceState.isSymbolicLink()) {
    const before = await fs.readlink(source);
    const authoritativeTarget = path.resolve(path.dirname(source), before);
    await fs.symlink(authoritativeTarget, staged);
    const [after, stagedTarget] = await Promise.all([fs.readlink(source), fs.readlink(staged)]);
    if (before !== after || path.resolve(path.dirname(staged), stagedTarget) !== authoritativeTarget) {
      throw new Error(`${name} changed while staging`);
    }
    return;
  }
  if (!sourceState.isFile()) throw new Error(`${name} is not a regular file or symlink`);

  const before = await fileFingerprint(source);
  await fs.copyFile(source, staged);
  const [after, stagedFingerprint] = await Promise.all([
    fileFingerprint(source),
    fileFingerprint(staged),
  ]);
  if (before !== after || after !== stagedFingerprint) {
    throw new Error(`${name} changed while staging`);
  }
}

async function moveDirContents(
  sourceDir: string,
  targetDir: string,
  result: ExtensionRootMigrationResult,
  moveFile: (source: string, target: string) => Promise<void>,
  relativeDir = "",
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!relativeDir && DATABASE_FILES.includes(entry.name as typeof DATABASE_FILES[number])) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (!await pathExists(targetPath)) {
      try {
        await moveFile(sourcePath, targetPath);
        result.moved++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`${sourcePath}: ${message}`);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await moveDirContents(
        sourcePath,
        targetPath,
        result,
        moveFile,
        path.join(relativeDir, entry.name),
      );
      result.merged++;
      try {
        const remaining = await fs.readdir(sourcePath);
        if (remaining.length === 0) await fs.rmdir(sourcePath);
      } catch {
        // best effort
      }
      continue;
    }

    result.skipped++;
  }
}

async function publishDatabaseFile(source: string, target: string): Promise<void> {
  if ((await fs.lstat(source)).isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), target);
    return;
  }
  await fs.link(source, target);
}

async function migrateDatabaseGeneration(
  legacyRoot: string,
  targetRoot: string,
  result: ExtensionRootMigrationResult,
  publish: (source: string, target: string) => Promise<void>,
): Promise<void> {
  const sourceNames: string[] = [];
  const targetNames: string[] = [];
  for (const name of DATABASE_FILES) {
    if (await pathEntryExists(path.join(legacyRoot, name))) sourceNames.push(name);
    if (await pathEntryExists(path.join(targetRoot, name))) targetNames.push(name);
  }
  if (sourceNames.length === 0) return;

  if (targetNames.includes("sessions.db")) {
    result.skipped += sourceNames.length;
    return;
  }

  if (!sourceNames.includes("sessions.db") || targetNames.length > 0) {
    const message = targetNames.length > 0
      ? `destination contains a partial SQLite generation: ${targetNames.join(", ")}`
      : "legacy SQLite sidecars exist without sessions.db";
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
    return;
  }

  await fs.mkdir(targetRoot, { recursive: true });
  const stagingDir = path.join(targetRoot, `.sessions-db-migration-${randomUUID()}`);
  const published: string[] = [];
  try {
    await fs.mkdir(stagingDir, { mode: 0o700 });
    for (const name of sourceNames) {
      const source = path.join(legacyRoot, name);
      const staged = path.join(stagingDir, name);
      await stageDatabaseArtifact(source, staged, name);
    }

    const publishOrder = sourceNames.filter((name) => name !== "sessions.db");
    publishOrder.push("sessions.db");
    for (const name of publishOrder) {
      const target = path.join(targetRoot, name);
      await publish(path.join(stagingDir, name), target);
      published.push(target);
    }

    for (const name of sourceNames) {
      try { await fs.unlink(path.join(legacyRoot, name)); } catch {}
    }
    result.moved += sourceNames.length;
  } catch (error) {
    for (const target of published.reverse()) {
      try { await fs.unlink(target); } catch {}
    }
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`${path.join(legacyRoot, "sessions.db")}: ${message}`);
    result.criticalFailures.push({
      name: "sessions.db",
      source: path.join(legacyRoot, "sessions.db"),
      target: path.join(targetRoot, "sessions.db"),
      message,
    });
  } finally {
    try { await fs.rm(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Move legacy extension assets from ~/.pi/agent/memory into
 * ~/.pi/agent/pi-hermes-memory. Existing destination files win.
 */
export async function migrateExtensionRoot(
  legacyRoot: string,
  targetRoot: string,
  options: ExtensionRootMigrationOptions = {},
): Promise<ExtensionRootMigrationResult> {
  const result: ExtensionRootMigrationResult = {
    moved: 0,
    merged: 0,
    skipped: 0,
    warnings: [],
    criticalFailures: [],
  };

  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return result;
  if (!existsSync(legacyRoot)) return result;

  await fs.mkdir(targetRoot, { recursive: true });
  await migrateDatabaseGeneration(
    legacyRoot,
    targetRoot,
    result,
    options.publishDatabaseFile ?? options.moveFile ?? publishDatabaseFile,
  );
  if (result.criticalFailures.some((failure) => failure.name === "sessions.db")) return result;
  await moveDirContents(legacyRoot, targetRoot, result, options.moveFile ?? moveFileSafe);

  try {
    const remaining = await fs.readdir(legacyRoot);
    if (remaining.length === 0) {
      await fs.rmdir(legacyRoot);
    }
  } catch {
    // best effort
  }

  return result;
}
