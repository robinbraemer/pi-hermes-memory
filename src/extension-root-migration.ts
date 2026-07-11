import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

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
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
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
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (!await pathExists(targetPath)) {
      try {
        await moveFile(sourcePath, targetPath);
        result.moved++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.warnings.push(`${sourcePath}: ${message}`);
        if (!relativeDir && entry.name === "sessions.db") {
          result.criticalFailures.push({
            name: entry.name,
            source: sourcePath,
            target: targetPath,
            message,
          });
        }
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
